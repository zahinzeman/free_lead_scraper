/**
 * Lead Scraper Pro V2 - Application Controller
 * Handles multi-country state selection, separate contact toggles,
 * up to 100,000 leads extraction, and Supabase cloud synchronization.
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Element References
  const countrySelect = document.getElementById('countrySelect');
  const stateSelect = document.getElementById('stateSelect');
  const industrySelect = document.getElementById('industrySelect');
  const websiteFilterSelect = document.getElementById('websiteFilterSelect');
  const includeWebsitesCheck = document.getElementById('includeWebsitesCheck');
  const includePhonesCheck = document.getElementById('includePhonesCheck');
  const excludeChainsCheck = document.getElementById('excludeChainsCheck');
  const quotaBtns = document.querySelectorAll('.quota-btn');
  const selectedQuotaInput = document.getElementById('selectedQuotaInput');

  // Control Buttons
  const startBtn = document.getElementById('startScraperBtn');
  const pauseBtn = document.getElementById('pauseScraperBtn');
  const stopBtn = document.getElementById('stopScraperBtn');
  const downloadBtn = document.getElementById('downloadCsvBtn');
  const syncGoogleSheetsBtn = document.getElementById('syncGoogleSheetsBtn');
  const openSheetsModalBtn = document.getElementById('openSheetsModalBtn');
  const syncSupabaseBtn = document.getElementById('syncSupabaseBtn');
  const openSupabaseModalBtn = document.getElementById('openSupabaseModalBtn');
  const clearBtn = document.getElementById('clearLeadsBtn');
  const downloadCountBadge = document.getElementById('downloadCountBadge');

  // Google Sheets UI Elements
  const sheetsModal = document.getElementById('sheetsModal');
  const closeSheetsModalBtn = document.getElementById('closeSheetsModalBtn');
  const sheetsWebhookUrlInput = document.getElementById('sheetsWebhookUrlInput');
  const testSheetsConnectionBtn = document.getElementById('testSheetsConnectionBtn');
  const saveSheetsConfigBtn = document.getElementById('saveSheetsConfigBtn');
  const copyAppsScriptBtn = document.getElementById('copyAppsScriptBtn');
  const appsScriptPreview = document.getElementById('appsScriptPreview');
  const sheetsFeedbackMsg = document.getElementById('sheetsFeedbackMsg');

  // Supabase UI Elements
  const cloudConfigOpenBtn = document.getElementById('cloudConfigOpenBtn');
  const cloudStatusDot = document.getElementById('cloudStatusDot');
  const cloudStatusText = document.getElementById('cloudStatusText');
  const supabaseModal = document.getElementById('supabaseModal');
  const closeSupabaseModalBtn = document.getElementById('closeSupabaseModalBtn');
  const supabaseUrlInput = document.getElementById('supabaseUrlInput');
  const supabaseKeyInput = document.getElementById('supabaseKeyInput');
  const testSupabaseConnectionBtn = document.getElementById('testSupabaseConnectionBtn');
  const saveSupabaseConfigBtn = document.getElementById('saveSupabaseConfigBtn');
  const copySqlSchemaBtn = document.getElementById('copySqlSchemaBtn');
  const sqlSchemaPreview = document.getElementById('sqlSchemaPreview');
  const supabaseFeedbackMsg = document.getElementById('supabaseFeedbackMsg');

  // System Status & Telemetry
  const systemPulse = document.getElementById('systemPulse');
  const systemStatusText = document.getElementById('systemStatusText');
  const metricTotalLeads = document.getElementById('metricTotalLeads');
  const metricVerifiedPhones = document.getElementById('metricVerifiedPhones');
  const metricWebsites = document.getElementById('metricWebsites');
  const metricWebsitesIcon = document.getElementById('metricWebsitesIcon');
  const metricWebsitesLabel = document.getElementById('metricWebsitesLabel');
  const metricVelocity = document.getElementById('metricVelocity');

  // Progress Bar & Log
  const progressStatusLabel = document.getElementById('progressStatusLabel');
  const progressPercentageText = document.getElementById('progressPercentageText');
  const progressBarFill = document.getElementById('progressBarFill');
  const terminalLog = document.getElementById('terminalLog');

  // Table & Pagination
  const tableHeading = document.getElementById('tableLeadCount');
  const leadsTableBody = document.getElementById('leadsTableBody');
  const tableSearchInput = document.getElementById('tableSearchInput');
  const paginationBar = document.getElementById('paginationBar');
  const paginationInfo = document.getElementById('paginationInfo');
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');

  const thPhone = document.getElementById('thPhone');
  const thWebsite = document.getElementById('thWebsite');
  const thStatus = document.getElementById('thStatus');
  const thSource = document.getElementById('thSource');

  function isGoogleMapsUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps/i.test(url);
  }

  // State Management
  let allLeads = [];
  let filteredLeads = [];
  let activeSession = null;
  let currentPage = 1;
  const PAGE_SIZE = 25;
  let isPaused = false;
  let pendingRender = false;

  // 1. Initialize State Select Options Based on Selected Country
  function populateStatesForCountry(countryName) {
    const states = ScraperEngine.getStatesForCountry(countryName);
    stateSelect.innerHTML = '';
    states.forEach(state => {
      const opt = document.createElement('option');
      opt.value = state.code;
      opt.textContent = state.code === 'ALL' ? `🌐 ${state.name}` : `${state.name} (${state.code})`;
      stateSelect.appendChild(opt);
    });
  }

  // Country Change Event
  countrySelect.addEventListener('change', () => {
    populateStatesForCountry(countrySelect.value);
    appendLog(`🌍 Selected country: ${countrySelect.value}. Available states updated.`);
  });

  // Initial populate for default country
  populateStatesForCountry(countrySelect.value);

  // 2. Separate Contact Checkbox Validation
  function validateContactCheckboxes(changedElement) {
    if (!includeWebsitesCheck.checked && !includePhonesCheck.checked) {
      if (changedElement) changedElement.checked = true;
      else includeWebsitesCheck.checked = true;
      alert('Please select at least one contact channel (Websites or Phone Numbers).');
    }
    updateTableHeadersVisibility();
  }

  includeWebsitesCheck.addEventListener('change', () => validateContactCheckboxes(includeWebsitesCheck));
  includePhonesCheck.addEventListener('change', () => validateContactCheckboxes(includePhonesCheck));

  function updateTableHeadersVisibility() {
    const showWeb = includeWebsitesCheck.checked;
    const showPhone = includePhonesCheck.checked;
    if (thWebsite) thWebsite.style.display = showWeb ? '' : 'none';
    if (thStatus) thStatus.style.display = showWeb ? '' : 'none';
    if (thPhone) thPhone.style.display = showPhone ? '' : 'none';
  }

  // 3. Quota Selection Handling (Supports 1k, 5k, 10k, 30k, 70k, 100k)
  quotaBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      quotaBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedQuotaInput.value = btn.dataset.quota;
      appendLog(`🎯 Lead quota set to ${parseInt(btn.dataset.quota, 10).toLocaleString()} leads.`);
    });
  });

  // 4. Terminal Log Helper
  function appendLog(message, type = 'normal') {
    const line = document.createElement('div');
    line.className = `terminal-line ${type}`;
    const time = new Date().toLocaleTimeString();
    line.textContent = `[${time}] ${message}`;
    terminalLog.appendChild(line);
    terminalLog.scrollTop = terminalLog.scrollHeight;
  }

  // 5. Start Scraper
  startBtn.addEventListener('click', () => {
    validateContactCheckboxes();

    const country = countrySelect.value;
    const stateCode = stateSelect.value;
    const industry = industrySelect.value;
    const websiteFilter = websiteFilterSelect ? websiteFilterSelect.value : 'with_website';
    const quota = Math.min(100000, parseInt(selectedQuotaInput.value, 10) || 1000);
    const includeWebsites = includeWebsitesCheck.checked;
    const includePhones = includePhonesCheck.checked;
    const excludeChains = excludeChainsCheck ? excludeChainsCheck.checked : true;

    if (activeSession && !activeSession.isStopped) {
      activeSession.stop();
    }

    allLeads = [];
    filteredLeads = [];
    currentPage = 1;
    updateTableHeadersVisibility();
    updateTable();
    updateMetrics(0, 0, 0, 0);

    // UI Status
    systemPulse.className = 'pulse-dot running';
    systemStatusText.textContent = 'Mining Leads...';
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
    downloadBtn.disabled = true;
    if (syncGoogleSheetsBtn) syncGoogleSheetsBtn.disabled = true;
    syncSupabaseBtn.disabled = true;
    countrySelect.disabled = true;
    stateSelect.disabled = true;
    industrySelect.disabled = true;
    if (websiteFilterSelect) websiteFilterSelect.disabled = true;
    includeWebsitesCheck.disabled = true;
    includePhonesCheck.disabled = true;
    if (excludeChainsCheck) excludeChainsCheck.disabled = true;
    quotaBtns.forEach(b => b.disabled = true);

    progressBarFill.style.width = '0%';
    progressPercentageText.textContent = '0%';
    progressStatusLabel.textContent = `Extracting ${quota.toLocaleString()} ${industry} leads in ${country}...`;

    let totalValidWebsitesCount = 0;

    // Initialize Session
    activeSession = new ScraperEngine.Session({
      country: country,
      stateCode: stateCode,
      industry: industry,
      websiteFilter: websiteFilter,
      leadCount: quota,
      includeWebsites: includeWebsites,
      includePhones: includePhones,
      excludeChains: excludeChains,
      onProgress: (stats) => {
        progressBarFill.style.width = `${stats.percentage}%`;
        progressPercentageText.textContent = `${stats.percentage.toFixed(1)}%`;

        const verifiedPhonesCount = includePhones ? stats.current : 0;
        let websitesCount = 0;
        if (websiteFilter === 'no_website') {
          websitesCount = stats.current;
        } else {
          websitesCount = totalValidWebsitesCount;
        }

        updateMetrics(stats.current, verifiedPhonesCount, websitesCount, stats.velocity);

        if (!pendingRender) {
          pendingRender = true;
          requestAnimationFrame(() => {
            renderActivePage();
            pendingRender = false;
          });
        }
      },
      onChunk: (chunk) => {
        if (!chunk || chunk.length === 0) return;
        for (let i = 0; i < chunk.length; i++) {
          const l = chunk[i];
          if (l.hasWebsite && l.website && !isGoogleMapsUrl(l.website)) {
            totalValidWebsitesCount++;
          }
          allLeads.push(l);
        }
        if (tableSearchInput && tableSearchInput.value.trim()) {
          applySearchFilter();
        } else {
          filteredLeads = allLeads;
          tableHeading.textContent = filteredLeads.length.toLocaleString();
        }
      },
      onLog: (msg, type) => {
        appendLog(msg, type);
      },
      onComplete: (leads) => {
        const finalValidWebsites = allLeads.filter(l => l.hasWebsite && l.website && !isGoogleMapsUrl(l.website)).length;
        updateMetrics(leads.length, includePhones ? leads.length : 0, websiteFilter === 'no_website' ? leads.length : finalValidWebsites, 0);
        systemPulse.className = 'pulse-dot';
        systemStatusText.textContent = 'Extraction Complete';
        startBtn.disabled = false;
        pauseBtn.disabled = true;
        stopBtn.disabled = true;
        downloadBtn.disabled = false;
        if (syncGoogleSheetsBtn) syncGoogleSheetsBtn.disabled = false;
        syncSupabaseBtn.disabled = false;
        countrySelect.disabled = false;
        stateSelect.disabled = false;
        industrySelect.disabled = false;
        if (websiteFilterSelect) websiteFilterSelect.disabled = false;
        includeWebsitesCheck.disabled = false;
        includePhonesCheck.disabled = false;
        if (excludeChainsCheck) excludeChainsCheck.disabled = false;
        quotaBtns.forEach(b => b.disabled = false);

        progressBarFill.style.width = '100%';
        progressPercentageText.textContent = '100%';
        progressStatusLabel.textContent = `Successfully gathered ${leads.length.toLocaleString()} verified leads.`;

        downloadCountBadge.textContent = leads.length.toLocaleString();
        appendLog(`✨ Dataset ready for export & cloud sync (${leads.length.toLocaleString()} leads).`, 'success');
        renderActivePage();
      }
    });

    activeSession.start();
  });

  // 6. Pause / Resume
  pauseBtn.addEventListener('click', () => {
    if (!activeSession) return;
    if (!isPaused) {
      activeSession.pause();
      isPaused = true;
      pauseBtn.innerHTML = '<span>▶️</span> Resume';
      systemPulse.className = 'pulse-dot paused';
      systemStatusText.textContent = 'Scraper Paused';
    } else {
      activeSession.resume();
      isPaused = false;
      pauseBtn.innerHTML = '<span>⏸️</span> Pause';
      systemPulse.className = 'pulse-dot running';
      systemStatusText.textContent = 'Mining Leads...';
    }
  });

  // 7. Stop Scraper
  stopBtn.addEventListener('click', () => {
    if (!activeSession) return;
    activeSession.stop();
    isPaused = false;
    pauseBtn.innerHTML = '<span>⏸️</span> Pause';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
    countrySelect.disabled = false;
    stateSelect.disabled = false;
    industrySelect.disabled = false;
    if (websiteFilterSelect) websiteFilterSelect.disabled = false;
    includeWebsitesCheck.disabled = false;
    includePhonesCheck.disabled = false;
    if (excludeChainsCheck) excludeChainsCheck.disabled = false;
    quotaBtns.forEach(b => b.disabled = false);

    systemPulse.className = 'pulse-dot';
    systemStatusText.textContent = 'Scraping Stopped';
    if (allLeads.length > 0) {
      downloadBtn.disabled = false;
      if (syncGoogleSheetsBtn) syncGoogleSheetsBtn.disabled = false;
      syncSupabaseBtn.disabled = false;
      downloadCountBadge.textContent = allLeads.length.toLocaleString();
    }
  });

  // 8. Clear All Leads
  clearBtn.addEventListener('click', () => {
    if (activeSession && !activeSession.isStopped) {
      activeSession.stop();
    }
    allLeads = [];
    filteredLeads = [];
    currentPage = 1;
    updateMetrics(0, 0, 0, 0);
    progressBarFill.style.width = '0%';
    progressPercentageText.textContent = '0%';
    progressStatusLabel.textContent = 'Extraction Progress';
    downloadBtn.disabled = true;
    if (syncGoogleSheetsBtn) syncGoogleSheetsBtn.disabled = true;
    syncSupabaseBtn.disabled = true;
    downloadCountBadge.textContent = '0';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
    countrySelect.disabled = false;
    stateSelect.disabled = false;
    industrySelect.disabled = false;
    if (websiteFilterSelect) websiteFilterSelect.disabled = false;
    includeWebsitesCheck.disabled = false;
    includePhonesCheck.disabled = false;
    if (excludeChainsCheck) excludeChainsCheck.disabled = false;
    quotaBtns.forEach(b => b.disabled = false);
    systemPulse.className = 'pulse-dot';
    systemStatusText.textContent = 'Engine Ready';

    leadsTableBody.innerHTML = `
      <tr>
        <td colspan="11">
          <div class="empty-state">
            <div class="empty-icon">📁</div>
            <p>No leads extracted yet. Configure your criteria above and click <strong>Start Scraper</strong> to extract up to 100,000 leads.</p>
          </div>
        </td>
      </tr>
    `;
    paginationBar.style.display = 'none';
    tableHeading.textContent = '0';
    appendLog(`🧹 Cleared all lead records from dashboard.`);
  });

  // 9. Download CSV
  downloadBtn.addEventListener('click', () => {
    if (allLeads.length === 0) return;

    appendLog(`📦 Preparing high-performance CSV stream for ${allLeads.length.toLocaleString()} leads...`);

    const result = CsvExporter.exportLeadsToCsv(allLeads, {
      country: countrySelect.value,
      state: stateSelect.value,
      industry: industrySelect.value,
      websiteFilter: websiteFilterSelect ? websiteFilterSelect.value : 'with_website',
      includeWebsites: includeWebsitesCheck.checked,
      includePhones: includePhonesCheck.checked
    });

    if (result && result.success) {
      appendLog(`✅ Download ready: ${result.filename} (${result.count.toLocaleString()} leads)`, 'success');
    }
  });

  // 10. Sync Leads to Supabase Database
  syncSupabaseBtn.addEventListener('click', async () => {
    if (allLeads.length === 0) return;

    const config = SupabaseManager.getSavedConfig();
    if (!config.url || !config.key) {
      openModal();
      setFeedback('Please enter your Supabase Project URL and Anon API Key to enable sync.', 'error');
      return;
    }

    syncSupabaseBtn.disabled = true;
    syncSupabaseBtn.innerHTML = '<span>⏳</span> Syncing...';
    appendLog(`☁️ Initiating cloud synchronization of ${allLeads.length.toLocaleString()} leads to Supabase...`);

    try {
      const res = await SupabaseManager.syncLeadsToSupabase(allLeads, {
        onProgress: (p) => {
          syncSupabaseBtn.innerHTML = `<span>⏳</span> Syncing (${p.percentage}%)`;
          if (p.synced % 2500 === 0 || p.synced === allLeads.length) {
            appendLog(`☁️ Synced ${p.synced.toLocaleString()} of ${p.total.toLocaleString()} leads to Supabase (${p.percentage}%)`);
          }
        }
      });

      appendLog(`🎉 Successfully synchronized ${res.syncedCount.toLocaleString()} leads into Supabase 'leads' table!`, 'success');
      alert(`Success! ${res.syncedCount.toLocaleString()} leads have been saved to your Supabase database.`);
    } catch (err) {
      appendLog(`❌ Supabase Sync Failed: ${err.message}`, 'warning');
      alert(`Supabase Sync Error: ${err.message}`);
    } finally {
      syncSupabaseBtn.disabled = false;
      syncSupabaseBtn.innerHTML = '<span>☁️</span> Sync to Supabase';
    }
  });

  // 10-B. Sync Leads Directly to Google Sheets
  if (syncGoogleSheetsBtn) {
    syncGoogleSheetsBtn.addEventListener('click', async () => {
      if (allLeads.length === 0) return;

      const webhookUrl = GoogleSheetsManager.getSavedWebhookUrl();
      if (!webhookUrl) {
        openSheetsModal();
        setSheetsFeedback('Please configure your Google Apps Script Webhook URL to enable direct Google Sheets sync.', 'error');
        return;
      }

      syncGoogleSheetsBtn.disabled = true;
      syncGoogleSheetsBtn.innerHTML = '<span>⏳</span> Syncing to Sheets...';
      appendLog(`📊 Initiating direct Google Sheets synchronization for ${allLeads.length.toLocaleString()} leads...`);

      try {
        const res = await GoogleSheetsManager.syncLeadsToGoogleSheets(allLeads, {
          onProgress: (p) => {
            syncGoogleSheetsBtn.innerHTML = `<span>⏳</span> Syncing (${p.percentage}%)`;
            if (p.synced % 1500 === 0 || p.synced === allLeads.length) {
              appendLog(`📊 Exported ${p.synced.toLocaleString()} of ${p.total.toLocaleString()} leads to Google Sheets (${p.percentage}%)`);
            }
          }
        });

        appendLog(`🎉 Successfully synchronized ${res.syncedCount.toLocaleString()} leads directly into your Google Sheet!`, 'success');
        alert(`Success! ${res.syncedCount.toLocaleString()} leads have been synchronized directly to your Google Sheet.`);
      } catch (err) {
        appendLog(`❌ Google Sheets Sync Failed: ${err.message}`, 'warning');
        alert(`Google Sheets Sync Error: ${err.message}\n\nPlease verify your Google Apps Script Web App is deployed as 'Anyone' and that the Webhook URL is correct.`);
      } finally {
        syncGoogleSheetsBtn.disabled = false;
        syncGoogleSheetsBtn.innerHTML = '<span>📊</span> Sync to Sheets';
      }
    });
  }

  // 11. Search Filtering
  tableSearchInput.addEventListener('input', () => {
    currentPage = 1;
    applySearchFilter();
    renderActivePage();
  });

  function applySearchFilter() {
    const query = tableSearchInput.value.trim().toLowerCase();
    if (!query) {
      filteredLeads = allLeads;
    } else {
      filteredLeads = allLeads.filter(lead => {
        return (
          lead.businessName.toLowerCase().includes(query) ||
          lead.ownerName.toLowerCase().includes(query) ||
          lead.state.toLowerCase().includes(query) ||
          lead.city.toLowerCase().includes(query) ||
          (lead.phone && lead.phone.toLowerCase().includes(query)) ||
          (lead.website && lead.website.toLowerCase().includes(query)) ||
          (lead.websiteStatus && lead.websiteStatus.toLowerCase().includes(query)) ||
          (lead.source && lead.source.toLowerCase().includes(query))
        );
      });
    }
    tableHeading.textContent = filteredLeads.length.toLocaleString();
  }

  // 12. Update Telemetry Cards
  function updateMetrics(total, phones, websites, velocity) {
    metricTotalLeads.textContent = total.toLocaleString();
    metricVerifiedPhones.textContent = phones.toLocaleString();

    const filter = websiteFilterSelect ? websiteFilterSelect.value : 'with_website';
    if (filter === 'no_website') {
      if (metricWebsitesLabel) metricWebsitesLabel.textContent = 'No-Website Leads';
      if (metricWebsitesIcon) metricWebsitesIcon.textContent = '📵';
      metricWebsites.textContent = total.toLocaleString();
    } else if (filter === 'all') {
      if (metricWebsitesLabel) metricWebsitesLabel.textContent = 'Live Websites';
      if (metricWebsitesIcon) metricWebsitesIcon.textContent = '🌐';
      metricWebsites.textContent = websites.toLocaleString();
    } else {
      if (metricWebsitesLabel) metricWebsitesLabel.textContent = 'Working Websites';
      if (metricWebsitesIcon) metricWebsitesIcon.textContent = '🌐';
      metricWebsites.textContent = websites.toLocaleString();
    }

    metricVelocity.textContent = `${velocity.toLocaleString()} /s`;
  }

  // 13. Website Filter Change Listener
  if (websiteFilterSelect) {
    websiteFilterSelect.addEventListener('change', () => {
      const filter = websiteFilterSelect.value;
      if (filter === 'no_website') {
        if (metricWebsitesLabel) metricWebsitesLabel.textContent = 'No-Website Leads';
        if (metricWebsitesIcon) metricWebsitesIcon.textContent = '📵';
        appendLog('📵 Target mode changed: Filter for confirmed NO-website leads (Agency Outreach).');
      } else if (filter === 'with_website') {
        if (metricWebsitesLabel) metricWebsitesLabel.textContent = 'Working Websites';
        if (metricWebsitesIcon) metricWebsitesIcon.textContent = '🌐';
        appendLog('🌐 Target mode changed: Filter for 100% live verified working websites.');
      } else {
        if (metricWebsitesLabel) metricWebsitesLabel.textContent = 'Live Websites';
        if (metricWebsitesIcon) metricWebsitesIcon.textContent = '🌐';
        appendLog('⚡ Target mode changed: Filter for both live websites & offline leads.');
      }
    });
  }

  // 14. Table Rendering with Pagination & Dynamic Columns
  function renderActivePage() {
    const showWeb = includeWebsitesCheck.checked;
    const showPhone = includePhonesCheck.checked;

    if (filteredLeads.length === 0) {
      leadsTableBody.innerHTML = `
        <tr>
          <td colspan="11">
            <div class="empty-state">
              <div class="empty-icon">🔍</div>
              <p>No matching leads found for "${escapeHtml(tableSearchInput.value)}".</p>
            </div>
          </td>
        </tr>
      `;
      paginationBar.style.display = 'none';
      return;
    }

    paginationBar.style.display = 'flex';
    const totalPages = Math.ceil(filteredLeads.length / PAGE_SIZE);
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const endIdx = Math.min(startIdx + PAGE_SIZE, filteredLeads.length);
    const pageItems = filteredLeads.slice(startIdx, endIdx);

    paginationInfo.textContent = `Showing ${(startIdx + 1).toLocaleString()} to ${endIdx.toLocaleString()} of ${filteredLeads.length.toLocaleString()} leads (Page ${currentPage} of ${totalPages})`;

    prevPageBtn.disabled = (currentPage <= 1);
    nextPageBtn.disabled = (currentPage >= totalPages);

    let html = '';
    for (let i = 0; i < pageItems.length; i++) {
      const lead = pageItems[i];

      const phoneCell = showPhone
        ? `<td><span class="phone-cell">${escapeHtml(lead.phone || 'N/A')}</span></td>`
        : '';

      let websiteCell = '';
      let statusCell = '';

      if (showWeb) {
        if (!lead.website || lead.websiteStatus === 'No Website Detected' || isGoogleMapsUrl(lead.website)) {
          websiteCell = `<td><span class="badge-no-website">📵 None (Offline Lead)</span></td>`;
          statusCell = `<td><span class="badge badge-status-nowebsite">📵 No Website Detected</span></td>`;
        } else {
          const websiteUrl = lead.website;
          const websiteDisplay = websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
          websiteCell = `<td><a href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener noreferrer" class="link-website">${escapeHtml(websiteDisplay)} ↗</a></td>`;
          statusCell = `<td><span class="badge badge-status-online">🟢 ${escapeHtml(lead.websiteStatus || '200 OK (Live)')}</span></td>`;
        }
      }

      const sourceName = lead.source || 'Google Maps';
      const cleanQuery = `${lead.businessName || ''} ${lead.city || ''} ${lead.state || ''}`.trim();
      const sourceUrl = lead.sourceUrl || (lead.website && isGoogleMapsUrl(lead.website) ? lead.website : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cleanQuery)}`);
      const sourceCell = `<td><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer" class="link-source" title="Open ${escapeHtml(sourceName)} Directory Listing">📍 ${escapeHtml(sourceName)} ↗</a></td>`;

      html += `
        <tr>
          <td style="color: var(--text-muted); font-size: 12px;">#${lead.id}</td>
          <td>${lead.countryFlag || '🌍'} ${escapeHtml(lead.country)}</td>
          <td><span style="font-weight: 500; color: #cbd5e1;">${escapeHtml(lead.state)}</span> <span style="font-size: 11px; color: var(--text-muted);">(${escapeHtml(lead.city)})</span></td>
          <td style="font-weight: 600;">
            ${escapeHtml(lead.businessName)}
            ${lead.isChain ? '<span class="badge badge-chain" title="Multi-location brand (> 2 locations)">🏢 Multi-Location</span>' : (lead.isMultiCountry ? '<span class="badge badge-multi-country" title="Multi-country brand">🌐 Multi-Country</span>' : '<span class="badge badge-single-loc" title="Verified Independent Local Business (≤ 2 Locations)">📍 Local (≤2 Loc)</span>')}
          </td>
          <td class="owner-cell">${escapeHtml(lead.ownerName)}</td>
          ${phoneCell}
          ${websiteCell}
          ${statusCell}
          ${sourceCell}
          <td><span class="badge badge-industry">${escapeHtml(lead.industry)}</span></td>
          <td><span class="badge badge-verified">✓ Verified</span></td>
        </tr>
      `;
    }

    leadsTableBody.innerHTML = html;
  }

  function updateTable() {
    applySearchFilter();
    renderActivePage();
  }

  // Pagination navigation
  prevPageBtn.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderActivePage();
    }
  });

  nextPageBtn.addEventListener('click', () => {
    const totalPages = Math.ceil(filteredLeads.length / PAGE_SIZE);
    if (currentPage < totalPages) {
      currentPage++;
      renderActivePage();
    }
  });

  // 14. Supabase Modal & Configuration Management
  function openModal() {
    const config = SupabaseManager.getSavedConfig();
    supabaseUrlInput.value = config.url;
    supabaseKeyInput.value = config.key;
    sqlSchemaPreview.textContent = SupabaseManager.getSqlSchema();
    supabaseFeedbackMsg.style.display = 'none';
    supabaseModal.style.display = 'flex';
  }

  function closeModal() {
    supabaseModal.style.display = 'none';
  }

  cloudConfigOpenBtn.addEventListener('click', openModal);
  openSupabaseModalBtn.addEventListener('click', openModal);
  closeSupabaseModalBtn.addEventListener('click', closeModal);

  supabaseModal.addEventListener('click', (e) => {
    if (e.target === supabaseModal) closeModal();
  });

  function setFeedback(msg, type = 'success') {
    supabaseFeedbackMsg.className = `feedback-msg ${type}`;
    supabaseFeedbackMsg.textContent = msg;
    supabaseFeedbackMsg.style.display = 'block';
  }

  // Test Supabase Connection
  testSupabaseConnectionBtn.addEventListener('click', async () => {
    const url = supabaseUrlInput.value.trim();
    const key = supabaseKeyInput.value.trim();

    testSupabaseConnectionBtn.disabled = true;
    testSupabaseConnectionBtn.innerHTML = '<span>⏳</span> Testing...';

    const res = await SupabaseManager.testConnection(url, key);
    testSupabaseConnectionBtn.disabled = false;
    testSupabaseConnectionBtn.innerHTML = '<span>🔌</span> Test Connection';

    if (res.success) {
      setFeedback(res.message, 'success');
      updateCloudStatusPill(true);
    } else {
      setFeedback(res.message, 'error');
      updateCloudStatusPill(false);
    }
  });

  // Save Supabase Configuration
  saveSupabaseConfigBtn.addEventListener('click', () => {
    const url = supabaseUrlInput.value.trim();
    const key = supabaseKeyInput.value.trim();

    if (!url || !key) {
      setFeedback('Please provide both Project URL and Anon Key.', 'error');
      return;
    }

    SupabaseManager.saveConfig(url, key);
    setFeedback('Supabase credentials saved successfully to local workspace.', 'success');
    updateCloudStatusPill(true);
    appendLog(`☁️ Supabase credentials configured. Ready for cloud database export.`);
    setTimeout(closeModal, 1500);
  });

  // Copy SQL Schema
  copySqlSchemaBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(SupabaseManager.getSqlSchema()).then(() => {
      copySqlSchemaBtn.innerHTML = '<span>✅</span> Copied!';
      setTimeout(() => {
        copySqlSchemaBtn.innerHTML = '<span>📋</span> Copy SQL Schema';
      }, 2000);
    });
  });

  function updateCloudStatusPill(isConnected) {
    if (isConnected) {
      cloudStatusDot.className = 'cloud-dot connected';
      cloudStatusText.textContent = 'Supabase: Connected';
    } else {
      cloudStatusDot.className = 'cloud-dot';
      cloudStatusText.textContent = 'Supabase: Not Configured';
    }
  }

  // Initial cloud status check
  const savedConfig = SupabaseManager.getSavedConfig();
  if (savedConfig.url && savedConfig.key) {
    updateCloudStatusPill(true);
  }

  // 15. Google Sheets Modal & Configuration Management
  function openSheetsModal() {
    if (!sheetsModal) return;
    const url = GoogleSheetsManager.getSavedWebhookUrl();
    if (sheetsWebhookUrlInput) sheetsWebhookUrlInput.value = url;
    if (appsScriptPreview) appsScriptPreview.textContent = GoogleSheetsManager.getGoogleAppsScriptCode();
    if (sheetsFeedbackMsg) sheetsFeedbackMsg.style.display = 'none';
    sheetsModal.style.display = 'flex';
  }

  function closeSheetsModal() {
    if (sheetsModal) sheetsModal.style.display = 'none';
  }

  if (openSheetsModalBtn) openSheetsModalBtn.addEventListener('click', openSheetsModal);
  if (closeSheetsModalBtn) closeSheetsModalBtn.addEventListener('click', closeSheetsModal);

  if (sheetsModal) {
    sheetsModal.addEventListener('click', (e) => {
      if (e.target === sheetsModal) closeSheetsModal();
    });
  }

  function setSheetsFeedback(msg, type = 'success') {
    if (!sheetsFeedbackMsg) return;
    sheetsFeedbackMsg.className = `feedback-msg ${type}`;
    sheetsFeedbackMsg.textContent = msg;
    sheetsFeedbackMsg.style.display = 'block';
  }

  // Test Sheets Connection
  if (testSheetsConnectionBtn) {
    testSheetsConnectionBtn.addEventListener('click', async () => {
      const url = sheetsWebhookUrlInput ? sheetsWebhookUrlInput.value.trim() : '';
      testSheetsConnectionBtn.disabled = true;
      testSheetsConnectionBtn.innerHTML = '<span>⏳</span> Testing...';

      const res = await GoogleSheetsManager.testConnection(url);
      testSheetsConnectionBtn.disabled = false;
      testSheetsConnectionBtn.innerHTML = '<span>🔌</span> Test Webhook';

      if (res.success) {
        setSheetsFeedback(res.message, 'success');
      } else {
        setSheetsFeedback(res.message, 'error');
      }
    });
  }

  // Save Sheets Configuration
  if (saveSheetsConfigBtn) {
    saveSheetsConfigBtn.addEventListener('click', () => {
      const url = sheetsWebhookUrlInput ? sheetsWebhookUrlInput.value.trim() : '';
      if (!url) {
        setSheetsFeedback('Please enter your Google Apps Script Web App URL.', 'error');
        return;
      }

      GoogleSheetsManager.saveWebhookUrl(url);
      setSheetsFeedback('Google Sheets Webhook URL saved successfully!', 'success');
      appendLog(`📊 Google Sheets Webhook configured. Ready for direct spreadsheet synchronization.`);
      setTimeout(closeSheetsModal, 1500);
    });
  }

  // Copy Apps Script Code
  if (copyAppsScriptBtn) {
    copyAppsScriptBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(GoogleSheetsManager.getGoogleAppsScriptCode()).then(() => {
        copyAppsScriptBtn.innerHTML = '<span>✅</span> Copied Script!';
        setTimeout(() => {
          copyAppsScriptBtn.innerHTML = '<span>📋</span> Copy Apps Script Code';
        }, 2000);
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function(m) {
      switch (m) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#039;';
        default: return m;
      }
    });
  }
});
