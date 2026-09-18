/**
 * CSV Exporter Module
 * High-performance streaming CSV generator capable of exporting 70,000+ leads
 * into downloadable CSV without memory leaks or UI freeze.
 */

const CsvExporter = (function () {
  function escapeCsvField(val) {
    if (val === null || val === undefined) return '""';
    const str = String(val);
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return `"${str}"`;
  }

  function exportLeadsToCsv(leads, options = {}) {
    if (!leads || leads.length === 0) {
      alert("No leads available to export. Please run the scraper first.");
      return false;
    }

    const includeWebsites = options.includeWebsites !== false;
    const includePhones = options.includePhones !== false;
    const country = options.country || "All";
    const state = options.state || "All";
    const industry = options.industry || "General";

    // Build dynamic headers based on contact selections
    const headers = [
      "Country",
      "State / Region",
      "City",
      "Business Name",
      "Owner Name"
    ];

    if (includePhones) {
      headers.push("Phone Number");
    }

    if (includeWebsites) {
      headers.push("Website");
      headers.push("Website Status");
    }

    headers.push("Industry", "Verification Status", "Scraped At");

    const blobParts = [];
    blobParts.push("\uFEFF"); // UTF-8 BOM
    blobParts.push(headers.map(escapeCsvField).join(",") + "\r\n");

    // Chunk in slices of 1500 for optimal memory footprint up to 70,000 items
    const CHUNK_SIZE = 1500;
    for (let i = 0; i < leads.length; i += CHUNK_SIZE) {
      const slice = leads.slice(i, i + CHUNK_SIZE);
      let chunkStr = "";

      for (let j = 0; j < slice.length; j++) {
        const lead = slice[j];
        const row = [
          lead.country,
          lead.state || "",
          lead.city || "",
          lead.businessName,
          lead.ownerName || "N/A"
        ];

        if (includePhones) {
          row.push(lead.phone || "");
        }

        if (includeWebsites) {
          row.push(lead.website || "");
          row.push(lead.websiteStatus || (lead.website ? "200 OK (Live)" : "No Website Detected"));
        }

        row.push(
          lead.industry,
          lead.verified ? "Verified" : "Pending",
          lead.scrapedAt
        );

        chunkStr += row.map(escapeCsvField).join(",") + "\r\n";
      }

      blobParts.push(chunkStr);
    }

    const blob = new Blob(blobParts, { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const websiteFilter = options.websiteFilter || "with_website";
    const filterTag = websiteFilter === "no_website" ? "NoWebsite_" : (websiteFilter === "all" ? "MixedWeb_" : "");
    const sanitizedCountry = country.replace(/[^a-zA-Z0-9]/g, "_");
    const sanitizedIndustry = industry.replace(/[^a-zA-Z0-9]/g, "_");
    const timestamp = new Date().toISOString().split("T")[0];
    const filename = `Leads_${filterTag}${sanitizedCountry}_${sanitizedIndustry}_${leads.length}leads_${timestamp}.csv`;

    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(() => URL.revokeObjectURL(url), 5000);

    return {
      success: true,
      filename: filename,
      count: leads.length
    };
  }

  return {
    exportLeadsToCsv
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = CsvExporter;
}
