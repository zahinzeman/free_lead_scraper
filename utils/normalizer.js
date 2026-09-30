/**
 * Business Data Normalization, Similarity, Chain Filtering, and Deduplication Utilities
 */

const MULTI_COUNTRY_BLOCKLIST = [
  // Real Estate Multinationals
  "cbre", "jll", "jones lang lasalle", "century 21", "century21", "re/max", "remax",
  "colliers", "cushman & wakefield", "cushmanwakefield", "savills", "knight frank",
  "knightfrank", "sotheby's international realty", "sothebys", "keller williams",
  "era real estate", "compass real estate", "berkshire hathaway",
  // Accounting Multinationals (Big 4 & Global Networks)
  "deloitte", "pwc", "pricewaterhousecoopers", "ernst & young", "ernst and young", "kpmg",
  "bdo", "grant thornton", "grantthornton", "rsm", "baker tilly", "bakertilly",
  "crowe", "mazars", "nexia", "moore global",
  // Pest Control & Facilities Multinationals
  "rentokil", "terminix", "orkin", "ecolab", "iss facility services", "issworld",
  "servicemaster", "service master", "sodexo", "compass group",
  // Dental & Healthcare Corporate Chains
  "aspen dental", "aspendental", "heartland dental", "heartlanddental", "bupa dental",
  "bupa", "colosseum dental", "mydentist",
  // Fast Food / Cafe Chains
  "starbucks", "mcdonald's", "mcdonalds", "subway", "dunkin", "costa coffee",
  "kfc", "domino's", "dominos", "pizza hut",
  // Auto & Trades Multinationals / Large Franchises
  "belron", "carglass", "safelite", "autocrew", "midas", "jiffy lube", "roto-rooter",
  "roto rooter", "rotorooter", "mr. rooter", "mr rooter", "ars / rescue rooter", "ars rescue rooter",
  "one hour heating", "benjamin franklin plumbing", "mister sparky",
  // Bakery, Cafe & UK Food Chains / Multinationals
  "bread ahead", "hummingbird bakery", "hummingbird", "ole & steen", "ole and steen", "gail's", "gails",
  "wenzel's", "wenzels", "paul", "blank street", "crosstown", "greggs", "warburtons",
  "patisserie valerie", "coughlans bakery", "coughlans", "the co-operative", "co-op food", "co-op supermarket",
  "coop food", "tesco", "sainsbury", "waitrose", "marks & spencer", "m&s", "asda", "morrisons", "pret a manger", "pret", "caffe nero",
  "copains", "copains paris", "aux merveilleux de fred", "merveilleux de fred", "aux merveilleux"
];

