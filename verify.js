#!/usr/bin/env node
/**
 * Spot-Check Verification CLI
 * Usage: node verify.js "<business name>" "<city>" [phone] [country]
 * Runs the full 6-layer zero-cost verification pipeline and prints the complete audit trail.
 */

require('dotenv').config();
const websiteVerifier = require('./verifier/index');
const searchBackendManager = require('./verifier/search-backends');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log(`
Usage: node verify.js "<business name>" "<city>" [phone] [country]

Examples:
  node verify.js "Chinatown Bakery" "London"
  node verify.js "Efficent AC, Electric & Plumbing" "Austin" "+1-512-501-2275"
  node verify.js "Joe's Handyman Service" "Chicago"
`);
    process.exit(1);
  }

  const name = args[0];
  const city = args[1];
  let phone = '';
  let country = 'United States';

  if (args.length === 3) {
    // Determine if arg 2 is phone or country
    if (/\d/.test(args[2])) {
      phone = args[2];
    } else {
      country = args[2];
    }
  } else if (args.length >= 4) {
    phone = args[2] || '';
    country = args[3] || 'United States';
  }

  console.log(`\n======================================================`);
  console.log(`🔍 Spot-Checking Lead Verification Pipeline`);
  console.log(`🏢 Business: "${name}"`);
  console.log(`📍 City:     "${city}" (${country})`);
  if (phone) console.log(`📞 Phone:    "${phone}"`);
  console.log(`======================================================\n`);

  await searchBackendManager.initialize();
  const backendStatus = searchBackendManager.getStatus();
  const blockRate = (backendStatus && typeof backendStatus.blockRatePercent === 'number') ? backendStatus.blockRatePercent : 0;
  console.log(`📡 Search Backend Active: ${backendStatus ? backendStatus.activeBackend : 'duckduckgo_html'} (Block rate: ${blockRate}%)\n`);

  const candidate = {
    name,
    city,
    country,
    phone,
    website: '',
    socialProfile: ''
  };

  const startTime = Date.now();
  console.log(`⏳ Executing 6-stage verification waterfall...`);
  const result = await websiteVerifier.verifyLead(candidate);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`\n----------------- VERIFICATION AUDIT -----------------`);
  console.log(`Status:   [ ${result.websiteCheckStatus.toUpperCase()} ]`);
  if (result.websiteUrl) {
    console.log(`Website:  ${result.websiteUrl}`);
  }
  if (result.socialProfile) {
    console.log(`Social:   ${result.socialProfile}`);
  }
  console.log(`Checked:  ${result.checkedAt} (${elapsed}s)`);
  console.log(`\nFull Evidence Trail:`);
  
  const steps = result.websiteEvidence.split('; ');
  steps.forEach((step, idx) => {
    console.log(`  ${idx + 1}. ${step}`);
  });
  console.log(`------------------------------------------------------\n`);
}

main().catch(err => {
  console.error('Verification failed with error:', err);
  process.exit(1);
});
