/**
 * Lead Scraper Engine - Geographic State & City Data Registry
 * (All synthetic lead generation, fake trade patterns, and synthetic phone generators have been permanently removed)
 */

const ScraperEngine = (function () {
  // Real Geographic Reference Databases for Country & State Dropdown Navigation
  const REGION_DATA = {
    "United States": {
      code: "+1",
      flag: "🇺🇸",
      states: [
        { name: "All States (Countrywide)", code: "ALL", city: "All Cities" },
        { name: "Alabama", code: "AL", cities: ["Birmingham", "Montgomery", "Mobile", "Huntsville"] },
        { name: "Alaska", code: "AK", cities: ["Anchorage", "Fairbanks", "Juneau"] },
        { name: "Arizona", code: "AZ", cities: ["Phoenix", "Tucson", "Mesa", "Chandler", "Scottsdale"] },
        { name: "Arkansas", code: "AR", cities: ["Little Rock", "Fort Smith", "Fayetteville", "Springdale"] },
        { name: "California", code: "CA", cities: ["Los Angeles", "San Diego", "San Jose", "San Francisco", "Fresno", "Sacramento"] },
        { name: "Colorado", code: "CO", cities: ["Denver", "Colorado Springs", "Aurora", "Fort Collins"] },
        { name: "Connecticut", code: "CT", cities: ["Bridgeport", "New Haven", "Stamford", "Hartford"] },
        { name: "Delaware", code: "DE", cities: ["Wilmington", "Dover", "Newark"] },
        { name: "Florida", code: "FL", cities: ["Miami", "Orlando", "Tampa", "Jacksonville", "St. Petersburg", "Fort Lauderdale"] },
        { name: "Georgia", code: "GA", cities: ["Atlanta", "Augusta", "Savannah", "Athens"] },
        { name: "Hawaii", code: "HI", cities: ["Honolulu", "Hilo", "Kailua"] },
        { name: "Idaho", code: "ID", cities: ["Boise", "Meridian", "Nampa", "Idaho Falls"] },
        { name: "Illinois", code: "IL", cities: ["Chicago", "Aurora", "Naperville", "Joliet", "Rockford"] },
        { name: "Indiana", code: "IN", cities: ["Indianapolis", "Fort Wayne", "Evansville", "South Bend"] },
        { name: "Iowa", code: "IA", cities: ["Des Moines", "Cedar Rapids", "Davenport", "Sioux City"] },
        { name: "Kansas", code: "KS", cities: ["Wichita", "Overland Park", "Kansas City", "Olathe"] },
        { name: "Kentucky", code: "KY", cities: ["Louisville", "Lexington", "Bowling Green", "Owensboro"] },
        { name: "Louisiana", code: "LA", cities: ["New Orleans", "Baton Rouge", "Shreveport", "Lafayette"] },
        { name: "Maine", code: "ME", cities: ["Portland", "Lewiston", "Bangor"] },
        { name: "Maryland", code: "MD", cities: ["Baltimore", "Columbia", "Germantown", "Silver Spring"] },
        { name: "Massachusetts", code: "MA", cities: ["Boston", "Worcester", "Springfield", "Cambridge"] },
        { name: "Michigan", code: "MI", cities: ["Detroit", "Grand Rapids", "Warren", "Sterling Heights", "Ann Arbor"] },
        { name: "Minnesota", code: "MN", cities: ["Minneapolis", "St. Paul", "Rochester", "Duluth", "Bloomington"] },
        { name: "Mississippi", code: "MS", cities: ["Jackson", "Gulfport", "Southaven", "Biloxi"] },
        { name: "Missouri", code: "MO", cities: ["Kansas City", "St. Louis", "Springfield", "Columbia"] },
        { name: "Montana", code: "MT", cities: ["Billings", "Missoula", "Great Falls", "Bozeman"] },
        { name: "Nebraska", code: "NE", cities: ["Omaha", "Lincoln", "Bellevue", "Grand Island"] },
        { name: "Nevada", code: "NV", cities: ["Las Vegas", "Henderson", "Reno", "North Las Vegas"] },
        { name: "New Hampshire", code: "NH", cities: ["Manchester", "Nashua", "Concord"] },
        { name: "New Jersey", code: "NJ", cities: ["Newark", "Jersey City", "Paterson", "Elizabeth", "Edison"] },
        { name: "New Mexico", code: "NM", cities: ["Albuquerque", "Las Cruces", "Rio Rancho", "Santa Fe"] },
        { name: "New York", code: "NY", cities: ["New York City", "Buffalo", "Rochester", "Yonkers", "Syracuse", "Albany"] },
        { name: "North Carolina", code: "NC", cities: ["Charlotte", "Raleigh", "Greensboro", "Durham", "Winston-Salem"] },
        { name: "North Dakota", code: "ND", cities: ["Fargo", "Bismarck", "Grand Forks"] },
        { name: "Ohio", code: "OH", cities: ["Columbus", "Cleveland", "Cincinnati", "Toledo", "Akron"] },
        { name: "Oklahoma", code: "OK", cities: ["Oklahoma City", "Tulsa", "Norman", "Broken Arrow"] },
        { name: "Oregon", code: "OR", cities: ["Portland", "Salem", "Eugene", "Gresham", "Hillsboro"] },
        { name: "Pennsylvania", code: "PA", cities: ["Philadelphia", "Pittsburgh", "Allentown", "Reading", "Erie"] },
        { name: "Rhode Island", code: "RI", cities: ["Providence", "Warwick", "Cranston", "Pawtucket"] },
        { name: "South Carolina", code: "SC", cities: ["Charleston", "Columbia", "North Charleston", "Mount Pleasant"] },
        { name: "South Dakota", code: "SD", cities: ["Sioux Falls", "Rapid City", "Aberdeen"] },
        { name: "Tennessee", code: "TN", cities: ["Nashville", "Memphis", "Knoxville", "Chattanooga"] },
        { name: "Texas", code: "TX", cities: ["Houston", "San Antonio", "Dallas", "Austin", "Fort Worth", "El Paso"] },
        { name: "Utah", code: "UT", cities: ["Salt Lake City", "West Valley City", "Provo", "West Jordan"] },
        { name: "Vermont", code: "VT", cities: ["Burlington", "South Burlington", "Rutland"] },
        { name: "Virginia", code: "VA", cities: ["Virginia Beach", "Norfolk", "Chesapeake", "Richmond", "Arlington"] },
        { name: "Washington", code: "WA", cities: ["Seattle", "Spokane", "Tacoma", "Vancouver", "Bellevue"] },
        { name: "West Virginia", code: "WV", cities: ["Charleston", "Huntington", "Morgantown", "Parkersburg"] },
        { name: "Wisconsin", code: "WI", cities: ["Milwaukee", "Madison", "Green Bay", "Kenosha"] },
        { name: "Wyoming", code: "WY", cities: ["Cheyenne", "Casper", "Laramie", "Gillette"] },
        { name: "Washington D.C.", code: "DC", cities: ["Washington"] }
      ]
    },
    "Australia": {
      code: "+61",
      flag: "🇦🇺",
      states: [
        { name: "All States / Territories", code: "ALL", city: "All Cities" },
        { name: "New South Wales", code: "NSW", cities: ["Sydney", "Newcastle", "Wollongong", "Central Coast"] },
        { name: "Victoria", code: "VIC", cities: ["Melbourne", "Geelong", "Ballarat", "Bendigo"] },
        { name: "Queensland", code: "QLD", cities: ["Brisbane", "Gold Coast", "Sunshine Coast", "Townsville", "Cairns"] },
        { name: "Western Australia", code: "WA", cities: ["Perth", "Fremantle", "Mandurah", "Bunbury"] },
        { name: "South Australia", code: "SA", cities: ["Adelaide", "Mount Gambier", "Whyalla"] },
        { name: "Tasmania", code: "TAS", cities: ["Hobart", "Launceston", "Devonport"] },
        { name: "Australian Capital Territory", code: "ACT", cities: ["Canberra", "Belconnen", "Tuggeranong"] },
        { name: "Northern Territory", code: "NT", cities: ["Darwin", "Alice Springs", "Palmerston"] }
      ]
    },
    "United Kingdom": {
      code: "+44",
      flag: "🇬🇧",
      states: [
        { name: "All Regions / Nations", code: "ALL", city: "All Cities" },
        { name: "Greater London", code: "GL", cities: ["London", "Westminster", "Croydon", "Bromley"] },
        { name: "West Midlands", code: "WM", cities: ["Birmingham", "Coventry", "Wolverhampton", "Solihull"] },
        { name: "Greater Manchester", code: "GM", cities: ["Manchester", "Salford", "Bolton", "Stockport"] },
        { name: "West Yorkshire", code: "WY", cities: ["Leeds", "Bradford", "Wakefield", "Huddersfield"] },
        { name: "Merseyside", code: "MS", cities: ["Liverpool", "Birkenhead", "St Helens", "Southport"] },
        { name: "South West", code: "SW", cities: ["Bristol", "Bath", "Plymouth", "Exeter"] },
        { name: "South Yorkshire", code: "SY", cities: ["Sheffield", "Doncaster", "Rotherham"] },
        { name: "Scotland", code: "SCT", cities: ["Glasgow", "Edinburgh", "Aberdeen", "Dundee"] },
        { name: "Wales", code: "WLS", cities: ["Cardiff", "Swansea", "Newport"] },
        { name: "Northern Ireland", code: "NIR", cities: ["Belfast", "Derry", "Lisburn", "Newry"] }
      ]
    },
    "New Zealand": {
      code: "+64",
      flag: "🇳🇿",
      states: [
        { name: "All Regions (Countrywide)", code: "ALL", city: "All Cities" },
        { name: "Auckland", code: "AUK", cities: ["Auckland City", "Manukau", "North Shore", "Waitakere"] },
        { name: "Canterbury", code: "CAN", cities: ["Christchurch", "Timaru", "Ashburton"] },
        { name: "Wellington", code: "WGN", cities: ["Wellington City", "Lower Hutt", "Porirua", "Upper Hutt"] },
        { name: "Waikato", code: "WKO", cities: ["Hamilton", "Taupo", "Cambridge", "Te Awamutu"] },
        { name: "Bay of Plenty", code: "BOP", cities: ["Tauranga", "Rotorua", "Whakatane"] },
        { name: "Otago", code: "OTA", cities: ["Dunedin", "Queenstown", "Wanaka", "Oamaru"] },
        { name: "Hawke's Bay", code: "HKB", cities: ["Napier", "Hastings", "Havelock North"] },
        { name: "Manawatu-Wanganui", code: "MWT", cities: ["Palmerston North", "Whanganui", "Feilding"] },
        { name: "Taranaki", code: "TKI", cities: ["New Plymouth", "Hawera", "Stratford"] },
        { name: "Northland", code: "NTL", cities: ["Whangarei", "Kerikeri", "Kaitaia"] },
        { name: "Nelson-Tasman", code: "TAS", cities: ["Nelson", "Richmond", "Motueka"] },
        { name: "Southland", code: "STL", cities: ["Invercargill", "Gore"] }
      ]
    },
    "Ireland": {
      code: "+353",
      flag: "🇮🇪",
      states: [
        { name: "All Counties (Countrywide)", code: "ALL", city: "All Cities" },
        { name: "County Dublin", code: "D", cities: ["Dublin City", "Dún Laoghaire", "Swords", "Tallaght"] },
        { name: "County Cork", code: "C", cities: ["Cork City", "Cobh", "Mallow", "Kinsale"] },
        { name: "County Galway", code: "G", cities: ["Galway City", "Tuam", "Ballinasloe"] },
        { name: "County Limerick", code: "L", cities: ["Limerick City", "Newcastle West"] },
        { name: "County Waterford", code: "W", cities: ["Waterford City", "Tramore", "Dungarvan"] },
        { name: "County Kildare", code: "KE", cities: ["Naas", "Newbridge", "Celbridge"] },
        { name: "County Meath", code: "MH", cities: ["Navan", "Ashbourne", "Dunboyne"] },
        { name: "County Wicklow", code: "WW", cities: ["Bray", "Greystones", "Arklow", "Wicklow Town"] },
        { name: "County Louth", code: "LH", cities: ["Dundalk", "Drogheda", "Ardee"] }
      ]
    },
    "Sweden": {
      code: "+46",
      flag: "🇸🇪",
      states: [
        { name: "All Counties / Regions", code: "ALL", city: "All Cities" },
        { name: "Stockholm County", code: "AB", cities: ["Stockholm", "Södertälje", "Täby", "Solna", "Sundbyberg"] },
        { name: "Västra Götaland County", code: "O", cities: ["Gothenburg", "Borås", "Trollhättan", "Skövde"] },
        { name: "Skåne County", code: "M", cities: ["Malmö", "Helsingborg", "Lund", "Kristianstad"] },
        { name: "Uppsala County", code: "C", cities: ["Uppsala", "Enköping", "Östhammar"] },
        { name: "Östergötland County", code: "E", cities: ["Linköping", "Norrköping", "Motala"] },
        { name: "Jönköping County", code: "F", cities: ["Jönköping", "Nässjö", "Värnamo"] },
        { name: "Halland County", code: "N", cities: ["Halmstad", "Varberg", "Kungsbacka"] },
        { name: "Örebro County", code: "T", cities: ["Örebro", "Karlskoga", "Kumla"] }
      ]
    },
    "Netherlands": {
      code: "+31",
      flag: "🇳🇱",
      states: [
        { name: "All Provinces (Countrywide)", code: "ALL", city: "All Cities" },
        { name: "North Holland", code: "NH", cities: ["Amsterdam", "Haarlem", "Zaanstad", "Haarlemmermeer", "Alkmaar"] },
        { name: "South Holland", code: "ZH", cities: ["Rotterdam", "The Hague", "Zoetermeer", "Leiden", "Dordrecht"] },
        { name: "North Brabant", code: "NB", cities: ["Eindhoven", "Tilburg", "Breda", "'s-Hertogenbosch", "Helmond"] },
        { name: "Utrecht", code: "UT", cities: ["Utrecht", "Amersfoort", "Veenendaal", "Zeist"] },
        { name: "Gelderland", code: "GE", cities: ["Nijmegen", "Arnhem", "Apeldoorn", "Ede"] },
        { name: "Overijssel", code: "OV", cities: ["Enschede", "Zwolle", "Deventer", "Hengelo"] },
        { name: "Limburg", code: "LI", cities: ["Maastricht", "Venlo", "Sittard-Geleen", "Heerlen"] },
        { name: "Groningen", code: "GR", cities: ["Groningen", "Stadskanaal", "Hoogezand-Sappemeer"] }
      ]
    }
  };

  function getStatesForCountry(countryName) {
    const region = REGION_DATA[countryName] || REGION_DATA["United States"];
    return region.states || [];
  }

  function getCitiesForState(countryName, stateCode) {
    const states = getStatesForCountry(countryName);
    if (!stateCode || stateCode === 'ALL') {
      const allCities = [];
      states.forEach(s => {
        if (s.cities) allCities.push(...s.cities);
      });
      return allCities;
    }
    const matched = states.find(s => s.code === stateCode);
    return matched && matched.cities ? matched.cities : [];
  }

  return {
    REGION_DATA,
    getStatesForCountry,
    getCitiesForState
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ScraperEngine;
}
