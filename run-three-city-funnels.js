/**
 * Multi-City Funnel and No-Website Audit Runner (Resumable & Crash-Proof)
 *
 * Runs real discovery, locality filtering, closed filtering, deduplication,
 * chain removal, and verification across:
 * 1. London + Bakeries
 * 2. Manchester + Locksmiths
 * 3. Leeds + Bakeries
 *
 * Saves progress immediately to disk (results-<city>-<industry>.jsonl) after each lead.
 * Can be resumed seamlessly at any time without repeating work.
 * Exports all leads in "Confirmed no website" and "No website found (social only)"
 * to no-website-leads-to-check.csv.
 */

const fs = require('fs');
const path = require('path');
const osmProvider = require('./providers/osm-provider');
const overtureProvider = require('./providers/overture-provider');
const fsaProvider = require('./providers/fsa-provider');
const { dedupeLeads, applyRealChainFilter, isClosedBusiness } = require('./utils/normalizer');
const { validateLocality } = require('./utils/locality-filter');
const websiteVerifier = require('./verifier/index');
const searchBackendManager = require('./verifier/search-backends');
const rateLimiter = require('./utils/rate-limiter');

const BATCH_SIZE = 100;

process.on('unhandledRejection', (reason, promise) => {
  console.warn('[Global] Unhandled Rejection:', reason && reason.message ? reason.message : reason);
});

process.on('uncaughtException', (err) => {
  console.warn('[Global] Uncaught Exception:', err && err.message ? err.message : err);
});

function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

function getLeadKey(lead) {
  const name = (lead.name || '').toLowerCase().trim();
  const pc = (lead.postcode || '').toLowerCase().trim();
  const addr = (lead.address || '').toLowerCase().trim();
  return `${name}|${pc || addr}`;
}

