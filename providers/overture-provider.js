/**
 * Overture Maps Foundation Places Provider
 * Queries Overture Maps open Parquet datasets directly with DuckDB.
 * Anonymous, zero-cost, zero-key S3/HTTP access with bbox predicate pushdown.
 */

const duckdb = require('duckdb');

let sharedDb = null;
function getSharedDb() {
  if (!sharedDb) sharedDb = new duckdb.Database(':memory:');
  return sharedDb;
}
const SHARED_DB_SETUP = "INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; " +
  "SET enable_http_metadata_cache=true; SET enable_object_cache=true; SET threads=16;";
const DiskCache = require('../utils/cache');
const osmProvider = require('./osm-provider');
const { isClosedBusiness } = require('../utils/normalizer');
const { validateLocality } = require('../utils/locality-filter');

const OVERTURE_CATEGORY_MAP = {
  'Plumbers': ['plumber', 'plumbing', 'water_heater'],
  'Electricians': ['electrician', 'electrical'],
  'HVAC': ['hvac', 'heating', 'air_conditioning'],
  'Landscapers': ['landscap', 'lawn', 'gardener'],
  'Pest Control': ['pest_control'],
  'Cleaning Services': ['clean'],
  'Handymen': ['handyman', 'carpenter'],
  'Locksmiths': ['locksmith'],
  'Independent Accountants': ['account', 'tax'],
  'Real Estate Agents': ['real_estate'],
  'Architects': ['architect'],
  'Massage Therapists': ['massage'],
  'Chiropractors': ['chiropractor'],
  'Physiotherapists': ['physio', 'physical_therapy'],
  'Independent Dental/Medical Clinics (Single-Location)': ['dentist', 'dental', 'medical_clinic', 'doctor'],
  'Bakeries': ['bakery', 'patisserie'],
  'Independent Auto Repair Shops': ['auto_repair', 'mechanic', 'brake'],
  'Detailing Services': ['car_wash', 'detailing'],
  'Event Planners': ['event_plan', 'wedding_plan'],
  'Interior Design': ['interior_design']
};

class OvertureProvider {
  constructor() {
    this.id = 'overture';
    this.name = 'Overture Maps Foundation (Places)';
    this.group = 'Open POI Datasets (No Key)';
    this.needsFreeKey = false;
    this.configured = true;
    this.supportedCountries = [
      'United States', 'United Kingdom', 'Australia',
      'New Zealand', 'Ireland', 'Sweden', 'Netherlands'
    ];
    this.lastLocalityRejections = [];
    this.lastLocalityAccepted = [];
  }

  /**
   * Fetch candidates from Overture Maps
   */
  async fetchCandidates(criteria) {
    this.lastLocalityRejections = [];
    this.lastLocalityAccepted = [];
    const { country, state, city, industry, quota } = criteria;
    // The query always returns every match in the city (LIMIT 5000), so the cache must not
    // depend on the quota; otherwise each quota choice repeats a 2-minute download.
    const cacheKey = `overture_candidates_all:${country}:${state}:${city}:${industry}`;
    const cached = DiskCache.get('overture_candidates', cacheKey);
    if (cached) return cached;

    // Get bbox from OSM geocoder
    const bbox = await osmProvider.getBoundingBox(city, state, country);
    if (!bbox) {
      console.warn(`[Overture] Could not resolve bounding box for ${city}, ${state}`);
      return [];
    }

    const categories = OVERTURE_CATEGORY_MAP[industry] || ['service'];
    const catConditions = categories.map(c => `lower(taxonomy.primary) LIKE '%${c}%'`).join(' OR ');

    // Use latest Overture places release on S3
    const parquetPath = `s3://overturemaps-us-west-2/release/2026-09-23.1/theme=places/type=place/*`;

    const sqlQuery = `
      SELECT 
        id,
        names.primary as name,
        taxonomy.primary as category,
        addresses[1].freeform as address,
        addresses[1].locality as city,
        addresses[1].region as state,
        addresses[1].country as country,
        addresses[1].postcode as postcode,
        phones[1] as phone,
        websites[1] as website,
        operating_status,
        bbox.xmin as lng,
        bbox.ymin as lat
      FROM read_parquet('${parquetPath}')
      WHERE bbox.xmin >= ${bbox.west} AND bbox.xmax <= ${bbox.east}
        AND bbox.ymin >= ${bbox.south} AND bbox.ymax <= ${bbox.north}
        AND (${catConditions})
      LIMIT 5000;
    `;

    return new Promise((resolve) => {
      let isResolved = false;
      const timeoutId = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          console.warn('[Overture] DuckDB query timed out after 300s. Returning empty.');
          resolve([]);
        }
      }, 300000); // full-detail city queries take ~2 minutes on slower connections (Houston: 123s)

      // One shared DuckDB instance with HTTP metadata caching: the first query reads the
      // Parquet file footers from S3, later queries reuse them (Houston 26s, Dallas 7s
      // instead of timing out).
      const db = getSharedDb();

      db.all(SHARED_DB_SETUP, (setupErr) => {
        if (setupErr) {
          clearTimeout(timeoutId);
          if (isResolved) return;
          isResolved = true;
          console.warn('[Overture] DuckDB httpfs setup notice:', setupErr.message);
          return resolve([]);
        }

        db.all(sqlQuery, (queryErr, rows) => {
          clearTimeout(timeoutId);
          if (isResolved) return;
          isResolved = true;

          if (queryErr) {
            console.warn('[Overture] Query notice:', queryErr.message);
            return resolve([]);
          }

          const candidates = [];
          for (const row of (rows || [])) {
            if (!row.name) continue;
            if (row.operating_status === 'closed' || row.operating_status === 'permanently_closed') continue;

            const placeId = `ovt_${row.id}`;
            const address = row.address || `${row.city || city}, ${row.state || state}`;

            const cand = {
              placeId,
              name: String(row.name).trim(),
              address: String(address).trim(),
              city: row.city || city,
              state: row.state || state,
              country: row.country || country,
              postcode: row.postcode ? String(row.postcode).trim() : '',
              phone: row.phone ? String(row.phone).trim() : '',
              website: row.website ? String(row.website).trim() : '',
              socialProfile: '',
              category: industry,
              lat: row.lat || null,
              lng: row.lng || null,
              sourceProvider: 'Overture Maps Foundation',
              sourceUrl: `https://explore.overturemaps.org/place/${row.id}`
            };

            const locCheck = validateLocality(cand, city, state, country, bbox.polygon);
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
            DiskCache.set('overture_candidates', cacheKey, candidates, 7 * 24 * 60 * 60 * 1000);
          }
          resolve(candidates);
        });
      });
    });
  }

  getStats() {
    return {
      raw: (this.lastLocalityRejections.length + this.lastLocalityAccepted.length),
      rejectedByLocality: this.lastLocalityRejections.length,
      accepted: this.lastLocalityAccepted.length
    };
  }
}

module.exports = new OvertureProvider();
