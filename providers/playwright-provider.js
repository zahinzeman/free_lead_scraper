/**
 * Playwright Google Maps & Local Directory Provider (OPT-IN, OFF BY DEFAULT)
 * 
 * Rules:
 * 1. Excluded from "Auto"
 * 2. Labeled "may violate source ToS, use sparingly"
 * 3. Stops immediately on any CAPTCHA or consent wall; never bypasses
 * 4. A CAPTCHA marks candidate as "Uncertain"
 */

class PlaywrightProvider {
  constructor() {
    this.id = 'playwright_maps';
    this.name = 'Google Maps Local (Playwright - may violate source ToS, use sparingly)';
    this.group = 'Self-Hosted Web Scraping (Opt-In Only)';
    this.needsFreeKey = false;
    this.configured = false; // Off by default
    this.warning = 'May violate source ToS, use sparingly. Halts on CAPTCHA.';
    this.supportedCountries = [
      'United States', 'United Kingdom', 'Australia',
      'New Zealand', 'Ireland', 'Sweden', 'Netherlands'
    ];
  }

  async fetchCandidates(criteria) {
    // If not explicitly enabled via environment or opt-in setting, return empty
    if (!process.env.ENABLE_PLAYWRIGHT_SCRAPING || process.env.ENABLE_PLAYWRIGHT_SCRAPING !== 'true') {
      console.log('[Playwright] Provider is opt-in and currently disabled in .env (ENABLE_PLAYWRIGHT_SCRAPING=false)');
      return [];
    }

    try {
      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      });
      const page = await context.newPage();

      const query = `${criteria.industry} in ${criteria.city}, ${criteria.state}`;
      const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Check for consent or CAPTCHA wall immediately
      const content = await page.content();
      if (content.includes('consent.google.com') || content.includes('recaptcha') || content.includes('solve this challenge')) {
        console.warn('[Playwright] Encountered Google consent/CAPTCHA wall. Halting immediately without bypass.');
        await browser.close();
        return [];
      }

      // Read real results from map panels
      const places = await page.evaluate(() => {
        const results = [];
        const items = document.querySelectorAll('div[role="feed"] > div > div[jsaction]');
        items.forEach(el => {
          const titleEl = el.querySelector('.fontHeadlineSmall');
          if (titleEl) {
            results.push({
              name: titleEl.textContent.trim(),
              text: el.textContent
            });
          }
        });
        return results;
      });

      await browser.close();

      return places.map((p, idx) => ({
        placeId: `gmap_${idx}_${Date.now()}`,
        name: p.name,
        address: `${criteria.city}, ${criteria.state}`,
        city: criteria.city,
        state: criteria.state,
        country: criteria.country,
        phone: '',
        website: '',
        socialProfile: '',
        category: criteria.industry,
        lat: null,
        lng: null,
        sourceProvider: 'Google Maps (Playwright)',
        sourceUrl: searchUrl
      }));
    } catch (err) {
      console.warn('[Playwright] Scraping stopped or unavailable:', err.message);
      return [];
    }
  }
}

module.exports = new PlaywrightProvider();
