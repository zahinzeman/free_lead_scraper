/**
 * Social Profile & Bio Link Inspector
 * Inspects discovered social profiles (Facebook, Instagram, LinkedIn, Linktree).
 * Tests multiple public variants for Facebook (www, mbasic, m., /about).
 * Actively searches for Facebook profiles when none were previously identified.
 * Logs what each fetch returned and identifies unreadable bios (HTTP 400, login walls, consent walls).
 */

const cheerio = require('cheerio');
const rateLimiter = require('../utils/rate-limiter');
const { isBlockedDomain } = require('./blocklist');
const { inspectCandidateWebsite, extractBusinessTokens } = require('./content-matcher');
const searchBackendManager = require('./search-backends');

const LOGIN_WALL_PATTERNS = [
  /login\.php/i,
  /\/accounts\/login/i,
  /id=["']login_form["']/i,
  /Log In or Sign Up/i,
  /Log in to Facebook/i,
  /You must log in to continue/i,
  /checkpoint\/?/i
];

const CONSENT_WALL_PATTERNS = [
  /consent\.facebook\.com/i,
  /cookie_consent/i,
  /Allow essential and optional cookies/i,
  /Before you continue to Facebook/i,
  /Accept all cookies/i
];

/**
 * Test if fetched response or HTML indicates login or consent wall
 */
function detectSocialWall(resUrl, html) {
  for (const p of LOGIN_WALL_PATTERNS) {
    if (p.test(resUrl) || p.test(html)) {
      return { isWall: true, wallType: 'login wall' };
    }
  }
  for (const p of CONSENT_WALL_PATTERNS) {
    if (p.test(resUrl) || p.test(html)) {
      return { isWall: true, wallType: 'consent wall' };
    }
  }
  return { isWall: false };
}

/**
 * Generate public variants for Facebook URLs (www, mbasic, m., /about)
 * @param {string} rawUrl 
 * @returns {Array<string>}
 */
function generateFacebookVariants(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return [];
  const cleanUrl = rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl;

  try {
    const parsed = new URL(cleanUrl);
    if (!parsed.hostname.includes('facebook.com')) {
      return [cleanUrl];
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return [cleanUrl];

    const handle = segments[0];
    if (['pages', 'profile.php', 'groups', 'people', 'share.php', 'login', 'sharer'].includes(handle)) {
      return [cleanUrl];
    }

    return [
      `https://www.facebook.com/${handle}/`,
      `https://www.facebook.com/${handle}/about/`,
      `https://mbasic.facebook.com/${handle}/`,
      `https://mbasic.facebook.com/${handle}/about/`,
      `https://m.facebook.com/${handle}/`
    ];
  } catch (e) {
    return [cleanUrl];
  }
}

/**
 * Search specifically for Facebook profile if none was found initially
 * @param {string} businessName 
 * @param {string} city 
 * @returns {Promise<string|null>}
 */
/**
 * Does a social page belong to this business? The handle must carry the leading brand
 * word (4+ letters) or every distinctive name word; failing that, the result title must
 * contain every distinctive word.
 */
function socialNameMatches(handleText, title, businessName) {
  const { distinctiveTokens } = extractBusinessTokens(businessName);
  if (!distinctiveTokens || distinctiveTokens.length === 0) return false;
  const handle = String(handleText || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const inHandle = (t) => handle.includes(t) || (t.length > 4 && t.endsWith('s') && handle.includes(t.slice(0, -1)));
  const lead = distinctiveTokens[0];
  if (handle && ((lead.length >= 4 && inHandle(lead)) || distinctiveTokens.every(inHandle))) return true;
  const t = String(title || '').toLowerCase().replace(/['’]/g, '');
  return distinctiveTokens.every(tok => t.includes(tok));
}

async function searchFacebookProfile(businessName, city) {
  try {
    const query = `"${businessName}" "${city}" facebook`.trim();
    const searchRes = await searchBackendManager.search(query);
    if (!searchRes || !searchRes.results || searchRes.results.length === 0) {
      return null;
    }

    for (const item of searchRes.results.slice(0, 5)) {
      const url = item.url || '';
      if (url.includes('facebook.com/')) {
        try {
          const parsed = new URL(url);
          const segments = parsed.pathname.split('/').filter(Boolean);
          if (segments.length > 0) {
            const h = segments[0].toLowerCase();
            if (!['login', 'sharer', 'help', 'recover', 'events', 'places', 'watch', 'people', 'groups', 'p'].includes(h) || h === 'p' || h === 'people') {
              // Only accept a page that is recognisably this business: its handle (or, for
              // /p/ and /people/ URLs, the result title) must carry the business's name.
              const handleText = (h === 'p' || h === 'people') ? (segments[1] || '') : h;
              if (socialNameMatches(handleText, item.title || '', businessName)) {
                return url;
              }
            }
          }
        } catch (e) {}
      }
    }
  } catch (err) {}
  return null;
}

/**
 * Inspect social profile URLs to discover external website links in bio/about
 * @param {Array<string>} profileUrls 
 * @param {string} businessName 
 * @param {string} city 
 * @param {string} phone 
 * @returns {Promise<{ foundWebsite: boolean, bioUnread?: boolean, bioUnreadReason?: string, isUncertain?: boolean, uncertainReason?: string, websiteUrl?: string, primarySocialProfile?: string, evidence: string }>}
 */
async function inspectSocialProfiles(profileUrls = [], businessName = '', city = '', phone = '') {
  let activeProfiles = Array.isArray(profileUrls) ? [...profileUrls] : [];
  let searchedForSocial = false;

  // If no social profile discovered so far, actively query search engine for Facebook page
  if (activeProfiles.length === 0 && businessName) {
    searchedForSocial = true;
    const discoveredFb = await searchFacebookProfile(businessName, city);
    if (discoveredFb) {
      activeProfiles.push(discoveredFb);
    }
  }

  if (activeProfiles.length === 0) {
    return {
      foundWebsite: false,
      bioUnread: false,
      isUncertain: false,
      primarySocialProfile: '',
      evidence: searchedForSocial 
        ? `Social check: searched '${businessName} ${city} facebook', no profile found`
        : 'Social check: no public social profiles identified'
    };
  }

  const primarySocialProfile = activeProfiles[0];
  const discoveredWebsites = [];
  const fetchLogs = [];
  let readableBioFound = false;

  // Test primary profile and variants
  const variantsToTest = generateFacebookVariants(primarySocialProfile);

  for (const targetUrl of variantsToTest) {
    try {
      const parsed = new URL(targetUrl);
      const label = `${parsed.hostname}${parsed.pathname}`;

      const res = await rateLimiter.politeFetch(targetUrl, {
        method: 'GET',
        timeoutMs: 5000,
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
      }, 1);

      fetchLogs.push(`${label} -> HTTP ${res.status}`);

      if (!res.ok) {
        continue;
      }

      const resUrl = res.url || targetUrl;
      const html = await res.text();

      // Check for login wall or consent wall
      const wallCheck = detectSocialWall(resUrl, html);
      if (wallCheck.isWall) {
        fetchLogs[fetchLogs.length - 1] += ` (${wallCheck.wallType})`;
        continue;
      }

      const $ = cheerio.load(html);

      // Check if bio or meta description has readable content
      const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
      const bodyText = $('body').text().trim();

      if (metaDesc.length > 25 && !metaDesc.includes('Log In') && !metaDesc.includes('Sign Up')) {
        readableBioFound = true;
      } else if (bodyText.length > 200 && !bodyText.includes('Log In to Facebook')) {
        readableBioFound = true;
      }

      // Extract all external links
      $('a[href]').each((_, el) => {
        let href = $(el).attr('href');
        if (!href) return;

        // Decode URL if Facebook/Instagram redirect (e.g. l.facebook.com/l.php?u=...)
        if (href.includes('l.facebook.com/l.php') || href.includes('l.instagram.com/')) {
          try {
            const parsedRedirect = new URL(href.startsWith('http') ? href : 'https://' + href);
            const u = parsedRedirect.searchParams.get('u');
            if (u) href = decodeURIComponent(u);
          } catch (e) {}
        }

        if (href.startsWith('http://') || href.startsWith('https://')) {
          if (!isBlockedDomain(href)) {
            discoveredWebsites.push(href);
          }
        }
      });

      // If we got readable content, no need to exhaust all remaining mobile variants
      if (readableBioFound) break;
    } catch (err) {
      try {
        const parsed = new URL(targetUrl);
        fetchLogs.push(`${parsed.hostname}${parsed.pathname} -> ${err.message}`);
      } catch (e) {
        fetchLogs.push(`${targetUrl} -> ${err.message}`);
      }
    }
  }

  // Test any candidate website discovered in social bio
  for (const candidateWebsite of discoveredWebsites.slice(0, 3)) {
    const match = await inspectCandidateWebsite(candidateWebsite, businessName, city, phone);
    if (match.isMatch) {
      return {
        foundWebsite: true,
        bioUnread: false,
        isUncertain: false,
        websiteUrl: match.matchedUrl || candidateWebsite,
        primarySocialProfile,
        evidence: `Social check: found valid website link in social bio '${candidateWebsite}' (${match.reason})`
      };
    }
  }

  // If bio was unreadable across all variants (HTTP 400, login wall, or consent wall)
  if (!readableBioFound) {
    const unreadReason = `Bio unreadable across variants (${fetchLogs.join('; ')})`;
    return {
      foundWebsite: false,
      bioUnread: true,
      bioUnreadReason: unreadReason,
      isUncertain: true, // For backwards compatibility
      uncertainReason: unreadReason,
      primarySocialProfile,
      evidence: `Social check: profile saved (${primarySocialProfile}); ${unreadReason}`
    };
  }

  return {
    foundWebsite: false,
    bioUnread: false,
    isUncertain: false,
    primarySocialProfile,
    evidence: `Social check: profile saved (${primarySocialProfile}); public bio read successfully (no external website linked; ${fetchLogs.slice(0, 2).join('; ')})`
  };
}

module.exports = {
  inspectSocialProfiles,
  detectSocialWall,
  generateFacebookVariants,
  searchFacebookProfile
};
