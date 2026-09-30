/**
 * Directory and Social Media Blocklist
 * These domains NEVER count as a business's own independent website.
 */

const BLOCKED_DOMAINS = [
  // Social networks & media
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'youtube.com',
  'pinterest.com',
  'reddit.com',

  // Review & Directory aggregators (US / Global)
  'yelp.com',
  'yellowpages.com',
  'whitepages.com',
  'thumbtack.com',
  'angi.com',
  'homeadvisor.com',
  'houzz.com',
  'bark.com',
  'trustpilot.com',
  'mapquest.com',
  'bbb.org',
  'foursquare.com',
  'nextdoor.com',
  'tripadvisor.com',
  'merchantcircle.com',
  'manta.com',
  'citysearch.com',
  'superpages.com',
  'dexknows.com',
  'cliqs.com',
  'birdeye.com',
  'allbiz.com',
  'bestpickreports.com',
  'buildzoom.com',
  'porch.com',
  'zoominfo.com',
  'dnb.com',
  'chamberofcommerce.com',
  'buzzfile.com',
  'ezlocal.com',
  'cybo.com',
  'spoke.com',
  'yellowise.com',
  'hvacservice.io',
  'bestlocal.now',

  // Reverse phone directories
  '800notes.com',
  'who-called.co.uk',
  'whocallsme.com',
  'shouldianswer.com',
  'truecaller.com',
  'callercenter.com',
  'numlookup.com',
  'sync.me',
  'okcaller.com',
  'spokeo.com',
  'beenverified.com',
  'intelius.com',
  'radaris.com',
  'fastpeoplesearch.com',
  'anywho.com',

  // Google Maps / Sites / Directory
  'google.com/maps',
  'maps.google.com',
  'g.page',
  'business.site',
  'sites.google.com',

  // UK & Ireland directories
  'checkatrade.com',
  'trustatrader.com',
  'yell.com',
  'cylex-uk.co.uk',
  'scoot.co.uk',
  'thomsonlocal.com',
  'goldenpages.ie',

  // Australia & New Zealand directories
  'hipages.com.au',
  'oneflare.com.au',
  'truelocal.com.au',
  'localsearch.com.au',
  'yellowpages.com.au',
  'whitepages.com.au',
  'yellow.co.nz',
  'finda.co.nz',

  // European directories
  'goudengids.nl',
  'telefoonboek.nl',
  'detelefoongids.nl',
  'hitta.se',
  'eniro.se',
  'allabolag.se',
  'cylex.de',
  'cylex.net',
  'hotfrog.com',
  'hotfrog.co.uk',
  'hotfrog.com.au',

  // News, Review, Awards, and Local Blog aggregators
  'dineawardslondon.com',
  'towerhamletsslice.co.uk',
  'restaurantguru.com',
  'opentable.com',
  'opentable.co.uk',
  'just-eat.co.uk',
  'deliveroo.co.uk',
  'ubereats.com',
  'zomato.com',
  'timeout.com',
  'eater.com',
  'standard.co.uk',
  'myldn.co.uk',
  'mylondon.news',
  'londonist.com',
  'infobel.com',
  'find-open.co.uk',
  '192.com',
  'thefoodguide.co.uk',
  'bakeriesnearme.co.uk',
  'hardens.com',
  'squaremeal.co.uk',
  'top-rated.online',

  // Booking, Scheduling & Listing Aggregator Platforms
  'schedulista.com',
  'bizncity.com',
  'vagaro.com',
  'fresha.com',
  'mindbodyonline.com',
  'acuityscheduling.com',
  'calendly.com',
  'setmore.com',
  'square.site',
  'booksy.com',
  'treatwell.com',
  'treatwell.co.uk',
  'jane.app',
  'noterro.com',
  'simplepractice.com',
  'healthgrades.com',
  'zocdoc.com',
  'doineedaplumber.org',
  'cityof.com',
  'home8.org',
  'austintexaspermitsearch.com',
  'locksmiths.co.uk',
  'locksmithmanchester-0161.co.uk',
  'cylex.com',
  'cylex.net',
  'cylex.de',
  'cylex-uk.co.uk',
  'bizpages.org',
  'find-us-here.com',
  'storeboard.com',
  'callupcontact.com',
  'showmelocal.com',
  'brownbook.net',
  'yalwa.com',

  // Open data projects
  'openstreetmap.org',
  'wikipedia.org',
  'wikidata.org'
];

