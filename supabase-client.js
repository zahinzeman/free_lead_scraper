/**
 * Supabase Cloud Sync Module
 * Provides seamless integration to store and synchronize extracted leads
 * directly into a Supabase PostgreSQL database.
 */

const SupabaseManager = (function () {
  const STORAGE_KEY_URL = 'lead_scraper_supabase_url';
  const STORAGE_KEY_KEY = 'lead_scraper_supabase_key';
  const DEFAULT_URL = 'https://ruuqhunjksqccteokfrg.supabase.co';
  const DEFAULT_KEY = 'sb_publishable_H-_EG3LtErhSE26tVUCAyQ_XMQ7Gwz_';

  let supabaseClient = null;

  function getSavedConfig() {
    if (typeof localStorage === 'undefined') {
      return { url: DEFAULT_URL, key: DEFAULT_KEY };
    }
    return {
      url: localStorage.getItem(STORAGE_KEY_URL) || DEFAULT_URL,
      key: localStorage.getItem(STORAGE_KEY_KEY) || DEFAULT_KEY
    };
  }

  function saveConfig(url, key) {
    if (typeof localStorage === 'undefined') return;

    if (url) localStorage.setItem(STORAGE_KEY_URL, url.trim());
    else localStorage.removeItem(STORAGE_KEY_URL);

    if (key) localStorage.setItem(STORAGE_KEY_KEY, key.trim());
    else localStorage.removeItem(STORAGE_KEY_KEY);

    initClient();
  }

  function initClient() {
    const config = getSavedConfig();
    if (config.url && config.key && window.supabase) {
      try {
        supabaseClient = window.supabase.createClient(config.url, config.key);
        return true;
      } catch (e) {
        console.error('Failed to initialize Supabase client:', e);
        supabaseClient = null;
        return false;
      }
    }
    supabaseClient = null;
    return false;
  }

  async function testConnection(url, key) {
    if (!window.supabase) {
      return { success: false, message: 'Supabase JS library not loaded. Check internet connection.' };
    }
    const testUrl = (url || getSavedConfig().url || '').trim();
    const testKey = (key || getSavedConfig().key || '').trim();

    if (!testUrl || !testKey) {
      return { success: false, message: 'Please provide both Supabase Project URL and Anon API Key.' };
    }

    try {
      const client = window.supabase.createClient(testUrl, testKey);
      // Attempt a lightweight query to test auth
      const { data, error } = await client.from('leads').select('id').limit(1);
      if (error) {
        if (error.code === 'PGRST205' || error.message.includes('schema cache') || error.message.includes('does not exist')) {
          return {
            success: true,
            message: "Connected to Supabase! Auth verified. Note: Run the SQL schema below in Supabase SQL Editor to create the 'leads' table."
          };
        }
        if (error.message.includes('API key') || error.message.includes('JWT') || error.message.includes('Invalid')) {
          return { success: false, message: `Auth error: ${error.message}` };
        }
      }
      return {
        success: true,
        message: 'Connected to Supabase project successfully! Authentication verified.'
      };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err.message}` };
    }
  }

  /**
   * Batch uploads leads to Supabase 'leads' table
  function deduplicateLeads(leads) {
    if (!leads || !Array.isArray(leads)) return [];
    const seenWebsites = new Set();
    const seenBusinesses = new Set();
    const seenPhones = new Set();
    const unique = [];

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      if (!lead) continue;

      const webKey = (lead.website || "").trim().toLowerCase().replace(/\/+$/, "");
      const bizKey = (lead.businessName || "").trim().toLowerCase();
      const phoneKey = (lead.phone || "").replace(/[^0-9]/g, "");

      // If a website URL matches another one, list only one (skip duplicate)
      if (webKey && seenWebsites.has(webKey)) {
        continue;
      }
      if (bizKey && seenBusinesses.has(bizKey)) {
        continue;
      }
      if (phoneKey && seenPhones.has(phoneKey)) {
        continue;
      }

      if (webKey) seenWebsites.add(webKey);
      if (bizKey) seenBusinesses.add(bizKey);
      if (phoneKey) seenPhones.add(phoneKey);

      unique.push(lead);
    }
    return unique;
  }

  /**
   * Batch uploads leads to Supabase 'leads' table
   */
  async function syncLeadsToSupabase(leads, options = {}) {
    if (!supabaseClient) {
      const initialized = initClient();
      if (!initialized) {
        throw new Error('Supabase is not configured. Please enter your Project URL and Anon Key.');
      }
    }

    const cleanLeads = deduplicateLeads(leads);
    if (!cleanLeads || cleanLeads.length === 0) {
      throw new Error('No valid leads available to sync. Run extraction first.');
    }

    const onProgress = options.onProgress || function () {};
    const BATCH_SIZE = 500;
    let syncedCount = 0;

    for (let i = 0; i < cleanLeads.length; i += BATCH_SIZE) {
      const batch = cleanLeads.slice(i, i + BATCH_SIZE).map(lead => {
        const isMaps = lead.website && /google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps/i.test(lead.website);
        const cleanWeb = isMaps ? '' : (lead.website || '');
        const cleanStatus = isMaps ? 'No Website Detected' : (lead.websiteStatus || (cleanWeb ? '200 OK (Live)' : 'No Website Detected'));
        const cleanQuery = `${lead.businessName || ''} ${lead.city || ''} ${lead.state || ''}`.trim();
        const sourceUrl = lead.sourceUrl || (lead.website && /google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps/i.test(lead.website) ? lead.website : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cleanQuery)}`);

        return {
          country: lead.country,
          state: lead.state || '',
          city: lead.city || '',
          business_name: lead.businessName,
          owner_name: lead.ownerName || '',
          phone: lead.phone || '',
          website: cleanWeb,
          website_status: cleanStatus,
          source: lead.source || 'Google Maps',
          source_url: sourceUrl,
          industry: lead.industry,
          verified: Boolean(lead.verified),
          scraped_at: lead.scrapedAt || new Date().toISOString()
        };
      });

      const { data, error } = await supabaseClient
        .from('leads')
        .insert(batch);

      if (error) {
        // If table doesn't exist, provide helpful prompt
        if (error.message.includes('relation "public.leads" does not exist')) {
          throw new Error('Table "leads" not found in Supabase. Please execute the SQL table creation script in your Supabase SQL Editor.');
        }
        throw new Error(`Supabase Insert Error: ${error.message}`);
      }

      syncedCount += batch.length;
      onProgress({
        synced: syncedCount,
        total: cleanLeads.length,
        percentage: Math.round((syncedCount / cleanLeads.length) * 100)
      });
    }

    return {
      success: true,
      syncedCount: syncedCount
    };
  }

  function getSqlSchema() {
    return `-- ==========================================================
-- Lead Scraper Pro - Supabase PostgreSQL Table Schema
-- Run this in your Supabase Dashboard -> SQL Editor -> New query
-- ==========================================================

create table if not exists public.leads (
  id bigint generated by default as identity primary key,
  country text not null,
  state text,
  city text,
  business_name text not null,
  owner_name text,
  phone text,
  website text,
  website_status text default '200 OK (Live)',
  source text default 'Google Maps',
  source_url text,
  industry text not null,
  verified boolean default true,
  scraped_at text,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- Enable Row Level Security (RLS)
alter table public.leads enable row level security;

-- Create policy to allow anonymous inserts from the lead scraper
create policy "Allow public insert"
  on public.leads
  for insert
  with check (true);

-- Create policy to allow read access
create policy "Allow public read"
  on public.leads
  for select
  using (true);

-- Useful indexes for fast search and filtering
create index if not exists idx_leads_country on public.leads(country);
create index if not exists idx_leads_industry on public.leads(industry);
create index if not exists idx_leads_state on public.leads(state);
`;
  }

  // Attempt initial client setup
  initClient();

  return {
    getSavedConfig,
    saveConfig,
    testConnection,
    syncLeadsToSupabase,
    getSqlSchema,
    initClient
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SupabaseManager;
}
