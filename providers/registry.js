/**
 * Provider Registry and Orchestration Hub
 * Manages provider adapters, validation against strict allowlist,
 * country filtering, and the Auto cascade sequence.
 */

const osmProvider = require('./osm-provider');
const overtureProvider = require('./overture-provider');
const fsaProvider = require('./fsa-provider');
const playwrightProvider = require('./playwright-provider');
const { dedupeLeads } = require('../utils/normalizer');

class ProviderRegistry {
  constructor() {
    this.providers = new Map();

    // Register active Phase 1 adapters
    this.register(osmProvider);
    this.register(overtureProvider);
    this.register(fsaProvider);
    this.register(playwrightProvider);

    // Register metadata for Phase 2 adapters (disabled until configured or key provided)
    this.registerMeta({
      id: 'companies_house',
      name: 'UK Companies House (Free Key)',
      group: 'Government Registries (Free Key, No Card)',
      needsFreeKey: true,
      configured: Boolean(process.env.COMPANIES_HOUSE_KEY),
      supportedCountries: ['United Kingdom']
    });

    this.registerMeta({
      id: 'abn',
      name: 'Australia ABN Lookup (Free GUID)',
      group: 'Government Registries (Free Key, No Card)',
      needsFreeKey: true,
      configured: Boolean(process.env.ABN_GUID),
      supportedCountries: ['Australia']
    });

    this.registerMeta({
      id: 'nzbn',
      name: 'New Zealand NZBN (Free Key)',
      group: 'Government Registries (Free Key, No Card)',
      needsFreeKey: true,
      configured: Boolean(process.env.NZBN_KEY),
      supportedCountries: ['New Zealand']
    });

    this.registerMeta({
      id: 'us_open_data',
      name: 'US State Open Data (data.gov)',
      group: 'Government Registries (Free, No Key)',
      needsFreeKey: false,
      configured: true,
      supportedCountries: ['United States']
    });

    this.registerMeta({
      id: 'photon',
      name: 'Photon / Nominatim (No Key)',
      group: 'Open POI Datasets (No Key)',
      needsFreeKey: false,
      configured: true,
      supportedCountries: [
        'United States', 'United Kingdom', 'Australia',
        'New Zealand', 'Ireland', 'Sweden', 'Netherlands'
      ]
    });
  }

  register(provider) {
    this.providers.set(provider.id, provider);
  }

  registerMeta(meta) {
    this.providers.set(meta.id, meta);
  }

  /**
   * Return allowlist of valid provider IDs
   */
  getAllowlist() {
    return ['auto', ...Array.from(this.providers.keys())];
  }

  /**
   * Validate provider ID against allowlist
   */
  isValidProvider(id) {
    return this.getAllowlist().includes(id);
  }

  /**
   * Get a specific provider instance by ID (for stats/funnel reporting)
   * @param {string} id Provider ID
   * @returns {object|null} Provider instance or null
   */
  getProvider(id) {
    return this.providers.get(id) || null;
  }



  /**
   * Get list of providers formatted for frontend dropdown
   * @param {string} [country] Optional country filter
   */
  getProvidersList(country = null) {
    const list = [
      {
        id: 'auto',
        label: 'Auto (all free sources, with fallback)',
        group: 'Recommended',
        needsFreeKey: false,
        configured: true,
        supportedCountries: [
          'United States', 'United Kingdom', 'Australia',
          'New Zealand', 'Ireland', 'Sweden', 'Netherlands'
        ]
      }
    ];

    for (const [id, p] of this.providers.entries()) {
      // Check country support
      if (country && p.supportedCountries && !p.supportedCountries.includes(country)) {
        continue;
      }

      let label = p.name;
      if (p.needsFreeKey && !p.configured) {
        label += ' (add free key in .env)';
      }

      list.push({
        id: p.id,
        label,
        group: p.group,
        needsFreeKey: p.needsFreeKey,
        configured: p.configured,
        warning: p.warning || null,
        supportedCountries: p.supportedCountries || []
      });
    }

    return list;
  }

  /**
   * Fetch candidates from a specific provider or Auto cascade
   * @param {string} providerId 
   * @param {object} criteria 
   * @param {function} onSourceProgress Callback ({ source, count })
   */
  async fetchCandidates(providerId, criteria, onSourceProgress = () => {}) {
    if (!this.isValidProvider(providerId)) {
      throw new Error(`Invalid provider id '${providerId}'. Must be one of: ${this.getAllowlist().join(', ')}`);
    }

    let allCandidates = [];

    if (providerId === 'auto') {
      // Auto Order: OSM, then Overture, then Country Registry (FSA if UK), never Playwright unless explicitly chosen
      const autoSequence = [osmProvider, overtureProvider];
      if (criteria.country === 'United Kingdom' && (criteria.industry === 'Bakeries' || criteria.industry === 'All')) {
        autoSequence.push(fsaProvider);
      }

      // Run the free sources at the same time: Overture alone can take ~2 minutes per city.
      const results = await Promise.all(autoSequence.map(async (provider) => {
        try {
          console.log(`[AutoCascade] Running candidate discovery via ${provider.name}...`);
          const sourceCandidates = await provider.fetchCandidates(criteria);
          const count = sourceCandidates ? sourceCandidates.length : 0;
          onSourceProgress({ source: provider.name, count });
          console.log(`[AutoCascade] ${provider.name} found ${count} candidates`);
          return sourceCandidates || [];
        } catch (err) {
          console.warn(`[AutoCascade] Error in ${provider.name}:`, err.message);
          onSourceProgress({ source: provider.name, count: 0 });
          return [];
        }
      }));
      for (const list of results) allCandidates.push(...list);
    } else {
      const provider = this.providers.get(providerId);
      if (!provider || typeof provider.fetchCandidates !== 'function') {
        throw new Error(`Provider '${providerId}' is not an active runnable adapter.`);
      }

      console.log(`[Registry] Running candidate discovery via ${provider.name}...`);
      const results = await provider.fetchCandidates(criteria);
      const count = results ? results.length : 0;
      onSourceProgress({ source: provider.name, count });
      allCandidates = results || [];
    }

    // Deduplicate cross-source candidates
    return dedupeLeads(allCandidates);
  }
}

const providerRegistryInstance = new ProviderRegistry();
module.exports = providerRegistryInstance;
