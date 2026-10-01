/**
 * Rate Limiter and Politeness Controller
 * Enforces per-host rate limits, concurrency caps, exponential backoff, and polite User-Agents.
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
];

const BOT_USER_AGENT = 'FreeLeadScraperBot/1.0 (Open Local Business Audit Tool; +https://github.com/zahinzeman/free_lead_scraper)';

class RateLimiter {
  constructor() {
    this.hostLastCall = new Map();
    this.activeRequests = 0;
    this.MAX_CONCURRENCY = 5;
    this.queue = [];
  }

  /**
   * Get random modern desktop User-Agent
   */
  getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  /**
   * Get honest API User-Agent (for Overpass, Nominatim, Gov APIs)
   */
  getBotUserAgent() {
    return BOT_USER_AGENT;
  }

  /**
   * Minimum delay required between requests for specific hostnames (in ms)
   */
  getHostDelay(hostname) {
    const host = hostname.toLowerCase();
    if (host.includes('overpass') || host.includes('openstreetmap')) {
      return 1100; // 1 req/sec strict for OSM/Overpass
    }
    if (host.includes('nominatim') || host.includes('komoot') || host.includes('photon')) {
      return 1100; // 1 req/sec for Nominatim
    }
    if (host.includes('duckduckgo.com') || host.includes('mojeek.com')) {
      // Requirement 1: at least 8-10 seconds between search queries per engine with random jitter
      return 8000 + Math.floor(Math.random() * 2500);
    }
    if (host.includes('food.gov.uk')) {
      return 300;
    }
    return 200; // Default politeness delay
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Schedule and execute a request honoring host delays, concurrency, and retries
   * @param {string} url 
   * @param {object} options 
   * @param {number} maxRetries 
   */
  async politeFetch(url, options = {}, maxRetries = 2) {
    let hostname = 'default';
    try {
      hostname = new URL(url).hostname;
    } catch (e) {
      hostname = 'invalid';
    }

    // Wait if concurrency limit reached
    while (this.activeRequests >= this.MAX_CONCURRENCY) {
      await this.sleep(100);
    }

    // Respect per-host spacing
    const requiredDelay = this.getHostDelay(hostname);
    const lastCall = this.hostLastCall.get(hostname) || 0;
    const elapsed = Date.now() - lastCall;
    if (elapsed < requiredDelay) {
      await this.sleep(requiredDelay - elapsed);
    }

    this.activeRequests++;
    this.hostLastCall.set(hostname, Date.now());

    let attempt = 0;
    let lastError = null;

    try {
      while (attempt <= maxRetries) {
        attempt++;
        try {
          const controller = new AbortController();
          const timeoutMs = Math.min(options.timeoutMs || 10000, 60000);
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

          const defaultHeaders = {
            'User-Agent': (hostname.includes('openstreetmap') || hostname.includes('food.gov.uk')) 
              ? this.getBotUserAgent() 
              : this.getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
            'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8'
          };

          const mergedHeaders = { ...defaultHeaders, ...(options.headers || {}) };

          let res;
          try {
            res = await fetch(url, {
              ...options,
              headers: mergedHeaders,
              signal: controller.signal
            });
          } catch (fetchErr) {
            clearTimeout(timeoutId);
            // Catch Node v24 undici internal stream error assert(!this.paused) or socket resets
            if (fetchErr.code === 'ERR_ASSERTION' || (fetchErr.message && fetchErr.message.includes('assert(!this.paused)'))) {
              throw new Error(`Undici socket assertion handled for ${url}: ${fetchErr.message}`);
            }
            if (fetchErr.name === 'AbortError') {
              throw new Error(`Request timed out after ${timeoutMs}ms for ${url}`);
            }
            if (fetchErr.code === 'ECONNRESET' || fetchErr.code === 'UND_ERR_SOCKET') {
              throw new Error(`Socket reset for ${url}: ${fetchErr.message}`);
            }
            throw fetchErr;
          }

          clearTimeout(timeoutId);

          // Handle 429 or 503 backoff
          if (res.status === 429 || res.status === 503) {
            if (attempt <= maxRetries) {
              const backoffMs = (Math.pow(2, attempt) * 1500) + Math.floor(Math.random() * 1000);
              console.warn(`[RateLimiter] ${hostname} returned ${res.status}. Backing off for ${backoffMs}ms (Attempt ${attempt}/${maxRetries})`);
              await this.sleep(backoffMs);
              continue;
            }
          }

          return res;
        } catch (err) {
          lastError = err;
          if (err.name === 'AbortError') {
            throw new Error(`Request timed out after ${options.timeoutMs || 10000}ms for ${url}`);
          }
          if (attempt <= maxRetries) {
            await this.sleep(1000 * attempt);
            continue;
          }
          throw err;
        }
      }
    } catch (outerErr) {
      throw outerErr;
    } finally {
      this.activeRequests--;
      this.hostLastCall.set(hostname, Date.now());
    }

    throw lastError || new Error(`Failed to fetch ${url}`);
  }
}

const rateLimiterInstance = new RateLimiter();
module.exports = rateLimiterInstance;
