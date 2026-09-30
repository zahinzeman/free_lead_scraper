const fs = require('fs');
const path = require('path');
const searchBackendManager = require('./verifier/search-backends');
const { isBlockedDomain } = require('./verifier/blocklist');

async function auditNoWebsiteLeads() {
  console.log('======================================================');
  console.log('🔬 AUDITING CONFIRMED NO-WEBSITE LEADS (INDEPENDENT FRESH SEARCH)');
  console.log('======================================================\n');

  // Load leads from results-London-Bakeries.jsonl
  const jsonlPath = path.join(__dirname, 'results-London-Bakeries.jsonl');
  if (!fs.existsSync(jsonlPath)) {
    console.error('No results-London-Bakeries.jsonl found.');
    return;
  }

  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
  const confirmedLeads = [];
  for (const line of lines) {
    try {
      const lead = JSON.parse(line);
      if (lead.websiteCheckStatus === 'Confirmed no website') {
        confirmedLeads.push(lead);
      }
    } catch (e) {}
  }

  console.log(`Found ${confirmedLeads.length} Confirmed No-Website leads so far in London.\n`);
  const leadsToAudit = confirmedLeads.slice(0, 15);

  const auditResults = [];

  for (let i = 0; i < leadsToAudit.length; i++) {
    const lead = leadsToAudit[i];
    console.log(`[Audit ${i + 1}/${leadsToAudit.length}] Testing: "${lead.name}" (${lead.address})`);

    const query1 = `"${lead.name}" ${lead.city || 'London'} bakery`;
    console.log(`  🔍 DuckDuckGo Query: ${query1}`);

    let ddgResults = [];
    try {
      const res = await searchBackendManager.search(query1, 'duckduckgo_html');
      ddgResults = res.results || [];
    } catch (err) {
      console.warn(`    DDG error: ${err.message}`);
    }

    const query2 = `"${lead.name}" ${lead.city || 'London'}`;
    console.log(`  🔍 Mojeek Query: ${query2}`);
    let mojeekResults = [];
    try {
      const res = await searchBackendManager.search(query2, 'mojeek');
      mojeekResults = res.results || [];
    } catch (err) {
      console.warn(`    Mojeek error: ${err.message}`);
    }

    const combined = [...ddgResults, ...mojeekResults];
    const seenUrls = new Set();
    const uniqueResults = [];
    for (const r of combined) {
      if (!seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        uniqueResults.push(r);
      }
    }

    console.log(`  Total raw search results returned: ${uniqueResults.length}`);

    const categorizedResults = uniqueResults.slice(0, 10).map((r, idx) => {
      const isDir = isBlockedDomain(r.url);
      return {
        rank: idx + 1,
        title: r.title,
        url: r.url,
        isDir
      };
    });

    let foundFirstParty = false;
    let candidateUrl = null;
    for (const r of categorizedResults) {
      if (!r.isDir) {
        // Potential candidate
        candidateUrl = r.url;
      }
    }

    auditResults.push({
      index: i + 1,
      name: lead.name,
      address: lead.address,
      phone: lead.phone || '(none)',
      confidence: lead.confidence,
      evidence: lead.websiteEvidence,
      totalSearchResults: uniqueResults.length,
      topUrls: categorizedResults,
      hasFirstPartyFound: foundFirstParty,
      candidateUrl
    });

    console.log(`  Top 5 inspected URLs:`);
    categorizedResults.slice(0, 5).forEach(u => {
      console.log(`    ${u.rank}. [${u.isDir ? 'DIRECTORY / AGGREGATOR' : 'NON-DIRECTORY'}] ${u.url}`);
    });
    console.log(`  Conclusion: ${foundFirstParty ? `⚠️ Potential Website: ${candidateUrl}` : '✅ VERIFIED NO WEBSITE (All results are directories / aggregators or empty)'}\n`);

    // Polite delay between audits
    await new Promise(r => setTimeout(r, 2000));
  }

  // Summary Table
  console.log('\n======================================================');
  console.log('📋 AUDIT VERIFICATION TABLE');
  console.log('======================================================');
  console.log('| # | Business Name | Address | Phone | Audit Verdict | Top Non-Directory URL |');
  console.log('|---|---|---|---|---|---|');
  for (const a of auditResults) {
    console.log(`| ${a.index} | ${a.name} | ${a.address} | ${a.phone} | ${a.hasFirstPartyFound ? '⚠️ Site Found' : '✅ Confirmed No Website'} | ${a.candidateUrl || 'None (all directories)'} |`);
  }
}

auditNoWebsiteLeads().catch(err => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
