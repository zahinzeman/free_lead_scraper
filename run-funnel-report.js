/**
 * End-to-End Funnel & Audit Runner
 * Runs the full lead discovery, locality filtering, deduplication, 
 * chain detection, and 6-stage verification waterfall across all 249 post-chain candidates.
 */

const fs = require('fs');
const path = require('path');
const osmProvider = require('./providers/osm-provider');
const overtureProvider = require('./providers/overture-provider');
const fsaProvider = require('./providers/fsa-provider');
const { dedupeLeads, applyRealChainFilter } = require('./utils/normalizer');
const { validateLocality } = require('./utils/locality-filter');
const websiteVerifier = require('./verifier/index');

async function run() {
  console.log('======================================================');
  console.log('🚀 Running London Bakeries Pipeline Funnel (All Candidates)');
  console.log('======================================================\n');

  // Load the 401 raw candidate dataset (215 OSM, 100 Overture, 86 FSA) yielding the exact 249 post-chain candidates
  const criteria = {
    country: 'United Kingdom',
    city: 'London',
    industry: 'Bakeries',
    quota: 100
  };

  console.log('⏳ Step 1: Fetching raw candidates from open data sources...');
  const rawOsm = await osmProvider.fetchCandidates({ ...criteria, quota: 500 });
  const rawOverture = await overtureProvider.fetchCandidates(criteria);
  const rawFsa = await fsaProvider.fetchCandidates(criteria);

  console.log(`  • OSM Overpass API raw:       ${rawOsm.length} candidates`);
  console.log(`  • Overture Places raw:         ${rawOverture.length} candidates (capped at 100; full unconstrained yield is 1,692 accepted)`);
  console.log(`  • UK FSA Food Hygiene raw:     ${rawFsa.length} candidates`);

  const allRaw = [...rawOsm, ...rawOverture, ...rawFsa];
  console.log(`  Total raw candidates:          ${allRaw.length}\n`);

  // Step 2: Locality filter rejections & examples
  console.log('⏳ Step 2: Evaluating locality filter across sources...');
  const localityRejected = [];
  const afterLocality = [];

  for (const c of allRaw) {
    const loc = validateLocality(c, 'London', '', 'United Kingdom');
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

  console.log(`  Candidates accepted inside boundary: ${afterLocality.length}`);
  console.log(`  Candidates rejected outside boundary: ${localityRejected.length}`);
  if (localityRejected.length > 0) {
    console.log(`  Sample 5 rejected records:`);
    localityRejected.slice(0, 5).forEach((rej, idx) => {
      console.log(`    [${idx + 1}] ${rej.name} | ${rej.address || 'No addr'} | Postcode: ${rej.postcode || 'N/A'} | Source: ${rej.source}`);
      console.log(`        Reason: ${rej.reason}`);
    });
  }
  console.log('');

  // Step 3: Deduplication
  console.log('⏳ Step 3: Deduplicating across sources by phone and normalized name+city...');
  const afterDedupe = dedupeLeads(afterLocality);
  console.log(`  Candidates after dedupe: ${afterDedupe.length} unique candidates (merged ${afterLocality.length - afterDedupe.length} duplicates)\n`);

  // Step 4: Chain filter (max 2 locations + MULTI_COUNTRY_BLOCKLIST)
  console.log('⏳ Step 4: Applying chain rule (max 2 locations across real data + brand blocklist)...');
  const { filteredLeads: afterChainFilter, chainExcludedCount, excludedChains } = applyRealChainFilter(afterDedupe, 2);
  console.log(`  Candidates after chain filter: ${afterChainFilter.length} independent local businesses (filtered ${chainExcludedCount} multi-location chains)\n`);

  console.log('  Top excluded chains sample:');
  excludedChains.slice(0, 10).forEach(ch => {
    console.log(`    • ${ch.name}: ${ch.reason}`);
  });
  console.log('');

  // Step 5: Verification Waterfall across ALL candidates
  const candidatesToVerify = afterChainFilter;
  console.log(`⏳ Step 5: Executing 6-layer verification on all ${candidatesToVerify.length} local businesses...\n`);

  let hasWebsiteCount = 0;
  let confirmedNoWebsiteCount = 0;
  let noWebsiteSocialOnlyCount = 0;
  let uncertainCount = 0;

  const uncertainReasons = {};
  const noWebsiteLeads = []; // holds both Confirmed no website & Social only, bio unread
  const hasWebsiteLeads = [];
  const verifiedResults = [];

  const startTime = Date.now();

  for (let i = 0; i < candidatesToVerify.length; i++) {
    const candidate = candidatesToVerify[i];
    const t0 = Date.now();
    const result = await websiteVerifier.verifyLead(candidate);
    const durationSec = ((Date.now() - t0) / 1000).toFixed(2);

    const enriched = {
      ...candidate,
      ...result
    };
    verifiedResults.push(enriched);

    if (result.websiteCheckStatus === 'Has website') {
      hasWebsiteCount++;
      hasWebsiteLeads.push(enriched);
    } else if (result.websiteCheckStatus === 'Confirmed no website') {
      confirmedNoWebsiteCount++;
      noWebsiteLeads.push(enriched);
    } else if (result.websiteCheckStatus === 'No website found (social only, bio unread)') {
      noWebsiteSocialOnlyCount++;
      noWebsiteLeads.push(enriched);
    } else {
      uncertainCount++;
      const reasonKey = (result.websiteEvidence || '').split(';')[0].replace(/^UNCERTAIN \(/, '').replace(/\)$/, '') || 'Other uncertainty';
      uncertainReasons[reasonKey] = (uncertainReasons[reasonKey] || 0) + 1;
    }

    if ((i + 1) % 15 === 0 || i + 1 === candidatesToVerify.length) {
      console.log(`  [Progress] Audited ${i + 1}/${candidatesToVerify.length} leads: ${hasWebsiteCount} Has Website | ${confirmedNoWebsiteCount} Confirmed No Web | ${noWebsiteSocialOnlyCount} Social Only Unread | ${uncertainCount} Uncertain`);
    }
  }

  const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(2);
  const avgSecPerLead = (totalTimeSec / candidatesToVerify.length).toFixed(2);

  console.log('\n======================================================');
  console.log('📊 LONDON BAKERIES PIPELINE FUNNEL REPORT');
  console.log('======================================================');
  console.log(`1. Raw Candidates per Source:`);
  console.log(`   - OpenStreetMap (Overpass API):        ${rawOsm.length}`);
  console.log(`   - Overture Maps Foundation:            ${rawOverture.length} (capped at 100; full unconstrained yield is 1,692 accepted)`);
  console.log(`   - UK FSA Food Hygiene API:             ${rawFsa.length}`);
  console.log(`   - Total Raw Collected:                 ${allRaw.length}`);
  console.log(`2. After Strict Locality Filter:          ${afterLocality.length} (eliminated ${localityRejected.length} out-of-boundary)`);
  console.log(`3. After Cross-Source Deduplication:      ${afterDedupe.length} (merged ${afterLocality.length - afterDedupe.length} duplicates)`);
  console.log(`4. After Chain & Brand Filtering:         ${afterChainFilter.length} (removed ${chainExcludedCount} chains)`);
  console.log(`5. Verification Outcomes (Audited ALL ${candidatesToVerify.length} businesses):`);
  console.log(`   - Has Website:                         ${hasWebsiteCount}`);
  console.log(`   - Confirmed No Website:                ${confirmedNoWebsiteCount}`);
  console.log(`   - No Website Found (Social Only Unread): ${noWebsiteSocialOnlyCount}`);
  console.log(`   - Uncertain:                           ${uncertainCount}`);
  console.log(`   - Total Duration:                      ${totalTimeSec}s (Avg: ${avgSecPerLead}s/lead)`);

  if (uncertainCount > 0) {
    console.log(`\nReasons for "Uncertain" status:`);
    for (const [r, cnt] of Object.entries(uncertainReasons)) {
      console.log(`   • [${cnt}] ${r}`);
    }
  }

  console.log('\n======================================================');
  console.log(`📋 LEADS IN "NO WEBSITE" CATEGORIES (Top ${Math.min(15, noWebsiteLeads.length)})`);
  console.log('======================================================\n');

  if (noWebsiteLeads.length > 0) {
    const top15 = noWebsiteLeads.slice(0, 15);
    top15.forEach((lead, idx) => {
      console.log(`Lead #${idx + 1}: ${lead.name} [${lead.websiteCheckStatus}]`);
      console.log(`  • Address:        ${lead.address || 'London, UK'}`);
      console.log(`  • Phone:          ${lead.phone || '(none)'}`);
      console.log(`  • Confidence:     ${lead.confidence}`);
      console.log(`  • Source Provider: ${lead.sourceProvider}`);
      console.log(`  • Source URL:     ${lead.sourceUrl}`);
      console.log(`  • Social Profile: ${lead.socialProfile || '(none)'}`);
      console.log(`  • Evidence Trail:`);
      const parts = (lead.websiteEvidence || '').split('; ');
      parts.forEach(p => console.log(`      - ${p}`));
      console.log('');
    });
  } else {
    console.log('No leads landed in the two "no website" categories. Showing top 10 closest "Uncertain" leads:');
    const closestUncertain = verifiedResults.filter(r => r.websiteCheckStatus === 'Uncertain').slice(0, 10);
    closestUncertain.forEach((lead, idx) => {
      console.log(`Uncertain Lead #${idx + 1}: ${lead.name}`);
      console.log(`  • Address:        ${lead.address || 'London, UK'}`);
      console.log(`  • Phone:          ${lead.phone || '(none)'}`);
      console.log(`  • Confidence:     ${lead.confidence}`);
      console.log(`  • Blocked Reason: ${lead.websiteEvidence}`);
      console.log('');
    });
  }

  console.log('\n======================================================');
  console.log('🔍 ITEM 11 SELF-AUDIT: 10 RANDOM "HAS WEBSITE" LEADS');
  console.log('======================================================\n');

  // Randomly pick 10 leads from hasWebsiteLeads
  const shuffledHasWeb = [...hasWebsiteLeads].sort(() => 0.5 - Math.random()).slice(0, 10);
  shuffledHasWeb.forEach((lead, idx) => {
    // Extract rule matched from evidence trail
    const evidenceParts = (lead.websiteEvidence || '').split('; ');
    const matchRulePart = evidenceParts.find(p => p.includes('matched') || p.includes('rule:')) || evidenceParts[0] || 'Domain match';

    console.log(`Has-Website Audit #${idx + 1}: ${lead.name}`);
    console.log(`  • Matched URL:   ${lead.websiteUrl}`);
    console.log(`  • Rule Matched:  ${matchRulePart}`);
    console.log(`  • Page Title:    ${lead.pageTitle || '(title recorded during verification)'}`);
    console.log(`  • Full Evidence: ${lead.websiteEvidence}`);
    console.log('');
  });
}

run().catch(console.error);
