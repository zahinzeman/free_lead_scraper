/**
 * Multi-Layer Real-Time Website Verifier
 * Orchestrates 6 rigorous detection layers with honest rate limiting and politeness.
 * 
 * Strict uncertainty & status rules:
 * - If ANY search layer is blocked, challenges with CAPTCHA, times out, or returns 0 results,
 *   the lead can NEVER be "Confirmed no website" -> marked "Uncertain".
 * - If phone is missing, lead cannot be "Confirmed no website" unless at least TWO independent 
 *   search queries (name+city and name+borough/neighbourhood/street/postcode) ran successfully.
 * - NEW MIDDLE STATUS: "No website found (social only, bio unread)" when every search layer and
 *   domain guessing ran successfully and found no site, but the only presence found is a social
 *   profile whose bio could not be read (Facebook HTTP 400, login wall, or consent wall).
 * - "Confirmed no website" requires either that the social bio was read with no website link, or no social profile exists.
 * - Provides confidence field: 'high' | 'medium' | 'low'.
 */

const { isBlockedDomain, isSocialMediaUrl } = require('./blocklist');
const { cleanBusinessName, cleanPhone, isMultiCountryChain } = require('../utils/normalizer');
const { inspectCandidateWebsite, extractBusinessTokens } = require('./content-matcher');
const { checkGuessedDomains, extractSocialHandle } = require('./domain-guesser');
const { checkArchiveHistory } = require('./archive-check');
const { inspectSocialProfiles } = require('./social-check');
const { searchByPhone } = require('./reverse-phone');
const searchBackendManager = require('./search-backends');

// Real business directories, review and ordering platforms. A listing on one of these proves a
// business exists (unlike Wikipedia, blogs or fan sites that merely mention a name).
const BUSINESS_LISTING_HOSTS = /(^|\.)(yelp\.[a-z.]+|yell\.com|yellowpages\.[a-z.]+|superpages\.com|manta\.com|bbb\.org|chamberofcommerce\.(com|uk)|nextdoor\.[a-z.]+|mapquest\.com|foursquare\.com|tripadvisor\.[a-z.]+|thumbtack\.com|angi\.com|homeadvisor\.com|houzz\.[a-z.]+|bark\.com|checkatrade\.com|trustatrader\.com|ratedpeople\.com|mybuilder\.com|hotfrog\.[a-z.]+|cylex[a-z.-]*|freeindex\.co\.uk|thomsonlocal\.com|scoot\.co\.uk|192\.com|find-open\.[a-z.]+|brownbook\.net|opendi\.[a-z.]+|infobel\.com|goldenpages\.ie|goudengids\.nl|telefoonboek\.nl|hitta\.se|eniro\.se|allabolag\.se|truelocal\.com\.au|localsearch\.com\.au|hipages\.com\.au|oneflare\.com\.au|yellow\.co\.nz|finda\.co\.nz|nocowboys\.co\.nz|deliveroo\.[a-z.]+|ubereats\.com|just-eat\.[a-z.]+|justeat\.[a-z.]+|doordash\.com|grubhub\.com|thuisbezorgd\.nl|foodora\.se|menulog\.com\.au|restaurantguru\.com|opentable\.[a-z.]+|thefork\.[a-z.]+|ratings\.food\.gov\.uk|companieshouse\.gov\.uk|find-and-update\.company-information\.service\.gov\.uk)$/i;
function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
}

const CLOSED_SNIPPET_PATTERNS = /\b(will close|closing|closed down|permanently closed|farewell|has closed|shut down|no longer trading|ceased trading)\b/i;

/**
 * Filter social URLs: must belong to the business (not third-party news/posts/pages)
 */