async function runPipelineForCity(criteria) {
  const { city, industry, country = 'United Kingdom' } = criteria;
  const safeCity = city.replace(/[^a-zA-Z0-9]/g, '_');
  const safeInd = industry.replace(/[^a-zA-Z0-9]/g, '_');
  const jsonlFilename = `results-${safeCity}-${safeInd}.jsonl`;
  const jsonlPath = path.join(__dirname, jsonlFilename);

  console.log(`\n======================================================`);
  console.log(`🚀 RUNNING PIPELINE: ${city} + ${industry}`);
  console.log(`   Persistence file: ${jsonlFilename}`);
  console.log(`======================================================\n`);

  // Step 1: Discover candidates from open data sources
  console.log(`⏳ Step 1: Discovering candidates from open data sources...`);
  const rawOsm = await osmProvider.fetchCandidates({ ...criteria, quota: 1000 }).catch(e => {
    console.warn(`  [OSM Error] ${e.message}`);
    return [];
  });
  const rawOverture = await overtureProvider.fetchCandidates({ ...criteria, quota: 500 }).catch(e => {
    console.warn(`  [Overture Error] ${e.message}`);
    return [];
  });
  let rawFsa = [];
  if (country === 'United Kingdom' && (industry === 'Bakeries' || industry === 'All')) {
    rawFsa = await fsaProvider.fetchCandidates({ ...criteria, quota: 500 }).catch(e => {
      console.warn(`  [FSA Error] ${e.message}`);
      return [];
    });
  }

  const osmStats = osmProvider.getStats ? osmProvider.getStats() : { raw: rawOsm.length, rejectedByLocality: 0, accepted: rawOsm.length };
  const ovtStats = overtureProvider.getStats ? overtureProvider.getStats() : { raw: rawOverture.length, rejectedByLocality: 0, accepted: rawOverture.length };
  const fsaStats = fsaProvider.getStats ? fsaProvider.getStats() : { raw: rawFsa.length, rejectedByLocality: 0, accepted: rawFsa.length };

  console.log(`\n--- Per-Provider Locality Filter Breakdown ---`);
  console.log(`  • OpenStreetMap:              raw=${osmStats.raw}, rejectedByLocality=${osmStats.rejectedByLocality}, accepted=${osmStats.accepted}`);
  if (osmProvider.lastLocalityRejections && osmProvider.lastLocalityRejections.length > 0) {
    console.log(`    Top 5 OSM Locality Rejection Examples:`);
    osmProvider.lastLocalityRejections.slice(0, 5).forEach((r, idx) => {
      console.log(`      ${idx + 1}. "${r.name}" (${r.address || r.postcode || 'No addr'}) -> ${r.reason}`);
    });
  }

  console.log(`  • Overture Maps Foundation:   raw=${ovtStats.raw}, rejectedByLocality=${ovtStats.rejectedByLocality}, accepted=${ovtStats.accepted}`);
  if (overtureProvider.lastLocalityRejections && overtureProvider.lastLocalityRejections.length > 0) {
    console.log(`    Top 5 Overture Locality Rejection Examples:`);
    overtureProvider.lastLocalityRejections.slice(0, 5).forEach((r, idx) => {
      console.log(`      ${idx + 1}. "${r.name}" (${r.address || r.postcode || 'No addr'}) -> ${r.reason}`);
    });
  }

  if (rawFsa.length > 0 || fsaStats.raw > 0) {
    console.log(`  • UK Food Hygiene (FSA):      raw=${fsaStats.raw}, rejectedByLocality=${fsaStats.rejectedByLocality}, accepted=${fsaStats.accepted}`);
    if (fsaProvider.lastLocalityRejections && fsaProvider.lastLocalityRejections.length > 0) {
      console.log(`    Top 5 FSA Locality Rejection Examples:`);
      fsaProvider.lastLocalityRejections.slice(0, 5).forEach((r, idx) => {
        console.log(`      ${idx + 1}. "${r.name}" (${r.address || r.postcode || 'No addr'}) -> ${r.reason}`);
      });
    }
  }

  const allRaw = [...rawOsm, ...rawOverture, ...rawFsa];
  const totalRawCount = osmStats.raw + ovtStats.raw + fsaStats.raw;
  const totalLocalityRejected = osmStats.rejectedByLocality + ovtStats.rejectedByLocality + fsaStats.rejectedByLocality;
  console.log(`\n  Total raw collected: ${totalRawCount} | Total locality rejected: ${totalLocalityRejected} | Accepted: ${allRaw.length}`);

  // Step 2: Locality filter verification
  console.log(`\n⏳ Step 2: Evaluating unified locality boundaries...`);
  const localityRejected = [];
  const afterLocality = [];
  for (const c of allRaw) {
    const loc = validateLocality(c, city, '', country);
    if (loc.isMatch) {
      afterLocality.push(c);
    } else {
      localityRejected.push({
        name: c.name,
        address: c.address,
        postcode: c.postcode,
        source: c.sourceProvider,
        reason: loc.reason
      });
    }
  }
  console.log(`  • Unified Locality Accepted: ${afterLocality.length}`);
  console.log(`  • Unified Locality Rejected: ${localityRejected.length}`);

  // Step 3: Closed business removal
  console.log(`\n⏳ Step 3: Filtering closed / disused businesses...`);
  const closedRejected = [];
  const afterClosed = [];
  for (const c of afterLocality) {
    if (isClosedBusiness(c)) {
      closedRejected.push(c);
    } else {
      afterClosed.push(c);
    }
  }
  console.log(`  • Active businesses: ${afterClosed.length}`);
  console.log(`  • Closed businesses filtered: ${closedRejected.length}`);

  // Step 4: Deduplication
  console.log(`\n⏳ Step 4: Deduplicating across sources...`);
  const afterDedupe = dedupeLeads(afterClosed);
  const duplicatesMerged = afterClosed.length - afterDedupe.length;
  console.log(`  • Unique candidates after dedupe: ${afterDedupe.length} (merged ${duplicatesMerged} duplicates)`);

  // Step 5: Chain filter
  console.log(`\n⏳ Step 5: Applying chain rule (max 2 locations & brand blocklist)...`);
  const { filteredLeads: afterChainFilter, chainExcludedCount, excludedChains } = applyRealChainFilter(afterDedupe, 2);
  console.log(`  • Independent local businesses: ${afterChainFilter.length} (filtered ${chainExcludedCount} chains)`);

  // Step 6: Full Verification Waterfall (Resumable, Batched & with Retry Pass)
  const candidatesToVerify = afterChainFilter;
  console.log(`\n⏳ Step 6: Executing 6-layer verification waterfall on ALL ${candidatesToVerify.length} candidates...\n`);

  // Load existing progress from disk
  const savedRecordsMap = new Map();
  if (fs.existsSync(jsonlPath)) {
    try {
      const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          const key = getLeadKey(record);
          savedRecordsMap.set(key, record);
        } catch (e) {}
      }
    } catch (readErr) {
      console.warn(`  [Warning] Could not read existing jsonl file: ${readErr.message}`);
    }
  }

  const loadedCount = savedRecordsMap.size;
  console.log(`======================================================`);
  console.log(`💾 [Resume] Found existing ${jsonlFilename}: loaded ${loadedCount} already verified leads.`);
  console.log(`⏩ Resuming run: skipped ${loadedCount} leads as already done.`);

  const remainingCandidates = candidatesToVerify.filter(c => !savedRecordsMap.has(getLeadKey(c)));
  console.log(`▶️  Remaining leads to verify in ${city}: ${remainingCandidates.length} of ${candidatesToVerify.length}\n`);

  if (remainingCandidates.length === 0) {
    console.log(`✅ All ${candidatesToVerify.length} leads for ${city} are already verified!`);
  } else {
    // Requirement 4: Run in batches of 100 leads per city
    const currentBatch = remainingCandidates.slice(0, BATCH_SIZE);
    console.log(`📦 Running Batch: processing next ${currentBatch.length} leads (leads ${loadedCount + 1} to ${loadedCount + currentBatch.length} of ${candidatesToVerify.length})...\n`);

    const t0 = Date.now();

    for (let i = 0; i < currentBatch.length; i++) {
      const candidate = currentBatch[i];
      let res;
      const leadT0 = Date.now();

      try {
        res = await websiteVerifier.verifyLead(candidate);
      } catch (err) {
        console.warn(`  [Verify Error on ${candidate.name}] ${err.message}`);
        res = {
          websiteCheckStatus: 'Uncertain (error)',
          websiteUrl: '',
          socialProfile: '',
          confidence: 'low',
          websiteEvidence: `UNCERTAIN (verification error: ${err.message}); Trail: Exception caught during verification`,
          checkedAt: new Date().toISOString()
        };
      }

      const leadDuration = ((Date.now() - leadT0) / 1000).toFixed(1);
      const enriched = {
        ...candidate,
        ...res,
        runCity: city,
        runIndustry: industry
      };

      // Save immediately to disk after every single lead
      try {
        fs.appendFileSync(jsonlPath, JSON.stringify(enriched) + '\n', 'utf8');
      } catch (saveErr) {
        console.error(`  [Persistence Error] Failed to append to ${jsonlPath}:`, saveErr.message);
      }

      const leadKey = getLeadKey(enriched);
      savedRecordsMap.set(leadKey, enriched);

      console.log(`  [${city} ${savedRecordsMap.size}/${candidatesToVerify.length}] ${candidate.name}: ${res.websiteCheckStatus} (${res.websiteUrl || 'None'}) [took ${leadDuration}s]`);

      if (savedRecordsMap.size % 10 === 0) {
        const stats = getStatusCounts(savedRecordsMap);
        console.log(`    └─ Progress: ${stats.hasWeb} Has Web | ${stats.noWeb} Confirmed No Web | ${stats.socialOnly} Social Only Unread | ${stats.uncertain} Uncertain | ${stats.closed} Closed`);
      }
    }

    // Requirement 3: Add a retry pass: after the main pass, re-verify every lead marked "Uncertain (search blocked)" or "timed out" once search has cooled down, and update its saved result.
    const allNeedingRetry = [];
    for (const [key, rec] of savedRecordsMap.entries()) {
      const status = (rec.websiteCheckStatus || '').toLowerCase();
      const ev = (rec.websiteEvidence || '').toLowerCase();
      if (
        status === 'uncertain (search blocked)' ||
        (status.startsWith('uncertain') && (
          ev.includes('search blocked') ||
          ev.includes('search layer blocked') ||
          ev.includes('blocked') ||
          ev.includes('search cooldown') ||
          ev.includes('timed out') ||
          ev.includes('timeout')
        ))
      ) {
        allNeedingRetry.push({ lead: rec, key });
      }
    }

    if (allNeedingRetry.length > 0) {
      console.log(`\n======================================================`);
      console.log(`🔄 RETRY PASS: Re-verifying ${allNeedingRetry.length} leads marked 'Uncertain (search blocked)' or 'timed out'`);
      console.log(`======================================================`);

      const sStatus = searchBackendManager.getStatus();
      const coolDowns = Object.values(sStatus.engines).map(e => e.coolDownRemainingS);
      const minCoolDown = Math.min(...coolDowns);
      if (minCoolDown > 60) {
        console.log(`⏳ All search engines are in 15-minute cooldown (${minCoolDown}s remaining). Postponing retry pass until cooldown expires.\n`);
      } else {
        if (minCoolDown > 0) {
          console.log(`⏳ Waiting ${minCoolDown}s for search engine cooldown before starting retry pass...`);
          await rateLimiter.sleep(minCoolDown * 1000);
        }

        let updatedCount = 0;
        for (const item of allNeedingRetry) {
          const currentStatus = searchBackendManager.getStatus();
          const anyAvailable = Object.values(currentStatus.engines).some(e => !e.inCoolDown);
          if (!anyAvailable) {
            console.log(`⚠️ All search engines entered cooldown during retry pass. Stopping retry pass cleanly.`);
            break;
          }

          const lead = item.lead;
          console.log(`  [Retry] Re-verifying "${lead.name}"...`);
          let retryRes;
          try {
            retryRes = await websiteVerifier.verifyLead(lead);
          } catch (e) {
            retryRes = { websiteCheckStatus: 'Uncertain (retry error)' };
          }

          if (retryRes.websiteCheckStatus && !retryRes.websiteCheckStatus.includes('blocked')) {
            const updated = { ...lead, ...retryRes };
            savedRecordsMap.set(item.key, updated);
            updatedCount++;
            console.log(`    ✅ Updated: ${lead.name} -> ${retryRes.websiteCheckStatus} (${retryRes.websiteUrl || 'None'})`);
          } else {
            console.log(`    ⚠️ Still search blocked/uncertain: ${lead.name}`);
          }
        }

        if (updatedCount > 0) {
          const updatedLines = Array.from(savedRecordsMap.values()).map(r => JSON.stringify(r));
          fs.writeFileSync(jsonlPath, updatedLines.join('\n') + '\n', 'utf8');
          console.log(`💾 Rewrote ${jsonlFilename} with ${updatedCount} updated retry results.\n`);
        }
      }
    }
  }

  // Update no-website-leads-to-check.csv
  syncNoWebsiteCsv(savedRecordsMap);

  // Requirement 4 & 6: Print batch summary and search engine stats
  printBatchSummary(city, industry, savedRecordsMap, candidatesToVerify.length);
  printSearchTelemetry();

  return {
    city,
    industry,
    totalVerified: savedRecordsMap.size,
    totalCandidates: candidatesToVerify.length,
    remaining: candidatesToVerify.length - savedRecordsMap.size,
    isComplete: savedRecordsMap.size >= candidatesToVerify.length
  };
}

