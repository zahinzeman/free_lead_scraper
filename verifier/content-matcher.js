/**
 * Content Matcher & Parked Domain Detector
 * Analyzes fetched HTML pages to verify whether a candidate website truly belongs to a business.
 * Token-based matching replacing raw substring containment, requiring second signals for generic names.
 */

const cheerio = require('cheerio');
const rateLimiter = require('../utils/rate-limiter');
const { cleanBusinessName, extractSlug, cleanPhone } = require('../utils/normalizer');

const { isBlockedDomain } = require('./blocklist');

const PARKING_SIGNATURES = [
  'this domain is for sale',
  'buy this domain',
  'domain is available for sale',
  'domain for sale',
  'for sale | spaceship.com',
  'spaceship.com',
  'dan.com',
  'sedo parking',
  'sedo.com',
  'godaddy domain parking',
  'namecheap parking',
  'hugedomains',
  'afternic.com',
  'parked free, courtesy of',
  'domain parked by',
  'parked domain',
  'domain may be for sale',
  'inquire about this domain',
  'lease to own',
  'listed with spaceship.com',
  'renew your domain',
  'account has been suspended',
  'this domain name is available to purchase',
  'domain name is available to purchase',
  'available to purchase',
  'webber.domains',
  'for sale!'
];

const STOP_WORDS = new Set([
  'the', 'and', '&', 'ltd', 'limited', 'llc', 'inc', 'incorporated', 'corp', 'corporation',
  'pty', 'co', 'company', 'services', 'service', 'uk', 'us', 'usa', 'group', 'solutions', 'of'
]);

const GENERIC_CATEGORY_WORDS = new Set([
  'bakery', 'bakeries', 'bake', 'bakers', 'bakeshop', 'patisserie', 'pastry', 'pastries',
  'bread', 'breads', 'cake', 'cakes',
  'plumber', 'plumbers', 'plumbing', 'heating', 'hvac', 'air', 'conditioning', 'cooling',
  'electrician', 'electricians', 'electrical',
  'landscaper', 'landscapers', 'landscaping', 'gardener', 'gardeners', 'gardening', 'lawn',
  'cleaner', 'cleaners', 'cleaning',
  'handyman', 'carpenter', 'carpentry', 'locksmith', 'locksmiths',
  'accountant', 'accountants', 'accounting', 'tax',
  'agent', 'agents', 'agency', 'realty', 'realestate',
  'architect', 'architects', 'architectural',
  'massage', 'therapist', 'therapists', 'therapy', 'spa',
  'chiropractor', 'chiropractors', 'chiropractic',
  'physio', 'physiotherapist', 'physiotherapy',
  'dentist', 'dentists', 'dental', 'clinic', 'clinics', 'medical', 'doctor', 'doctors',
  'repair', 'repairs', 'auto', 'garage', 'mechanic', 'mechanics', 'motors', 'brakes',
  'detail', 'detailing', 'carwash', 'wash',
  'event', 'events', 'planner', 'planners', 'planning', 'wedding', 'weddings',
  'interior', 'design', 'designer', 'designers',
  'shop', 'shops', 'store', 'stores', 'cafe', 'restaurant', 'bar', 'food',
  // Shop types that describe the business rather than name it
  'deli', 'delicatessen', 'catering', 'caterers', 'coffee', 'espresso', 'kitchen', 'bakehouse',
  'confectionery', 'confectioner', 'chocolatier', 'boulangerie', 'bakkerij', 'bageri', 'konditori',
  'electric', 'electrics', 'services', 'service', 'contractor', 'contractors', 'solutions'
]);

const DIRECTORY_TITLE_PATTERNS = [
  /\bdirectory\b/i,
  /\bnear me\b/i,
  /\bbest .* near me\b/i,
  /\btop \d+\b/i,
  /\bfind a \b/i,
  /\byellow pages\b/i,
  /\byelp\b/i,
  /\breviews and ratings\b/i,
  /\blocal business listings\b/i
];

const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz',
  'co.za', 'com.sg', 'com.br',
  'uk.com', 'us.com', 'eu.com'
]);

function getRegistrableDomain(hostname) {
  if (!hostname) return { registrableDomain: '', domainBase: '' };
  const cleanHost = hostname.toLowerCase().replace(/^www\./, '');
  const parts = cleanHost.split('.');
  if (parts.length <= 1) return { registrableDomain: cleanHost, domainBase: cleanHost };

  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (TWO_PART_TLDS.has(lastTwo)) {
      const regDomain = parts.slice(-3).join('.');
      const domainBase = parts[parts.length - 3];
      return { registrableDomain: regDomain, domainBase };
    }
  }

  const regDomain = parts.slice(-2).join('.');
  const domainBase = parts[parts.length - 2];
  return { registrableDomain: regDomain, domainBase };
}

const REGISTRY_DOMAINS = [
  'opengovuk.com',
  'companycheck.co.uk',
  'companycheck',
  'companieshouse.gov.uk',
  'service.gov.uk',
  'endole.co.uk',
  'duedil.com',
  'bizdb.co.uk',
  'checkcompany.co.uk',
  'pomanda.com',
  'companiesintheuk.co.uk'
];

