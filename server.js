require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const dns = require('dns');
const { promisify } = require('util');
const dnsLookup = promisify(dns.lookup);

const providerRegistry = require('./providers/registry');
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
  const criteria = {
    country,
    state,
    city: city || state,
    industry,
    quota: targetQuota
  };

  sendEvent('log', { message: `🚀 Initializing extraction pipeline for ${industry} in ${city || state}, ${country}...` });
  sendEvent('log', { message: `⚙️ Data Source: ${primarySource} | Verification Engine: ${verificationMethod}` });

  try {
    // 3. Fetch candidates from Primary Provider
    const sourceCandidates = await providerRegistry.fetchCandidates(
      primarySource,
      criteria,
      (prog) => {
        sendEvent('source_count', prog);
        sendEvent('log', { message: `📡 [${prog.source}] Found ${prog.count} real business candidates` });
      }
    );

    let candidates = sourceCandidates || [];

    // Fallback if primary returned 0 and fallback is selected
    if (candidates.length === 0 && fallbackSource && providerRegistry.isValidProvider(fallbackSource)) {
      sendEvent('log', { message: `⚠️ Primary source returned 0 candidates. Falling back to ${fallbackSource}...` });
      candidates = await providerRegistry.fetchCandidates(
        fallbackSource,
        criteria,
        (prog) => {
          sendEvent('source_count', prog);
          sendEvent('log', { message: `📡 [${prog.source} (Fallback)] Found ${prog.count} real business candidates` });
        }
      );
    }

    if (candidates.length === 0) {
      sendEvent('log', { message: `ℹ️ No candidate businesses discovered for current search criteria. Real datasets return fewer results when coverage is sparse.` });
      sendEvent('complete', { totalFound: 0, confirmedNoWebsite: 0, hasWebsite: 0, uncertain: 0 });
      return res.end();
    }

    // 4. Apply Deduplication & Real Chain Filter
    const dedupedCandidates = dedupeLeads(candidates);
    let eligibleCandidates = dedupedCandidates;

    if (excludeChains === 'true') {
      const { filteredLeads, chainExcludedCount } = applyRealChainFilter(dedupedCandidates, 2);
      eligibleCandidates = filteredLeads;
      if (chainExcludedCount > 0) {
        sendEvent('log', { message: `🛡️ Local Chain Filter: Excluded ${chainExcludedCount} businesses with > 2 locations or on corporate blocklist.` });
      }
    }

    sendEvent('log', { message: `🔍 Beginning multi-layer website verification on ${eligibleCandidates.length} real candidates (Quota cap: ${targetQuota})...` });

    let confirmedNoWebsiteCount = 0;
    let noWebsiteSocialOnlyCount = 0;
    let hasWebsiteCount = 0;
    let uncertainCount = 0;
    let verifiedCount = 0;

    // 5. Verification Waterfall Loop
    for (const candidate of eligibleCandidates) {
      if (isClientClosed) break;
      if (confirmedNoWebsiteCount >= targetQuota && websiteFilter === 'no_website') break;

      verifiedCount++;

      // Execute full 6-stage verification
      const verifyResult = await websiteVerifier.verifyLead(candidate, verificationMethod);

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
        website: verifyResult.websiteUrl || candidate.website || '',
        hasWebsite: verifyResult.websiteCheckStatus === 'Has website',
        websiteStatus: verifyResult.websiteCheckStatus === 'Has website' ? 'Working Website (Live)' : verifyResult.websiteCheckStatus,
        websiteCheckStatus: verifyResult.websiteCheckStatus,
        websiteEvidence: verifyResult.websiteEvidence,
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
        // Skip emitting if phone required and absent
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
      }

      sendEvent('progress', {
        current: verifiedCount,
        total: eligibleCandidates.length,
        percentage: Math.min(100, (verifiedCount / eligibleCandidates.length) * 100),
        confirmedNoWebsite: confirmedNoWebsiteCount,
        noWebsiteSocialOnly: noWebsiteSocialOnlyCount,
        hasWebsite: hasWebsiteCount,
        uncertain: uncertainCount
      });
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

    res.end();
  } catch (err) {
    console.error('[SSE Stream Error]', err);
    sendEvent('error', { message: `Pipeline error: ${err.message}` });
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
