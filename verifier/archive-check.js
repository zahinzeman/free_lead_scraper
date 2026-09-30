/**
 * Archive & CDX Index Verifier
 * Checks Wayback Machine CDX API as EVIDENCE ONLY.
 * Rule: Never by itself produces "Has website" or "Confirmed no website".
 * If live fetch fails but archive shows history, forces "Uncertain".
 */

const rateLimiter = require('../utils/rate-limiter');
const DiskCache = require('../utils/cache');
const { generateDomainCandidates } = require('./domain-guesser');
const { inspectCandidateWebsite } = require('./content-matcher');

/**
 * Check Wayback Machine CDX API for candidate domains
 * @param {string} businessName 
 * @param {string} city 
 * @param {string} country 
 * @param {string} phone 
 * @returns {Promise<{ hasArchiveHistory: boolean, foundLive: boolean, url?: string, evidence: string, forceUncertain?: boolean }>}
 */
async function checkArchiveHistory(businessName, city = '', country = 'United States', phone = '') {
  const candidates = generateDomainCandidates(businessName, city, country).slice(0, 3);
  if (candidates.length === 0) {
    return { hasArchiveHistory: false, foundLive: false, evidence: 'Archive check: no domains tested' };
  }

  for (const domain of candidates) {
    const cacheKey = `cdx:${domain}`;
    let cdxData = DiskCache.get('archive_cache', cacheKey);

    if (!cdxData) {
      try {
        const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}/*&output=json&limit=3&fl=timestamp,original,statuscode`;
        const res = await rateLimiter.politeFetch(cdxUrl, { timeoutMs: 5000 }, 1);
        if (res.ok) {
          const json = await res.json();
          // CDX returns array of arrays, header row first: [["timestamp","original","statuscode"], ...]
          cdxData = Array.isArray(json) && json.length > 1 ? json.slice(1) : [];
          DiskCache.set('archive_cache', cacheKey, cdxData, 30 * 24 * 60 * 60 * 1000);
        } else {
          cdxData = [];
        }
      } catch (err) {
        cdxData = [];
      }
    }

    if (cdxData && cdxData.length > 0) {
      // Archive history exists for this domain! Now perform live check as required
      const liveCheck = await inspectCandidateWebsite(`https://${domain}`, businessName, city, phone);
      if (liveCheck.isMatch) {
        return {
          hasArchiveHistory: true,
          foundLive: true,
          url: liveCheck.matchedUrl || `https://${domain}`,
          evidence: `Wayback CDX: Domain '${domain}' has historical archives AND live site verified (${liveCheck.reason})`
        };
      } else {
        // Archive shows history, but live site failed -> force "Uncertain"
        return {
          hasArchiveHistory: true,
          foundLive: false,
          forceUncertain: true,
          evidence: `Wayback CDX: Historical crawl snapshots found for '${domain}', but live site is currently unreachable or changed (marking Uncertain)`
        };
      }
    }
  }

  return {
    hasArchiveHistory: false,
    foundLive: false,
    evidence: `Wayback CDX: No historical snapshots found for ${candidates.join(', ')}`
  };
}

module.exports = {
  checkArchiveHistory
};