function isCompanyOrGovRegistry(url, hostname) {
  const lowerUrl = (url || '').toLowerCase();
  const lowerHost = (hostname || '').toLowerCase();

  if (REGISTRY_DOMAINS.some(d => lowerHost.includes(d))) return true;

  // Patterns such as /company/<number> or /company/<id> or /fiche/
  if (/\/company\/\d+/i.test(lowerUrl) || /\/company\/[a-z0-9_-]{5,}/i.test(lowerUrl) || /\/fiche\//i.test(lowerUrl)) {
    return true;
  }
  return false;
}

const DIRECTORY_HOMEPAGE_WORDS = [
  'directory', 'listings', 'listing', 'find a', 'companies', 'reviews', 'near me',
  'categories', 'search businesses', 'local guide', 'yellow pages', 'local directory',
  'businesses in', 'places to eat', 'add listing', 'submit business'
];

/**
 * Check if HTML content indicates a parked or domain-for-sale placeholder page
 */
function isParkedDomain(html, title = '') {
  const text = (html + ' ' + title).toLowerCase();
  for (const sig of PARKING_SIGNATURES) {
    if (text.includes(sig)) return true;
  }
  return false;
}

/**
 * Check if page title represents a directory or aggregator
 */
function isDirectoryOrListingTitle(title) {
  if (!title) return false;
  return DIRECTORY_TITLE_PATTERNS.some(p => p.test(title));
}

const METRO_AREAS = {
  'austin': ['austin', 'round rock', 'pflugerville', 'cedar park', 'georgetown', 'travis', 'williamson', 'buda', 'kyle', 'lakeway', 'leander', 'san marcos'],
  'round rock': ['round rock', 'austin', 'pflugerville', 'cedar park', 'georgetown', 'travis', 'williamson'],
  'manchester': ['manchester', 'greater manchester', 'salford', 'stockport', 'trafford', 'bolton', 'bury', 'rochdale', 'oldham', 'tameside', 'wigan'],
  'leeds': ['leeds', 'west yorkshire', 'bradford', 'wakefield', 'kirklees', 'calderdale'],
  'london': ['london', 'greater london', 'westminster', 'camden', 'islington', 'hackney', 'tower hamlets', 'southwark', 'lambeth'],
  'brisbane': ['brisbane', 'moreton bay', 'logan', 'ipswich', 'redland'],
  'portland': ['portland', 'beaverton', 'hillsboro', 'gresham', 'tigard', 'lake oswego'],
  'auckland': ['auckland', 'north shore', 'waitakere', 'manukau']
};

const SPELL_FIXES = {
  'plubing': 'plumbing',
  'pluber': 'plumber',
  'electic': 'electric',
  'electical': 'electrical',
  'cleanig': 'cleaning',
  'bakry': 'bakery',
  'bakeri': 'bakery',
  'resturant': 'restaurant',
  'restaraunt': 'restaurant',
  'servces': 'services',
  'maintanance': 'maintenance',
  'maintainance': 'maintenance',
  'landscapig': 'landscaping',
  'chiropracter': 'chiropractor',
  'chiropractice': 'chiropractic'
};

const DOMAIN_TOKEN_ALIASES = {
  'portland': ['pdx', 'portland'],
  'chiropractic': ['chiro', 'chiropractic'],
  'chiropractor': ['chiro', 'chiropractor'],
  'cooperative': ['coop', 'co-op'],
  'coop': ['coop', 'co-op'],
  'plumbing': ['plumb'],
  'electrical': ['elec'],
  'locksmith': ['lock', 'locks'],
  'locksmiths': ['lock', 'locks'],
  'clinic': ['clinic', 'clinics']
};

function domainMatchesToken(domainBase, regDomain, t) {
  if (!t) return false;
  const base = (domainBase || '').toLowerCase();
  const reg = (regDomain || '').toLowerCase();
  if (base.includes(t) || reg.includes(t)) return true;
  const aliases = DOMAIN_TOKEN_ALIASES[t];
  if (aliases && aliases.some(a => base.includes(a) || reg.includes(a))) return true;
  return false;
}

/**
 * Extract tokens from business name, separating distinctive vs generic category vs locality tokens
 */
function extractBusinessTokens(name, city = '') {
  if (!name || typeof name !== 'string') {
    return { allTokens: [], distinctiveTokens: [], genericTokens: [], localityTokens: [], brandTokens: [] };
  }
  const rawWords = name.toLowerCase()
    .replace(/\bco-?op\b/g, 'coop')
    .replace(/['’]/g, '') // remove apostrophes: joe's -> joes
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !STOP_WORDS.has(w));

  const words = rawWords.map(w => SPELL_FIXES[w] || w);

  const cityWords = new Set(
    (city || '').toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0 && !STOP_WORDS.has(w))
  );

  const distinctiveTokens = [];
  const genericTokens = [];
  const localityTokens = [];
  const brandTokens = [];

  for (const w of words) {
    if (cityWords.has(w)) {
      localityTokens.push(w);
    }
    if (GENERIC_CATEGORY_WORDS.has(w) || w.length <= 2) {
      genericTokens.push(w);
    } else {
      distinctiveTokens.push(w);
      if (!cityWords.has(w)) {
        brandTokens.push(w);
      }
    }
  }

  return { allTokens: words, distinctiveTokens, genericTokens, localityTokens, brandTokens };
}

