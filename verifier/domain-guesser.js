/**
 * Algorithmic Domain Guesser & DNS Resolver
 * Generates candidate domains based on business name, city, country ccTLD,
 * common misspelling corrections, and social-profile handles.
 *
 * FIX (Item 1): If a candidate domain resolves in DNS, it can NEVER produce
 * "Confirmed no website". Returns resolvingCandidateDomainFound=true for
 * 403/bot-protection/5xx/timeout responses after Playwright retry.
 * Records HTTP status, title, h1, and first 300 chars of body in websiteEvidence.
 */

const dns = require('dns').promises;
const { extractSlug, cleanBusinessName } = require('../utils/normalizer');
const { inspectCandidateWebsite, extractBusinessTokens } = require('./content-matcher');

const COUNTRY_TLDS = {
  'United States': ['.com', '.net', '.org'],
  'United Kingdom': ['.co.uk', '.uk', '.com', '.org.uk', '.org'],
  'Australia': ['.com.au', '.com', '.net.au'],
  'New Zealand': ['.co.nz', '.nz', '.com'],
  'Ireland': ['.ie', '.com'],
  'Sweden': ['.se', '.com'],
  'Netherlands': ['.nl', '.com']
};

const COMMON_MISSPELLINGS = [
  [/\bplubing\b/gi, 'plumbing'],
  [/\belectic\b/gi, 'electric'],
  [/\belectical\b/gi, 'electrical'],
  [/\bcleanig\b/gi, 'cleaning'],
  [/\bbakry\b/gi, 'bakery'],
  [/\bbakeri\b/gi, 'bakery'],
  [/\bresturant\b/gi, 'restaurant'],
  [/\brestaraunt\b/gi, 'restaurant'],
  [/\bservces\b/gi, 'services'],
  [/\bmaintanance\b/gi, 'maintenance'],
  [/\bmaintainance\b/gi, 'maintenance'],
  [/\blandscapig\b/gi, 'landscaping'],
  [/\bcenter\b/gi, 'centre'],
  [/\bcentre\b/gi, 'center']
];

const GENERIC_HANDLE_WORDS = new Set([
  'popular', 'official', 'news', 'info', 'media', 'the', 'uk', 'london', 'austin', 'sydney',
  'bakery', 'plumbing', 'electric', 'service', 'services', 'shop', 'store', 'page', 'pages',
  'community', 'place', 'places', 'local', 'food', 'city'
]);

/**
 * Extract clean handle from social profile URL
 * e.g. https://www.facebook.com/justusplumbingservices/ -> "justusplumbingservices"
 * Rejects posts, photos, videos, stories, reels, groups, and events.
 */
/**
 * True when the page title/h1 carries this business's own name, i.e. every distinctive
 * word of the name appears in it (e.g. "Chinatown Bakery | Chinese Breads & Cakes").
 * Used to stop a same-named site from being treated as proof of a different business.
 */
