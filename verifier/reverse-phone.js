/**
 * Reverse Phone Number Search
 * Searches for a business's phone number across non-directory websites.
 */

const { cleanPhone } = require('../utils/normalizer');
const { isBlockedDomain } = require('./blocklist');
const searchBackendManager = require('./search-backends');
const { inspectCandidateWebsite } = require('./content-matcher');

/**
 * Perform reverse phone search for a business
 * @param {string} phone 
 * @param {string} businessName 
 * @param {string} city 
 * @returns {Promise<{ found: boolean, url?: string, evidence: string, blocked?: boolean, reason?: string }>}
 */
async function searchByPhone(phone, businessName, city = '') {
  const digits = cleanPhone(phone);
  if (!digits || digits.length < 8) {
    return { found: false, evidence: 'Phone search: phone number absent or invalid' };
  }

  const query = `"${digits}"`;
  const searchResult = await searchBackendManager.search(query);

  if (searchResult.blocked) {
    return {
      found: false,
      blocked: true,
      reason: searchResult.reason,
      evidence: `Phone search: blocked by search engine (${searchResult.reason})`
    };
  }

  const organicResults = (searchResult.results || []).filter(r => !isBlockedDomain(r.url));

  for (const item of organicResults.slice(0, 3)) {
    const check = await inspectCandidateWebsite(item.url, businessName, city, phone);
    if (check.isMatch) {
      return {
        found: true,
        url: check.matchedUrl || item.url,
        evidence: `Phone search: phone ${digits} matched non-directory website '${item.url}' (${check.reason})`
      };
    }
  }

  return {
    found: false,
    evidence: `Phone search: ${organicResults.length} non-directory results tested, no business match`
  };
}

module.exports = {
  searchByPhone
};