/**
 * Test if text contains a specific token as a whole word (with spell tolerance)
 */
function textContainsToken(text, token) {
  if (!text || !token) return false;
  const cleanTarget = text.toLowerCase().replace(/\bco-?op\b/gi, 'coop').replace(/['’]/g, '');
  const cleanToken = (SPELL_FIXES[token.toLowerCase()] || token).toLowerCase().replace(/\bco-?op\b/gi, 'coop');
  const re1 = new RegExp(`(?:^|[^a-z0-9])${token.toLowerCase()}(?:$|[^a-z0-9])`, 'i');
  const re2 = new RegExp(`(?:^|[^a-z0-9])${cleanToken}(?:$|[^a-z0-9])`, 'i');
  if (re1.test(cleanTarget) || re2.test(cleanTarget)) return true;
  const aliases = DOMAIN_TOKEN_ALIASES[cleanToken] || DOMAIN_TOKEN_ALIASES[token.toLowerCase()];
  if (aliases && aliases.some(a => new RegExp(`(?:^|[^a-z0-9])${a}(?:$|[^a-z0-9])`, 'i').test(cleanTarget))) {
    return true;
  }
  return false;
}

/**
 * True when the business's phone number appears on the page. Compares the last 9 digits so
 * "+1 281-502-2062" matches "(281) 502-2062" and "+44 20 7437 8898" matches "020 7437 8898"
 * (country codes and trunk 0s differ between records and websites).
 */
function pageHasPhone(html, businessPhone) {
  const nsn = nationalNumber(businessPhone);
  if (!html || nsn.length < 7) return false;
  return cleanPhone(html).includes(nsn);
}

/**
 * National significant number: drops the country code and trunk 0, so
 * "+46 8 641 91 11" -> "86419111" matches "08 – 641 91 11" on a Swedish site, and
 * "+1 281-502-2062" -> "2815022062" matches "(281) 502-2062".
 */
function nationalNumber(phone) {
  let d = cleanPhone(phone);
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  const hadPlus = /^\s*\+/.test(String(phone)) || cleanPhone(phone).startsWith('00');
  const codes = ['353', '44', '61', '64', '46', '31', '1'];
  if (hadPlus || d.length > 10) {
    for (const cc of codes) {
      if (d.startsWith(cc) && d.length - cc.length >= 7) { d = d.slice(cc.length); break; }
    }
  } else if (d.length === 11 && d.startsWith('1')) {
    d = d.slice(1); // US numbers stored as 1XXXXXXXXXX without "+"
  }
  return d.replace(/^0+/, '');
}

/** Levenshtein distance, used only for one-letter spelling slips in brand names. */
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/**
 * Check for corroborating second signals on candidate page (city + category, postcode, phone, domain slug)
 */
function checkSecondSignals({ html, pageTitle, businessCity, businessPostcode, businessPhone, isSlugMatch, isGuessedDomain, hostname }) {
  const signals = [];

  // 1. Phone match
  if (pageHasPhone(html, businessPhone)) {
    signals.push('phone match');
  }

  // 2. Postcode match
  if (businessPostcode && businessPostcode.length >= 3) {
    const cleanPostcode = businessPostcode.toLowerCase().replace(/\s+/g, '');
    const cleanHtml = html.toLowerCase().replace(/\s+/g, '');
    if (cleanHtml.includes(cleanPostcode)) {
      signals.push('postcode match');
    }
  }

  // 3. City match + Category match (with nearby metro tolerance)
  if (businessCity && businessCity.length >= 3) {
    const cleanCity = businessCity.toLowerCase().trim();
    // Region lists use names like "Dublin City" / "Auckland City"; sites just say "Dublin".
    const baseCity = cleanCity.replace(/\s+city$/, '').replace(/^city of\s+/, '').trim();
    const cityCandidates = [...new Set([cleanCity, baseCity, ...(METRO_AREAS[cleanCity] || []), ...(METRO_AREAS[baseCity] || [])])].filter(c => c.length >= 3);
    const cityPresent = cityCandidates.some(c => textContainsToken(pageTitle, c) || textContainsToken(html, c));

    if (cityPresent) {
      let categoryPresent = false;
      for (const cat of GENERIC_CATEGORY_WORDS) {
        if (textContainsToken(pageTitle, cat) || textContainsToken(html, cat)) {
          categoryPresent = true;
          break;
        }
      }
      if (categoryPresent) {
        signals.push('city + category match');
      } else {
        signals.push('city match');
      }
    }
  }

  // 4. Domain slug match: NEVER count as signal if the domain was guessed from the business name!
  if (isSlugMatch && !isGuessedDomain) {
    signals.push('domain slug match');
  }

  return signals;
}

/**
 * Inspect a candidate URL to determine if it is the business's genuine website
 * @param {string} rawUrl 
 * @param {string} businessName 
 * @param {string} businessCity 
 * @param {string} businessPhone 
 * @param {string} businessPostcode
 * @param {object} options { isGuessedDomain, socialHandle, preRenderedHtml, preRenderedStatus, preRenderedTitle, preRenderedH1 }
 * @returns {Promise<{ isMatch: boolean, reason?: string, matchedUrl?: string, isParked?: boolean, isClosed?: boolean, isBlocked?: boolean, error?: string, title?: string }>}
 */
async function inspectCandidateWebsite(rawUrl, businessName, businessCity = '', businessPhone = '', businessPostcode = '', options = {}) {
  const { isGuessedDomain = false, socialHandle = '', preRenderedHtml = null, preRenderedStatus = null, preRenderedTitle = '', preRenderedH1 = '' } = options;

  if (!rawUrl || typeof rawUrl !== 'string') {
    return { isMatch: false, error: 'Empty or invalid URL' };
  }

  let targetUrl = rawUrl.trim();
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  let hostname = '';
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    hostname = parsedUrl.hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return { isMatch: false, error: 'Invalid URL format' };
  }

  // Check directory, news, review, or aggregator blocklist
  if (isBlockedDomain(targetUrl)) {
    return {
      isMatch: false,
      isBlocked: true,
      reason: `URL matches directory/review/blog/aggregator blocklist (${targetUrl})`,
      title: ''
    };
  }

  // Slug domain check: does domain match business name directly?
  const nameSlug = extractSlug(businessName);
  const hostNoTld = hostname.split('.')[0] || '';
  const isSlugMatch = nameSlug.length >= 4 && (hostname.includes(nameSlug) || hostNoTld.includes(nameSlug));

  let html = preRenderedHtml || '';
  let finalUrl = targetUrl;
  let fetchStatus = preRenderedStatus || 200;

  if (!preRenderedHtml) {
    try {
      let res;
      try {
        res = await rateLimiter.politeFetch(targetUrl, {
          method: 'GET',
          timeoutMs: 6000,
          headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
        }, 1);
      } catch (httpsErr) {
        if (targetUrl.startsWith('https://')) {
          const httpUrl = targetUrl.replace('https://', 'http://');
          res = await rateLimiter.politeFetch(httpUrl, {
            method: 'GET',
            timeoutMs: 6000,
            headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
          }, 1);
        } else {
          throw httpsErr;
        }
      }

      finalUrl = res.url || targetUrl;
      fetchStatus = res.status;

      if (res.status >= 200 && res.status < 400) {
        try {
          html = await res.text();
        } catch (textErr) {
          return { isMatch: false, error: `Socket stream error reading body: ${textErr.message}`, statusCode: res.status };
        }
      } else {
        return { isMatch: false, error: `HTTP ${res.status}`, statusCode: res.status };
      }
    } catch (fetchErr) {
      return { isMatch: false, error: fetchErr.message };
    }
  }

  // 1. Check for parked domain
  const $ = cheerio.load(html);
  const pageTitle = (preRenderedTitle || $('title').text()).trim();
  const h1Texts = [];
  if (preRenderedH1) h1Texts.push(preRenderedH1);
  $('h1').each((_, el) => {
    const t = $(el).text().trim();
    if (t && !h1Texts.includes(t)) h1Texts.push(t);
  });

  if (isParkedDomain(html, pageTitle)) {
    return {
      isMatch: false,
      isParked: true,
      reason: `Domain ${hostname} is a parked or for-sale placeholder`,
      matchedUrl: finalUrl,
      title: pageTitle
    };
  }

  // 2. Reject directory or aggregator title signatures
  if (isDirectoryOrListingTitle(pageTitle)) {
    return {
      isMatch: false,
      reason: `Page title indicates directory or aggregator ('${pageTitle}')`,
      title: pageTitle
    };
  }

  // 3. Own website test: check third-person / review / former / closed subject in title/h1
  const thirdPersonPatterns = /\b(review|reviews|rating|ratings|closing|closed down|former|tribute|farewell|rip|obituary|guide|top \d+)\b/i;
  if (thirdPersonPatterns.test(pageTitle) || h1Texts.some(h1 => thirdPersonPatterns.test(h1))) {
    return {
      isMatch: false,
      reason: `Page is a third-person review, article, or closed-business tribute, not the business's own website ('${pageTitle}')`,
      title: pageTitle
    };
  }

  // 4. Closed business detection (Item 4)
  const closedMarkers = /\b(closed down|permanently closed|closing|farewell|rip|has closed|shut down|no longer trading|ceased trading)\b/i;
  if (closedMarkers.test(pageTitle) || closedMarkers.test(html.slice(0, 3000))) {
    return {
      isMatch: false,
      isClosed: true,
      reason: `Page indicates the business has closed down or ceased trading`,
      title: pageTitle
    };
  }

  // 5. Company / Government Registry Check (Problem 1d)
  if (isCompanyOrGovRegistry(targetUrl, hostname)) {
    return {
      isMatch: false,
      reason: `Rejected: company/government registry page (${hostname})`,
      title: pageTitle
    };
  }

  // 6. Token-based Name Extraction
  const { allTokens, distinctiveTokens, genericTokens, localityTokens, brandTokens } = extractBusinessTokens(businessName, businessCity);

  // 6b. Strong contact match: the business's own phone number is on this page and the domain
  // is the business name give or take one letter (map "Gunnarssons" vs gunnarsons.se).
  {
    const { domainBase: fuzzyBase } = getRegistrableDomain(hostname);
    const base = (fuzzyBase || '').replace(/[^a-z0-9]/g, '');
    const nameGlued = (brandTokens.length ? brandTokens : distinctiveTokens).join('');
    const nearName = base.length >= 5 && (brandTokens.length ? brandTokens : distinctiveTokens)
      .some(t => t.length >= 5 && (base.includes(t) || editDistance(t, base) <= 1)) ||
      (nameGlued.length >= 5 && editDistance(nameGlued, base) <= 1);
    if (nearName && pageHasPhone(html, businessPhone)) {
      return {
        isMatch: true,
        reason: `business phone number is on the page and the domain matches the name (${hostname})`,
        matchedUrl: finalUrl,
        title: pageTitle
      };
    }
  }
  if (allTokens.length === 0) {
    return { isMatch: false, reason: 'Business name has no valid tokens', title: pageTitle };
  }

  // 7. Structural First-Party Site Test (Problem 1)
  const { registrableDomain, domainBase } = getRegistrableDomain(hostname);
  let domainContainsNameToken = false;
  if (brandTokens.length > 0 && brandTokens.some(t => domainMatchesToken(domainBase, registrableDomain, t))) {
    domainContainsNameToken = true;
  } else if (brandTokens.length === 0 && allTokens.length >= 2 && allTokens.every(t => domainMatchesToken(domainBase, registrableDomain, t))) {
    domainContainsNameToken = true;
  } else if (nameSlug.length >= 4 && (domainBase.includes(nameSlug) || registrableDomain.replace(/[^a-z0-9]/g, '').includes(nameSlug))) {
    domainContainsNameToken = true;
  } else if (socialHandle) {
    const handleClean = socialHandle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const sharesToken = distinctiveTokens.some(t => handleClean.includes(t));
    if (sharesToken && !GENERIC_CATEGORY_WORDS.has(handleClean) && (domainBase.includes(handleClean) || registrableDomain.includes(handleClean))) {
      domainContainsNameToken = true;
    }
  }

  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
  const pathDepth = pathParts.length;

  // Problem 1b: If business name appears in URL path or query but not in domain, reject as directory listing
  const pathAndQuery = (parsedUrl.pathname + parsedUrl.search).toLowerCase();
  const slugInPathOrQuery = nameSlug.length >= 4 && pathAndQuery.replace(/[^a-z0-9]/g, '').includes(nameSlug);
  const relevantTokens = brandTokens.length > 0 ? brandTokens : distinctiveTokens;
  const distinctiveInPathOrQuery = relevantTokens.length > 0 && relevantTokens.some(t => {
    const re = new RegExp(`(?:[/_?&=~-]|^)${t}(?:[/_?&=~-]|$)`, 'i');
    return re.test(pathAndQuery);
  });
  const hasShopParam = parsedUrl.searchParams.has('shop') || parsedUrl.searchParams.has('business') || parsedUrl.searchParams.has('q');

  if (!domainContainsNameToken && (slugInPathOrQuery || distinctiveInPathOrQuery || (hasShopParam && pathAndQuery.includes(nameSlug)))) {
    return {
      isMatch: false,
      reason: `Directory listing: business name appears in URL path or query but not in domain (${hostname}${parsedUrl.pathname}); first-party test: domain contains name token no, path depth ${pathDepth}, homepage about business no`,
      title: pageTitle
    };
  }

  // When brandTokens is empty (business name is purely locality + generic category e.g. "Manchester Locksmiths"),
  // an arbitrary external domain (e.g. keyaccesslocksmiths.com, ctml.co.uk) cannot claim to be this business.
  // The domain itself MUST match the business tokens (e.g. locksmithsmanchester.co.uk).
  if (brandTokens.length === 0 && !domainContainsNameToken) {
    return {
      isMatch: false,
      reason: `First-party test failed: generic city+category name '${businessName}' requires matching domain tokens (${hostname}); first-party test: domain contains name token no, path depth ${pathDepth}, homepage about business no`,
      title: pageTitle
    };
  }

  // Problem 1a & 1c: If domain does NOT contain name token, require depth <= 1, homepage title/h1 about business, and homepage not a directory
  let homepageAboutBusiness = false;
  if (!domainContainsNameToken) {
    if (pathDepth > 1) {
      return {
        isMatch: false,
        reason: `First-party test failed: domain '${domainBase}' lacks name token and path depth is ${pathDepth} > 1; first-party test: domain contains name token no, path depth ${pathDepth}, homepage about business no`,
        title: pageTitle
      };
    }

    let homepageHtml = html;
    let homepageTitle = pageTitle;
    let homepageH1 = h1Texts[0] || '';
    if (pathDepth > 0) {
      try {
        const homeRes = await rateLimiter.politeFetch(`${parsedUrl.protocol}//${parsedUrl.host}/`, {
          method: 'GET',
          timeoutMs: 5000,
          headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
        }, 1);
        if (homeRes.ok) {
          homepageHtml = await homeRes.text();
          const $home = cheerio.load(homepageHtml);
          homepageTitle = ($home('title').text() || '').trim();
          homepageH1 = ($home('h1').first().text() || '').trim();
        }
      } catch (e) {}
    }

    const homeLower = (homepageHtml.slice(0, 5000) + ' ' + homepageTitle).toLowerCase();
    const isDirectoryHome = DIRECTORY_HOMEPAGE_WORDS.some(w => homeLower.includes(w));
    if (isDirectoryHome || isDirectoryOrListingTitle(homepageTitle)) {
      return {
        isMatch: false,
        reason: `First-party test failed: domain '${hostname}' homepage is a directory or listing aggregator; first-party test: domain contains name token no, path depth ${pathDepth}, homepage about business no`,
        title: pageTitle
      };
    }

    // Check if the domain represents a different primary brand (e.g. ctml.co.uk is CTML Ltd)
    const domainIsDifferentBrand = domainBase.length >= 3 &&
      (textContainsToken(homepageTitle, domainBase) || textContainsToken(homepageH1, domainBase)) &&
      !textContainsToken(businessName, domainBase);

    const checkTokens = brandTokens.length > 0 ? brandTokens : allTokens;
    const homeTitleMatches = checkTokens.length > 0 && checkTokens.every(t => textContainsToken(homepageTitle, t));
    const homeH1Matches = checkTokens.length > 0 && textContainsToken(homepageH1, checkTokens[0]);

    if (!domainIsDifferentBrand && (homeTitleMatches || homeH1Matches)) {
      homepageAboutBusiness = true;
    } else {
      return {
        isMatch: false,
        reason: `First-party test failed: domain '${hostname}' lacks name token and homepage is not about '${businessName}'${domainIsDifferentBrand ? ' (site belongs to brand ' + domainBase + ')' : ''}; first-party test: domain contains name token no, path depth ${pathDepth}, homepage about business no`,
        title: pageTitle
      };
    }
  } else {
    homepageAboutBusiness = true;
  }

  const firstPartyLog = `first-party test: domain contains name token ${domainContainsNameToken ? 'yes' : 'no'}, path depth ${pathDepth}, homepage about business ${homepageAboutBusiness ? 'yes' : 'no'}`;

  // Problem 3: Chain detection during site inspection
  const multiLocationPatterns = /\b(nos boutiques|our boutiques|our shops|our locations|boutiques in paris|shops in paris|locations in)\b/i;
  const internationalCities = /\b(paris|lyon|brussels|bruxelles|tokyo|new york|berlin|amsterdam)\b/i;
  if (multiLocationPatterns.test(html.slice(0, 10000)) && internationalCities.test(html.slice(0, 10000))) {
    return {
      isMatch: false,
      isChain: true,
      reason: `Multi-country chain detected: site features international boutique/shop locations; ${firstPartyLog}`,
      title: pageTitle
    };
  }

  // URL depth constraint (if depth > 1 without primary contact proof)
  const targetPhone = cleanPhone(businessPhone);
  const targetPostcode = businessPostcode ? businessPostcode.toLowerCase().replace(/\s+/g, '') : '';
  const pageRawPhone = cleanPhone(html);
  const pageRawHtml = html.toLowerCase().replace(/\s+/g, '');
  const hasContactProof = pageHasPhone(html, businessPhone) ||
                          (targetPostcode && targetPostcode.length >= 3 && pageRawHtml.includes(targetPostcode));
  // Deep pages on a domain that carries the business's own name (marcolini.co.uk/en/shops/...)
  // are still its own site; the depth rule is only for pages on other people's domains.
  if (pathDepth > 1 && !hasContactProof && !domainContainsNameToken) {
    return {
      isMatch: false,
      reason: `URL path depth > 1 ('${parsedUrl.pathname}') without primary contact address/phone proof; ${firstPartyLog}`,
      title: pageTitle
    };
  }

  // Support social handle tokens (e.g. sokopatisserie -> soko, patisserie)
  // Handles may be concatenated (no spaces), so we also try to split them at known category words.
  let socialHandleTokens = [];
  let socialHandleSlug = ''; // the full handle slug for substring matching
  if (socialHandle) {
    const handleClean = socialHandle.toLowerCase().replace(/[^a-z0-9]/g, '');
    socialHandleSlug = handleClean;

    // First: try splitting by separators
    const handleBySep = socialHandle.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
    const handleWords = handleBySep.split(/\s+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w));

    if (handleWords.length === 1 && handleWords[0].length > 5) {
      // Concatenated handle — try to strip known generic category words from the end/start
      // to extract the distinctive prefix/suffix
      const raw = handleWords[0];
      let remaining = raw;
      // Strip known generic words from end
      for (const cat of Array.from(GENERIC_CATEGORY_WORDS).sort((a, b) => b.length - a.length)) {
        if (remaining !== cat && remaining.endsWith(cat)) {
          const prefix = remaining.slice(0, remaining.length - cat.length);
          if (prefix.length >= 3) {
            if (!genericTokens.includes(cat)) genericTokens.push(cat);
            if (!allTokens.includes(cat)) allTokens.push(cat);
            remaining = prefix;
          }
        }
        if (remaining !== cat && remaining.startsWith(cat)) {
          const suffix = remaining.slice(cat.length);
          if (suffix.length >= 3) {
            if (!genericTokens.includes(cat)) genericTokens.push(cat);
            if (!allTokens.includes(cat)) allTokens.push(cat);
            remaining = suffix;
          }
        }
      }
      if (remaining.length >= 3 && !STOP_WORDS.has(remaining) && !GENERIC_CATEGORY_WORDS.has(remaining)) {
        socialHandleTokens.push(remaining);
        if (!distinctiveTokens.includes(remaining)) distinctiveTokens.push(remaining);
      }
    } else {
      for (const hw of handleWords) {
        if (!GENERIC_CATEGORY_WORDS.has(hw) && !distinctiveTokens.includes(hw)) {
          distinctiveTokens.push(hw);
          socialHandleTokens.push(hw);
        }
      }
    }
  }

  const footerText = ($('footer').text() || $('.footer').text() || $('#footer').text() || '').trim();

  // Test token occurrences
  const titleMatchesAllDistinctive = distinctiveTokens.length > 0 && distinctiveTokens.every(t => textContainsToken(pageTitle, t));
  const titleMatchesAllTokens = allTokens.length > 0 && allTokens.every(t => textContainsToken(pageTitle, t));

  const h1MatchesAllDistinctive = distinctiveTokens.length > 0 && h1Texts.some(h1 => distinctiveTokens.every(t => textContainsToken(h1, t)));
  const h1MatchesAllTokens = allTokens.length > 0 && h1Texts.some(h1 => allTokens.every(t => textContainsToken(h1, t)));

  const footerMatchesAllTokens = allTokens.length > 0 && allTokens.every(t => textContainsToken(footerText, t));

  const signals = checkSecondSignals({
    html,
    pageTitle,
    businessCity,
    businessPostcode,
    businessPhone,
    isSlugMatch,
    isGuessedDomain,
    hostname
  });

  // RULE A: 1-2 distinctive or generic tokens (e.g. "Baked", "Angels Bakery", "Sharons Bakery", "The Bakery")
  // Circular slug matching is disabled. Genuine independent signals REQUIRED:
  // - phone digits on page, OR
  // - postcode on page, OR
  // - city PLUS business category term on page.
  // ALSO: social handle slug appearing in title/h1 + generic category counts as a handle match.
  const isShortOrGeneric = distinctiveTokens.length <= 1 || (allTokens.length <= 2 && distinctiveTokens.length <= 2);
  if (isShortOrGeneric) {
    // Check if social handle slug appears as substring of title or h1 (handle match rule)
    const handleSlugInTitle = socialHandleSlug && pageTitle.toLowerCase().replace(/[^a-z0-9]/g, '').includes(socialHandleSlug);
    const handleSlugInH1 = socialHandleSlug && h1Texts.some(h1 => h1.toLowerCase().replace(/[^a-z0-9]/g, '').includes(socialHandleSlug));
    // Also check if known tokens from handle appear in title (e.g. 'soko' in 'Soko Patisserie')
    const handleTokensInTitle = socialHandleTokens.length > 0 && socialHandleTokens.every(t => textContainsToken(pageTitle, t));
    const handleTokensInH1 = socialHandleTokens.length > 0 && h1Texts.some(h1 => socialHandleTokens.every(t => textContainsToken(h1, t)));

    // A category word must also appear to avoid false positives for the handle-slug match
    const categoryInPageTitle = Array.from(GENERIC_CATEGORY_WORDS).some(cat => textContainsToken(pageTitle, cat));
    const categoryInBody = Array.from(GENERIC_CATEGORY_WORDS).some(cat => textContainsToken(html, cat));

    const hasHandleMatch = (handleSlugInTitle || handleSlugInH1 || handleTokensInTitle || handleTokensInH1) &&
                           (categoryInPageTitle || categoryInBody);

    const hasNameMatch = titleMatchesAllTokens || titleMatchesAllDistinctive || h1MatchesAllTokens || h1MatchesAllDistinctive ||
      (distinctiveTokens.length > 0 && distinctiveTokens.every(t => textContainsToken(html, t)));
    
    const hasGenuineSignal = signals.includes('phone match') || signals.includes('postcode match') || signals.includes('city + category match');

    if (hasHandleMatch) {
      return {
        isMatch: true,
        reason: `social handle '${socialHandleSlug}' found in page title/h1 + category term present${hasGenuineSignal ? ' + ' + signals.join(' + ') : ''}; ${firstPartyLog}`,
        matchedUrl: finalUrl,
        title: pageTitle
      };
    }

    if (hasNameMatch && hasGenuineSignal) {
      return {
        isMatch: true,
        reason: `all tokens matched + ${signals.join(' + ')}; ${firstPartyLog}`,
        matchedUrl: finalUrl,
        title: pageTitle
      };
    }
    return {
      isMatch: false,
      reason: `Name has 1-2 distinctive tokens without genuine independent phone, postcode, or city+category signal on page (${hostname}); ${firstPartyLog}`,
      title: pageTitle
    };
  }

  // RULE B: Distinctive multi-token names (>= 2 distinctive tokens)
  if (titleMatchesAllDistinctive || h1MatchesAllDistinctive) {
    if (signals.length > 0) {
      return {
        isMatch: true,
        reason: `all distinctive tokens matched in title + ${signals.join(' + ')}; ${firstPartyLog}`,
        matchedUrl: finalUrl,
        title: pageTitle
      };
    }
    return {
      isMatch: true,
      reason: `all distinctive tokens matched in title; ${firstPartyLog}`,
      matchedUrl: finalUrl,
      title: pageTitle
    };
  }

  // RULE B2 (Social Handle Alternative Match):
  if (socialHandleTokens.length > 0) {
    const handleTokensInTitle = socialHandleTokens.every(t => textContainsToken(pageTitle, t));
    const handleTokensInH1 = h1Texts.some(h1 => socialHandleTokens.every(t => textContainsToken(h1, t)));
    const handleTokensInBody = socialHandleTokens.every(t => textContainsToken(html, t));
    const categoryInPage = Array.from(GENERIC_CATEGORY_WORDS).some(cat =>
      textContainsToken(pageTitle, cat) || textContainsToken(html, cat)
    );
    if ((handleTokensInTitle || handleTokensInH1 || (handleTokensInBody && signals.length > 0)) && categoryInPage) {
      return {
        isMatch: true,
        reason: `social handle tokens [${socialHandleTokens.join(', ')}] matched in page title/body + category present${signals.length > 0 ? ' + ' + signals.join(' + ') : ''}; ${firstPartyLog}`,
        matchedUrl: finalUrl,
        title: pageTitle
      };
    }
  }

  // RULE B3 (Handle Slug Substring Match):
  if (socialHandleSlug && socialHandleSlug.length >= 4) {
    const titleAlnum = pageTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const h1Alnum = h1Texts.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, '')).join('');
    const categoryInPage = Array.from(GENERIC_CATEGORY_WORDS).some(cat =>
      textContainsToken(pageTitle, cat) || textContainsToken(html, cat)
    );
    if ((titleAlnum.includes(socialHandleSlug) || h1Alnum.includes(socialHandleSlug)) && categoryInPage) {
      return {
        isMatch: true,
        reason: `social handle slug '${socialHandleSlug}' found as substring in page title/h1 + category present; ${firstPartyLog}`,
        matchedUrl: finalUrl,
        title: pageTitle
      };
    }
  }

  // RULE C: Footer match with second signal or all tokens
  if (footerMatchesAllTokens && signals.length > 0) {
    return {
      isMatch: true,
      reason: `all tokens matched in website footer + ${signals.join(' + ')}; ${firstPartyLog}`,
      matchedUrl: finalUrl,
      title: pageTitle
    };
  }

  // RULE D: Phone digits match on page
  if (signals.includes('phone match')) {
    return {
      isMatch: true,
      reason: `phone digits match website page content; ${firstPartyLog}`,
      matchedUrl: finalUrl,
      title: pageTitle
    };
  }

  // RULE E: Domain slug match with active distinctive website (ONLY for non-guessed search results!)
  if (!isGuessedDomain && isSlugMatch && distinctiveTokens.length >= 2 && distinctiveTokens.every(t => hostname.includes(t))) {
    return {
      isMatch: true,
      reason: `domain slug matches business name ('${hostname}'); ${firstPartyLog}`,
      matchedUrl: finalUrl,
      title: pageTitle
    };
  }

  return {
    isMatch: false,
    reason: `Page at ${hostname} did not satisfy token and verification criteria; ${firstPartyLog}`
  };
}

module.exports = {
  isParkedDomain,
  inspectCandidateWebsite,
  extractBusinessTokens,
  isDirectoryOrListingTitle,
  getRegistrableDomain,
  isCompanyOrGovRegistry
};