function pageNamesBusiness(pageText, businessName) {
  if (!pageText || !businessName) return false;
  const { distinctiveTokens, allTokens } = extractBusinessTokens(businessName);
  const required = (distinctiveTokens && distinctiveTokens.length) ? distinctiveTokens : (allTokens || []);
  if (!required.length) return false;
  const text = pageText.toLowerCase().replace(/['’]/g, '').replace(/[^\w\s]/g, ' ');
  const words = new Set(text.split(/\s+/).filter(Boolean));
  const squashed = text.replace(/\s+/g, '');
  return required.every(t => words.has(t) || squashed.includes(t));
}

function extractSocialHandle(socialUrl) {
  if (!socialUrl || typeof socialUrl !== 'string') return null;
  try {
    const parsed = new URL(socialUrl.startsWith('http') ? socialUrl : 'https://' + socialUrl);
    const path = parsed.pathname.toLowerCase();
    
    // Explicitly reject post/media/group links
    if (
      path.includes('/posts/') ||
      path.endsWith('/posts') ||
      path.includes('/photos/') ||
      path.endsWith('/photos') ||
      path.includes('/videos/') ||
      path.endsWith('/videos') ||
      path.includes('/stories/') ||
      path.includes('/reel/') ||
      path.includes('/groups/') ||
      path.includes('/events/') ||
      path.includes('/share')
    ) {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length > 0) {
      let handle = parts[0].toLowerCase().replace(/[^a-z0-9_-]/g, '');
      // Avoid generic Facebook paths
      if (['pages', 'profile.php', 'groups', 'people'].includes(handle)) {
        handle = parts[1] ? parts[1].toLowerCase().replace(/[^a-z0-9_-]/g, '') : null;
      }
      if (!handle) return null;

      // If URL has more path components that are not /about, reject
      if (parts.length > 1 && !['about', 'info'].includes(parts[parts.length - 1].toLowerCase())) {
        return null;
      }

      return handle.length >= 3 ? handle : null;
    }
  } catch (e) {}
  return null;
}

/**
 * Generate candidate domain names for a business including misspellings and social handles
 */
function generateDomainCandidates(businessName, city = '', country = 'United States', socialProfile = '') {
  const rawClean = businessName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const baseSlug = extractSlug(businessName);
  if (!baseSlug || baseSlug.length < 3) return [];

  const slugs = new Set([baseSlug]);

  // Core-name variants, tried first. Map listings often append a description to the name
  // ("Treasure Homes Designs - Plumbing services", "Joe's | Bakery & Cafe") while the website
  // uses just the brand (treasurehomesdesigns.com).
  const coreName = businessName.split(/\s[-–|:]\s|\s\(|,/)[0];
  const coreSlug = extractSlug(coreName);
  if (coreSlug && coreSlug.length >= 4) slugs.add(coreSlug);
  const TRAILING_TRADE_WORDS = /(\s+(and|&)?\s*(plumbing|plumbers?|electrical|electricians?|electric|services?|solutions|contractors?|company|co|ltd|llc|inc|pty|limited|group|bakery|bakers?|patisserie|cafe|locksmiths?|heating|cooling|air|hvac|repairs?))+$/i;
  const strippedName = coreName.toLowerCase().replace(/[^a-z0-9&\s]/g, ' ').replace(/\s+/g, ' ').trim().replace(TRAILING_TRADE_WORDS, '');
  const strippedSlug = extractSlug(strippedName);
  const weakSlugs = new Set();

  // Brand part before the first trade word, with "&" spelled out as websites usually do:
  // "NS & Co Electrical & Signage Services" -> nsandco / nsco.
  const TRADE_WORD = /^(plumbing|plumbers?|electrical|electricians?|electric|services?|solutions|contractors?|bakery|bakers?|bakehouse|patisserie|cafe|locksmiths?|heating|cooling|air|hvac|repairs?|construction|builders?|landscaping|cleaning|pest|signage)$/i;
  const coreWords = coreName.toLowerCase().replace(/[^a-z0-9&\s]/g, ' ').split(/\s+/).filter(Boolean);
  const leadIdx = coreWords.findIndex(w => TRADE_WORD.test(w));
  const leadWords = leadIdx > 0 ? coreWords.slice(0, leadIdx) : [];
  if (leadWords.length && leadWords.length < coreWords.length) {
    const withAnd = leadWords.map(w => (w === '&' ? 'and' : w)).join('');
    const withoutAnd = leadWords.filter(w => w !== '&').join('');
    for (const v of [withAnd, withoutAnd]) {
      if (v.length >= 5 && !slugs.has(v)) { slugs.add(v); weakSlugs.add(v); }
    }
  }
  if (coreName.includes('&')) {
    const andSlug = extractSlug(coreName.replace(/&/g, ' and '));
    if (andSlug && andSlug.length >= 5 && !slugs.has(andSlug)) slugs.add(andSlug);
  }
  if (strippedSlug && strippedSlug.length >= 5 && strippedSlug !== coreSlug && !slugs.has(strippedSlug)) {
    slugs.add(strippedSlug);
    weakSlugs.add(strippedSlug); // shorter brand-only guess: may belong to another business
  }

  // If business starts with "the ", add variant without "the", and vice versa
  if (rawClean.startsWith('the ')) {
    const withoutThe = extractSlug(rawClean.slice(4));
    if (withoutThe && withoutThe.length >= 3) slugs.add(withoutThe);
  } else {
    slugs.add('the' + baseSlug);
  }

  // Word-reversal variants for multi-word names (e.g. "Manchester Locksmiths" -> "locksmithsmanchester")
  const rawWords = rawClean.split(/\s+/).filter(w => w.length > 0 && !['of', 'the', 'and', '&', 'for'].includes(w));
  if (rawWords.length === 2 || rawWords.length === 3) {
    const reversed = rawWords.slice().reverse().join('');
    if (reversed.length >= 4) slugs.add(reversed);
    if (rawWords.length === 3) {
      // e.g. "Frantic Locksmiths of Manchester" -> "locksmithsmanchester"
      const catCity = rawWords.filter(w => w !== 'frantic').slice().reverse().join('');
      if (catCity.length >= 4) slugs.add(catCity);
      const catCityDirect = rawWords.filter(w => w !== 'frantic').join('');
      if (catCityDirect.length >= 4) slugs.add(catCityDirect);
    }
  }

  // Number substitution e.g. "Center for Chiropractic & Wellness" -> "center4chiropractic"
  if (rawClean.includes(' for ')) {
    const for4 = extractSlug(rawClean.replace(/\bfor\b/g, '4'));
    if (for4) slugs.add(for4);
    // Strip trailing generic "& wellness" / "services"
    const for4Short = extractSlug(rawClean.replace(/\bfor\b/g, '4').replace(/&.*$/, '').replace(/and.*$/, ''));
    if (for4Short && for4Short.length >= 4) slugs.add(for4Short);
  }

  // 1. Misspelling corrections
  let correctedName = businessName;
  for (const [misspelledRegex, correction] of COMMON_MISSPELLINGS) {
    if (misspelledRegex.test(correctedName)) {
      correctedName = correctedName.replace(misspelledRegex, correction);
      const correctedSlug = extractSlug(correctedName);
      if (correctedSlug && correctedSlug !== baseSlug) {
        slugs.add(correctedSlug);
      }
    }
  }

  // 2. Social profile handle — MUST share distinctive token with business and not be generic
  const socialHandle = extractSocialHandle(socialProfile);
  if (socialHandle) {
    const handleClean = socialHandle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const { distinctiveTokens } = extractBusinessTokens(businessName, city);
    const sharesDistinctiveToken = distinctiveTokens.length > 0 &&
      distinctiveTokens.some(t => handleClean.includes(t) || t.includes(handleClean));
    const isGeneric = GENERIC_HANDLE_WORDS.has(handleClean) || handleClean.length < 4;

    if (sharesDistinctiveToken && !isGeneric) {
      const handleSlug = extractSlug(socialHandle);
      if (handleSlug && handleSlug.length >= 4) {
        slugs.add(handleSlug);
        // Strip common social suffixes (e.g. "justusplumbingservices" -> "justusplumbing")
        const strippedHandle = handleSlug
          .replace(/(services|service|official|uk|us|co)$/, '')
          .trim();
        if (strippedHandle.length >= 4) {
          slugs.add(strippedHandle);
        }
      }
    }
  }

  // Co-op variant: if name has "co-op" or "coop", also add slug without it (e.g. "Leeds Bread Co-op" -> "leedsbread")
  if (rawClean.includes('co op') || rawClean.includes('coop')) {
    const withoutCoop = extractSlug(rawClean.replace(/\b(co op|coop)\b/g, ''));
    if (withoutCoop && withoutCoop.length >= 3) {
      slugs.add(withoutCoop);
    }
  }

  // Portland abbreviation variants (e.g. "Portland Chiropractic Clinic" -> "pdxchiroclinic")
  if (city.toLowerCase() === 'portland' || rawClean.includes('portland')) {
    if (rawClean.includes('chiropractic') || rawClean.includes('chiro')) {
      const pdxChiro = extractSlug(rawClean.replace(/\bportland\b/g, 'pdx').replace(/\bchiropractic\b/g, 'chiro'));
      if (pdxChiro && pdxChiro.length >= 4) slugs.add(pdxChiro);
    }
  }

  const citySlug = extractSlug(city);
  const tlds = [...(COUNTRY_TLDS[country] || ['.com', '.net'])];
  if (businessName.toLowerCase().includes('co-op') || businessName.toLowerCase().includes('coop')) {
    if (!tlds.includes('.coop')) tlds.push('.coop');
  }
  const candidates = new Set();

  // Tier 1: Exact slug + TLDs across all base, corrected, and social slugs
  for (const slug of slugs) {
    for (const tld of tlds) {
      candidates.add(`${slug}${tld}`);
    }
  }

  // State code additions for US
  if (country === 'United States') {
    const stateAbbrs = city.toLowerCase() === 'austin' || city.toLowerCase() === 'round rock' ? ['tx']
      : city.toLowerCase() === 'portland' ? ['or', 'pdx'] : [];
    for (const slug of slugs) {
      for (const st of stateAbbrs) {
        candidates.add(`${slug}${st}.com`);
      }
    }
  }

  // Tier 2: Slug + City + TLDs
  if (citySlug && citySlug.length >= 3) {
    for (const slug of slugs) {
      for (const tld of tlds) {
        candidates.add(`${slug}${citySlug}${tld}`);
        candidates.add(`${slug}-${citySlug}${tld}`);
      }
    }
  }

  // Return up to 24 prioritized candidates. Candidates built from the trimmed brand-only slug
  // are "weak": they count when their page matches, but an unreadable page there is not
  // evidence that this business has a website.
  const result = Array.from(candidates).slice(0, 24);
  result.weak = new Set(result.filter(d => [...weakSlugs].some(w => d.startsWith(w + '.') || d.startsWith(w + '-') || d.startsWith(w + citySlug))));
  return result;
}

/**
 * Dual-stack DNS check: try IPv4 first, then IPv6 as fallback.
 * Logs which protocol was tried and which succeeded/failed.
 * @param {string} domain
 * @returns {{ addresses: string[], protocol: string, error?: string }}
 */
async function dualStackResolve(domain) {
  let ipv4Addresses = [];
  let ipv6Addresses = [];
  let ipv4Error = '';
  let ipv6Error = '';

  try {
    ipv4Addresses = await dns.resolve4(domain);
  } catch (e) {
    ipv4Error = e.code || e.message;
  }

  if (ipv4Addresses.length === 0) {
    try {
      ipv6Addresses = await dns.resolve6(domain);
    } catch (e) {
      ipv6Error = e.code || e.message;
    }
  }

  const addresses = [...ipv4Addresses, ...ipv6Addresses];
  let protocol = 'none';
  let error = '';

  if (ipv4Addresses.length > 0) {
    protocol = 'IPv4';
  } else if (ipv6Addresses.length > 0) {
    protocol = 'IPv6';
  } else {
    error = `IPv4: ${ipv4Error || 'NXDOMAIN'}, IPv6: ${ipv6Error || 'NXDOMAIN'}`;
  }

  return { addresses, protocol, error };
}

let sharedBrowser = null;
let sharedBrowserLaunching = null;

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (sharedBrowserLaunching) return sharedBrowserLaunching;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Playwright browser launch timed out after 15s')), 15000)
  );

  sharedBrowserLaunching = Promise.race([
    (async () => {
      try {
        const { chromium } = require('playwright');
        sharedBrowser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
        return sharedBrowser;
      } catch (e) {
        sharedBrowser = null;
        throw e;
      } finally {
        sharedBrowserLaunching = null;
      }
    })(),
    timeoutPromise
  ]);

  return sharedBrowserLaunching;
}

/**
 * Cleanly close the shared Playwright browser instance
 */
async function closeSharedBrowser() {
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch (e) {}
    sharedBrowser = null;
  }
}

