require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const dns = require('dns');
const { promisify } = require('util');
const dnsLookup = promisify(dns.lookup);

// undici (Node's fetch engine, 7.29/7.30) can throw `assert(!this.paused)` from a socket
// event when a remote server closes a connection mid-response. It is thrown outside any
// request, so without this guard one flaky website crashes the whole server and ends every
// running search. The affected request simply times out and that lead is marked Uncertain.
process.on('uncaughtException', (err) => {
  const isUndiciSocketBug = err && err.code === 'ERR_ASSERTION' && /client-h1|undici/.test(String(err.stack || ''));
  if (isUndiciSocketBug) {
    console.warn('[Server] Ignored undici socket assertion (remote server closed connection early).');
    return;
  }
  console.error('[Server] Uncaught exception:', err);
  process.exit(1);
});

const providerRegistry = require('./providers/registry');
const ScraperEngine = require('./scraper-engine');
const websiteVerifier = require('./verifier/index');
const searchBackendManager = require('./verifier/search-backends');
const { isParkedDomain } = require('./verifier/content-matcher');
const { applyRealChainFilter, dedupeLeads, cleanPhone } = require('./utils/normalizer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

/**
 * Health check endpoint
 */
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    version: '2.0.0',
    service: 'Free Lead Scraper Engine with Multi-Layer Verification',
    searchBackend: searchBackendManager.getStatus()
  });
});

/**
 * Providers endpoint
 * GET /api/providers?country=United+States
 */
app.get('/api/providers', (req, res) => {
  const country = req.query.country || null;
  const providers = providerRegistry.getProvidersList(country);
  res.json({
    providers,
    allowlist: providerRegistry.getAllowlist()
  });
});

/**
 * Search telemetry endpoint
 * GET /api/search-status
 */
app.get('/api/search-status', (req, res) => {
  res.json(searchBackendManager.getStatus());
});

/**
 * Provider-level locality funnel metrics
 * GET /api/funnel-stats
 * Returns per-provider: raw, rejectedByLocality, rejectedNonBusiness, accepted counts
 * and sample records of what was rejected (for debugging false-geography issues).
 */
app.get('/api/funnel-stats', (req, res) => {
  const osmProvider = providerRegistry.getProvider('osm');
  const overtureProvider = providerRegistry.getProvider('overture');
  const fsaProvider = providerRegistry.getProvider('fsa');

  const stats = {};

  if (osmProvider && typeof osmProvider.getStats === 'function') {
    stats.osm = {
      ...osmProvider.getStats(),
      sampleLocalityRejections: (osmProvider.lastLocalityRejections || []).slice(0, 5),
      sampleNonBusinessRejections: (osmProvider.lastNonBusinessRejections || []).slice(0, 5),
      sampleAccepted: (osmProvider.lastLocalityAccepted || []).slice(0, 5)
    };
  }

  if (overtureProvider && typeof overtureProvider.getStats === 'function') {
    stats.overture = {
      ...overtureProvider.getStats(),
      sampleLocalityRejections: (overtureProvider.lastLocalityRejections || []).slice(0, 5),
      sampleAccepted: (overtureProvider.lastLocalityAccepted || []).slice(0, 5)
    };
  }

  if (fsaProvider && typeof fsaProvider.getStats === 'function') {
    stats.fsa = {
      ...fsaProvider.getStats(),
      sampleLocalityRejections: (fsaProvider.lastLocalityRejections || []).slice(0, 5),
      sampleAccepted: (fsaProvider.lastLocalityAccepted || []).slice(0, 5)
    };
  }

  res.json({
    description: 'Provider-level locality funnel reporting (raw -> rejectedByLocality -> rejectedNonBusiness -> accepted)',
    providers: stats
  });
});



/**
 * Single URL verification helper
 * Dual-layer DNS lookup + HTTP reachability + Parked Domain filter
 * Strictly returns working: false on error or dead site.
 */