const GENERIC_AGGREGATOR_DOMAIN_PATTERNS = [
  /(^|\.)(review|reviews|directory|directories|listing|listings|guide|guides|news|blog|blogs|awards|award|best-of|bestof|near-me|nearme|top10|top-10|slice)\./i,
  /(^|\.)(dineawards|foodguide|restaurantguide|localbusinessguide|booking|scheduler|appointments|appointment)\./i
];

const ARTICLE_URL_PATTERNS = [
  /\/\d{4}\/\d{2}\//, // Date pattern e.g. /2020/05/
  /\/(news|blog|article|articles|reviews|posts|stories|category|press)\//i // Article folders
];

/**
 * Check if a URL or hostname belongs to the directory or social blocklist
 * @param {string} urlString 
 * @returns {boolean}
 */
function isBlockedDomain(urlString) {
  if (!urlString || typeof urlString !== 'string') return true;

  try {
    let target = urlString.trim().toLowerCase();
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = 'https://' + target;
    }
    const parsed = new URL(target);
    const hostname = parsed.hostname.replace(/^www\./, '');
    const pathname = parsed.pathname;
    const fullPath = hostname + pathname;

    // 1. Direct blocklist check
    for (const blocked of BLOCKED_DOMAINS) {
      if (blocked.includes('/')) {
        if (fullPath.includes(blocked)) return true;
      } else {
        if (hostname === blocked || hostname.endsWith('.' + blocked)) return true;
      }
    }

    // 2. Generic aggregator domain pattern check
    for (const pat of GENERIC_AGGREGATOR_DOMAIN_PATTERNS) {
      if (pat.test(hostname)) return true;
    }

    // 3. Article-like URL path check
    for (const pat of ARTICLE_URL_PATTERNS) {
      if (pat.test(pathname)) return true;
    }

    // 4. Long hyphenated slug check (e.g. /east-end-bakery-percy-ingles-closing-tribute/)
    const segments = pathname.split('/').filter(Boolean);
    for (const seg of segments) {
      const hyphenCount = (seg.match(/-/g) || []).length;
      if (hyphenCount >= 4) {
        return true;
      }
    }

    return false;
  } catch (err) {
    return true; // Malformed URLs are rejected
  }
}

/**
 * Check if URL is a genuine social profile link (for recording in socialProfile)
 * Rejects posts, photos, videos, groups, stories, and share links.
 * @param {string} urlString 
 * @returns {boolean}
 */
function isSocialMediaUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return false;
  const lower = urlString.toLowerCase();
  const isSocialDomain = lower.includes('facebook.com') ||
         lower.includes('instagram.com') ||
         lower.includes('linkedin.com') ||
         lower.includes('linktr.ee') ||
         lower.includes('twitter.com') ||
         lower.includes('x.com');
  if (!isSocialDomain) return false;

  // Must NOT be a post, photo, video, story, reel, group, event, or share link
  try {
    const parsed = new URL(urlString.startsWith('http') ? urlString : 'https://' + urlString);
    const path = parsed.pathname.toLowerCase();
    if (
      path.includes('/posts/') ||
      path.endsWith('/posts') ||
      path.includes('/photos/') ||
      path.endsWith('/photos') ||
      path.includes('/videos/') ||
      path.endsWith('/videos') ||
      path.includes('/stories/') ||
      path.includes('/reel/') ||
      path.includes('/reels/') ||
      path.includes('/groups/') ||
      path.includes('/events/') ||
      path.includes('/permalink/') ||
      path.includes('/share.php') ||
      path.includes('/sharer/') ||
      path.includes('/watch/')
    ) {
      return false;
    }

    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) return false;
    if (['login', 'help', 'recover', 'events', 'places', 'watch', 'share', 'sharer.php'].includes(segments[0])) {
      return false;
    }
  } catch (e) {
    return false;
  }

  return true;
}

module.exports = {
  BLOCKED_DOMAINS,
  isBlockedDomain,
  isSocialMediaUrl
};