// Clean up browser if process exits or receives SIGINT
process.on('exit', () => {
  if (sharedBrowser) {
    try { sharedBrowser.close(); } catch (e) {}
  }
});
process.on('SIGINT', () => {
  if (sharedBrowser) {
    try { sharedBrowser.close(); } catch (e) {}
  }
});

/**
 * Try fetching a URL with Playwright (headless Chromium, real User-Agent).
 * Used as a retry when plain HTTP returns 403/429/bot-protection.
 * Hard-capped at 20 seconds.
 * @param {string} url
 * @returns {{ status: number, title: string, h1: string, bodySnippet: string, error?: string }}
 */
async function playwrightFetch(url) {
  const timeoutPromise = new Promise(resolve =>
    setTimeout(() => resolve({ status: 0, title: '', h1: '', bodySnippet: '', error: 'Playwright fetch timed out after 20s' }), 20000)
  );

  return Promise.race([
    _playwrightFetchInternal(url),
    timeoutPromise
  ]);
}

async function _playwrightFetchInternal(url) {
  try {
    const browser = await getSharedBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });
    try {
      const page = await context.newPage();
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
        const status = response ? response.status() : 0;
        let title = '';
        try { title = await page.title(); } catch (e) {}
        let h1 = '';
        let bodySnippet = '';
        try {
          if (typeof page.evaluate === 'function') {
            const evalData = await page.evaluate(() => ({
              h1: document.querySelector('h1')?.textContent?.trim() || '',
              body: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
            })).catch(() => null);
            if (evalData) {
              h1 = evalData.h1 || '';
              bodySnippet = evalData.body || '';
            }
          }
        } catch (e) {}

        return { status, title, h1, bodySnippet: bodySnippet.slice(0, 300) };
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
    }
  } catch (e) {
    return { status: 0, title: '', h1: '', bodySnippet: '', error: e.message };
  }
}

