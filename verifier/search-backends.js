/**
 * Search Backend Manager — Multi-Engine Rotation
 *
 * Engines (all 100% free, no key required):
 *   1. DuckDuckGo HTML (html.duckduckgo.com) — primary
 *   2. DuckDuckGo Lite (lite.duckduckgo.com) — fallback after DDG HTML block
 *   3. Mojeek HTML (mojeek.com) — independent index, UK-friendly
 *   4. Public SearXNG instances — JSON API, no key
 *
 * Rotation policy:
 *   - Round-robin across enabled engines.
 *   - Per-engine 2-minute cooldown on 429/CAPTCHA/block.
 *   - If ALL engines are in cooldown, SLEEP until the shortest cooldown expires (never mark Uncertain for this).
 *   - Max ~30 successful queries per engine before voluntary rotation.
 *   - Cache successful results on disk for 48 h.
 *   - Track and expose per-engine stats.
 */

const cheerio = require('cheerio');
const rateLimiter = require('../utils/rate-limiter');
const DiskCache = require('../utils/cache');

const SEARXNG_PUBLIC_INSTANCES = [
  'https://searx.be',
  'https://search.ononoki.org',
  'https://searx.fmac.xyz',
  'https://search.indst.eu',
  'https://searxng.site',
  'https://paulgo.io'
];

const MOJEEK_URL = 'https://www.mojeek.com/search';

// Alternate between Mojeek and DuckDuckGo Lite as primary engines to prevent DDG HTML blocks
const ENGINES = ['mojeek', 'duckduckgo_lite', 'duckduckgo_html', 'searxng'];

class SearchBackendManager {
  constructor() {
    this.activeBackend = 'mojeek';
    this.searxngUrl = process.env.SEARXNG_URL || 'http://localhost:8080';

    // Per-engine state
    this.engineState = {};
    for (const e of ENGINES) {
      this.engineState[e] = {
        totalQueries: 0,
        successfulQueries: 0,
        blockedQueries: 0,
        coolDownUntil: 0,
        lastQueryTime: 0,
        currentDelayMs: 8000,
        consecutiveBlocks: 0,
        lastError: null,
        voluntaryRotationCount: 0
      };
    }

    // Which engine we're currently on (index into ENGINES array)
    this.currentEngineIdx = 0;
    this.initialized = false;
    this.selfHostedSearxngAvailable = false;
    this.activeSearxngInstance = null;
  }