function getStatusCounts(recordsMap) {
  let hasWeb = 0;
  let noWeb = 0;
  let socialOnly = 0;
  let uncertain = 0;
  let closed = 0;
  for (const r of recordsMap.values()) {
    if (r.websiteCheckStatus === 'Has website') hasWeb++;
    else if (r.websiteCheckStatus === 'Confirmed no website') noWeb++;
    else if (r.websiteCheckStatus === 'No website found (social only, bio unread)') socialOnly++;
    else if (r.websiteCheckStatus === 'Closed / skip') closed++;
    else uncertain++;
  }
  return { hasWeb, noWeb, socialOnly, uncertain, closed };
}

function syncNoWebsiteCsv(recordsMap) {
  const csvHeaders = [
    'City', 'Industry', 'Business Name', 'Full Address', 'Phone',
    'Status', 'Confidence', 'Source Provider', 'Source URL', 'Social Profile', 'Evidence Trail'
  ];
  const csvRows = [csvHeaders.join(',')];
  let count = 0;
  for (const lead of recordsMap.values()) {
    if (lead.websiteCheckStatus === 'Confirmed no website' || lead.websiteCheckStatus === 'No website found (social only, bio unread)') {
      count++;
      csvRows.push([
        escapeCsv(lead.runCity || lead.city),
        escapeCsv(lead.runIndustry || lead.industry),
        escapeCsv(lead.name),
        escapeCsv(lead.address || `${lead.city || ''}, UK`),
        escapeCsv(lead.phone || ''),
        escapeCsv(lead.websiteCheckStatus),
        escapeCsv(lead.confidence),
        escapeCsv(lead.sourceProvider || ''),
        escapeCsv(lead.sourceUrl || ''),
        escapeCsv(lead.socialProfile || ''),
        escapeCsv(lead.websiteEvidence || '')
      ].join(','));
    }
  }
  const csvPath = path.join(__dirname, 'no-website-leads-to-check.csv');
  fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
  console.log(`💾 Saved ${count} leads in "no website" categories to: ${csvPath}\n`);
}