function isMatchingBusinessSocial(url, businessName) {
  if (!url || typeof url !== 'string') return false;
  if (!isSocialMediaUrl(url)) return false;
  const handle = extractSocialHandle(url);
  if (!handle) return false;
  const { distinctiveTokens } = extractBusinessTokens(businessName);
  if (distinctiveTokens.length === 0) return false;
  const cleanHandle = handle.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['popular', 'official', 'news', 'info', 'media', 'butlerandstag', 'pages', 'community', 'places'].includes(cleanHandle)) {
    return false;
  }
  // The handle must carry the business's leading brand word (4+ letters), or every
  // distinctive word of the name. Matching any one short word let "The One 2 Vue Shop"
  // claim facebook.com/TheOneBySineadCorcoran.
  const inHandle = (t) => cleanHandle.includes(t) || (t.length > 4 && t.endsWith('s') && cleanHandle.includes(t.slice(0, -1)));
  const lead = distinctiveTokens[0];
  if (lead.length >= 4 && inHandle(lead)) return true;
  return distinctiveTokens.every(inHandle);
}

/**
 * Extract borough, neighbourhood, street, or postcode for second independent query
 * @param {object} candidate 
 * @param {string} city 
 * @returns {string}
 */
function extractLocalityPart(candidate, city = '') {
  // 1. Postcode
  let pc = candidate.postcode;
  if (!pc && candidate.address) {
    const pcMatch = candidate.address.match(/[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}/i);
    if (pcMatch) pc = pcMatch[0];
  }
  if (pc && pc.length >= 3) return pc.trim();

  // 2. Candidate borough, suburb, district, street
  if (candidate.borough && candidate.borough.length >= 3 && candidate.borough.toLowerCase() !== city.toLowerCase()) {
    return candidate.borough.trim();
  }
  if (candidate.suburb && candidate.suburb.length >= 3 && candidate.suburb.toLowerCase() !== city.toLowerCase()) {
    return candidate.suburb.trim();
  }
  if (candidate.district && candidate.district.length >= 3 && candidate.district.toLowerCase() !== city.toLowerCase()) {
    return candidate.district.trim();
  }
  if (candidate.street && candidate.street.length >= 3) {
    return candidate.street.trim();
  }

  // 3. Address parts (street, neighbourhood, area)
  if (candidate.address) {
    const parts = candidate.address
      .split(/[,;\n]/)
      .map(p => p.trim())
      .filter(p => p.length >= 3 && p.toLowerCase() !== city.toLowerCase() && !/^(greater|metro|area|region|england|uk|united kingdom|london)/i.test(p));

    if (parts.length > 0) {
      return parts[0];
    }
  }

  return '';
}

