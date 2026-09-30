/**
 * OpenStreetMap Provider via Overpass API
 * Uses tag mappings for all 20 target industries, area geocoding via Nominatim with bounding boxes,
 * disused/closed filtering, 1 req/sec politeness rate limiting, and disk caching.
 */

const rateLimiter = require('../utils/rate-limiter');
const DiskCache = require('../utils/cache');
const { isClosedBusiness, cleanBusinessName } = require('../utils/normalizer');
const { validateLocality } = require('../utils/locality-filter');

const INDUSTRY_OSM_TAGS = {
  'Plumbers': ['["craft"="plumber"]', '["service"="plumbing"]'],
  'Electricians': ['["craft"="electrician"]'],
  'HVAC': ['["craft"="hvac"]', '["craft"="heating_engineer"]'],
  'Landscapers': ['["craft"="gardener"]', '["craft"="landscaper"]', '["shop"="garden_centre"]'],
  'Pest Control': ['["craft"="pest_control"]'],
  'Cleaning Services': ['["craft"="cleaning"]'],
  'Handymen': ['["craft"="handyman"]', '["craft"="carpenter"]'],
  'Locksmiths': ['["craft"="locksmith"]', '["shop"="locksmith"]'],
  'Independent Accountants': ['["office"="accountant"]', '["office"="financial"]'],
  'Real Estate Agents': ['["office"="estate_agent"]'],
  'Architects': ['["office"="architect"]'],
  'Massage Therapists': ['["shop"="massage"]', '["healthcare"="massage"]', '["amenity"="spa"]'],
  'Chiropractors': ['["healthcare"="chiropractor"]'],
  'Physiotherapists': ['["healthcare"="physiotherapist"]'],
  'Independent Dental/Medical Clinics (Single-Location)': ['["amenity"="dentist"]', '["amenity"="clinic"]', '["healthcare"="clinic"]'],
  'Bakeries': ['["shop"="bakery"]', '["craft"="baker"]', '["craft"="confectionery"]'],
  'Independent Auto Repair Shops': ['["shop"="car_repair"]'],
  'Detailing Services': ['["amenity"="car_wash"]'],
  'Event Planners': ['["office"="event_planner"]'],
  'Interior Design': ['["office"="interior_designer"]', '["shop"="interior_decoration"]']
};

const NON_BUSINESS_TAG_KEYS = [
  'highway',
  'public_transport',
  'railway',
  'place',
  'route',
  'historic',
  'natural',
  'landuse'
];

const NON_BUSINESS_AMENITIES = new Set([
  'bus_station', 'taxi', 'parking', 'parking_space', 'bicycle_parking',
  'shelter', 'bench', 'waste_basket', 'post_box', 'telephone',
  'drinking_water', 'toilets', 'fountain', 'grit_bin', 'vending_machine'
]);

