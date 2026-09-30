/**
 * Real Locality & Geographic Filter
 * Enforces strict boundary and address validation beyond raw bounding boxes.
 * Handles polygon containment (ray-casting), city/borough matching, 
 * and UK-specific phone area code & postcode validation (e.g., London area codes & postcodes).
 */

// Greater London Localities & 32 Boroughs + City of London
const LONDON_LOCALITIES = new Set([
  'london', 'city of london', 'westminster', 'camden', 'islington', 'hackney',
  'tower hamlets', 'southwark', 'lambeth', 'kensington', 'chelsea', 'hammersmith',
  'fulham', 'wandsworth', 'greenwich', 'lewisham', 'bromley', 'croydon', 'sutton',
  'merton', 'kingston', 'kingston upon thames', 'richmond', 'richmond upon thames',
  'hounslow', 'hillingdon', 'ealing', 'brent', 'harrow', 'barnet', 'enfield',
  'haringey', 'waltham forest', 'redbridge', 'havering', 'barking', 'dagenham',
  'barking and dagenham', 'bexley', 'shoreditch', 'soho', 'mayfair', 'brixton',
  'clapham', 'battersea', 'wimbledon', 'stratford', 'chiswick', 'islington',
  'notting hill', 'paddington', 'finchley', 'twickenham'
]);

// Non-London neighbouring commuter towns that fall into rectangular bounding boxes
const NON_LONDON_TOWNS = new Set([
  'guildford', 'staines', 'staines-upon-thames', 'egham', 'woking', 'epsom',
  'watford', 'slough', 'dartford', 'brentwood', 'weybridge', 'leatherhead',
  'chertsey', 'potters bar', 'sevenoaks', 'caterham', 'redhill', 'reigate',
  'st albans', 'borehamwood', 'rickmansworth', 'gravesend', 'dorking'
]);

/**
 * Ray-casting algorithm to test if [lng, lat] is inside a GeoJSON Polygon ring
 */
function isPointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Test if [lng, lat] is inside GeoJSON Polygon or MultiPolygon geometry
 */
