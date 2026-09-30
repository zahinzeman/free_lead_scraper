# Free Real-Data Lead Scraper & Website Verifier

A 100% free local business discovery engine and multi-layer website verifier designed specifically to find genuine, active local businesses that truly have **no website**, so you can pitch web design, SEO, and digital services with zero false positives.

Zero paid APIs. Zero credit cards. Zero fabricated leads.

---

## 🌟 Key Architecture

### 1. 100% Real Data Pipeline
- **OpenStreetMap via Overpass API**: Live geographic queries using industry tag mappings (`craft=*`, `shop=*`, `amenity=*`, `office=*`) bounded by city/state bounding boxes.
- **Overture Maps Foundation**: Direct open Apache Parquet queries over AWS S3 via DuckDB (anonymous access, no credentials required).
- **UK FSA Food Hygiene Ratings**: Open government database with 100% complete records of UK bakeries and food establishments.
- **Government Registries**: High-trust entity candidate sources.
- **Opt-In Self-Hosted Scraping**: Playwright Google Maps searcher (opt-in only, respects ToS, halts immediately on any CAPTCHA).

### 2. Multi-Layer "Has Website" Verification Waterfall
A business is categorized into one of 4 mutually exclusive statuses:
1. **`Has website`**: Matching website found via source tags, web search, domain guessing, archive, or social bio.
2. **`Confirmed no website`**: All 6 layers executed cleanly, all searches succeeded with 0 matches, domain guessing checked negative, and social profile either has a verified public bio with no website link or does not exist. (Confidence: `high` if phone verified, `medium` if verified via dual search without phone).
3. **`No website found (social only, bio unread)`**: All web searches and domain guessing ran cleanly with 0 matches, but the only identified online presence is a social profile (Facebook, Instagram) whose bio was unreadable due to HTTP 400, login walls, or cookie consent walls.
4. **`Uncertain`**: Any search layer was blocked, challenged, or timed out; or missing phone without any borough/street/postcode locality data. (Confidence: `low`).

### 3. Search Engine Adaptive Pacing & Persistent Caching
- **Adaptive Pacing**: If DuckDuckGo presents a challenge or rate limit, pacing delay automatically steps up from 2.5s to up to 12s, with a 2-minute cooldown timer.
- **Persistent Disk Caching**: All successful search queries are persistently cached in `.cache/search_queries.json`, making retries instantaneous with zero network calls.

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Optional: Self-Hosted SearXNG Search Backend (One Command)
A complete SearXNG setup with JSON API enabled is preconfigured in `docker-compose.yml` and `searxng/settings.yml`:
```bash
docker compose up -d
```
*Note on this host: Docker is currently NOT installed/running on this machine (`docker: command not found`). The scraper automatically uses DuckDuckGo HTML/Lite with zero setup required.*

### 3. Start Server
```bash
npm start
```
Open [http://localhost:3000](http://localhost:3000) in your web browser.

---

## 🔍 CLI Spot-Check Tool

You can audit any lead manually and see the full evidence trail from your terminal:
```bash
node verify.js "<business name>" "<city>" [phone] [country]
```

**Example:**
```bash
node verify.js "Chinatown Bakery" "London" "" "United Kingdom"
node verify.js "Efficient AC, Electric & Plumbing" "Austin" "+1-512-501-2275"
```

---

## 🧪 Automated Testing

Run the test suite verifying provider allowlist enforcement, search failure uncertainty fallback, parked domain detection, and regression on known-website businesses:
```bash
npm test
```

---

## 📊 Exporting Leads

- **CSV Export**: Downloads a clean CSV with `sourceProvider`, `sourceUrl`, `websiteCheckStatus`, `websiteEvidence`, `socialProfile`, and `checkedAt`.
- **Google Sheets Sync**: Streams leads directly into your Google Sheet via Google Apps Script Webhook.
- **Supabase Cloud Sync**: Synchronizes leads directly into a Supabase PostgreSQL database table.