async function checkWebsiteStatus(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { url: rawUrl, working: false, statusCode: 0, statusText: 'Invalid URL' };
  }

  let targetUrl = rawUrl.trim();
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  const startTime = Date.now();

  // 1. Extract hostname
  let hostname = '';
  try {
    const parsed = new URL(targetUrl);
    hostname = parsed.hostname;
  } catch (e) {
    return { url: targetUrl, working: false, statusCode: 0, statusText: 'Invalid URL Format' };
  }

  // 2. DNS Verification - fails immediately if domain doesn't exist
  let resolvedIp = null;
  try {
    const dnsRes = await dnsLookup(hostname);
    resolvedIp = dnsRes.address;
  } catch (dnsErr) {
    return {
      url: targetUrl,
      working: false,
      statusCode: 0,
      statusText: 'DNS Not Found (Domain Dead)',
      latencyMs: Date.now() - startTime
    };
  }

  // 3. HTTP Reachability Check
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);

  try {
    let response;
    try {
      response = await fetch(targetUrl, {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'follow'
      });
    } catch (headErr) {
      response = await fetch(targetUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'follow'
      });
    }

    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;
    const finalUrl = response.url || targetUrl;

    // Detect 403 bot-protected domains
    if (response.status === 403 || response.status === 429) {
      return {
        url: finalUrl,
        working: true,
        statusCode: response.status,
        statusText: `Bot Protected Active Domain (${response.status})`,
        latencyMs: latency,
        ip: resolvedIp
      };
    }

    // Status 200-399
    if (response.status >= 200 && response.status < 400) {
      // Check for parked / domain for sale page
      try {
        const bodyText = await response.text();
        if (isParkedDomain(bodyText)) {
          return {
            url: finalUrl,
            working: false,
            statusCode: response.status,
            statusText: 'Parked Domain (For Sale / Placeholder)',
            latencyMs: latency,
            ip: resolvedIp
          };
        }
      } catch (tErr) {
        // If reading text fails, keep status
      }

      return {
        url: finalUrl,
        working: true,
        statusCode: response.status,
        statusText: `${response.status} OK (Live)`,
        latencyMs: latency,
        ip: resolvedIp
      };
    }

    // Any other status (404, 500, etc.) is NOT working
    return {
      url: finalUrl,
      working: false,
      statusCode: response.status,
      statusText: `HTTP ${response.status} ${response.statusText || 'Error'}`,
      latencyMs: latency,
      ip: resolvedIp
    };
  } catch (httpError) {
    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;
    return {
      url: targetUrl,
      working: false,
      statusCode: 0,
      statusText: `Connection Failed: ${httpError.message}`,
      latencyMs: latency,
      ip: resolvedIp
    };
  }
}

/**
 * GET /api/verify-url?url=https://...
 */
app.get('/api/verify-url', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'URL query parameter required' });
  }

  const result = await checkWebsiteStatus(url);
  res.json(result);
});

/**
 * Turn the dashboard's country + state/region code (+ optional city) into a list of
 * { state, city } place names that the geocoder can resolve.
 * - A specific city is used as-is.
 * - A specific region code searches that region's main cities.
 * - "ALL" (countrywide) searches the main city of every region.
 */
function resolveSearchTargets(country, stateCode, city) {
  const region = ScraperEngine.REGION_DATA[country];
  const states = region ? region.states.filter(s => s.code !== 'ALL') : [];
  const stateObj = states.find(s => s.code === stateCode || s.name === stateCode);

  if (city) {
    return [{ state: stateObj ? stateObj.name : '', city }];
  }
  if (stateObj) {
    const cities = (stateObj.cities && stateObj.cities.length) ? stateObj.cities : [stateObj.name];
    return cities.map(c => ({ state: stateObj.name, city: c }));
  }
  if (states.length) {
    return states.map(s => ({ state: s.name, city: (s.cities && s.cities[0]) || s.name }));
  }
  return [{ state: stateCode || '', city: stateCode || country }];
}

