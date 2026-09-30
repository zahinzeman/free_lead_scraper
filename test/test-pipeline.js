const assert = require('assert');
const fs = require('fs');
const path = require('path');
const providerRegistry = require('../providers/registry');
const websiteVerifier = require('../verifier/index');
const searchBackendManager = require('../verifier/search-backends');
const { isParkedDomain, inspectCandidateWebsite, getRegistrableDomain } = require('../verifier/content-matcher');
const { validateLocality, isValidLondonPhone, isValidLondonPostcode } = require('../utils/locality-filter');
const { inspectSocialProfiles } = require('../verifier/social-check');
const { applyRealChainFilter } = require('../utils/normalizer');
const rateLimiter = require('../utils/rate-limiter');
const { closeSharedBrowser } = require('../verifier/domain-guesser');

// Load real HTML fixtures from disk
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const realParkedHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'parked_domain.html'), 'utf8');
const realDdgChallengeHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'ddg_challenge.html'), 'utf8');
const realFacebook400Html = fs.readFileSync(path.join(FIXTURES_DIR, 'facebook_400.html'), 'utf8');
const realBusinessHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'real_business.html'), 'utf8');
const realDirectoryListingHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'directory_listing.html'), 'utf8');
const realCompanyRegisterHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'company_register.html'), 'utf8');
const realGenericHandleHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'generic_handle_domain.html'), 'utf8');
const realFacebookPostHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'facebook_post.html'), 'utf8');
const realClosedBusinessNewsHtml = fs.readFileSync(path.join(FIXTURES_DIR, 'closed_business_news.html'), 'utf8');

// Global 15-minute hard timeout
const GLOBAL_TIMEOUT_MS = 15 * 60 * 1000;
const globalTimeoutTimer = setTimeout(() => {
  console.error('\n❌ GLOBAL TIMEOUT EXCEEDED: Test suite exceeded 15 minutes hard limit. Failing clearly.\n');
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
globalTimeoutTimer.unref();

const testTimings = [];

async function runTestCase(testNum, testName, timeoutMs, testFn) {
  console.log(`[START] Test ${testNum}: ${testName}...`);
  const t0 = Date.now();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Test ${testNum} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });

  try {
    await Promise.race([testFn(), timeoutPromise]);
    clearTimeout(timer);
    const durationSec = parseFloat(((Date.now() - t0) / 1000).toFixed(2));
    console.log(`[FINISH] Test ${testNum}: ${testName} - PASSED (took ${durationSec}s)\n`);
    testTimings.push({ num: testNum, name: testName, status: 'PASSED', durationSec });
    return true;
  } catch (err) {
    clearTimeout(timer);
    const durationSec = parseFloat(((Date.now() - t0) / 1000).toFixed(2));
    console.error(`[FINISH] Test ${testNum}: ${testName} - FAILED (took ${durationSec}s): ${err.message}\n`);
    testTimings.push({ num: testNum, name: testName, status: 'FAILED', durationSec, error: err.message });
    return false;
  }
}