function printBatchSummary(city, industry, recordsMap, totalCandidates) {
  const counts = getStatusCounts(recordsMap);
  console.log('======================================================');
  console.log(`📦 BATCH COMPLETE SUMMARY: ${city} + ${industry}`);
  console.log('======================================================');
  console.log(`• Total verified leads:   ${recordsMap.size} of ${totalCandidates}`);
  console.log(`• Remaining leads:        ${totalCandidates - recordsMap.size}`);
  console.log(`• Status Breakdown:`);
  console.log(`    - Has website:                         ${counts.hasWeb}`);
  console.log(`    - Confirmed no website:                ${counts.noWeb}`);
  console.log(`    - No website found (social only):      ${counts.socialOnly}`);
  console.log(`    - Uncertain:                           ${counts.uncertain}`);
  console.log(`    - Closed / skip:                       ${counts.closed}`);
}

function printSearchTelemetry() {
  const searchTelemetry = searchBackendManager.getStatus();
  console.log('\n======================================================');
  console.log('🔍 SEARCH ENGINE TELEMETRY STATS PER ENGINE');
  console.log('======================================================');
  console.log('| Engine | Total Queries | Successful | Blocked | Block Rate | In Cooldown? | Cooldown Remaining | Last Error |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [engine, stats] of Object.entries(searchTelemetry.engines)) {
    console.log(`| ${engine} | ${stats.totalQueries} | ${stats.successfulQueries} | ${stats.blockedQueries} | ${stats.blockRatePercent}% | ${stats.inCoolDown ? 'YES' : 'NO'} | ${stats.coolDownRemainingS}s | ${stats.lastError || 'None'} |`);
  }
  console.log('======================================================\n');
}

async function main() {
  console.log('======================================================');
  console.log('🎯 Multi-City Real Pipeline Discovery & Verification Run');
  console.log('======================================================');

  const runs = [
    { city: 'London', industry: 'Bakeries', country: 'United Kingdom' },
    { city: 'Manchester', industry: 'Locksmiths', country: 'United Kingdom' },
    { city: 'Leeds', industry: 'Bakeries', country: 'United Kingdom' }
  ];

  for (const r of runs) {
    const report = await runPipelineForCity(r);
    console.log(`✨ Batch for ${r.city} + ${r.industry} finished cleanly.`);
    console.log(`   Processed: ${report.totalVerified}/${report.totalCandidates} (Remaining: ${report.remaining})`);
    if (!report.isComplete) {
      console.log(`   Run again to execute the next batch of 100 leads.\n`);
      process.exit(0);
    }
  }

  console.log('🎉 All cities and industries fully completed!\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