const OVERPASS_ENDPOINTS = [
  process.env.OVERPASS_URL || 'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];

class OsmProvider {
  constructor() {
    this.id = 'osm';
    this.name = 'OpenStreetMap (Overpass API)';
    this.group = 'Open POI Datasets (No Key)';
    this.needsFreeKey = false;
    this.configured = true;
    this.supportedCountries = [
      'United States', 'United Kingdom', 'Australia',
      'New Zealand', 'Ireland', 'Sweden', 'Netherlands'
    ];
    this.lastLocalityRejections = [];
    this.lastLocalityAccepted = [];
    this.lastNonBusinessRejections = [];
    this.lastRawCount = 0;
  }

  /**
   * Geocode a city/state to a bounding box [south, west, north, east] via Nominatim
   */
  async getBoundingBox(city, state, country) {
    const qParts = [city, state, country].filter(Boolean);
    const query = qParts.join(', ');
    const cacheKey = `nominatim_bbox:${query}`;

    const cached = DiskCache.get('geocoding', cacheKey);
    if (cached) return cached;

    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&polygon_geojson=1&limit=1`;
      const res = await rateLimiter.politeFetch(url, {
        headers: { 'User-Agent': rateLimiter.getBotUserAgent() },
        timeoutMs: 6000
      });

      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) return null;

      const item = data[0];
      // boundingbox: [south, north, west, east]
      if (item.boundingbox && item.boundingbox.length === 4) {
        const [south, north, west, east] = item.boundingbox.map(Number);
        const bbox = {
          south,
          west,
          north,
          east,
          polygon: item.geojson || null
        };
        DiskCache.set('geocoding', cacheKey, bbox, 30 * 24 * 60 * 60 * 1000);
        return bbox;
      }
    } catch (err) {
      console.warn(`[OSM] Nominatim bbox lookup failed for ${query}:`, err.message);
    }
    return null;
  }

  /**
   * Fetch real local business candidates
   * @param {object} criteria { country, state, city, industry, quota }
   * @returns {Promise<Array<object>>}
   */
  async fetchCandidates(criteria) {
    this.lastLocalityRejections = [];
    this.lastLocalityAccepted = [];
    this.lastNonBusinessRejections = [];
    const { country, state, city, industry, quota = 100 } = criteria;
    const tagFilters = INDUSTRY_OSM_TAGS[industry] || ['["craft"]'];

    // 1. Resolve bounding box
    const bbox = await this.getBoundingBox(city, state, country);
    let bboxFilter = '';
    if (bbox) {
      // Overpass bbox format: (south,west,north,east)
      bboxFilter = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
    }

    // 2. Build Overpass QL (Strict business tags only - no name-regex-only queries)
    const clauses = [];
    for (const tag of tagFilters) {
      clauses.push(`node${tag}${bboxFilter};`);
      clauses.push(`way${tag}${bboxFilter};`);
    }

    const overpassQuery = `
      [out:json][timeout:25];
      (
        ${clauses.join('\n')}
      );
      out center ${Math.min(quota * 2, 500)};
    `;

    const cacheKey = `osm_query_strict:${country}:${state}:${city}:${industry}:${quota}`;
    const cached = DiskCache.get('osm_candidates', cacheKey);
    if (cached) {
      this.lastRawCount = cached.length;
      return cached;
    }

    let elements = [];
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const url = `${endpoint}?data=${encodeURIComponent(overpassQuery)}`;
        const res = await rateLimiter.politeFetch(url, {
          timeoutMs: 15000,
          headers: { 'User-Agent': rateLimiter.getBotUserAgent() }
        }, 1);

        if (res.ok) {
          const json = await res.json();
          if (json && Array.isArray(json.elements)) {
            elements = json.elements;
            break;
          }
        }
      } catch (err) {
        console.warn(`[OSM] Overpass endpoint ${endpoint} failed:`, err.message);
      }
    }

    this.lastRawCount = elements.length;
    const candidates = [];
    for (const el of elements) {
      const tags = el.tags || {};
      const name = tags.name || tags['brand'] || tags['operator'];
      if (!name) continue;

      // Filter out closed or disused locations
      if (isClosedBusiness(el)) continue;

      // Filter out non-business features (bus stops, road junctions, stations, routes, places)
      let nonBusinessReason = null;
      for (const k of NON_BUSINESS_TAG_KEYS) {
        if (tags[k]) {
          nonBusinessReason = `Contains non-business tag '${k}=${tags[k]}'`;
          break;
        }
      }
      if (!nonBusinessReason && tags.amenity && NON_BUSINESS_AMENITIES.has(tags.amenity)) {
        nonBusinessReason = `Contains non-business amenity '${tags.amenity}'`;
      }
      // Require real business tag for Bakeries or the selected industry
      const hasBusinessTag = tags.shop || tags.craft || tags.office || (tags.amenity && !NON_BUSINESS_AMENITIES.has(tags.amenity));
      if (!nonBusinessReason && !hasBusinessTag) {
        nonBusinessReason = 'Lacks required business tag (no shop/craft/office/amenity)';
      }
      if (!nonBusinessReason && industry === 'Bakeries') {
        const isBakeryTag = tags.shop === 'bakery' || tags.shop === 'pastry' ||
          tags.craft === 'baker' || tags.craft === 'confectionery' || tags.craft === 'pastry_cook' ||
          (tags.amenity === 'cafe' && tags.cuisine && /bakery|pastry|bake|cake/i.test(tags.cuisine)) ||
          tags.bakery === 'yes';
        if (!isBakeryTag) {
          nonBusinessReason = `Feature is not a bakery (tags: shop=${tags.shop || ''}, craft=${tags.craft || ''}, amenity=${tags.amenity || ''})`;
        }
      }

      if (nonBusinessReason) {
        this.lastNonBusinessRejections.push({
          name: name.trim(),
          tags: { ...tags },
          reason: nonBusinessReason
        });
        continue;
      }

      const osmId = el.id;
      const osmType = el.type || 'node';
      const sourceUrl = `https://www.openstreetmap.org/${osmType}/${osmId}`;

      // Address extraction
      const street = tags['addr:street'] ? `${tags['addr:housenumber'] || ''} ${tags['addr:street']}`.trim() : '';
      const elCity = tags['addr:city'] || city || '';
      const elState = tags['addr:state'] || state || '';
      const fullAddress = [street, elCity, elState, tags['addr:postcode']].filter(Boolean).join(', ') || `${city}, ${state}`;

      // Contact info
      const phone = tags.phone || tags['contact:phone'] || tags['contact:mobile'] || '';
      const website = tags.website || tags['contact:website'] || tags.url || '';
      const social = tags['contact:facebook'] || tags['contact:instagram'] || tags['contact:linkedin'] || '';

      const lat = el.lat || (el.center && el.center.lat) || null;
      const lng = el.lon || (el.center && el.center.lon) || null;

      const cand = {
        placeId: `osm_${osmType}_${osmId}`,
        name: name.trim(),
        address: fullAddress,
        city: elCity,
        state: elState,
        country: country,
        postcode: tags['addr:postcode'] || '',
        phone: phone.trim(),
        website: website.trim(),
        socialProfile: social.trim(),
        category: industry,
        lat,
        lng,
        osmTags: { ...tags },
        sourceProvider: 'OpenStreetMap',
        sourceUrl
      };

      const locCheck = validateLocality(cand, city, state, country, bbox ? bbox.polygon : null);
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
      DiskCache.set('osm_candidates', cacheKey, candidates, 24 * 60 * 60 * 1000);
    }
    return candidates;
  }

  getStats() {
    return {
      raw: this.lastRawCount,
      rejectedByLocality: this.lastLocalityRejections.length,
      rejectedNonBusiness: this.lastNonBusinessRejections.length,
      accepted: this.lastLocalityAccepted.length
    };
  }
}

module.exports = new OsmProvider();