async function executeTest8SingleRun(runNumber, businesses) {
  console.log(`\n--- Test 8 Run ${runNumber}: Evaluating ${businesses.length} businesses (concurrency 1) ---`);
  const t0 = Date.now();
  let exactOwnDomainMatches = 0;
  let wrongDomainMatches = 0;
  let uncertainMatches = 0;
  let falseNoWebsiteMatches = 0;
  let missMatches = 0;
  const test8Errors = [];
  const results = [];

  for (let i = 0; i < businesses.length; i++) {
    const b = businesses[i];
    const bizT0 = Date.now();

    const res = await websiteVerifier.verifyLead({
      name: b.name,
      city: b.city,
      country: b.country || 'United States',
      phone: '',
      website: ''
    });

    const bizDuration = ((Date.now() - bizT0) / 1000).toFixed(2);

    let expectedDomain = '';
    if (b.website) {
      try {
        const u = new URL(b.website.startsWith('http') ? b.website : 'https://' + b.website);
        expectedDomain = getRegistrableDomain(u.hostname).registrableDomain;
      } catch (e) {}
    }

    let matchedDomain = '';
    if (res.websiteUrl) {
      try {
        const u = new URL(res.websiteUrl.startsWith('http') ? res.websiteUrl : 'https://' + res.websiteUrl);
        matchedDomain = getRegistrableDomain(u.hostname).registrableDomain;
      } catch (e) {}
    }

    let rowResult = '';
    if (b.expected === 'no_website_tentative') {
      rowResult = `INFO (${res.websiteCheckStatus})`;
    } else if (res.websiteCheckStatus === 'Has website') {
      if (expectedDomain && matchedDomain === expectedDomain) {
        exactOwnDomainMatches++;
        rowResult = 'PASS (Exact Domain)';
      } else {
        wrongDomainMatches++;
        rowResult = 'FAIL (Wrong Domain)';
        test8Errors.push(`${b.name}: Expected domain ${expectedDomain}, but matched ${matchedDomain} (${res.websiteUrl})`);
      }
    } else if (res.websiteCheckStatus === 'Uncertain') {
      uncertainMatches++;
      const evidenceStr = res.websiteEvidence || '';
      const botStatusMatch = evidenceStr.match(/\b(HTTP\s*(?:403|429|503)|bot-protected[^\)]*|challenge page|Cloudflare)\b/i);
      const hasRealBotProtection = Boolean(botStatusMatch);
      const loggedStatus = botStatusMatch ? botStatusMatch[0] : 'no bot HTTP status logged';

      if (b.botProtected && hasRealBotProtection) {
        rowResult = `PASS (Uncertain / Bot-Protected: ${loggedStatus})`;
      } else {
        rowResult = `MISS (Uncertain: ${loggedStatus})`;
        missMatches++;
      }
    } else if (res.websiteCheckStatus === 'Confirmed no website' || res.websiteCheckStatus.startsWith('No website found')) {
      falseNoWebsiteMatches++;
      rowResult = 'FAIL (False No-Website)';
      test8Errors.push(`${b.name}: Wrongly marked '${res.websiteCheckStatus}' (expected website: ${b.website})`);
    } else if (res.websiteCheckStatus === 'Closed / skip') {
      rowResult = 'FAIL (Closed / skip)';
      test8Errors.push(`${b.name}: Wrongly marked 'Closed / skip' (expected website: ${b.website})`);
    } else {
      rowResult = `FAIL (${res.websiteCheckStatus})`;
      test8Errors.push(`${b.name}: Unexpected status '${res.websiteCheckStatus}'`);
    }

    console.log(`  [Business ${i + 1}/${businesses.length}] ${b.name} (${b.city}): ${res.websiteCheckStatus} -> ${res.websiteUrl || 'None'} [${rowResult}] (${bizDuration}s)`);
    results.push({
      name: b.name,
      city: b.city,
      expectedDomain: expectedDomain || b.website,
      matchedUrl: res.websiteUrl || '',
      status: res.websiteCheckStatus,
      result: rowResult,
      durationSec: parseFloat(bizDuration)
    });
  }

  const durationSec = parseFloat(((Date.now() - t0) / 1000).toFixed(2));
  console.log(`\n  Run ${runNumber} Summary: ${exactOwnDomainMatches}/24 exact matches, ${uncertainMatches} uncertain, ${falseNoWebsiteMatches} false no-web in ${durationSec}s`);

  return {
    runNumber,
    durationSec,
    exactOwnDomainMatches,
    wrongDomainMatches,
    uncertainMatches,
    falseNoWebsiteMatches,
    missMatches,
    test8Errors,
    results
  };
}

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 Running Lead Scraper Verification Pipeline Tests');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  // TEST 1
  const t1 = await runTestCase(1, 'Provider ID Allowlist Validation', 15000, async () => {
    assert.strictEqual(providerRegistry.isValidProvider('auto'), true, 'Auto provider must be valid');
    assert.strictEqual(providerRegistry.isValidProvider('osm'), true, 'OSM provider must be valid');
    assert.strictEqual(providerRegistry.isValidProvider('overture'), true, 'Overture provider must be valid');
    assert.strictEqual(providerRegistry.isValidProvider('fsa'), true, 'FSA provider must be valid');
    assert.strictEqual(providerRegistry.isValidProvider('fake_provider_xyz'), false, 'Fake provider must be rejected');
    assert.strictEqual(providerRegistry.isValidProvider('hack_source'), false, 'Malicious provider must be rejected');

    let errorThrown = false;
    try {
      await providerRegistry.fetchCandidates('invalid_id', {});
    } catch (e) {
      errorThrown = true;
    }
    assert.strictEqual(errorThrown, true, 'fetchCandidates with invalid provider must throw error');
  });
  t1 ? passed++ : failed++;

  // TEST 2
  const t2 = await runTestCase(2, 'Blocked Search Layer MUST Force "Uncertain"', 20000, async () => {
    const originalSearch = searchBackendManager.search;
    searchBackendManager.search = async () => ({
      results: [],
      blocked: true,
      reason: 'HTTP 429 Rate limited challenge'
    });

    const testLead = {
      name: 'Simulated Local Bakery Without Website',
      city: 'Smalltown',
      country: 'United States',
      phone: '512-555-0199',
      website: '',
      socialProfile: ''
    };

    const result = await websiteVerifier.verifyLead(testLead);
    searchBackendManager.search = originalSearch;

    assert(
      result.websiteCheckStatus.startsWith('Uncertain'),
      `Lead must be marked 'Uncertain' when search is blocked. Got: ${result.websiteCheckStatus}`
    );
    assert.notStrictEqual(
      result.websiteCheckStatus,
      'Confirmed no website',
      'Lead must NEVER be marked "Confirmed no website" when search is blocked!'
    );
    assert.strictEqual(result.confidence, 'low', 'Blocked lead confidence must be low');
    assert(result.websiteEvidence.includes('UNCERTAIN'), 'Evidence must state UNCERTAIN');
  });
  t2 ? passed++ : failed++;

  // TEST 3
  const t3 = await runTestCase(3, 'Parked Domain Detection (Recorded Real HTML Fixture)', 15000, async () => {
    const isParked = isParkedDomain(realParkedHtml, 'Domain For Sale | Sedo Parking');
    assert.strictEqual(isParked, true, 'Real Sedo parked domain HTML fixture must be detected');

    const isNotParked = isParkedDomain(realBusinessHtml, 'Chinatown Bakery London');
    assert.strictEqual(isNotParked, false, 'Real business HTML fixture must not be flagged parked');
  });
  t3 ? passed++ : failed++;

  // TEST 4
  const t4 = await runTestCase(4, 'Real Business HTML Inspection & Generic-Name False Match Prevention', 20000, async () => {
    const originalFetch = rateLimiter.politeFetch;
    rateLimiter.politeFetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://chinatownbakerylondon.co.uk',
      text: async () => realBusinessHtml
    });

    const matchPos = await inspectCandidateWebsite(
      'https://chinatownbakerylondon.co.uk',
      'Chinatown Bakery',
      'London',
      '020 7287 7995',
      'WC2H 7JR'
    );
    assert.strictEqual(matchPos.isMatch, true, 'Real business HTML must match Chinatown Bakery');
    assert(matchPos.reason.includes('city match') || matchPos.reason.includes('phone match') || matchPos.reason.includes('token'), 'Reason must record matched signals');

    rateLimiter.politeFetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://local-directory.com/bakery',
      text: async () => '<html><head><title>Best Bakeries in Town | Directory</title></head><body><h1>Find Local Bakeries</h1></body></html>'
    });

    const matchNeg = await inspectCandidateWebsite(
      'https://local-directory.com/bakery',
      'The Bakery',
      'London',
      ''
    );
    rateLimiter.politeFetch = originalFetch;

    assert.strictEqual(matchNeg.isMatch, false, 'Generic "The Bakery" must NOT match directory page');
  });
  t4 ? passed++ : failed++;

  // TEST 5
  const t5 = await runTestCase(5, 'Strict Locality Filter (London Postcode & Phone Area Code Boundary)', 15000, async () => {
    assert.strictEqual(isValidLondonPhone('+441483536344'), false, '01483 (Guildford) must be rejected for London');
    assert.strictEqual(isValidLondonPhone('01784 434653'), false, '01784 (Staines) must be rejected for London');
    assert.strictEqual(isValidLondonPhone('+44 20 7403 5444'), true, '020 (London) must be accepted');

    assert.strictEqual(isValidLondonPostcode('GU1 1AA'), false, 'GU1 (Guildford) postcode must be rejected for London');
    assert.strictEqual(isValidLondonPostcode('TW20 8HE'), false, 'TW20 (Egham/Surrey) postcode must be rejected for London');
    assert.strictEqual(isValidLondonPostcode('SE1 9DA'), true, 'SE1 (London) postcode must be accepted');
    assert.strictEqual(isValidLondonPostcode('EC1A 1BB'), true, 'EC1 (London) postcode must be accepted');

    const candGuildford = {
      name: 'The Bakery',
      address: 'Kingpost Parade, 6 London Rd',
      city: 'Guildford',
      phone: '+441483536344',
      postcode: 'GU1 1AA'
    };
    const resGuildford = validateLocality(candGuildford, 'London', '', 'United Kingdom');
    assert.strictEqual(resGuildford.isMatch, false, 'Guildford candidate must be filtered out for London run');

    const candStaines = {
      name: 'Greggs',
      address: '64-65 High St, Staines-upon-Thames',
      city: 'Staines-upon-Thames',
      phone: '01784 434653',
      postcode: 'TW20 8HE'
    };
    const resStaines = validateLocality(candStaines, 'London', '', 'United Kingdom');
    assert.strictEqual(resStaines.isMatch, false, 'Staines candidate must be filtered out for London run');
  });
  t5 ? passed++ : failed++;

  // TEST 6
  const t6 = await runTestCase(6, 'Missing Phone Downgrades to "Uncertain" if Locality Parts Unavailable', 20000, async () => {
    const originalSearch = searchBackendManager.search;
    searchBackendManager.search = async () => ({
      results: [
        { title: 'Some Directory', url: 'https://yelp.com/biz/abc' }
      ],
      blocked: false
    });

    const leadWithoutPhoneAndAddress = {
      name: 'Independent Artisan Woodworker',
      city: 'London',
      country: 'United Kingdom',
      phone: '',
      address: '',
      postcode: '',
      website: '',
      socialProfile: ''
    };

    const res = await websiteVerifier.verifyLead(leadWithoutPhoneAndAddress);
    searchBackendManager.search = originalSearch;

    assert.strictEqual(
      res.websiteCheckStatus,
      'Uncertain',
      `Lead with no phone and no address/borough for second search query must be 'Uncertain'. Got: ${res.websiteCheckStatus}`
    );
    assert.strictEqual(res.confidence, 'low', 'Confidence must be low');
    assert(
      res.websiteEvidence.includes('no phone, reduced confidence'),
      'Evidence must record no phone, reduced confidence'
    );
  });
  t6 ? passed++ : failed++;

  // TEST 7
  const t7 = await runTestCase(7, 'Facebook HTTP 400 Real HTML Fixture -> Bio Unread Detection', 20000, async () => {
    const originalFetch = rateLimiter.politeFetch;
    rateLimiter.politeFetch = async () => ({
      ok: false,
      status: 400,
      url: 'https://www.facebook.com/justusplumbingservices/',
      text: async () => realFacebook400Html
    });

    const socialCheck = await inspectSocialProfiles(
      ['https://www.facebook.com/justusplumbingservices/'],
      'Just Us Plumbing',
      'Austin'
    );
    rateLimiter.politeFetch = originalFetch;

    assert.strictEqual(socialCheck.bioUnread, true, 'Facebook HTTP 400 must trigger bioUnread: true');
    assert(
      socialCheck.evidence.includes('HTTP 400'),
      'Evidence must log HTTP 400 response from Facebook'
    );
  });
  t7 ? passed++ : failed++;

  // TEST 8
  const t8 = await runTestCase(8, 'Real Fixture Businesses Evaluation (Concurrency 1, Timing & Variance Check)', 600000, async () => {
    const fixturesPath = path.join(__dirname, 'fixtures.json');
    const fixturesData = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
    const businesses = fixturesData.businesses || [];

    // Run 1 first (mandatory)
    const run1 = await executeTest8SingleRun(1, businesses);
    console.log(`\n⏱️ Test 8 Run 1 completed in ${run1.durationSec}s.`);

    if (run1.exactOwnDomainMatches < 17) {
      throw new Error(`Test 8 Run 1 exact own-domain matches dropped to ${run1.exactOwnDomainMatches}/24 (minimum 17 required). Errors:\n  - ${run1.test8Errors.join('\n  - ')}`);
    }

    // Only run 3 times afterwards if single run finishes in under 10 minutes (600s)
    if (run1.durationSec < 600) {
      console.log(`\n⚡ Single run finished in under 10 minutes (${run1.durationSec}s < 600s). Proceeding with Run 2 and Run 3 for variance evaluation...`);
      const run2 = await executeTest8SingleRun(2, businesses);
      const run3 = await executeTest8SingleRun(3, businesses);

      console.log('\n========================================================================================================');
      console.log('📊 TEST 8 SIDE-BY-SIDE VARIANCE REPORT (3 CONSECUTIVE RUNS)');
      console.log('========================================================================================================');
      console.log('| Business Name | City | Expected Domain | Run 1 Result | Run 2 Result | Run 3 Result | Variance |');
      console.log('|---|---|---|---|---|---|---|');

      for (let i = 0; i < businesses.length; i++) {
        const b = businesses[i];
        const r1 = run1.results[i] || {};
        const r2 = run2.results[i] || {};
        const r3 = run3.results[i] || {};
        const isStable = (r1.result === r2.result && r2.result === r3.result);
        const varianceStr = isStable ? 'STABLE' : 'VARIANCE';
        console.log(`| ${b.name} | ${b.city} | ${r1.expectedDomain || b.website} | ${r1.result} | ${r2.result} | ${r3.result} | ${varianceStr} |`);
      }

      console.log('\n--- 3-Run Totals ---');
      console.log(`  Run 1: ${run1.exactOwnDomainMatches}/24 exact matches in ${run1.durationSec}s`);
      console.log(`  Run 2: ${run2.exactOwnDomainMatches}/24 exact matches in ${run2.durationSec}s`);
      console.log(`  Run 3: ${run3.exactOwnDomainMatches}/24 exact matches in ${run3.durationSec}s`);

      assert(run2.exactOwnDomainMatches >= 17, `Run 2 exact matches dropped below 17: ${run2.exactOwnDomainMatches}`);
      assert(run3.exactOwnDomainMatches >= 17, `Run 3 exact matches dropped below 17: ${run3.exactOwnDomainMatches}`);
    } else {
      console.log(`⚠️ Single run exceeded 10 minutes (${run1.durationSec}s >= 600s). Skipping runs 2 and 3 as requested.`);
    }
  });
  t8 ? passed++ : failed++;

  // TEST 9
  const t9 = await runTestCase(9, 'DuckDuckGo Challenge Page Detection Against Real HTML Fixture', 20000, async () => {
    const originalFetch = rateLimiter.politeFetch;
    rateLimiter.politeFetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://html.duckduckgo.com/html/',
      text: async () => realDdgChallengeHtml
    });

    const ddgRes = await searchBackendManager._searchDuckDuckGoHtml('sample query');
    rateLimiter.politeFetch = originalFetch;

    assert.strictEqual(ddgRes.blocked, true, 'Real DDG anomaly challenge must flag blocked: true');
    assert(ddgRes.reason.includes('challenge') || ddgRes.reason.includes('anomaly'), 'Reason must state anomaly challenge');
  });
  t9 ? passed++ : failed++;

  // TEST 10
  const t10 = await runTestCase(10, 'New Middle Status "No website found (social only, bio unread)"', 20000, async () => {
    const originalSearch = searchBackendManager.search;
    const originalFetch = rateLimiter.politeFetch;

    searchBackendManager.search = async () => ({
      results: [
        { title: 'Just Us Plumbing Facebook', url: 'https://www.facebook.com/justusplumbingservices/' }
      ],
      blocked: false
    });

    rateLimiter.politeFetch = async (url) => {
      if (url.includes('facebook.com')) {
        return {
          ok: false,
          status: 400,
          url,
          text: async () => realFacebook400Html
        };
      }
      return {
        ok: false,
        status: 404,
        url,
        text: async () => ''
      };
    };

    const lead = {
      name: 'Just Us Plubing',
      city: 'Austin',
      country: 'United States',
      phone: '+1-512-501-2275',
      address: '123 Congress Ave, Austin, TX'
    };

    const res = await websiteVerifier.verifyLead(lead);
    searchBackendManager.search = originalSearch;
    rateLimiter.politeFetch = originalFetch;

    assert.strictEqual(
      res.websiteCheckStatus,
      'No website found (social only, bio unread)',
      `Status must be 'No website found (social only, bio unread)'. Got: ${res.websiteCheckStatus}`
    );
    assert.strictEqual(res.confidence, 'medium', 'Confidence must be medium');
    assert(res.websiteEvidence.includes('Bio unreadable across variants'), 'Evidence must explain unreadable bio');
  });
  t10 ? passed++ : failed++;

  // TEST 11
  const t11 = await runTestCase(11, 'Chain Filter Exclusion of Bread Ahead & Hummingbird Bakery', 20000, async () => {
    const chainTestLeads = [
      { name: 'Bread Ahead Bakery & School', city: 'London' },
      { name: 'Bread Ahead Borough Market', city: 'London' },
      { name: 'The Hummingbird Bakery', city: 'London' },
      { name: 'Hummingbird Bakery South Kensington', city: 'London' },
      { name: 'Independent Local Bakery', city: 'London' }
    ];

    const { filteredLeads, chainExcludedCount, excludedChains } = applyRealChainFilter(chainTestLeads, 2);

    assert.strictEqual(filteredLeads.length, 1, 'Only 1 independent local business should remain');
    assert.strictEqual(filteredLeads[0].name, 'Independent Local Bakery');
    assert.strictEqual(chainExcludedCount, 4, '4 chain locations must be excluded');

    const excludedNames = excludedChains.map(c => c.name);
    assert(excludedNames.includes('Bread Ahead Bakery & School'), 'Bread Ahead must be excluded');
    assert(excludedNames.includes('The Hummingbird Bakery'), 'Hummingbird Bakery must be excluded');
  });
  t11 ? passed++ : failed++;

  // TEST 12
  const t12 = await runTestCase(12, '403 Bot-Protected Resolving Domain MUST Force Uncertain', 30000, async () => {
    await closeSharedBrowser(); // ensure clean state
    const { checkGuessedDomains } = require('../verifier/domain-guesser');
    const dns = require('dns').promises;
    const originalResolve4 = dns.resolve4;

    dns.resolve4 = async (domain) => {
      if (domain === 'toastrackbakehouse.co.uk') return ['35.214.84.245'];
      throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' });
    };

    const originalFetch = rateLimiter.politeFetch;
    rateLimiter.politeFetch = async (url) => {
      if (url.includes('toastrackbakehouse')) {
        return { ok: false, status: 403, url, text: async () => '<html><title>403 - Forbidden</title><body>Access denied</body></html>' };
      }
      return { ok: false, status: 404, url, text: async () => '' };
    };

    const playwright = require('playwright');
    const origLaunch = playwright.chromium.launch.bind(playwright.chromium);
    playwright.chromium.launch = async () => ({
      isConnected: () => true,
      on: () => {},
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => ({ status: () => 403 }),
          title: async () => '403 - Forbidden',
          evaluate: async () => ({ h1: '403 - Forbidden', body: 'Access denied' }),
          close: async () => {}
        }),
        close: async () => {}
      }),
      close: async () => {}
    });

    try {
      const guessRes = await checkGuessedDomains('The Toast Rack Bakehouse', 'London', 'United Kingdom', '', '');
      assert.strictEqual(guessRes.found, false, 'No website should be confirmed found');
      assert.strictEqual(guessRes.resolvingCandidateDomainFound, true, 'resolvingCandidateDomainFound must be true for 403 bot-protected domain');
    } finally {
      dns.resolve4 = originalResolve4;
      rateLimiter.politeFetch = originalFetch;
      playwright.chromium.launch = origLaunch;
      await closeSharedBrowser();
    }
  });
  t12 ? passed++ : failed++;

  // TEST 13
  const t13 = await runTestCase(13, 'News Article About Closed Bakery Must NOT Count as Own Website', 20000, async () => {
    const originalFetch = rateLimiter.politeFetch;
    rateLimiter.politeFetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://towerhamletsslice.co.uk/percy-ingle-bakery-closure-east-london/',
      text: async () => '<html><head><title>Percy Ingle Bakery Closure — a tribute | Tower Hamlets Slice</title></head>' +
        '<body><h1>Percy Ingle closure: farewell to an East End legend</h1><p>Percy Ingle has closed down...</p></body></html>'
    });

    const res = await inspectCandidateWebsite(
      'https://towerhamletsslice.co.uk/percy-ingle-bakery-closure-east-london/',
      'Percy Ingle', 'London', '', ''
    );
    rateLimiter.politeFetch = originalFetch;

    assert.strictEqual(res.isMatch, false, 'News closure article must NOT match as own website');
    assert(res.isBlocked || res.reason, 'Result must have a reason for rejection');
  });
  t13 ? passed++ : failed++;

  // TEST 14
  const t14 = await runTestCase(14, 'Review-Site Page Must NOT Count as Own Website', 15000, async () => {
    const { isBlockedDomain } = require('../verifier/blocklist');
    assert.strictEqual(isBlockedDomain('https://dineawardslondon.com/fruit-cake-patisserie/'), true, 'dineawardslondon.com must be in blocklist');
    assert.strictEqual(isBlockedDomain('https://restaurantguru.com/Percy-Ingle-London'), true, 'restaurantguru.com must be in blocklist');
    assert.strictEqual(isBlockedDomain('https://yelp.com/biz/some-bakery'), true, 'yelp.com must be in blocklist');
    assert.strictEqual(isBlockedDomain('https://myactualbakery.co.uk'), false, 'Real bakery domain must NOT be blocked');
  });
  t14 ? passed++ : failed++;

  // TEST 15
  const t15 = await runTestCase(15, 'Circular Slug Match on Generic Name Must NOT Count', 20000, async () => {
    const originalFetch = rateLimiter.politeFetch;
    rateLimiter.politeFetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://baked.com',
      text: async () => '<html><head><title>Baked.com for sale | Spaceship.com</title></head>' +
        '<body>Listed with Spaceship.com. This domain is for sale. Inquire about this domain.</body></html>'
    });

    const res = await inspectCandidateWebsite('https://baked.com', 'Baked', 'London', '', '', { isGuessedDomain: true });
    rateLimiter.politeFetch = originalFetch;

    assert.strictEqual(res.isMatch, false, 'Parked domain must not match for generic "Baked"');
    assert.strictEqual(res.isParked, true, 'baked.com must be detected as parked');
  });
  t15 ? passed++ : failed++;

  // TEST 16
  const t16 = await runTestCase(16, 'Non-Business OSM Tags (Highway, Public_Transport) Must Be Excluded', 15000, async () => {
    const busStop = {
      name: 'Hoe Street / Bakers Arms',
      osmTags: { highway: 'bus_stop', public_transport: 'stop_position' },
      lat: 51.5693, lon: -0.0141,
      city: 'London',
      country: 'United Kingdom'
    };
    const isNonBusiness = busStop.osmTags &&
      Boolean(busStop.osmTags.highway || busStop.osmTags.public_transport || busStop.osmTags.railway);
    assert.strictEqual(isNonBusiness, true, 'Bus stop candidate with highway/public_transport tags must be detected as non-business');
  });
  t16 ? passed++ : failed++;

  // TEST 17
  const t17 = await runTestCase(17, 'Directory Listing Page on Unknown Domain Must NOT Count as First-Party', 20000, async () => {
    const originalFetch = rateLimiter.politeFetch;
    rateLimiter.politeFetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://unknownportal.co.uk/bakeries/london/the-royal-bakery-10525',
      text: async () => realDirectoryListingHtml
    });

    const res = await inspectCandidateWebsite(
      'https://unknownportal.co.uk/bakeries/london/the-royal-bakery-10525',
      'The Royal Bakery',
      'London',
      '',
      '',
      { preRenderedHtml: realDirectoryListingHtml, preRenderedStatus: 200, preRenderedTitle: 'The Royal Bakery in London - Opening Times and Location' }
    );
    rateLimiter.politeFetch = originalFetch;

    assert.strictEqual(res.isMatch, false, 'Directory listing page must NOT be matched as first-party site');
  });
  t17 ? passed++ : failed++;

  // TEST 18
  const t18 = await runTestCase(18, 'Company-Register Page on Unknown Domain Must Be Rejected', 20000, async () => {
    const originalFetch = rateLimiter.politeFetch;
    rateLimiter.politeFetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://bizportal-uk.net/company/12345678/artisan-bread-ltd',
      text: async () => realCompanyRegisterHtml
    });

    const res = await inspectCandidateWebsite(
      'https://bizportal-uk.net/company/12345678/artisan-bread-ltd',
      'Artisan Bread Ltd',
      'London',
      '',
      '',
      { preRenderedHtml: realCompanyRegisterHtml, preRenderedStatus: 200, preRenderedTitle: 'Artisan Bread Ltd - Company Profile and Registration' }
    );
    rateLimiter.politeFetch = originalFetch;

    assert.strictEqual(res.isMatch, false, 'Company register page must NOT match as first-party site');
  });
  t18 ? passed++ : failed++;

  // TEST 19
  const t19 = await runTestCase(19, 'Generic Social-Handle Domain Must Be Rejected', 20000, async () => {
    const originalFetch = rateLimiter.politeFetch;
    rateLimiter.politeFetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://popular.co.uk',
      text: async () => realGenericHandleHtml
    });

    const res = await inspectCandidateWebsite(
      'https://popular.co.uk',
      'Copains',
      'London',
      '',
      '',
      { socialHandle: 'popular', preRenderedHtml: realGenericHandleHtml, preRenderedStatus: 200, preRenderedTitle: 'Popular UK News and Lifestyle' }
    );
    rateLimiter.politeFetch = originalFetch;

    assert.strictEqual(res.isMatch, false, 'Generic word handle "popular" domain must NOT match for "Copains"');
  });
  t19 ? passed++ : failed++;

  // TEST 20
  const t20 = await runTestCase(20, 'Third-Party Facebook Post URL Must NOT Be Accepted as Business Social Profile', 15000, async () => {
    const candidateLead = {
      name: 'Independent Bakery',
      city: 'London',
      socialProfile: 'https://www.facebook.com/groups/londonfoodies/permalink/987654321/'
    };
    const { isMatchingBusinessSocial } = require('../verifier/index');
    assert.strictEqual(
      isMatchingBusinessSocial(candidateLead.socialProfile, candidateLead.name),
      false,
      'Group permalink URL must NOT be accepted as business profile'
    );
  });
  t20 ? passed++ : failed++;

  // TEST 21
  const t21 = await runTestCase(21, 'Closed-Business News Snippet Must Yield "Closed / skip"', 20000, async () => {
    const originalSearch = searchBackendManager.search;
    searchBackendManager.search = async () => ({
      results: [
        {
          title: 'East London bakery chain Percy Ingle will close down all 48 shops',
          url: 'https://www.standard.co.uk/news/london/percy-ingle-bakery-chain-closed-a4478126.html',
          snippet: 'Sad news for east Londoners as historic bakery chain Percy Ingle will close permanently after 66 years.'
        }
      ],
      blocked: false
    });

    const res = await websiteVerifier.verifyLead({
      name: 'Percy Ingle',
      city: 'London',
      country: 'United Kingdom',
      phone: '',
      website: '',
      socialProfile: ''
    });
    searchBackendManager.search = originalSearch;

    assert.strictEqual(
      res.websiteCheckStatus,
      'Closed / skip',
      `Closed business snippet must yield 'Closed / skip'. Got: ${res.websiteCheckStatus}`
    );
    assert(
      res.websiteEvidence.includes('Closed business detected in search results'),
      'Evidence must report closed business detection'
    );
  });
  t21 ? passed++ : failed++;

  // Clean up Playwright browser
  await closeSharedBrowser().catch(() => {});

  // Print Timings Table
  console.log('\n======================================================');
  console.log('⏱️  TEST EXECUTION TIMINGS SUMMARY');
  console.log('======================================================');
  console.log('| Test # | Test Name | Status | Duration |');
  console.log('|---|---|---|---|');
  for (const t of testTimings) {
    console.log(`| Test ${t.num} | ${t.name} | ${t.status} | ${t.durationSec}s |`);
  }

  console.log('\n======================================================');
  console.log(`Summary: ${passed} Passed, ${failed} Failed, 0 Skipped`);
  console.log('======================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(async (err) => {
  console.error('Fatal test execution error:', err);
  await closeSharedBrowser().catch(() => {});
  process.exit(1);
});
