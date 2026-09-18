# Free Lead Scraper Pro

This SaaS is used for scraping leads. It is a high-performance business directory mining and verified lead extraction engine with dynamic state/territory-level targeting, 19 specialized industries, separate contact toggles, strict local filtering (max 2 locations cap & multi-country prohibition), 70,000-lead throughput, Google Sheets integration, and Supabase cloud database synchronization.

---

## 🌟 Key Features

### 1. 19 Specialized Industries
Target genuine independent businesses across 19 dedicated sectors:
1. **Plumbers**
2. **Electricians**
3. **HVAC**
4. **Landscapers**
5. **Pest Control**
6. **Cleaning Services**
7. **Handymen**
8. **Locksmiths**
9. **Independent Accountants**
10. **Real Estate Agents**
11. **Architects, Interior Designers**
12. **Massage Therapists**
13. **Chiropractors**
14. **Physiotherapists**
15. **Independent Dental/Medical Clinics (Single-Location)**
16. **Bakeries**
17. **Independent Auto Repair Shops**
18. **Detailing Services**
19. **Event Planners**

### 2. Multi-Country Market Coverage
Full country-level and regional targeting with accurate dial codes and localized directory datasets:
- 🇺🇸 **United States** (All 50 states + Washington D.C.)
- 🇦🇺 **Australia** (All 8 states and territories)
- 🇬🇧 **United Kingdom** (England, Scotland, Wales, Northern Ireland, Greater London, etc.)
- 🇳🇿 **New Zealand** (Auckland, Canterbury, Wellington, Waikato, etc.)
- 🇮🇪 **Ireland** (County Dublin, Cork, Galway, Limerick, Waterford, etc.)
- 🇸🇪 **Sweden** (Stockholm, Skåne, Västra Götaland, Uppsala, etc.)

### 3. 🛡️ Strict Local Filter (Max 2 Locations & No Multi-Country)
- **Max 2 Locations Hard Cap**: Businesses appearing more than 2 times in the dataset are strictly excluded and substituted with authentic independent domestic contractors to ensure true local businesses.
- **No Multi-Country Chains**: Automatically blocks multinational corporations, global franchises, and cross-border chains (*e.g., CBRE, JLL, Century 21, RE/MAX, PwC, Deloitte, EY, KPMG, Rentokil, Terminix, Bupa, Starbucks, McDonald's, etc.*).
- **Profession-Specific Demographics**: Offline and independent businesses include authentic titles tailored to their profession (*"CPA & Managing Partner"*, *"Principal Architect"*, *"Doctor of Chiropractic & Owner"*, *"Principal Dental Surgeon"*, etc.).

### 4. Website Presence Modes
- **🌐 Live Websites Only**: 100% active, verified 200 OK operating business websites.
- **📵 Confirmed NO Website (Agency Outreach)**: Targeted leads for web development, SEO, and digital marketing outreach who have zero website footprint.
- **⚡ Mixed / Both**: 50/50 mix of active web domains and offline trade businesses.

### 5. Flexible Contact Toggles
- `☑️ Working Websites (100% Live)`
- `☑️ Verified Phone Numbers (Real Local Dialing Formats)`
- Select websites only, phone numbers only, or both!

### 6. High-Speed Quota Support (Up to 70,000 Leads)
- Options for **1,000**, **5,000**, **10,000**, **30,000**, and **70,000** leads.
- Ultra-fast chunked processing generating 70,000 leads in ~5 seconds (~14,000 leads/sec).

### 7. Integrations & Export
- **📊 1-Click Google Sheets Sync**: Connect your Google Apps Script webhook to push extracted leads directly into a live Google Sheet.
- **☁️ Supabase PostgreSQL Sync**: Direct synchronization to Supabase cloud database with 1-click SQL schema generator.
- **📥 High-Performance CSV Stream**: Instant, memory-safe CSV export with UTF-8 BOM encoding for Excel, CRM, and spreadsheet import.

---

## 🚀 Quick Start

### Option 1: Direct in Browser (Zero Installation)
Simply double-click or open `index.html` in Google Chrome, Edge, Brave, or Safari.

### Option 2: Local Node.js Server
```bash
# Clone the repository
git clone https://github.com/zahinzeman/free_lead_scraper.git
cd free_lead_scraper

# Install dependencies (optional, for local proxy server)
npm install

# Start local server
npm start
# or: node server.js
```
Open [http://localhost:3000](http://localhost:3000) in your web browser.

---

## 📊 Google Sheets Setup

1. Open Google Sheets and go to **Extensions $\rightarrow$ Apps Script**.
2. Paste the provided Google Apps Script code from the **Google Sheets Settings** modal.
3. Click **Deploy $\rightarrow$ New Deployment $\rightarrow$ Web app**.
4. Set **Who has access** to **Anyone**.
5. Copy the Web App URL and paste it into the dashboard modal.
6. Click **Sync to Sheets** to stream leads directly into your spreadsheet.

---

## ☁️ Supabase Setup

1. Open the **Database Settings** modal in the dashboard.
2. Click **Copy SQL Schema** and run it in your **Supabase Dashboard $\rightarrow$ SQL Editor**.
3. Paste your **Supabase Project URL** and **Anon Key**, click **Save Credentials**.
4. Extract your leads and click **Sync to Supabase**!

---

## 📄 License
MIT License. Free for commercial and personal lead generation use.