/**
 * Real-time Lead Scraping & Verification Streaming Endpoint (SSE)
 * GET /api/stream-scrape
 */
app.get('/api/stream-scrape', async (req, res) => {
  const {
    country = 'United States',
    state = '',
    city = '',
    industry = 'Plumbers',
    quota = '100',
    primarySource = 'auto',
    fallbackSource = '',
    verificationMethod = 'duckduckgo_html',
    websiteFilter = 'no_website',
    includeWebsites = 'true',
    includePhones = 'true',
    excludeChains = 'true'
  } = req.query;

  // 1. Validate primarySource against allowlist
  if (!providerRegistry.isValidProvider(primarySource)) {
    return res.status(400).json({
      error: `Invalid provider '${primarySource}'. Allowed: ${providerRegistry.getAllowlist().join(', ')}`
    });
  }

  // 2. Set SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let isClientClosed = false;
  req.on('close', () => {
    isClientClosed = true;
  });

  const sendEvent = (eventName, data) => {
    if (isClientClosed) return;
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const targetQuota = Math.min(parseInt(quota, 10) || 100, 5000);
  // Most businesses in open map data already have a website, so discovery must pull
  // far more candidates than the number of no-website leads requested.
  const discoveryQuota = Math.min(Math.max(targetQuota * 10, 200), 500);

  // The dashboard sends a state/region CODE (e.g. "GL", "NH", or "ALL"). Resolve it to
  // real place names, otherwise geocoding "GL, GL, United Kingdom" finds nothing.
  const targets = resolveSearchTargets(country, state, city);

  // Keep the connection alive during long verification steps.
  const heartbeat = setInterval(() => {
    if (!isClientClosed) res.write(': ping\n\n');
  }, 15000);
  req.on('close', () => clearInterval(heartbeat));

  sendEvent('log', { message: `🚀 Initializing extraction pipeline for ${industry} in ${targets.map(t => t.city).join(', ')}, ${country}...` });
  sendEvent('log', { message: `⚙️ Data Source: ${primarySource} | Verification Engine: ${verificationMethod}` });

  try {
    let confirmedNoWebsiteCount = 0;
    let noWebsiteSocialOnlyCount = 0;
    let hasWebsiteCount = 0;
    let uncertainCount = 0;
    let verifiedCount = 0;
    let hiddenNoPhoneCount = 0;
    let deliveredNoWebsiteCount = 0;
    let totalDiscovered = 0;
    let eligibleTotal = 0;
    const seenKeys = new Set();
    // Same business found again in a neighbouring city: match on phone, else name + street.
    const leadKey = (c) => cleanPhone(c.phone || '') || (String(c.name || '').toLowerCase().trim() + '|' + String(c.address || '').toLowerCase().slice(0, 30));
    const quotaReached = () => websiteFilter === 'no_website' && deliveredNoWebsiteCount >= targetQuota;
    const progressPayload = () => ({
      current: verifiedCount,
      total: eligibleTotal,
      percentage: websiteFilter === 'no_website'
        ? Math.min(100, (deliveredNoWebsiteCount / targetQuota) * 100)
        : Math.min(100, eligibleTotal ? (verifiedCount / eligibleTotal) * 100 : 0),
      confirmedNoWebsite: confirmedNoWebsiteCount,
      noWebsiteSocialOnly: noWebsiteSocialOnlyCount,
      hasWebsite: hasWebsiteCount,
      uncertain: uncertainCount
    });

    // 3-5. Discover and verify one city at a time, so leads appear quickly and the run
    // stops as soon as the quota is met.
    for (const target of targets) {
      if (isClientClosed || quotaReached()) break;
      const criteria = { country, state: target.state, city: target.city, industry, quota: discoveryQuota };
      sendEvent('log', { message: `🗺️ Searching ${industry} in ${target.city}${target.state ? ', ' + target.state : ''}...` });

      let found = await providerRegistry.fetchCandidates(
        primarySource,
        criteria,
        (prog) => {
          sendEvent('source_count', prog);
          sendEvent('log', { message: `📡 [${prog.source}] ${target.city}: found ${prog.count} real business candidates` });
        }
      );

      // Fallback if primary returned 0 and fallback is selected
      if ((!found || found.length === 0) && fallbackSource && providerRegistry.isValidProvider(fallbackSource)) {
        sendEvent('log', { message: `⚠️ Primary source returned 0 candidates for ${target.city}. Falling back to ${fallbackSource}...` });
        found = await providerRegistry.fetchCandidates(
          fallbackSource,
          criteria,
          (prog) => {
            sendEvent('source_count', prog);
            sendEvent('log', { message: `📡 [${prog.source} (Fallback)] ${target.city}: found ${prog.count} real business candidates` });
          }
        );
      }

      // 4. Deduplicate (also against earlier cities) & apply the real chain filter
      const fresh = dedupeLeads(found || []).filter(c => {
        const k = leadKey(c);
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
        return true;
      });
      totalDiscovered += fresh.length;
      if (fresh.length === 0) continue;

      let eligibleCandidates = fresh;
      if (excludeChains === 'true') {
        const { filteredLeads, chainExcludedCount } = applyRealChainFilter(fresh, 2);
        eligibleCandidates = filteredLeads;
        if (chainExcludedCount > 0) {
          sendEvent('log', { message: `🛡️ Local Chain Filter (${target.city}): Excluded ${chainExcludedCount} businesses with > 2 locations or on corporate blocklist.` });
        }
      }
      eligibleTotal += eligibleCandidates.length;
      sendEvent('log', { message: `🔍 Verifying websites for ${eligibleCandidates.length} businesses in ${target.city}...` });

    // 5. Verification Waterfall Loop
    for (const candidate of eligibleCandidates) {
      if (isClientClosed) break;
      if (quotaReached()) break;

      verifiedCount++;

      // Execute full 6-stage verification
      const verifyResult = await websiteVerifier.verifyLead(candidate, verificationMethod);

      // Variants such as "Uncertain (search blocked)" are all Uncertain for the dashboard,
      // tabs and exports; the specific reason stays in uncertainReason and the evidence.
      let uncertainReason = '';
      if (typeof verifyResult.websiteCheckStatus === 'string' && verifyResult.websiteCheckStatus.startsWith('Uncertain')) {
        const m = verifyResult.websiteCheckStatus.match(/\((.*)\)/);
        uncertainReason = m ? m[1] : '';
        verifyResult.websiteCheckStatus = 'Uncertain';
      }

      const enrichedLead = {
        id: candidate.placeId,
        placeId: candidate.placeId,
        name: candidate.name,
        businessName: candidate.name,
        ownerName: candidate.ownerName || '', // Only real registry data, blank otherwise
        address: candidate.address,
        city: candidate.city,
        state: candidate.state,
        country: candidate.country,
        phone: candidate.phone,
        hasPhone: Boolean(candidate.phone),
        category: candidate.category,
        industry: candidate.category,
        // Only a verified website goes in the Website column. A dead or rejected URL from the
        // map record (e.g. an expired domain) stays in the evidence text instead.
        website: verifyResult.websiteCheckStatus === 'Has website' ? (verifyResult.websiteUrl || candidate.website || '') : '',
        hasWebsite: verifyResult.websiteCheckStatus === 'Has website',
        websiteStatus: verifyResult.websiteCheckStatus === 'Has website' ? 'Working Website (Live)' : verifyResult.websiteCheckStatus,
        websiteCheckStatus: verifyResult.websiteCheckStatus,
        websiteEvidence: verifyResult.websiteEvidence,
        uncertainReason,
        socialProfile: verifyResult.socialProfile || candidate.socialProfile || '',
        sourceProvider: candidate.sourceProvider,
        source: candidate.sourceProvider,
        sourceUrl: candidate.sourceUrl,
        confidence: verifyResult.confidence || 'medium',
        checkedAt: verifyResult.checkedAt,
        lat: candidate.lat,
        lng: candidate.lng
      };

      if (verifyResult.websiteCheckStatus === 'Confirmed no website') {
        confirmedNoWebsiteCount++;
      } else if (verifyResult.websiteCheckStatus === 'No website found (social only, bio unread)') {
        noWebsiteSocialOnlyCount++;
      } else if (verifyResult.websiteCheckStatus === 'Has website') {
        hasWebsiteCount++;
      } else {
        uncertainCount++;
      }

      // Check contact filters
      if (includePhones === 'true' && !candidate.phone) {
        // Skip emitting if phone required and absent, but still report progress
        hiddenNoPhoneCount++;
        sendEvent('progress', progressPayload());
        continue;
      }

      // Determine emission based on websiteFilter
      let shouldEmit = false;
      if (websiteFilter === 'no_website') {
        shouldEmit = (verifyResult.websiteCheckStatus === 'Confirmed no website' || verifyResult.websiteCheckStatus === 'No website found (social only, bio unread)');
      } else if (websiteFilter === 'with_website') {
        shouldEmit = (verifyResult.websiteCheckStatus === 'Has website');
      } else {
        shouldEmit = true; // 'all'
      }

      // Always emit uncertain leads and social-only leads so UI can present them in their dedicated tabs
      if (verifyResult.websiteCheckStatus === 'Uncertain' || verifyResult.websiteCheckStatus === 'No website found (social only, bio unread)') {
        shouldEmit = true;
      }

      if (shouldEmit) {
        sendEvent('lead', enrichedLead);
        if (enrichedLead.websiteCheckStatus === 'Confirmed no website' || enrichedLead.websiteCheckStatus === 'No website found (social only, bio unread)') {
          deliveredNoWebsiteCount++;
        }
      }

      sendEvent('progress', progressPayload());
    }
    } // end per-city loop

    if (totalDiscovered === 0) {
      sendEvent('log', { message: `ℹ️ No candidate businesses discovered for ${industry} in ${targets.map(t => t.city).join(', ')}. Try another city or industry; open map data is thinner in some places.` });
    }

    if (hiddenNoPhoneCount > 0) {
      sendEvent('log', { message: `📵 ${hiddenNoPhoneCount} leads were hidden because they have no phone number ("Must Have Phone Number" is on).` });
    }

    sendEvent('log', {
      message: `✨ Extraction complete: ${verifiedCount} evaluated | ${confirmedNoWebsiteCount} Confirmed No Website | ${noWebsiteSocialOnlyCount} No Website (Social Only, Bio Unread) | ${hasWebsiteCount} Has Website | ${uncertainCount} Uncertain.`
    });

    sendEvent('complete', {
      totalFound: verifiedCount,
      confirmedNoWebsite: confirmedNoWebsiteCount,
      noWebsiteSocialOnly: noWebsiteSocialOnlyCount,
      hasWebsite: hasWebsiteCount,
      uncertain: uncertainCount
    });

    clearInterval(heartbeat);
    res.end();
  } catch (err) {
    console.error('[SSE Stream Error]', err);
    sendEvent('error', { message: `Pipeline error: ${err.message}` });
    clearInterval(heartbeat);
    res.end();
  }
});

// Start Server
app.listen(PORT, async () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Free Real-Data Lead Scraper Engine (Port ${PORT})`);
  console.log(`📡 Local Server: http://localhost:${PORT}`);
  console.log(`🛡️ 100% Free Data Sources & Multi-Layer Verifier Active`);
  console.log(`======================================================\n`);

  await searchBackendManager.initialize();
});