class WebsiteVerifier {
  /**
   * Verify whether a business genuinely has no active website
   * @param {object} candidate { name, address, city, state, country, phone, website, socialProfile, postcode }
   * @param {string} preferredSearchMethod
   * @returns {Promise<object>}
   */
  async verifyLead(candidate, preferredSearchMethod = null) {
    const PER_LEAD_TIMEOUT_MS = 90000;
    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({
          websiteCheckStatus: 'Uncertain',
          websiteUrl: '',
          socialProfile: candidate.socialProfile || '',
          confidence: 'low',
          websiteEvidence: 'UNCERTAIN (lead verification timed out after 90s)',
          checkedAt: new Date().toISOString()
        });
      }, PER_LEAD_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        this._verifyLeadInternal(candidate, preferredSearchMethod),
        timeoutPromise
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async _verifyLeadInternal(candidate, preferredSearchMethod = null) {
    const {
      name,
      city = '',
      state = '',
      country = 'United States',
      phone = '',
      postcode = '',
      address = ''
    } = candidate;

    const checkedAt = new Date().toISOString();
    const evidenceTrail = [];
    let searchBlockedOrFailed = false;
    let searchBlockedReason = '';
    let directoryListingCount = 0;
    let detectedSocialProfile = candidate.socialProfile || '';
    const hasPhone = Boolean(phone && cleanPhone(phone).length >= 7);

    // Problem 3: Chain / multi-country corporate check
    if (isMultiCountryChain(name, candidate.website)) {
      evidenceTrail.push(`Excluded as multi-country corporate chain / brand ('${name}')`);
      return {
        websiteCheckStatus: 'Closed / skip',
        websiteUrl: candidate.website || '',
        socialProfile: '',
        confidence: 'high',
        websiteEvidence: evidenceTrail.join('; '),
        checkedAt
      };
    }

    // =========================================================================
    // LAYER 1: Source Record Inspection
    // =========================================================================
    if (candidate.website && candidate.website.trim().length > 0) {
      const srcUrl = candidate.website.trim();
      if (!isBlockedDomain(srcUrl)) {
        const srcMatch = await inspectCandidateWebsite(srcUrl, name, city, phone, postcode);
        if (srcMatch.isChain) {
          evidenceTrail.push(`Source record: excluded as multi-location chain (${srcUrl})`);
          return {
            websiteCheckStatus: 'Closed / skip',
            websiteUrl: srcUrl,
            socialProfile: detectedSocialProfile,
            confidence: 'high',
            websiteEvidence: evidenceTrail.join('; '),
            checkedAt
          };
        }
        if (srcMatch.isMatch) {
          evidenceTrail.push(`Source record: verified first-party website (${srcUrl})`);
          return {
            websiteCheckStatus: 'Has website',
            websiteUrl: srcMatch.matchedUrl || srcUrl,
            pageTitle: srcMatch.title || '',
            socialProfile: detectedSocialProfile,
            confidence: 'high',
            websiteEvidence: evidenceTrail.join('; '),
            checkedAt
          };
        } else {
          // Why was the listed website rejected? A domain that no longer exists means the
          // business genuinely has no working website. A site that exists but could not be
          // loaded (timeout, blocking, JS-only) is unknown, so it must not allow a "no website" result.
          let srcHost = '';
          try { srcHost = new URL(srcUrl.startsWith('http') ? srcUrl : `https://${srcUrl}`).hostname; } catch (_) {}
          let srcDomainDead = false;
          if (srcHost) {
            try {
              await require('dns').promises.resolve(srcHost);
            } catch (dnsErr) {
              srcDomainDead = ['ENOTFOUND', 'ENODATA', 'ESERVFAIL'].includes(dnsErr.code);
            }
          }
          const why = srcMatch.reason || srcMatch.error || (srcMatch.isParked ? 'parked domain' : 'page did not identify this business');

          // A listed domain that does not exist is often a typo in the map record
          // (treasurehomesdesign.com vs the real treasurehomesdesigns.com). Try close variants.
          if (srcDomainDead && srcHost) {
            const bare = srcHost.replace(/^www\./, '');
            const dot = bare.indexOf('.');
            const sld = bare.slice(0, dot), tld = bare.slice(dot);
            const variants = [sld.endsWith('s') ? sld.slice(0, -1) : sld + 's', sld.replace(/-/g, ''), sld.includes('-') ? sld : null]
              .filter(v => v && v !== sld && v.length >= 3)
              .map(v => v + tld);
            for (const variant of [...new Set(variants)]) {
              let resolves = false;
              try { await require('dns').promises.resolve(variant); resolves = true; } catch (_) {}
              if (!resolves) continue;
              const vMatch = await inspectCandidateWebsite(`https://${variant}`, name, city, phone, postcode);
              if (vMatch.isMatch) {
                evidenceTrail.push(`Source record: listed website ${srcUrl} does not exist, but the corrected domain ${variant} is this business's site (${vMatch.reason})`);
                return {
                  websiteCheckStatus: 'Has website',
                  websiteUrl: vMatch.matchedUrl || `https://${variant}`,
                  pageTitle: vMatch.title || '',
                  socialProfile: detectedSocialProfile,
                  confidence: 'high',
                  websiteEvidence: evidenceTrail.join('; '),
                  checkedAt
                };
              }
            }
          }

          if (srcDomainDead) {
            evidenceTrail.push(`Source record: listed website ${srcUrl} no longer exists (domain does not resolve) — no working website`);
          } else if (srcMatch.isParked) {
            evidenceTrail.push(`Source record: listed website ${srcUrl} is a parked/for-sale domain — no working website`);
          } else if (!srcMatch.error && !srcMatch.isBlocked && !srcMatch.isClosed &&
                     /domain contains name token yes/.test(srcMatch.reason || '') &&
                     /homepage about business yes/.test(srcMatch.reason || '')) {
            // The business's own map listing links to a live site whose domain carries its name
            // and whose homepage is about it. The listing itself is the second signal.
            evidenceTrail.push(`Source record: listed website ${srcUrl} carries the business name and its homepage is about this business`);
            return {
              websiteCheckStatus: 'Has website',
              websiteUrl: srcUrl,
              pageTitle: srcMatch.title || '',
              socialProfile: detectedSocialProfile,
              confidence: 'high',
              websiteEvidence: evidenceTrail.join('; '),
              checkedAt
            };
          } else if (/HTTP (401|403|429|503)\b/.test(srcMatch.error || '') || [401, 403, 429, 503].includes(srcMatch.statusCode)) {
            // The business's own map listing names this website and the server answers, but
            // blocks automated visitors (Cloudflare etc). That is a live website.
            evidenceTrail.push(`Source record: listed website ${srcUrl} is live but blocks automated checks (${srcMatch.error || 'HTTP ' + srcMatch.statusCode})`);
            return {
              websiteCheckStatus: 'Has website',
              websiteUrl: srcUrl,
              pageTitle: '',
              socialProfile: detectedSocialProfile,
              confidence: 'medium',
              websiteEvidence: evidenceTrail.join('; '),
              checkedAt
            };
          } else if (srcMatch.error || !srcMatch.title) {
            evidenceTrail.push(`Source record: listed website ${srcUrl} exists but could not be checked (${why})`);
            searchBlockedOrFailed = true;
            if (!searchBlockedReason) searchBlockedReason = `source lists a website (${srcUrl}) that exists but could not be checked: ${why}`;
          } else {
            evidenceTrail.push(`Source record: URL rejected by first-party verification (${srcUrl}: ${why})`);
          }
        }
      } else if (isSocialMediaUrl(srcUrl)) {
        if (isMatchingBusinessSocial(srcUrl, name)) {
          detectedSocialProfile = srcUrl;
          evidenceTrail.push(`Source record: social URL in website field (${srcUrl})`);
        }
      } else {
        evidenceTrail.push(`Source record: URL is in directory blocklist (${srcUrl})`);
      }
    } else {
      evidenceTrail.push('Source record: no website tag in source database');
    }

    // =========================================================================
    // LAYER 2: Free Web Search (Name + City)
    // =========================================================================
    const searchSocialLinks = [];
    const cleanName = cleanBusinessName(name);
    const cleanCity = cleanBusinessName(city);
    const query1 = `${cleanName} ${cleanCity}`.trim();

    let searchRes = await searchBackendManager.search(query1, preferredSearchMethod);

    if ((searchRes.blocked || !searchRes.results || searchRes.results.length === 0) && name !== cleanName) {
      searchRes = await searchBackendManager.search(`${name} ${city}`, preferredSearchMethod);
    }

    if (searchRes.blocked) {
      searchBlockedOrFailed = true;
      searchBlockedReason = searchRes.reason && searchRes.reason.includes('search cooldown')
        ? 'search cooldown'
        : `Search layer blocked or challenged (${searchRes.reason || 'rate limited'})`;
      evidenceTrail.push(`Web search: BLOCKED (${searchRes.reason})`);

      // Requirement 2: Do not spend 90 seconds on a lead when search is blocked. Skip it, mark it "Uncertain (search blocked)"
      return {
        websiteCheckStatus: 'Uncertain (search blocked)',
        websiteUrl: '',
        socialProfile: detectedSocialProfile || '',
        confidence: 'low',
        websiteEvidence: `UNCERTAIN (search blocked: ${searchBlockedReason}); Trail: ${evidenceTrail.join('; ')}`,
        checkedAt
      };
    } else if (!searchRes.results || searchRes.results.length === 0) {
      searchBlockedOrFailed = true;
      searchBlockedReason = 'Web search returned 0 results for query where results are expected';
      evidenceTrail.push('Web search: 0 results returned (cannot confirm absence of website, marking Uncertain)');
    } else {
      // Problem 4: Closed business check in search result titles & snippets
      const { distinctiveTokens } = extractBusinessTokens(name);
      for (const item of searchRes.results) {
        const text = `${item.title} ${item.snippet}`;
        if (CLOSED_SNIPPET_PATTERNS.test(text)) {
          const mentionsName = distinctiveTokens.length > 0 && distinctiveTokens.every(t => text.toLowerCase().includes(t));
          if (mentionsName) {
            evidenceTrail.push(`Closed business detected in search results: "${item.title} - ${item.snippet}"`);
            return {
              websiteCheckStatus: 'Closed / skip',
              websiteUrl: '',
              socialProfile: '',
              confidence: 'high',
              websiteEvidence: evidenceTrail.join('; '),
              checkedAt
            };
          }
        }
      }

      const organicResults = [];
      for (const item of searchRes.results) {
        // Directory / review listings (Yelp, Yell, Yellow Pages...) that name this business are
        // proof it really exists, even though they are not its website.
        if (BUSINESS_LISTING_HOSTS.test(safeHost(item.url))) {
          const { distinctiveTokens: dt } = extractBusinessTokens(name);
          const text = `${item.title || ''} ${item.url || ''}`.toLowerCase().replace(/['’]/g, '');
          if (dt.length && dt.every(t => text.includes(t))) directoryListingCount++;
        }
        if (isSocialMediaUrl(item.url)) {
          if (isMatchingBusinessSocial(item.url, name)) {
            searchSocialLinks.push(item.url);
            if (!detectedSocialProfile) detectedSocialProfile = item.url;
          }
        } else if (!isBlockedDomain(item.url)) {
          organicResults.push(item);
        }
      }

      let webSearchFoundMatch = false;
      for (const item of organicResults.slice(0, 5)) {
        const match = await inspectCandidateWebsite(item.url, name, city, phone, postcode);
        if (match.isChain) {
          evidenceTrail.push(`Excluded as chain: ${match.reason}`);
          return {
            websiteCheckStatus: 'Closed / skip',
            websiteUrl: match.matchedUrl || item.url,
            socialProfile: detectedSocialProfile,
            confidence: 'high',
            websiteEvidence: evidenceTrail.join('; '),
            checkedAt
          };
        }
        if (match.isMatch) {
          evidenceTrail.push(`Web search: found matching business site '${item.url}' (${match.reason})`);
          return {
            websiteCheckStatus: 'Has website',
            websiteUrl: match.matchedUrl || item.url,
            pageTitle: match.title || '',
            socialProfile: detectedSocialProfile,
            confidence: 'high',
            websiteEvidence: evidenceTrail.join('; '),
            checkedAt
          };
        }
      }

      if (!webSearchFoundMatch) {
        if (organicResults.length === 0) {
          evidenceTrail.push(`Web search top-10: all results were directory/social aggregator pages`);
        } else {
          evidenceTrail.push(`Web search top-10: ${organicResults.length} non-directory results inspected, no match`);
        }
      }
    }

    // =========================================================================
    // LAYER 2b: Second Independent Search Query (Mandatory if phone is missing)
    // =========================================================================
    let dualSearchSuccessful = false;
    if (!hasPhone && !searchBlockedOrFailed) {
      const targetLocality = extractLocalityPart(candidate, city);

      if (targetLocality && targetLocality.length >= 3) {
        const query2 = `${cleanName} ${targetLocality}`.trim();
        const searchRes2 = await searchBackendManager.search(query2, preferredSearchMethod);

        if (searchRes2.blocked) {
          searchBlockedOrFailed = true;
          searchBlockedReason = searchRes2.reason && searchRes2.reason.includes('search cooldown')
            ? 'search cooldown'
            : `second search query blocked (${searchRes2.reason || 'rate limited'})`;
          evidenceTrail.push(`Web search query 2 ('${query2}'): blocked or throttled`);

          // Requirement 2: Skip immediately when blocked
          return {
            websiteCheckStatus: 'Uncertain (search blocked)',
            websiteUrl: '',
            socialProfile: detectedSocialProfile || '',
            confidence: 'low',
            websiteEvidence: `UNCERTAIN (search blocked: ${searchBlockedReason}); Trail: ${evidenceTrail.join('; ')}`,
            checkedAt
          };
        } else if (!searchRes2.results || searchRes2.results.length === 0) {
          searchBlockedOrFailed = true;
          searchBlockedReason = 'no phone, reduced confidence (second search query returned 0 results)';
          evidenceTrail.push(`Web search query 2 ('${query2}'): returned 0 results`);
        } else {
          // Closed business check on query 2
          const { distinctiveTokens } = extractBusinessTokens(name);
          for (const item of searchRes2.results) {
            const text = `${item.title} ${item.snippet}`;
            if (CLOSED_SNIPPET_PATTERNS.test(text)) {
              const mentionsName = distinctiveTokens.length > 0 && distinctiveTokens.every(t => text.toLowerCase().includes(t));
              if (mentionsName) {
                evidenceTrail.push(`Closed business detected in search results: "${item.title} - ${item.snippet}"`);
                return {
                  websiteCheckStatus: 'Closed / skip',
                  websiteUrl: '',
                  socialProfile: '',
                  confidence: 'high',
                  websiteEvidence: evidenceTrail.join('; '),
                  checkedAt
                };
              }
            }
          }

          let matchFound2 = false;
          for (const item of searchRes2.results.slice(0, 5)) {
            if (isSocialMediaUrl(item.url)) {
              if (isMatchingBusinessSocial(item.url, name) && !detectedSocialProfile) {
                detectedSocialProfile = item.url;
              }
            } else if (!isBlockedDomain(item.url)) {
              const match2 = await inspectCandidateWebsite(item.url, name, city, phone, targetLocality);
              if (match2.isChain) {
                evidenceTrail.push(`Excluded as chain: ${match2.reason}`);
                return {
                  websiteCheckStatus: 'Closed / skip',
                  websiteUrl: match2.matchedUrl || item.url,
                  socialProfile: detectedSocialProfile,
                  confidence: 'high',
                  websiteEvidence: evidenceTrail.join('; '),
                  checkedAt
                };
              }
              if (match2.isMatch) {
                matchFound2 = true;
                evidenceTrail.push(`Web search query 2: found matching site '${item.url}' (${match2.reason})`);
                return {
                  websiteCheckStatus: 'Has website',
                  websiteUrl: match2.matchedUrl || item.url,
                  pageTitle: match2.title || '',
                  socialProfile: detectedSocialProfile,
                  confidence: 'high',
                  websiteEvidence: evidenceTrail.join('; '),
                  checkedAt
                };
              }
            }
          }
          if (!matchFound2) {
            dualSearchSuccessful = true;
            evidenceTrail.push(`Web search query 2 ('${query2}'): verified 0 matches`);
          }
        }
      } else {
        // No locality, borough, street or postcode available
        searchBlockedOrFailed = true;
        searchBlockedReason = 'no phone, reduced confidence (address/borough/postcode unavailable for second independent search)';
        evidenceTrail.push('Web search query 2: cannot run (postcode/borough/street missing), downgrading to Uncertain');
      }
    }

    // =========================================================================
    // LAYER 3: Domain Guessing & DNS Resolution (with Misspelling & Social Handle)
    // =========================================================================
    const domainGuessResult = await checkGuessedDomains(
      name,
      city,
      country,
      phone,
      detectedSocialProfile || candidate.socialProfile
    );

    if (domainGuessResult.found) {
      evidenceTrail.push(domainGuessResult.evidence);
      return {
        websiteCheckStatus: 'Has website',
        websiteUrl: domainGuessResult.url,
        pageTitle: domainGuessResult.title || '',
        socialProfile: detectedSocialProfile,
        confidence: 'high',
        websiteEvidence: evidenceTrail.join('; '),
        checkedAt
      };
    }

    // Item 1 FIX: If any candidate domain resolves in DNS and is not proven parked/wrong-business,
    // the lead CANNOT be "Confirmed no website" — force Uncertain.
    if (domainGuessResult.resolvingCandidateDomainFound) {
      if (!searchBlockedOrFailed) {
        searchBlockedOrFailed = true;
        searchBlockedReason = `candidate domain(s) resolve in DNS but content could not be verified (bot-protection or no readable content): ${domainGuessResult.evidence}`;
      }
    }

    evidenceTrail.push(domainGuessResult.evidence);

    // =========================================================================
    // LAYER 4: Free Archive & Index Checks (Wayback CDX)
    // =========================================================================
    const archiveResult = await checkArchiveHistory(name, city, country, phone);
    if (archiveResult.foundLive) {
      evidenceTrail.push(archiveResult.evidence);
      return {
        websiteCheckStatus: 'Has website',
        websiteUrl: archiveResult.url,
        socialProfile: detectedSocialProfile,
        confidence: 'high',
        websiteEvidence: evidenceTrail.join('; '),
        checkedAt
      };
    }
    if (archiveResult.forceUncertain) {
      searchBlockedOrFailed = true;
      if (!searchBlockedReason) searchBlockedReason = archiveResult.evidence;
    }
    evidenceTrail.push(archiveResult.evidence);

    // =========================================================================
    // LAYER 5: Social / Profile Check (Login/Consent Wall Detection)
    // =========================================================================
    const allSocials = [
      ...(candidate.socialProfile ? [candidate.socialProfile] : []),
      ...searchSocialLinks
    ];

    let socialOnlyBioUnread = false;
    let socialUnreadReason = '';

    const socialResult = await inspectSocialProfiles(allSocials, name, city, phone);
    if (socialResult.primarySocialProfile && !detectedSocialProfile) {
      detectedSocialProfile = socialResult.primarySocialProfile;
    }
    if (socialResult.foundWebsite) {
      evidenceTrail.push(socialResult.evidence);
      return {
        websiteCheckStatus: 'Has website',
        websiteUrl: socialResult.websiteUrl,
        socialProfile: detectedSocialProfile,
        confidence: 'high',
        websiteEvidence: evidenceTrail.join('; '),
        checkedAt
      };
    }
    if (socialResult.isClosed) {
      evidenceTrail.push(socialResult.evidence);
      return {
        websiteCheckStatus: 'Closed / skip',
        websiteUrl: '',
        socialProfile: detectedSocialProfile,
        confidence: 'high',
        websiteEvidence: `Business detected as closed: ${socialResult.evidence}; Trail: ${evidenceTrail.join('; ')}`,
        checkedAt
      };
    }
    if (socialResult.bioUnread) {
      socialOnlyBioUnread = true;
      socialUnreadReason = socialResult.bioUnreadReason || 'Social bio could not be read (login wall, consent wall, or HTTP 400)';
    }
    evidenceTrail.push(socialResult.evidence);

    // =========================================================================
    // LAYER 6: Reverse Phone Search
    // =========================================================================
    if (hasPhone) {
      const phoneResult = await searchByPhone(phone, name, city);
      if (phoneResult.blocked) {
        searchBlockedOrFailed = true;
        if (!searchBlockedReason) searchBlockedReason = phoneResult.evidence;
      }
      if (phoneResult.isClosed) {
        evidenceTrail.push(phoneResult.evidence);
        return {
          websiteCheckStatus: 'Closed / skip',
          websiteUrl: '',
          socialProfile: detectedSocialProfile,
          confidence: 'high',
          websiteEvidence: `Business detected as closed via phone search: ${phoneResult.evidence}; Trail: ${evidenceTrail.join('; ')}`,
          checkedAt
        };
      }
      if (phoneResult.found) {
        evidenceTrail.push(phoneResult.evidence);
        return {
          websiteCheckStatus: 'Has website',
          websiteUrl: phoneResult.url,
          pageTitle: phoneResult.title || '',
          socialProfile: detectedSocialProfile,
          confidence: 'high',
          websiteEvidence: evidenceTrail.join('; '),
          checkedAt
        };
      }
      evidenceTrail.push(phoneResult.evidence);
    } else {
      evidenceTrail.push('Phone search: phone number absent, skipped');
    }

    // =========================================================================
    // FINAL EVALUATION
    // =========================================================================
    // 1. If any search layer was blocked or failed, status is Uncertain
    if (searchBlockedOrFailed) {
      return {
        websiteCheckStatus: 'Uncertain',
        websiteUrl: '',
        socialProfile: detectedSocialProfile,
        confidence: 'low',
        websiteEvidence: `UNCERTAIN (${searchBlockedReason}); Trail: ${evidenceTrail.join('; ')}`,
        checkedAt
      };
    }

    // 1b. The business must be shown to exist before it can be a "no website" lead. Open map
    // data contains joke/fictional entries (e.g. "Mrs. Lovett's Meat Pies, Fleet St") and
    // long-gone places. Accept a phone number, a government food-hygiene registration, a
    // matching social profile, or at least one directory listing under its name.
    const existsEvidence = hasPhone ||
      /FSA|Food Hygiene/i.test(candidate.sourceProvider || '') ||
      Boolean(detectedSocialProfile) ||
      directoryListingCount > 0;
    if (!existsEvidence) {
      evidenceTrail.push('Existence check: no phone, no registry record, no social profile and no directory listing found for this name');
      return {
        websiteCheckStatus: 'Uncertain',
        websiteUrl: '',
        socialProfile: '',
        confidence: 'low',
        websiteEvidence: `UNCERTAIN (could not confirm this business exists); Trail: ${evidenceTrail.join('; ')}`,
        checkedAt
      };
    }
    if (directoryListingCount > 0) {
      evidenceTrail.push(`Existence check: listed in ${directoryListingCount} directory result(s)`);
    }

    // A generic name ("Lunch Bar", "The Bakery") with no phone and no street address cannot be
    // tied to one real business: directory hits may belong to any of many similarly named places.
    const { distinctiveTokens: nameDistinctive } = extractBusinessTokens(name, city);
    const hasStreetAddress = /\d/.test(address || '') || Boolean(postcode);
    if (!hasPhone && !hasStreetAddress && nameDistinctive.length <= 1) {
      evidenceTrail.push('Identity check: generic name with no phone and no street address');
      return {
        websiteCheckStatus: 'Uncertain',
        websiteUrl: '',
        socialProfile: detectedSocialProfile,
        confidence: 'low',
        websiteEvidence: `UNCERTAIN (name too generic to identify one business without a phone or street address); Trail: ${evidenceTrail.join('; ')}`,
        checkedAt
      };
    }

    // 2. Middle status: all searches and domain guessing ran clean with 0 matches,
    // and the only presence found is a social profile whose bio was unreadable
    if (socialOnlyBioUnread) {
      return {
        websiteCheckStatus: 'No website found (social only, bio unread)',
        websiteUrl: '',
        socialProfile: detectedSocialProfile,
        confidence: 'medium',
        websiteEvidence: `No website found (social only, bio unread: ${socialUnreadReason}); Trail: ${evidenceTrail.join('; ')}`,
        checkedAt
      };
    }

    // 3. Confirmed no website: high confidence if phone was verified, medium if verified via dual search without phone
    const finalConfidence = hasPhone ? 'high' : 'medium';

    return {
      websiteCheckStatus: 'Confirmed no website',
      websiteUrl: '',
      socialProfile: detectedSocialProfile,
      confidence: finalConfidence,
      websiteEvidence: evidenceTrail.join('; '),
      checkedAt
    };
  }
}

const websiteVerifierInstance = new WebsiteVerifier();
websiteVerifierInstance.extractLocalityPart = extractLocalityPart;
websiteVerifierInstance.isMatchingBusinessSocial = isMatchingBusinessSocial;
module.exports = websiteVerifierInstance;
