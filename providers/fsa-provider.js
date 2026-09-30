/**
 * UK Food Standards Agency (FSA) Food Hygiene Ratings API Provider
 * 100% Free Open Government Data (No API Key Required).
 * High accuracy candidate list for UK Bakeries and Food Businesses.
 */

const rateLimiter = require('../utils/rate-limiter');
const DiskCache = require('../utils/cache');
const { validateLocality } = require('../utils/locality-filter');

class FsaProvider {
  constructor() {
    this.id = 'fsa';
    this.name = 'UK FSA Food Hygiene (Bakeries/Food)';
    this.group = 'Government Registries (Free, No Key)';
    this.needsFreeKey = false;
    this.configured = true;
    this.supportedCountries = ['United Kingdom'];
    this.lastLocalityRejections = [];
    this.lastLocalityAccepted = [];
  }

  /**
   * Fetch candidates from UK FSA Ratings API
   * @param {object} criteria { country, state, city, industry, quota }
   */
  async fetchCandidates(criteria) {
    this.lastLocalityRejections = [];
    this.lastLocalityAccepted = [];
    const { country, state = '', city, industry, quota = 100 } = criteria;

    if (country !== 'United Kingdom' || (industry !== 'Bakeries' && industry !== 'All')) {
      return [];
    }

    const cacheKey = `fsa_candidates:${city}:${industry}:${quota}`;
    const cached = DiskCache.get('fsa_candidates', cacheKey);
    if (cached) return cached;

    try {
      const url = `https://api.ratings.food.gov.uk/Establishments?name=bakery&address=${encodeURIComponent(city || '')}&pageSize=${Math.min(quota, 100)}`;
      const res = await rateLimiter.politeFetch(url, {
        headers: {
          'x-api-version': '2',
          'Accept': 'application/json',
          'User-Agent': rateLimiter.getBotUserAgent()
        },
        timeoutMs: 6000
      });

      if (!res.ok) return [];
      const json = await res.json();
      const establishments = json.establishments || [];

      const candidates = [];
      for (const item of establishments) {
        if (!item.BusinessName) continue;

        const addressParts = [
          item.AddressLine1,
          item.AddressLine2,
          item.AddressLine3,
          item.AddressLine4,
          item.PostCode
        ].filter(Boolean);

        const fullAddress = addressParts.join(', ') || city;
        const placeId = `fsa_${item.FHRSID || Math.random().toString(36).substring(7)}`;

        const cand = {
          placeId,
          name: item.BusinessName.trim(),
          address: fullAddress,
          city: item.AddressLine3 || city,
          state: 'England / UK',
          country: 'United Kingdom',
          postcode: item.PostCode ? item.PostCode.trim() : '',
          phone: item.Phone || '',
          website: '', // FSA does not store websites; verified in pipeline
          socialProfile: '',
          category: 'Bakeries',
          lat: item.geocode ? parseFloat(item.geocode.latitude) : null,
          lng: item.geocode ? parseFloat(item.geocode.longitude) : null,
          sourceProvider: 'UK FSA Food Hygiene Ratings',
          sourceUrl: item.links && item.links[0] ? item.links[0].href : 'https://ratings.food.gov.uk/'
        };

        const locCheck = validateLocality(cand, city, state, country);
        if (!locCheck.isMatch) {
          this.lastLocalityRejections.push({
            name: cand.name,
            address: cand.address,
            postcode: cand.postcode,
            phone: cand.phone,
            lat: cand.lat,
            lng: cand.lng,
            reason: locCheck.reason
          });
          continue;
        }

        this.lastLocalityAccepted.push({
          name: cand.name,
          lat: cand.lat,
          lng: cand.lng,
          postcode: cand.postcode,
          boundaryResult: locCheck.reason
        });
        candidates.push(cand);
      }

      if (candidates.length > 0) {
        DiskCache.set('fsa_candidates', cacheKey, candidates, 24 * 60 * 60 * 1000);
      }
      return candidates;
    } catch (err) {
      console.warn('[FSA] API error:', err.message);
      return [];
    }
  }

  getStats() {
    return {
      raw: (this.lastLocalityRejections.length + this.lastLocalityAccepted.length),
      rejectedByLocality: this.lastLocalityRejections.length,
      accepted: this.lastLocalityAccepted.length
    };
  }
}

module.exports = new FsaProvider();