  /**
   * Auto-detect SearXNG availability at startup
   */
  async initialize() {
    if (this.initialized) return;
    this.initialized = true;

    // Try self-hosted SearXNG
    try {
      console.log(`[SearchBackend] Checking self-hosted SearXNG at ${this.searxngUrl}...`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`${this.searxngUrl}/search?q=test&format=json`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'LeadScraperSearchTest/1.0' }
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.results)) {
          this.selfHostedSearxngAvailable = true;
          this.activeSearxngInstance = this.searxngUrl;
          console.log(`[SearchBackend] ✅ Self-hosted SearXNG active.`);
        }
      }
    } catch (err) {
      // Not available — will try public instances
    }

    if (!this.selfHostedSearxngAvailable) {
      // Probe public SearXNG instances
      for (const inst of SEARXNG_PUBLIC_INSTANCES) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          const res = await fetch(`${inst}/search?q=bakery&format=json`, {
            signal: controller.signal,
            headers: { 'User-Agent': 'LeadScraperSearchTest/1.0' }
          });
          clearTimeout(timeout);
          if (res.ok) {
            const data = await res.json();
            if (data && Array.isArray(data.results) && data.results.length > 0) {
              this.activeSearxngInstance = inst;
              console.log(`[SearchBackend] ✅ Public SearXNG active: ${inst}`);
              break;
            }
          }
        } catch (e) {}
      }
    }

    if (!this.activeSearxngInstance) {
      // Remove searxng from engine list if nothing available
      const idx = ENGINES.indexOf('searxng');
      if (idx !== -1) ENGINES.splice(idx, 1);
      console.log(`[SearchBackend] SearXNG unavailable — using DDG + Mojeek.`);
    }

    console.log(`[SearchBackend] 🔄 Multi-engine rotation active: alternating Mojeek and DuckDuckGo Lite.`);
  }

  /**
   * Get telemetry status
   */
  getStatus() {
    const summary = {};
    let totalQueriesAll = 0;
    let blockedQueriesAll = 0;
    for (const e of ENGINES) {
      const s = this.engineState[e];
      totalQueriesAll += s.totalQueries;
      blockedQueriesAll += s.blockedQueries;
      summary[e] = {
        totalQueries: s.totalQueries,
        successfulQueries: s.successfulQueries,
        blockedQueries: s.blockedQueries,
        blockRatePercent: s.totalQueries > 0
          ? parseFloat(((s.blockedQueries / s.totalQueries) * 100).toFixed(1))
          : 0,
        inCoolDown: Date.now() < s.coolDownUntil,
        coolDownRemainingS: Math.max(0, Math.ceil((s.coolDownUntil - Date.now()) / 1000)),
        currentDelayMs: s.currentDelayMs,
        lastError: s.lastError
      };
    }
    const overallBlockRate = totalQueriesAll > 0
      ? parseFloat(((blockedQueriesAll / totalQueriesAll) * 100).toFixed(1))
      : 0;
    return {
      currentEngine: ENGINES[this.currentEngineIdx] || 'none',
      activeBackend: this.activeBackend,
      blockRatePercent: overallBlockRate,
      searxngInstance: this.activeSearxngInstance,
      engines: summary
    };
  }

  /**
   * Get next non-cooling-down engine, sleeping if all are down.
   * Returns engine name, or null only if an unrecoverable error occurs.
   */
  async _pickEngine() {
    const totalEngines = ENGINES.length;
    if (totalEngines === 0) return null;

    const now = Date.now();
    // Find first engine not in cooldown starting from current
    for (let i = 0; i < totalEngines; i++) {
      const idx = (this.currentEngineIdx + i) % totalEngines;
      const engine = ENGINES[idx];
      const state = this.engineState[engine];
      if (now >= state.coolDownUntil) {
        this.currentEngineIdx = idx;
        return engine;
      }
    }

    // All engines are in cooldown:
    // When search engines are cooling down, do not wait more than 60 seconds per lead in tests.
    // Mark the lead Uncertain with reason "search cooldown" and continue.
    const remainingMsList = ENGINES.map(e => Math.max(0, this.engineState[e].coolDownUntil - now));
    const minRemainingMs = Math.min(...remainingMsList);

    // If cooldown remaining is greater than 60s, do not wait.
    if (minRemainingMs > 60000) {
      return null;
    }

    // If minRemainingMs is <= 60000 (e.g. 5s), wait at most that duration
    if (minRemainingMs > 0 && minRemainingMs <= 60000) {
      console.log(`[SearchBackend] All engines in cooldown, shortest wait ${Math.ceil(minRemainingMs / 1000)}s (<=60s limit). Waiting...`);
      await rateLimiter.sleep(minRemainingMs);
      const nowAfter = Date.now();
      for (let i = 0; i < totalEngines; i++) {
        const idx = (this.currentEngineIdx + i) % totalEngines;
        const engine = ENGINES[idx];
        const state = this.engineState[engine];
        if (nowAfter >= state.coolDownUntil) {
          this.currentEngineIdx = idx;
          return engine;
        }
      }
    }

    return null;
  }

  /**
   * Record a block for a given engine and trigger cooldown + adaptive pacing
   */
  /**
   * Record a block for a given engine and trigger cooldown + adaptive pacing
   */
  _recordBlock(engine, reason) {
    const state = this.engineState[engine];
    state.consecutiveBlocks++;
    state.blockedQueries++;
    state.lastError = reason;
    // Requirement 1: On the first bot challenge, back off that engine for 15 minutes, not 2
    const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
    state.coolDownUntil = Date.now() + FIFTEEN_MINUTES_MS;
    console.warn(`[SearchBackend] ${engine}: block/challenge detected (${reason}). Cooling down for 15 minutes (until ${new Date(state.coolDownUntil).toLocaleTimeString()}).`);

    // Rotate to next engine
    this.currentEngineIdx = (this.currentEngineIdx + 1) % ENGINES.length;
  }

  /**
   * Record a success for a given engine
   */
  _recordSuccess(engine) {
    const state = this.engineState[engine];
    state.consecutiveBlocks = 0;
    state.successfulQueries++;
    // Requirement 1: Rotate engine on every query to alternate Mojeek and DDG Lite
    this.currentEngineIdx = (this.currentEngineIdx + 1) % ENGINES.length;
  }

  /**
   * Execute search with hard 20s timeout, multi-engine rotation, and cooldown handling
   * @param {string} query
   * @param {string} preferredMethod Optional override
   * @returns {Promise<{ results, blocked, reason?, fromCache?, engine? }>}
   */
  async search(query, preferredMethod = null) {
    const SEARCH_TIMEOUT_MS = 20000;
    let timer;
    const timeoutPromise = new Promise(resolve => {
      timer = setTimeout(() => {
        resolve({ results: [], blocked: true, reason: 'search query timed out after 20s' });
      }, SEARCH_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        this._searchInternal(query, preferredMethod),
        timeoutPromise
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async _searchInternal(query, preferredMethod = null) {
    if (!this.initialized) await this.initialize();

    const cacheKey = `search:${query}`;
    const cached = DiskCache.get('search_queries', cacheKey);
    if (cached) {
      return { results: cached, blocked: false, fromCache: true };
    }

    const engineToUse = preferredMethod && ENGINES.includes(preferredMethod)
      ? preferredMethod
      : await this._pickEngine();

    if (!engineToUse) {
      const anyInCooldown = ENGINES.some(e => Date.now() < this.engineState[e].coolDownUntil);
      const reason = anyInCooldown ? 'search cooldown' : 'No search engines available';
      return { results: [], blocked: true, reason };
    }

    const state = this.engineState[engineToUse];
    state.totalQueries++;

    // Requirement 1: At least 8-10 seconds between search queries per engine with random jitter
    const now = Date.now();
    const lastTime = state.lastQueryTime || 0;
    const minPacingMs = 8000 + Math.floor(Math.random() * 2500); // 8,000 - 10,500ms
    const elapsed = now - lastTime;
    if (elapsed < minPacingMs) {
      await rateLimiter.sleep(minPacingMs - elapsed);
    }
    state.lastQueryTime = Date.now();

    let result;
    switch (engineToUse) {
      case 'duckduckgo_html':
        result = await this._searchDuckDuckGoHtml(query);
        break;
      case 'duckduckgo_lite':
        result = await this._searchDuckDuckGoLite(query);
        break;
      case 'mojeek':
        result = await this._searchMojeek(query);
        break;
      case 'searxng':
        result = await this._searchSearXNG(query);
        break;
      default:
        result = await this._searchMojeek(query);
    }

    result.engine = engineToUse;

    if (result.blocked) {
      this._recordBlock(engineToUse, result.reason || 'blocked');

      // Try one automatic fallback to a different engine (if available and not preferred)
      if (!preferredMethod) {
        const fallbackEngine = await this._pickEngine();
        if (fallbackEngine && fallbackEngine !== engineToUse) {
          console.log(`[SearchBackend] Falling back from ${engineToUse} to ${fallbackEngine}`);
          const fallbackState = this.engineState[fallbackEngine];
          fallbackState.totalQueries++;

          // Pacing on fallback engine as well
          const fbNow = Date.now();
          const fbLast = fallbackState.lastQueryTime || 0;
          const fbMinPacing = 8000 + Math.floor(Math.random() * 2500);
          const fbElapsed = fbNow - fbLast;
          if (fbElapsed < fbMinPacing) {
            await rateLimiter.sleep(fbMinPacing - fbElapsed);
          }
          fallbackState.lastQueryTime = Date.now();

          let fallbackResult;
          switch (fallbackEngine) {
            case 'duckduckgo_html': fallbackResult = await this._searchDuckDuckGoHtml(query); break;
            case 'duckduckgo_lite': fallbackResult = await this._searchDuckDuckGoLite(query); break;
            case 'mojeek': fallbackResult = await this._searchMojeek(query); break;
            case 'searxng': fallbackResult = await this._searchSearXNG(query); break;
            default: fallbackResult = { results: [], blocked: true, reason: 'unknown engine' };
          }
          fallbackResult.engine = fallbackEngine;
          if (!fallbackResult.blocked && fallbackResult.results && fallbackResult.results.length > 0) {
            this._recordSuccess(fallbackEngine);
            DiskCache.set('search_queries', cacheKey, fallbackResult.results, 48 * 60 * 60 * 1000);
            return fallbackResult;
          } else if (fallbackResult.blocked) {
            this._recordBlock(fallbackEngine, fallbackResult.reason || 'blocked');
          }
        }
      }

      return result;
    }

    // Success path
    this._recordSuccess(engineToUse);
    DiskCache.set('search_queries', cacheKey, result.results, 48 * 60 * 60 * 1000);
    return result;
  }

  /**
   * Search DuckDuckGo HTML endpoint
   */
  async _searchDuckDuckGoHtml(query) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await rateLimiter.politeFetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        },
        timeoutMs: 9000
      }, 2);

      if (res.status === 429 || res.status === 403) {
        return { results: [], blocked: true, reason: `DuckDuckGo HTML returned HTTP ${res.status}` };
      }

      const html = await res.text();

      if (html.includes('anomaly-detected') || html.includes('bot-traffic') || html.includes('challenge-form')) {
        return { results: [], blocked: true, reason: 'DuckDuckGo returned bot anomaly verification challenge' };
      }

      const $ = cheerio.load(html);
      const results = [];

      $('.result').each((_, el) => {
        if (results.length >= 10) return;
        const titleEl = $(el).find('.result__title a');
        const snippetEl = $(el).find('.result__snippet');
        const urlEl = $(el).find('.result__url');
        let rawUrl = titleEl.attr('href') || urlEl.text().trim();
        const title = titleEl.text().trim();
        const snippet = snippetEl.text().trim();

        let cleanUrl = rawUrl;
        if (rawUrl && rawUrl.includes('uddg=')) {
          try {
            const parsed = new URL('https://duckduckgo.com' + rawUrl);
            const uddg = parsed.searchParams.get('uddg');
            if (uddg) cleanUrl = decodeURIComponent(uddg);
          } catch (e) {}
        }
        if (cleanUrl && !cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
          cleanUrl = 'https://' + cleanUrl;
        }
        if (cleanUrl && title) results.push({ title, url: cleanUrl, snippet });
      });

      return { results, blocked: false };
    } catch (err) {
      return { results: [], blocked: true, reason: `DuckDuckGo HTML fetch failed: ${err.message}` };
    }
  }

  /**
   * Search DuckDuckGo Lite (POST)
   */
  async _searchDuckDuckGoLite(query) {
    try {
      const url = 'https://lite.duckduckgo.com/lite/';
      const body = new URLSearchParams({ q: query }).toString();
      const res = await rateLimiter.politeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        body,
        timeoutMs: 8000
      }, 1);

      if (!res.ok) {
        return { results: [], blocked: true, reason: `DDG Lite returned HTTP ${res.status}` };
      }

      const html = await res.text();
      const $ = cheerio.load(html);
      const results = [];

      $('a.result-link').each((_, el) => {
        if (results.length >= 10) return;
        const title = $(el).text().trim();
        let href = $(el).attr('href');
        if (href && href.includes('uddg=')) {
          try {
            const parsed = new URL('https://duckduckgo.com' + href);
            const uddg = parsed.searchParams.get('uddg');
            if (uddg) href = decodeURIComponent(uddg);
          } catch (e) {}
        }
        if (href && title) results.push({ title, url: href, snippet: '' });
      });

      if (results.length === 0) {
        return { results: [], blocked: true, reason: 'DDG Lite returned 0 results (possible rate limit or CAPTCHA)' };
      }

      return { results, blocked: false };
    } catch (err) {
      return { results: [], blocked: true, reason: `DDG Lite error: ${err.message}` };
    }
  }

  /**
   * Search Mojeek HTML — independent index, UK-friendly, no API key required
   * CSS selector: ul#results li a.ob (title link)
   */
  async _searchMojeek(query) {
    try {
      const url = `${MOJEEK_URL}?q=${encodeURIComponent(query)}`;
      const res = await rateLimiter.politeFetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9'
        },
        timeoutMs: 9000
      }, 1);

      if (res.status === 403 || res.status === 429) {
        return { results: [], blocked: true, reason: `Mojeek returned HTTP ${res.status}` };
      }
      if (!res.ok) {
        return { results: [], blocked: true, reason: `Mojeek returned HTTP ${res.status}` };
      }

      const html = await res.text();
      const $ = cheerio.load(html);
      const results = [];

      // Mojeek result links: ul.results-standard li a.ob
      $('a.ob').each((_, el) => {
        if (results.length >= 10) return;
        const title = $(el).text().trim();
        const href = $(el).attr('href');
        // Snippet is in following sibling p.s
        const snippet = $(el).parent().find('p.s').text().trim();
        if (title && href && href.startsWith('http')) {
          results.push({ title, url: href, snippet });
        }
      });

      if (results.length === 0) {
        return { results: [], blocked: true, reason: 'Mojeek returned 0 results (blocked or selectors changed)' };
      }

      return { results, blocked: false };
    } catch (err) {
      return { results: [], blocked: true, reason: `Mojeek fetch failed: ${err.message}` };
    }
  }

  /**
   * Search SearXNG (self-hosted or public JSON API)
   */
  async _searchSearXNG(query) {
    const instance = this.activeSearxngInstance;
    if (!instance) {
      return { results: [], blocked: true, reason: 'No SearXNG instance available' };
    }
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json`;
      const res = await rateLimiter.politeFetch(url, { timeoutMs: 7000 }, 1);

      if (!res.ok) {
        // Try next public instance
        const currentIdx = SEARXNG_PUBLIC_INSTANCES.indexOf(instance);
        if (currentIdx >= 0 && currentIdx + 1 < SEARXNG_PUBLIC_INSTANCES.length) {
          this.activeSearxngInstance = SEARXNG_PUBLIC_INSTANCES[currentIdx + 1];
        }
        return { results: [], blocked: true, reason: `SearXNG (${instance}) returned HTTP ${res.status}` };
      }

      const json = await res.json();
      const rawResults = json.results || [];
      const results = rawResults.slice(0, 10).map(r => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.content || ''
      }));

      return { results, blocked: false };
    } catch (err) {
      return { results: [], blocked: true, reason: `SearXNG connection error: ${err.message}` };
    }
  }
}

const searchBackendManager = new SearchBackendManager();
module.exports = searchBackendManager;