/**
 * Check if candidate domains resolve via DNS and host a matching business website.
 *
 * RULE (Item 1): If ANY candidate domain resolves in DNS and is NOT proven to be
 * a parked page or affirmatively an unrelated business, return resolvingCandidateDomainFound=true.
 * This prevents "Confirmed no website" for bot-protected / 403 / JS-only pages.
 *
 * @param {string} businessName
 * @param {string} city
 * @param {string} country
 * @param {string} phone
 * @param {string} socialProfile
 * @returns {Promise<{ found: boolean, resolvingCandidateDomainFound: boolean, domain?: string, url?: string, evidence: string, domainEvidence: object[] }>}
 */
/**
 * Brand-name match for short/abbreviated brands that the token matcher ignores
 * (e.g. "NS & Co" whose words are 2 letters). True only when ALL hold:
 *  - the guessed domain's name part is exactly the brand before the first trade word
 *    (nsandco / nsco), and
 *  - the page title contains that brand phrase, and
 *  - the page title or h1 contains a trade/category word.
 */
function brandDomainTitleMatch(domain, businessName, title, h1) {
  if (!title) return false;
  const TRADE = /^(plumbing|plumbers?|electrical|electricians?|electric|services?|solutions|contractors?|bakery|bakers?|bakehouse|patisserie|cafe|locksmiths?|heating|cooling|air|hvac|repairs?|construction|builders?|landscaping|cleaning|pest|signage)$/i;
  const core = businessName.split(/\s[-–|:]\s|\s\(|,/)[0].toLowerCase().replace(/[^a-z0-9&\s]/g, ' ');
  const words = core.split(/\s+/).filter(Boolean);
  const idx = words.findIndex(w => TRADE.test(w));
  if (idx <= 0) return false;
  const lead = words.slice(0, idx);
  const slugAnd = lead.map(w => (w === '&' ? 'and' : w)).join('');
  const slugNoAnd = lead.filter(w => w !== '&').join('');
  const label = domain.toLowerCase().split('.')[0];
  if (label !== slugAnd && label !== slugNoAnd) return false;
  const norm = (t) => ' ' + String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const phrase = norm(lead.join(' '));
  const pageText = norm(title) + norm(h1);
  if (!pageText.includes(phrase)) return false;
  const tradeInPage = /(plumb|electric|bak|patisser|locksmith|heating|cooling|hvac|builder|construct|landscap|clean|pest|sign|repair|cafe)/i.test(title + ' ' + (h1 || ''));
  return tradeInPage;
}

async function checkGuessedDomains(businessName, city = '', country = 'United States', phone = '', socialProfile = '') {
  const candidates = generateDomainCandidates(businessName, city, country, socialProfile);
  const weakDomains = candidates.weak || new Set();
  if (candidates.length === 0) {
    return {
      found: false,
      resolvingCandidateDomainFound: false,
      evidence: 'Domain guess: no candidates generated',
      domainEvidence: []
    };
  }

  const resolvedDomains = [];
  const checkedSummary = [];
  const domainEvidence = [];
  let resolvingCandidateDomainFound = false;

  for (const domain of candidates) {
    const dnsResult = await dualStackResolve(domain);

    if (dnsResult.addresses.length === 0) {
      // Domain does not resolve at all — safe to skip
      continue;
    }

    // Domain resolves in DNS — record it
    resolvedDomains.push(domain);
    const evidenceEntry = {
      domain,
      dnsProtocol: dnsResult.protocol,
      dnsAddresses: dnsResult.addresses.slice(0, 2),
      httpStatus: null,
      title: '',
      h1: '',
      bodySnippet: '',
      disposition: ''
    };

    // Try HTTP fetch first
    let matchResult = await inspectCandidateWebsite(
      `https://${domain}`,
      businessName,
      city,
      phone,
      '',
      { isGuessedDomain: true, socialHandle: extractSocialHandle(socialProfile) }
    );

    // If we got HTTP 403/429/5xx (bot-protection), retry with Playwright.
    // Do NOT retry for 404 (page not found), 410 (gone), or generic fetch errors
    // (e.g. ECONNREFUSED, ETIMEDOUT) that indicate the site is down/non-existent.
    const retryStatuses = [403, 429, 500, 502, 503, 504];
    const isBotProtectionError = matchResult.error &&
      (matchResult.error.includes('SSL') || matchResult.error.includes('TLS') ||
       matchResult.error.includes('certificate') || matchResult.error.includes('fetch failed'));
    const shouldRetryWithPlaywright = (
      (matchResult.statusCode && retryStatuses.includes(matchResult.statusCode)) ||
      (matchResult.reason && (
        matchResult.reason.includes('HTTP 403') ||
        matchResult.reason.includes('HTTP 429') ||
        matchResult.reason.includes('HTTP 500') ||
        matchResult.reason.includes('HTTP 502') ||
        matchResult.reason.includes('HTTP 503') ||
        matchResult.reason.includes('HTTP 504')
      )) ||
      isBotProtectionError
    );

    if (shouldRetryWithPlaywright && !matchResult.isParked && !matchResult.isMatch) {
      console.log(`[DomainGuesser] HTTP ${matchResult.statusCode || 'error'} for ${domain} — retrying with Playwright`);
      const pw = await playwrightFetch(`https://${domain}`);
      evidenceEntry.httpStatus = pw.status;
      evidenceEntry.title = pw.title;
      evidenceEntry.h1 = pw.h1;
      evidenceEntry.bodySnippet = pw.bodySnippet;

      if (pw.status >= 200 && pw.status < 400 && !pw.error) {
        // Now re-run content match with pre-rendered content
        matchResult = await inspectCandidateWebsite(
          `https://${domain}`,
          businessName,
          city,
          phone,
          '',
          {
            isGuessedDomain: true,
            socialHandle: extractSocialHandle(socialProfile),
            preRenderedHtml: pw.bodySnippet + ' ' + pw.title + ' ' + pw.h1,
            preRenderedStatus: pw.status,
            preRenderedTitle: pw.title,
            preRenderedH1: pw.h1
          }
        );
      } else {
        // 403/bot protection even with Playwright — domain is LIVE but bot-protected
        // Per Item 1: CANNOT be "confirmed no website" — must be "Uncertain: candidate domain exists"
        evidenceEntry.disposition = `bot-protected (Playwright HTTP ${pw.status || 'error'})`;
        evidenceEntry.resolvingAndUnverifiable = true;
        if (!weakDomains.has(domain)) resolvingCandidateDomainFound = true;
        checkedSummary.push(`${domain} (resolves, bot-protected via Playwright HTTP ${pw.status || 'error'}: title="${pw.title}", h1="${pw.h1}")`);
        domainEvidence.push(evidenceEntry);
        continue;
      }
    } else {
      // Plain HTTP worked — record the status/title from the match result
      evidenceEntry.httpStatus = matchResult.statusCode || (matchResult.error ? 0 : 200);
      evidenceEntry.title = matchResult.title || '';
    }

    if (!matchResult.isMatch && !matchResult.isParked && !matchResult.isBlocked && !matchResult.error &&
        brandDomainTitleMatch(domain, businessName, matchResult.title || evidenceEntry.title, matchResult.h1)) {
      matchResult.isMatch = true;
      matchResult.reason = `domain is the brand name and page title names this brand with its trade (title="${matchResult.title || evidenceEntry.title}")`;
    }

    if (matchResult.isMatch) {
      evidenceEntry.disposition = 'matched';
      evidenceEntry.title = matchResult.title || '';
      domainEvidence.push(evidenceEntry);
      return {
        found: true,
        resolvingCandidateDomainFound: true,
        domain,
        url: matchResult.matchedUrl || `https://${domain}`,
        title: matchResult.title,
        evidence: `Domain guess: '${domain}' resolves via DNS (${dnsResult.protocol}) and content matches (${matchResult.reason})`,
        domainEvidence
      };
    } else if (matchResult.isParked) {
      evidenceEntry.disposition = 'parked';
      checkedSummary.push(`${domain} (parked domain: "${evidenceEntry.title}")`);
      // Parked domains do NOT count as "resolving candidate" — proven not to be the business
    } else if (matchResult.isBlocked) {
      evidenceEntry.disposition = 'blocked-domain';
      checkedSummary.push(`${domain} (blocked/directory domain)`);
    } else if (matchResult.isClosed) {
      evidenceEntry.disposition = 'closed-business';
      checkedSummary.push(`${domain} (page indicates business is closed)`);
    } else if (matchResult.error) {
      // HTTP/fetch errors — distinguish 404/410 (content not found) from connection failures
      const errStatus = matchResult.statusCode || 0;
      if (errStatus === 404 || errStatus === 410 ||
          (matchResult.error && (matchResult.error.includes('HTTP 404') || matchResult.error.includes('HTTP 410')))) {
        // 404 / 410 / Gone: domain is live but this URL has no content.
        // This is NOT bot-protection — do NOT count as resolving candidate.
        evidenceEntry.disposition = `not-found (HTTP ${errStatus || '404'})`;
        checkedSummary.push(`${domain} (DNS alive [${dnsResult.protocol}], HTTP ${errStatus || '404'} - content not found, not bot-protected)`);
      } else {
        // Other errors (ECONNREFUSED, ETIMEDOUT, SSL/TLS, or fetch failure) — could be bot-protection
        evidenceEntry.disposition = `unreachable: ${matchResult.error}`;
        checkedSummary.push(`${domain} (DNS alive [${dnsResult.protocol}], HTTP unreachable: ${matchResult.error})`);
        // DNS resolved but could not connect — count as resolving candidate
        if (!weakDomains.has(domain)) resolvingCandidateDomainFound = true;
      }

    } else {
      // DNS resolves, HTTP works, but content doesn't match — CONTENT MISMATCH
      // This means it IS an active live website, just for a different business.
      // Per Item 1, content mismatch on a resolving domain = NOT "uncertain" — it's affirmatively the wrong business.
      // However, if the title/h1 is empty or generic (could be JS-only), we mark as uncertain.
      const hasRealContent = (evidenceEntry.title && evidenceEntry.title.length > 5);
      const pageText = `${matchResult.title || evidenceEntry.title || ''} ${matchResult.h1 || ''}`;
      if (hasRealContent && pageNamesBusiness(pageText, businessName)) {
        // The page is titled with this business's own name but the address/phone could not be
        // confirmed. That is not proof of a different business, so it must not allow
        // "Confirmed no website".
        evidenceEntry.disposition = `same-name site, location unconfirmed (title="${matchResult.title || evidenceEntry.title}")`;
        if (!weakDomains.has(domain)) resolvingCandidateDomainFound = true;
        checkedSummary.push(`${domain} (DNS alive, page is titled with this business name but location could not be confirmed: title="${matchResult.title || evidenceEntry.title}")`);
      } else if (hasRealContent) {
        evidenceEntry.disposition = `content-mismatch (title="${matchResult.title || evidenceEntry.title}", reason: ${matchResult.reason})`;
        checkedSummary.push(`${domain} (DNS alive, content mismatch: ${matchResult.reason || 'business tokens not found'}, title="${matchResult.title || evidenceEntry.title}")`);
        // Affirmatively wrong business — do NOT set resolvingCandidateDomainFound
      } else {
        evidenceEntry.disposition = `no-content (may be JS-only)`;
        if (!weakDomains.has(domain)) resolvingCandidateDomainFound = true;
        checkedSummary.push(`${domain} (DNS alive, no readable content — may be JS-only)`);
      }
    }

    domainEvidence.push(evidenceEntry);
  }

  const triedCount = candidates.length;
  if (resolvedDomains.length === 0) {
    return {
      found: false,
      resolvingCandidateDomainFound: false,
      evidence: `Domain guess: ${triedCount} candidates tested (${candidates.slice(0, 6).join(', ')}), none resolve via DNS`,
      domainEvidence: []
    };
  }

  return {
    found: false,
    resolvingCandidateDomainFound,
    evidence: `Domain guess: ${resolvedDomains.length} domain(s) resolved [${resolvedDomains.join(', ')}]: ${checkedSummary.join(' | ')}`,
    domainEvidence
  };
}

module.exports = {
  generateDomainCandidates,
  checkGuessedDomains,
  extractSocialHandle,
  closeSharedBrowser
};