function isPointInPolygon(point, geometry) {
  if (!point || !geometry || !point[0] || !point[1]) return false;
  const type = geometry.type;
  const coords = geometry.coordinates;

  if (type === 'Polygon') {
    // Exterior ring must contain point, interior holes must not
    if (!coords || coords.length === 0) return false;
    if (!isPointInRing(point, coords[0])) return false;
    for (let h = 1; h < coords.length; h++) {
      if (isPointInRing(point, coords[h])) return false; // In a hole
    }
    return true;
  } else if (type === 'MultiPolygon') {
    for (const polyCoords of coords) {
      if (!polyCoords || polyCoords.length === 0) continue;
      if (isPointInRing(point, polyCoords[0])) {
        let inHole = false;
        for (let h = 1; h < polyCoords.length; h++) {
          if (isPointInRing(point, polyCoords[h])) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Validate UK London Postcode
 * Inner London: E, EC, N, NW, SE, SW, W, WC
 * Greater London Outer Boroughs: BR, CR, DA, EN, HA, IG, KT, RM, SM, TW (except TW15-TW20), UB
 */
function isValidLondonPostcode(postcode) {
  if (!postcode) return null; // Postcode absent, cannot definitively rule out on postcode alone
  const norm = postcode.trim().toUpperCase().replace(/\s+/g, '');

  // Definite non-London postcodes that border London
  if (/^(GU|RH|SL|AL|HP|CM|SS|ME|TN|RG|SG)/.test(norm)) return false;
  if (/^TW(1[5-9]|20)/.test(norm)) return false; // Staines, Ashford, Egham (Surrey)
  if (/^KT(1[0-9]|2[0-9])/.test(norm)) return false; // Surrey parts of KT (Esher, Weybridge, etc.)

  // Valid Inner London
  if (/^(E|EC|N|NW|SE|SW|W|WC)\d/.test(norm)) return true;

  // Valid Greater London Outer Postcodes
  if (/^(BR[1-8]|CR[024-9]|DA[15-8]|EN[1-5]|HA[0-9]|IG[1-9]|IG1[01]|KT[1-6]|KT9|RM[1-9]|RM1[0-4]|SM[1-7]|TW[1-9]|TW1[0-4]|UB[1-9]|UB1[01])/.test(norm)) {
    return true;
  }

  // Any other postcode pattern is outside London
  return false;
}

/**
 * Validate UK London Phone Area Code
 * London landline codes are 020 (0207, 0208, 0203, 0204).
 * Mobile codes: 07. Non-geographic: 03, 08.
 * 01xxx codes are outside London (e.g. 01483 Guildford, 01784 Staines).
 */
function isValidLondonPhone(phone) {
  if (!phone) return null; // Phone absent, cannot rule out on phone alone
  const digits = phone.replace(/\D/g, '');
  
  // Standardize UK digits
  let ukNumber = digits;
  if (ukNumber.startsWith('44')) {
    ukNumber = '0' + ukNumber.slice(2);
  }

  if (ukNumber.length < 5) return null;

  // UK outside London landlines start with 01
  if (ukNumber.startsWith('01')) {
    // 01483 Guildford, 01784 Staines, etc.
    return false;
  }

  // Valid London landline
  if (ukNumber.startsWith('020')) {
    return true;
  }

  // Mobile or national freephone
  if (ukNumber.startsWith('07') || ukNumber.startsWith('03') || ukNumber.startsWith('08')) {
    return true;
  }

  return true;
}

/**
 * Filter a lead candidate to ensure it is genuinely within the requested locality
 * @param {object} candidate { name, address, city, state, country, phone, lat, lng, postcode }
 * @param {string} requestedCity 
 * @param {string} requestedState 
 * @param {string} requestedCountry 
 * @param {object} boundaryPolygon Optional GeoJSON boundary
 * @returns {{ isMatch: boolean, reason?: string }}
 */
function validateLocality(candidate, requestedCity, requestedState = '', requestedCountry = '', boundaryPolygon = null) {
  if (!requestedCity) return { isMatch: true };

  const normReqCity = requestedCity.trim().toLowerCase();
  const candCity = (candidate.city || '').trim().toLowerCase();
  const candAddress = (candidate.address || '').toLowerCase();
  const candPostcode = candidate.postcode || '';

  // 1. Polygon boundary check if available
  if (boundaryPolygon && candidate.lat && candidate.lng) {
    const pt = [Number(candidate.lng), Number(candidate.lat)];
    const insidePoly = isPointInPolygon(pt, boundaryPolygon);
    if (!insidePoly) {
      return { isMatch: false, reason: `Coordinates (${candidate.lat}, ${candidate.lng}) fall outside boundary polygon` };
    }
  }

  // 2. Specific London, UK Rules
  if (normReqCity === 'london' && (!requestedCountry || requestedCountry.toLowerCase().includes('kingdom') || requestedCountry.toLowerCase() === 'uk' || candidate.country === 'GB' || candidate.country === 'UK')) {
    // Check phone area code
    const phoneValid = isValidLondonPhone(candidate.phone);
    if (phoneValid === false) {
      return { isMatch: false, reason: `Phone area code (${candidate.phone}) is outside London (e.g. 01xxx commuter area)` };
    }

    // Check postcode
    // Extract postcode from candPostcode or end of address if not explicit
    let pc = candPostcode;
    if (!pc && candAddress) {
      const pcMatch = candAddress.match(/[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}/i);
      if (pcMatch) pc = pcMatch[0];
    }
    const pcValid = isValidLondonPostcode(pc);
    if (pcValid === false) {
      return { isMatch: false, reason: `Postcode (${pc}) is outside Greater London boundaries` };
    }

    // Check if address/city contains known non-London town
    for (const nonTown of NON_LONDON_TOWNS) {
      if (candCity === nonTown) {
        return { isMatch: false, reason: `Locality '${candCity}' is outside London` };
      }
      // Check word boundary in address
      const re = new RegExp(`\\b${nonTown}\\b`, 'i');
      if (re.test(candAddress) && !candAddress.includes('london rd') && !candAddress.includes('london road')) {
        return { isMatch: false, reason: `Address specifies neighbouring non-London town '${nonTown}'` };
      }
    }

    // If city is explicit London or London borough
    if (LONDON_LOCALITIES.has(candCity) || candAddress.includes('london')) {
      return { isMatch: true, reason: 'Matched London locality' };
    }

    // If no explicit city match and no coordinate match
    if (candCity && !LONDON_LOCALITIES.has(candCity) && candCity !== 'london') {
      return { isMatch: false, reason: `Locality '${candCity}' does not match London borough` };
    }

    return { isMatch: true };
  }

  // 3. General City Matching for other cities (e.g. Austin, New York, Sydney)
  if (candCity) {
    if (candCity === normReqCity || candCity.includes(normReqCity) || normReqCity.includes(candCity)) {
      return { isMatch: true, reason: `City '${candCity}' matches '${requestedCity}'` };
    }
    // If candidate has distinct other city name
    return { isMatch: false, reason: `City '${candCity}' does not match requested city '${requestedCity}'` };
  }

  // If candidate has no city field, check address string
  if (candAddress && (candAddress.includes(normReqCity))) {
    return { isMatch: true, reason: `Address contains '${requestedCity}'` };
  }

  return { isMatch: true };
}

module.exports = {
  validateLocality,
  isValidLondonPhone,
  isValidLondonPostcode,
  isPointInPolygon
};
