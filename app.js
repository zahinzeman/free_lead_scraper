/**
 * Free Lead Scraper - Application Controller
 * Connects frontend UI to real-data SSE streaming backend (/api/stream-scrape),
 * dynamically loads provider allowlists, manages verification tabs, and handles exports.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Form Controls
  const countrySelect = document.getElementById('countrySelect');
  const stateSelect = document.getElementById('stateSelect');
  const industrySelect = document.getElementById('industrySelect');
  const primarySourceSelect = document.getElementById('primarySourceSelect');
  const fallbackSourceSelect = document.getElementById('fallbackSourceSelect');
  const verificationMethodSelect = document.getElementById('verificationMethodSelect');
  const websiteFilterSelect = document.getElementById('websiteFilterSelect');
  const includePhonesCheck = document.getElementById('includePhonesCheck');
  const excludeChainsCheck = document.getElementById('excludeChainsCheck');
  const quotaBtns = document.querySelectorAll('.quota-btn');
  const selectedQuotaInput = document.getElementById('selectedQuotaInput');

  // Action Buttons
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

  // Modals & Feedback
  const sheetsModal = document.getElementById('sheetsModal');
  const closeSheetsModalBtn = document.getElementById('closeSheetsModalBtn');
  const sheetsWebhookUrlInput = document.getElementById('sheetsWebhookUrlInput');
  const testSheetsConnectionBtn = document.getElementById('testSheetsConnectionBtn');
  const saveSheetsConfigBtn = document.getElementById('saveSheetsConfigBtn');
  const copyAppsScriptBtn = document.getElementById('copyAppsScriptBtn');
  const appsScriptPreview = document.getElementById('appsScriptPreview');
  const sheetsFeedbackMsg = document.getElementById('sheetsFeedbackMsg');

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

  // Metrics & Telemetry
  const systemPulse = document.getElementById('systemPulse');
  const systemStatusText = document.getElementById('systemStatusText');
  const metricTotalLeads = document.getElementById('metricTotalLeads');
  const metricConfirmedNoWebsite = document.getElementById('metricConfirmedNoWebsite');
  const metricSocialOnly = document.getElementById('metricSocialOnly');
  const metricWebsites = document.getElementById('metricWebsites');
  const metricUncertain = document.getElementById('metricUncertain');

  // Progress & Terminal
  const progressStatusLabel = document.getElementById('progressStatusLabel');
  const progressPercentageText = document.getElementById('progressPercentageText');
  const progressBarFill = document.getElementById('progressBarFill');
  const terminalLog = document.getElementById('terminalLog');

  // Tabs & Table
  const tabAll = document.getElementById('tabAll');
  const tabNoWebsite = document.getElementById('tabNoWebsite');
  const tabNoWebsiteSocialOnly = document.getElementById('tabNoWebsiteSocialOnly');
  const tabWithWebsite = document.getElementById('tabWithWebsite');
  const tabUncertain = document.getElementById('tabUncertain');
  const tabCountAll = document.getElementById('tabCountAll');
  const tabCountNoWebsite = document.getElementById('tabCountNoWebsite');
  const tabCountNoWebsiteSocialOnly = document.getElementById('tabCountNoWebsiteSocialOnly');
  const tabCountWithWebsite = document.getElementById('tabCountWithWebsite');
  const tabCountUncertain = document.getElementById('tabCountUncertain');

  const tableHeading = document.getElementById('tableLeadCount');
  const leadsTableBody = document.getElementById('leadsTableBody');
  const tableSearchInput = document.getElementById('tableSearchInput');
  const paginationBar = document.getElementById('paginationBar');
  const paginationInfo = document.getElementById('paginationInfo');
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');

  // State Management
  let allLeads = [];
  let currentTab = 'all';
  let currentPage = 1;
  const PAGE_SIZE = 25;
  let activeEventSource = null;
  let isPaused = false;

  // 1. Populate States for Country
  function populateStatesForCountry(countryName) {
    if (typeof ScraperEngine === 'undefined') return;
    const states = ScraperEngine.getStatesForCountry(countryName);
    stateSelect.innerHTML = '';
    states.forEach(state => {
      const opt = document.createElement('option');
      opt.value = state.code;
      opt.textContent = state.code === 'ALL' ? `🌐 ${state.name}` : `${state.name} (${state.code})`;
      stateSelect.appendChild(opt);
    });
  }

  // 2. Load Providers dynamically from backend
  async function loadProvidersForCountry(countryName) {
    try {
      const res = await fetch(`/api/providers?country=${encodeURIComponent(countryName)}`);
      if (!res.ok) return;
      const data = await res.json();
      const providers = data.providers || [];

      // Group providers
      const groups = {};
      providers.forEach(p => {
        const grp = p.group || 'Other';
        if (!groups[grp]) groups[grp] = [];
        groups[grp].push(p);
      });

      primarySourceSelect.innerHTML = '';
      fallbackSourceSelect.innerHTML = '<option value="">None (Primary Only)</option>';

      for (const [groupName, list] of Object.entries(groups)) {
        const optgroupPrimary = document.createElement('optgroup');
        optgroupPrimary.label = groupName;

        const optgroupFallback = document.createElement('optgroup');
        optgroupFallback.label = groupName;

        list.forEach(p => {
          const optP = document.createElement('option');
          optP.value = p.id;
          optP.textContent = p.label;
          if (p.needsFreeKey && !p.configured) {
            optP.disabled = true;
          }
          optgroupPrimary.appendChild(optP);

          if (p.id !== 'auto') {
            const optF = document.createElement('option');
            optF.value = p.id;
            optF.textContent = p.label;
            if (p.needsFreeKey && !p.configured) {
              optF.disabled = true;
            }
            optgroupFallback.appendChild(optF);
          }
        });

        primarySourceSelect.appendChild(optgroupPrimary);
        if (optgroupFallback.children.length > 0) {
          fallbackSourceSelect.appendChild(optgroupFallback);
        }
      }

      // Default to auto
      primarySourceSelect.value = 'auto';
    } catch (err) {
      console.warn('Failed to load providers from backend:', err);
    }
  }

  // 3. Update Search Telemetry Status
  async function updateSearchTelemetry() {
    try {
      const res = await fetch('/api/search-status');
      if (res.ok) {
        const status = await res.json();
        const backendName = status.activeBackend === 'searxng' ? 'SearXNG (Docker)' : 'DuckDuckGo HTML';
        const blockRate = (status && typeof status.blockRatePercent === 'number') ? status.blockRatePercent : 0;
        systemStatusText.textContent = `Ready | Search: ${backendName} (${blockRate}% block rate)`;
      }
    } catch (e) {}
  }

  // Initialize dropdowns & telemetry
  populateStatesForCountry(countrySelect.value);
  loadProvidersForCountry(countrySelect.value);
  updateSearchTelemetry();

  countrySelect.addEventListener('change', () => {
    populateStatesForCountry(countrySelect.value);
    loadProvidersForCountry(countrySelect.value);
    appendLog(`🌍 Selected country: ${countrySelect.value}. Available sources updated.`);
  });

  // Quota buttons
  quotaBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      quotaBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedQuotaInput.value = btn.dataset.quota;
    });
  });

  // Tabs switching
  const tabBtns = [tabAll, tabNoWebsite, tabNoWebsiteSocialOnly, tabWithWebsite, tabUncertain].filter(Boolean);
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      currentPage = 1;
      renderActivePage();
    });
  });

  // Logging helper
  function appendLog(msg, type = 'info') {
    const line = document.createElement('div');
    line.className = `terminal-line ${type}`;
    const time = new Date().toLocaleTimeString();
    line.textContent = `[${time}] ${msg}`;
    terminalLog.appendChild(line);
    terminalLog.scrollTop = terminalLog.scrollHeight;
  }

  // Metrics helper
  function updateMetrics(total, noWeb, hasWeb, uncertain, socialOnly = 0) {
    if (metricTotalLeads) metricTotalLeads.textContent = total.toLocaleString();
    if (metricConfirmedNoWebsite) metricConfirmedNoWebsite.textContent = noWeb.toLocaleString();
    if (metricSocialOnly) metricSocialOnly.textContent = socialOnly.toLocaleString();
    if (metricWebsites) metricWebsites.textContent = hasWeb.toLocaleString();
    if (metricUncertain) metricUncertain.textContent = uncertain.toLocaleString();

    if (tabCountAll) tabCountAll.textContent = total.toLocaleString();
    if (tabCountNoWebsite) tabCountNoWebsite.textContent = noWeb.toLocaleString();
    if (tabCountNoWebsiteSocialOnly) tabCountNoWebsiteSocialOnly.textContent = socialOnly.toLocaleString();
    if (tabCountWithWebsite) tabCountWithWebsite.textContent = hasWeb.toLocaleString();
    if (tabCountUncertain) tabCountUncertain.textContent = uncertain.toLocaleString();
  }

  // Filter leads according to active tab and search query
  function getFilteredLeads() {
    let list = allLeads;

    if (currentTab === 'no_website') {
      list = list.filter(l => l.websiteCheckStatus === 'Confirmed no website');
    } else if (currentTab === 'no_website_social_only') {
      list = list.filter(l => l.websiteCheckStatus === 'No website found (social only, bio unread)');
    } else if (currentTab === 'with_website') {
      list = list.filter(l => l.websiteCheckStatus === 'Has website');
    } else if (currentTab === 'uncertain') {
      list = list.filter(l => l.websiteCheckStatus === 'Uncertain');
    }

    const query = tableSearchInput.value.trim().toLowerCase();
    if (!query) return list;

    return list.filter(l => {
      return (
        (l.businessName && l.businessName.toLowerCase().includes(query)) ||
        (l.city && l.city.toLowerCase().includes(query)) ||
        (l.phone && l.phone.toLowerCase().includes(query)) ||
        (l.websiteEvidence && l.websiteEvidence.toLowerCase().includes(query)) ||
        (l.sourceProvider && l.sourceProvider.toLowerCase().includes(query))
      );
    });
  }

  // Render active page
  function renderActivePage() {
    const list = getFilteredLeads();
    tableHeading.textContent = list.length.toLocaleString();

    if (list.length === 0) {
      leadsTableBody.innerHTML = `
        <tr>
          <td colspan="10">
            <div class="empty-state">
              <div class="empty-icon">📁</div>
              <p>No leads found matching current filter.</p>
            </div>
          </td>
        </tr>
      `;
      paginationBar.style.display = 'none';
      return;
    }

    const totalPages = Math.ceil(list.length / PAGE_SIZE) || 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const pageItems = list.slice(startIdx, startIdx + PAGE_SIZE);

    leadsTableBody.innerHTML = '';
    pageItems.forEach((lead, i) => {
      const row = document.createElement('tr');
      const idx = startIdx + i + 1;

      // Status pill class & label
      let statusClass = 'status-pill live';
      let statusText = 'Has website';
      if (lead.websiteCheckStatus === 'Confirmed no website') {
        statusClass = 'status-pill offline';
        statusText = 'Confirmed No Website';
      } else if (lead.websiteCheckStatus === 'No website found (social only, bio unread)') {
        statusClass = 'status-pill social-only';
        statusText = 'Social Only (Bio Unread)';
      } else if (lead.websiteCheckStatus === 'Uncertain') {
        statusClass = 'status-pill uncertain';
        statusText = 'Uncertain (Review)';
      }

      // Confidence badge
      const conf = (lead.confidence || 'medium').toLowerCase();
      const confClass = conf === 'high' ? 'badge-confidence-high' : (conf === 'low' ? 'badge-confidence-low' : 'badge-confidence-medium');
      const confBadge = `<span class="${confClass}">${conf}</span>`;

      // Website URL link
      const webCell = lead.website && lead.website.startsWith('http')
        ? `<a href="${lead.website}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8; text-decoration:underline;">${lead.website}</a>`
        : `<span style="color:var(--text-muted);">—</span>`;

      // Social profile link
      const socialCell = lead.socialProfile && lead.socialProfile.startsWith('http')
        ? `<a href="${lead.socialProfile}" target="_blank" rel="noopener noreferrer" style="color:#a855f7; text-decoration:underline;">Social Link</a>`
        : `<span style="color:var(--text-muted);">—</span>`;

      // Source URL badge
      const sourceBadge = lead.sourceUrl
        ? `<a href="${lead.sourceUrl}" target="_blank" rel="noopener noreferrer" class="source-badge"><span>🔗</span> ${lead.sourceProvider || 'Source'}</a>`
        : `<span class="source-badge">${lead.sourceProvider || 'Source'}</span>`;

      row.innerHTML = `
        <td>${idx}</td>
        <td><strong>${escapeHtml(lead.businessName || lead.name)}</strong></td>
        <td>${escapeHtml(lead.city || '')}${lead.state ? ', ' + escapeHtml(lead.state) : ''}</td>
        <td>${lead.phone ? `<code>${escapeHtml(lead.phone)}</code>` : '<span style="color:var(--text-muted);">—</span>'}</td>
        <td><span class="${statusClass}">${statusText}</span></td>
        <td>${confBadge}</td>
        <td>${webCell}</td>
        <td class="evidence-cell">${escapeHtml(lead.websiteEvidence || 'Direct source tag')}</td>
        <td>${sourceBadge}</td>
        <td>${socialCell}</td>
      `;
      leadsTableBody.appendChild(row);
    });

    paginationBar.style.display = totalPages > 1 ? 'flex' : 'none';
    paginationInfo.textContent = `Showing ${startIdx + 1} to ${Math.min(startIdx + PAGE_SIZE, list.length)} of ${list.length} leads`;
    prevPageBtn.disabled = (currentPage === 1);
    nextPageBtn.disabled = (currentPage === totalPages);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  tableSearchInput.addEventListener('input', () => {
    currentPage = 1;
    renderActivePage();
  });

  prevPageBtn.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderActivePage();
    }
  });

  nextPageBtn.addEventListener('click', () => {
    currentPage++;
    renderActivePage();
  });

  // 4. Start Scraper Execution
  startBtn.addEventListener('click', () => {
    const country = countrySelect.value;
    const stateCode = stateSelect.value;
    const industry = industrySelect.value;
    const primarySource = primarySourceSelect.value;
    const fallbackSource = fallbackSourceSelect.value;
    const verificationMethod = verificationMethodSelect.value;
    const websiteFilter = websiteFilterSelect.value;
    const includePhones = includePhonesCheck.checked;
    const excludeChains = excludeChainsCheck.checked;
    const quota = parseInt(selectedQuotaInput.value, 10) || 50;

    // Reset UI
    allLeads = [];
    currentPage = 1;
    updateMetrics(0, 0, 0, 0);
    renderActivePage();

    systemPulse.className = 'pulse-dot running';
    systemStatusText.textContent = 'Mining Real Data...';
    startBtn.disabled = true;
    pauseBtn.disabled = true; // Stream cannot be paused mid-flight without disconnect
    stopBtn.disabled = false;
    downloadBtn.disabled = true;
    syncGoogleSheetsBtn.disabled = true;
    syncSupabaseBtn.disabled = true;

    countrySelect.disabled = true;
    stateSelect.disabled = true;
    industrySelect.disabled = true;
    primarySourceSelect.disabled = true;
    fallbackSourceSelect.disabled = true;
    verificationMethodSelect.disabled = true;
    websiteFilterSelect.disabled = true;
    includePhonesCheck.disabled = true;
    excludeChainsCheck.disabled = true;
    quotaBtns.forEach(b => b.disabled = true);

    progressBarFill.style.width = '0%';
    progressPercentageText.textContent = '0%';
    progressStatusLabel.textContent = `Streaming ${industry} leads in ${country}...`;

    const params = new URLSearchParams({
      country,
      state: stateCode,
      industry,
      quota,
      primarySource,
      fallbackSource,
      verificationMethod,
      websiteFilter,
      includePhones,
      excludeChains
    });

    const streamUrl = `/api/stream-scrape?${params.toString()}`;
    activeEventSource = new EventSource(streamUrl);

    activeEventSource.addEventListener('log', (e) => {
      const data = JSON.parse(e.data);
      appendLog(data.message);
    });

    activeEventSource.addEventListener('source_count', (e) => {
      const data = JSON.parse(e.data);
      appendLog(`📡 [${data.source}] Identified ${data.count} candidate businesses`, 'success');
    });

    activeEventSource.addEventListener('lead', (e) => {
      const lead = JSON.parse(e.data);
      allLeads.push(lead);
      renderActivePage();
      downloadCountBadge.textContent = allLeads.length.toLocaleString();
    });

    activeEventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      progressBarFill.style.width = `${data.percentage}%`;
      progressPercentageText.textContent = `${data.percentage.toFixed(1)}%`;
      updateMetrics(data.total, data.confirmedNoWebsite, data.hasWebsite, data.uncertain, data.noWebsiteSocialOnly || 0);
    });

    activeEventSource.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data);
      appendLog(`🏁 Finished: ${data.totalFound} real businesses audited.`, 'success');
      finishRun();
    });

    activeEventSource.addEventListener('error', (e) => {
      // A server-sent "error" event carries a message; a dropped connection does not.
      let serverMessage = '';
      try { serverMessage = e.data ? JSON.parse(e.data).message : ''; } catch (_) {}
      if (serverMessage) {
        appendLog(`❌ ${serverMessage}`, 'error');
      } else {
        appendLog('⚠️ Lost connection to the scraper server. Make sure `node server.js` is still running, then refresh the page.', 'warning');
      }
      finishRun();
    });
  });

  function finishRun() {
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }

    systemPulse.className = 'pulse-dot';
    systemStatusText.textContent = 'Extraction Complete';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;

    countrySelect.disabled = false;
    stateSelect.disabled = false;
    industrySelect.disabled = false;
    primarySourceSelect.disabled = false;
    fallbackSourceSelect.disabled = false;
    verificationMethodSelect.disabled = false;
    websiteFilterSelect.disabled = false;
    includePhonesCheck.disabled = false;
    excludeChainsCheck.disabled = false;
    quotaBtns.forEach(b => b.disabled = false);

    if (allLeads.length > 0) {
      downloadBtn.disabled = false;
      syncGoogleSheetsBtn.disabled = false;
      syncSupabaseBtn.disabled = false;
      downloadCountBadge.textContent = allLeads.length.toLocaleString();
    }
  }

  // Stop button
  stopBtn.addEventListener('click', () => {
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }
    appendLog('🛑 Stream stopped by user.');
    finishRun();
  });

  // Clear button
  clearBtn.addEventListener('click', () => {
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }
    allLeads = [];
    currentPage = 1;
    updateMetrics(0, 0, 0, 0);
    renderActivePage();
    progressBarFill.style.width = '0%';
    progressPercentageText.textContent = '0%';
    downloadBtn.disabled = true;
    syncGoogleSheetsBtn.disabled = true;
    syncSupabaseBtn.disabled = true;
    downloadCountBadge.textContent = '0';
    finishRun();
    appendLog('🧹 Cleared all lead records from dashboard.');
  });

  // Download CSV
  downloadBtn.addEventListener('click', () => {
    const exportSubset = getFilteredLeads();
    if (exportSubset.length === 0) {
      alert('No leads available in current tab to export.');
      return;
    }

    appendLog(`📦 Exporting ${exportSubset.length} leads (${currentTab} tab) to CSV...`);
    CsvExporter.exportLeadsToCsv(exportSubset, {
      country: countrySelect.value,
      industry: industrySelect.value,
      currentTab
    });
  });

  // Supabase sync
  syncSupabaseBtn.addEventListener('click', async () => {
    const exportSubset = getFilteredLeads();
    if (exportSubset.length === 0) return;

    syncSupabaseBtn.disabled = true;
    syncSupabaseBtn.innerHTML = '<span>⏳</span> Syncing...';
    try {
      const res = await SupabaseManager.syncLeadsToSupabase(exportSubset, {
        onProgress: (p) => {
          syncSupabaseBtn.innerHTML = `<span>⏳</span> Syncing (${p.percentage}%)`;
        }
      });
      alert(`Success! ${res.syncedCount} leads synchronized to Supabase.`);
      appendLog(`🎉 Synced ${res.syncedCount} leads to Supabase!`, 'success');
    } catch (err) {
      alert(`Supabase Sync Error: ${err.message}`);
      appendLog(`❌ Supabase Error: ${err.message}`, 'warning');
    } finally {
      syncSupabaseBtn.disabled = false;
      syncSupabaseBtn.innerHTML = '<span>☁️</span> Sync to Supabase';
    }
  });

  // Google Sheets sync
  syncGoogleSheetsBtn.addEventListener('click', async () => {
    const exportSubset = getFilteredLeads();
    if (exportSubset.length === 0) return;

    syncGoogleSheetsBtn.disabled = true;
    syncGoogleSheetsBtn.innerHTML = '<span>⏳</span> Syncing to Sheets...';
    try {
      const res = await GoogleSheetsManager.syncLeadsToGoogleSheets(exportSubset, {
        onProgress: (p) => {
          syncGoogleSheetsBtn.innerHTML = `<span>⏳</span> Syncing (${p.percentage}%)`;
        }
      });
      alert(`Success! ${res.syncedCount} leads synchronized directly to Google Sheets.`);
      appendLog(`🎉 Synced ${res.syncedCount} leads to Google Sheets!`, 'success');
    } catch (err) {
      alert(`Google Sheets Error: ${err.message}`);
      appendLog(`❌ Google Sheets Error: ${err.message}`, 'warning');
    } finally {
      syncGoogleSheetsBtn.disabled = false;
      syncGoogleSheetsBtn.innerHTML = '<span>📊</span> Sync to Sheets';
    }
  });

  // Modals management
  function openSupabaseModal() {
    const config = SupabaseManager.getSavedConfig();
    supabaseUrlInput.value = config.url || '';
    supabaseKeyInput.value = config.key || '';
    sqlSchemaPreview.textContent = SupabaseManager.getSqlSchema();
    supabaseModal.style.display = 'flex';
    supabaseModal.setAttribute('aria-hidden', 'false');
  }

  function closeSupabaseModal() {
    supabaseModal.style.display = 'none';
    supabaseModal.setAttribute('aria-hidden', 'true');
  }

  openSupabaseModalBtn.addEventListener('click', openSupabaseModal);
  cloudConfigOpenBtn.addEventListener('click', openSupabaseModal);
  closeSupabaseModalBtn.addEventListener('click', closeSupabaseModal);

  saveSupabaseConfigBtn.addEventListener('click', () => {
    SupabaseManager.saveConfig(supabaseUrlInput.value, supabaseKeyInput.value);
    alert('Supabase credentials saved locally.');
    closeSupabaseModal();
  });

  copySqlSchemaBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(SupabaseManager.getSqlSchema());
    alert('SQL Schema copied to clipboard! Paste it into Supabase SQL Editor.');
  });

  // Sheets modal
  function openSheetsModal() {
    const config = GoogleSheetsManager.getSavedConfig();
    sheetsWebhookUrlInput.value = config.webhookUrl || '';
    appsScriptPreview.textContent = GoogleSheetsManager.getAppsScriptCode();
    sheetsModal.style.display = 'flex';
    sheetsModal.setAttribute('aria-hidden', 'false');
  }

  function closeSheetsModal() {
    sheetsModal.style.display = 'none';
    sheetsModal.setAttribute('aria-hidden', 'true');
  }

  openSheetsModalBtn.addEventListener('click', openSheetsModal);
  closeSheetsModalBtn.addEventListener('click', closeSheetsModal);

  saveSheetsConfigBtn.addEventListener('click', () => {
    GoogleSheetsManager.saveConfig(sheetsWebhookUrlInput.value);
    alert('Google Sheets Webhook URL saved locally.');
    closeSheetsModal();
  });

  copyAppsScriptBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(GoogleSheetsManager.getAppsScriptCode());
    alert('Google Apps Script code copied to clipboard!');
  });
});