const COMMON_SPELLING_CORRECTIONS = {
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

const CORP_SUFFIX_REGEX = /\b(llc|inc|corp|corporation|ltd|limited|pty|pty ltd|co|company|pllc|pc|gmbh|bv|ab|sa|sarl|cic|holdings|group)\b/gi;

/**
 * Clean and normalize a business name for comparison
 * @param {string} name 
 * @returns {string}
 */
function cleanBusinessName(name) {
  if (!name || typeof name !== 'string') return '';
  let cleaned = name
    .toLowerCase()
    .replace(/\bco-?op\b/gi, 'coop')
    .replace(CORP_SUFFIX_REGEX, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Apply common spelling corrections
  const words = cleaned.split(/\s+/);
  const corrected = words.map(w => COMMON_SPELLING_CORRECTIONS[w] || w);
  return corrected.join(' ').trim();
}

/**
 * Generate a condensed alphanumeric slug from a business name
 * @param {string} name 
 * @returns {string}
 */
function extractSlug(name) {
  if (!name || typeof name !== 'string') return '';
  return cleanBusinessName(name).replace(/\s+/g, '');
}

/**
 * Extract digits only from phone number
 * @param {string} phone 
 * @returns {string}
 */
function cleanPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  return phone.replace(/\D/g, '');
}

/**
 * Bigram Dice coefficient string similarity (returns 0.0 to 1.0)
 * @param {string} str1 
 * @param {string} str2 
 * @returns {number}
 */
function stringSimilarity(str1, str2) {
  const s1 = cleanBusinessName(str1);
  const s2 = cleanBusinessName(str2);

  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;
  if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1.0 : 0.0;

  const getBigrams = (str) => {
    const bigrams = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bigram = str.substring(i, i + 2);
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
    return bigrams;
  };

  const b1 = getBigrams(s1);
  const b2 = getBigrams(s2);

  let intersection = 0;
  for (const [bigram, count] of b1.entries()) {
    if (b2.has(bigram)) {
      intersection += Math.min(count, b2.get(bigram));
    }
  }

  const total = (s1.length - 1) + (s2.length - 1);
  return (2.0 * intersection) / total;
}

/**
 * Check if a business belongs to the multi-country corporate blocklist
 * @param {string} brandName 
 * @param {string} websiteUrl 
 * @returns {boolean}
 */
function isMultiCountryChain(brandName, websiteUrl = '') {
  if (!brandName && !websiteUrl) return false;
  const lowerName = (brandName || '').toLowerCase();
  const slug = extractSlug(lowerName);
  const cleanUrl = (websiteUrl || '').toLowerCase();

  for (const term of MULTI_COUNTRY_BLOCKLIST) {
    const termClean = term.toLowerCase();
    const termSlug = termClean.replace(/[^a-z0-9]/g, '');
    if (lowerName.includes(termClean) || slug.includes(termSlug)) return true;
    if (cleanUrl.includes(termSlug)) return true;
  }
  return false;
}

/**
 * Filter out closed/disused businesses based on OSM or Overture tags
 * @param {object} record 
 * @returns {boolean} True if closed or disused
 */
function isClosedBusiness(record) {
  if (!record) return false;

  // OSM tags
  if (record.tags) {
    const tags = record.tags;
    for (const key of Object.keys(tags)) {
      if (key.startsWith('disused:') || key.startsWith('abandoned:') || key.startsWith('was:')) {
        return true;
      }
    }
    if (tags.disused === 'yes' || tags.abandoned === 'yes') return true;
    if (tags.end_date) return true;
    if (tags.opening_hours === 'off' || tags.opening_hours === 'closed') return true;
  }

  // Overture operating_status or status
  if (record.operating_status === 'closed' || record.operating_status === 'permanently_closed') {
    return true;
  }
  if (record.status && typeof record.status === 'string' && record.status.toLowerCase().includes('inactive')) {
    return true;
  }

  return false;
}

/**
 * Deduplicate leads across sources by normalized phone, then by normalized name + city
 * @param {Array} leads 
 * @returns {Array}
 */
function dedupeLeads(leads) {
  if (!Array.isArray(leads)) return [];

  const seenPhones = new Set();
  const seenNameCity = new Set();
  const deduped = [];

  for (const lead of leads) {
    const phone = cleanPhone(lead.phone);
    const normName = cleanBusinessName(lead.name);
    const normCity = (lead.city || '').toLowerCase().trim();
    const nameCityKey = `${normName}|${normCity}`;

    // 1. Phone deduplication (if phone exists and has >= 7 digits)
    if (phone && phone.length >= 7) {
      if (seenPhones.has(phone)) continue;
      seenPhones.add(phone);
    }

    // 2. Name + City deduplication
    if (normName) {
      if (seenNameCity.has(nameCityKey)) continue;
      seenNameCity.add(nameCityKey);
    }

    deduped.push(lead);
  }

  return deduped;
}

const GENERIC_CHAIN_TOKENS = new Set([
  'bakery', 'bakeries', 'bakers', 'bakehouse', 'bake', 'patisserie', 'pastry', 'pastries',
  'bread', 'breads', 'cake', 'cakes', 'cafe', 'coffee', 'shop', 'store', 'market', 'school',
  'express', 'ltd', 'limited', 'london', 'uk', 'central', 'the', 'and', '&'
]);

/**
 * Extract core brand name by stripping corporate suffixes, location terms, and generic category words
 * @param {string} name 
 * @returns {string}
 */
function extractCoreBrand(name) {
  if (!name || typeof name !== 'string') return '';
  const clean = cleanBusinessName(name);
  const words = clean.split(/\s+/).filter(w => !GENERIC_CHAIN_TOKENS.has(w));
  return words.join(' ').trim();
}

/**
 * Compute the max-2-locations chain rule from REAL results across records.
 * Excludes businesses with > 2 locations or matching corporate/brand blocklist.
 * Groups by normalized name and core brand tokens.
 * @param {Array} leads 
 * @param {number} maxLocations Default 2
 * @returns {{ filteredLeads: Array, chainExcludedCount: number, excludedChains: Array }}
 */
function applyRealChainFilter(leads, maxLocations = 2) {
  if (!Array.isArray(leads)) return { filteredLeads: [], chainExcludedCount: 0, excludedChains: [] };

  // Count occurrences of each normalized name and core brand
  const nameCounts = new Map();
  const coreBrandCounts = new Map();

  for (const lead of leads) {
    const norm = cleanBusinessName(lead.name);
    if (norm) {
      nameCounts.set(norm, (nameCounts.get(norm) || 0) + 1);
    }
    const core = extractCoreBrand(lead.name);
    if (core && core.length >= 3) {
      coreBrandCounts.set(core, (coreBrandCounts.get(core) || 0) + 1);
    }
  }

  const excludedChains = [];
  const filteredLeads = [];

  for (const lead of leads) {
    // 1. Check corporate / multi-country chain blocklist first
    if (isMultiCountryChain(lead.name, lead.website)) {
      excludedChains.push({
        name: lead.name,
        reason: 'Matched corporate / multi-location brand blocklist',
        locationCount: nameCounts.get(cleanBusinessName(lead.name)) || 1
      });
      continue;
    }

    // 2. Check exact normalized name count across records
    const norm = cleanBusinessName(lead.name);
    const count = nameCounts.get(norm) || 1;
    if (count > maxLocations) {
      excludedChains.push({
        name: lead.name,
        reason: `Exceeded ${maxLocations} locations across dataset (${count} locations with identical name)`,
        locationCount: count
      });
      continue;
    }

    // 3. Check core brand token count across records
    const core = extractCoreBrand(lead.name);
    const coreCount = (core && core.length >= 3) ? (coreBrandCounts.get(core) || 1) : 1;
    if (coreCount > maxLocations) {
      excludedChains.push({
        name: lead.name,
        reason: `Exceeded ${maxLocations} locations under core brand '${core}' (${coreCount} locations)`,
        locationCount: coreCount
      });
      continue;
    }

    lead.locationCount = count;
    lead.isChain = false;
    filteredLeads.push(lead);
  }

  return { filteredLeads, chainExcludedCount: excludedChains.length, excludedChains };
}

module.exports = {
  cleanBusinessName,
  extractSlug,
  extractCoreBrand,
  cleanPhone,
  stringSimilarity,
  COMMON_SPELLING_CORRECTIONS,
  MULTI_COUNTRY_BLOCKLIST,
  isMultiCountryChain,
  isClosedBusiness,
  dedupeLeads,
  applyRealChainFilter
};
