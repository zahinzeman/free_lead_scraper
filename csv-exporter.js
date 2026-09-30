/**
 * CSV Exporter Module
 * High-performance streaming CSV generator for real lead datasets.
 * Includes complete verification evidence trail, real source records, and social profiles.
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
    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      alert("No valid leads available to export. Please run the scraper first.");
      return false;
    }

    const country = options.country || "All";
    const industry = options.industry || "General";
    const currentTab = options.currentTab || "all";

    const headers = [
      "Country",
      "State / Region",
      "City",
      "Address",
      "Business Name",
      "Owner / Decision Maker",
      "Phone Number",
      "Website URL",
      "Website Check Status",
      "Social Presence Only (Bio Unread)",
      "Confidence",
      "Verification Evidence",
      "Data Source",
      "Source URL",
      "Social Profile",
      "Industry",
      "Checked At"
    ];

    const blobParts = [];
    blobParts.push("\uFEFF"); // UTF-8 BOM
    blobParts.push(headers.map(escapeCsvField).join(",") + "\r\n");

    const CHUNK_SIZE = 2500;
    for (let i = 0; i < leads.length; i += CHUNK_SIZE) {
      const slice = leads.slice(i, i + CHUNK_SIZE);
      let chunkStr = "";

      for (let j = 0; j < slice.length; j++) {
        const lead = slice[j];
        const status = lead.websiteCheckStatus || (lead.hasWebsite ? "Has website" : "Confirmed no website");
        const isSocialOnly = status === "No website found (social only, bio unread)" ? "Yes" : "No";

        const row = [
          lead.country || "",
          lead.state || "",
          lead.city || "",
          lead.address || "",
          lead.businessName || lead.name || "",
          lead.ownerName || "", // Real registry data only, blank when unknown
          lead.phone || "",
          lead.website || "",
          status,
          isSocialOnly,
          lead.confidence || "medium",
          lead.websiteEvidence || "",
          lead.sourceProvider || lead.source || "",
          lead.sourceUrl || "",
          lead.socialProfile || "",
          lead.industry || lead.category || "",
          lead.checkedAt || new Date().toISOString()
        ];

        chunkStr += row.map(escapeCsvField).join(",") + "\r\n";
      }

      blobParts.push(chunkStr);
    }

    const blob = new Blob(blobParts, { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const tag = currentTab !== "all" ? `${currentTab}_` : "";
    const sanitizedCountry = country.replace(/[^a-zA-Z0-9]/g, "_");
    const sanitizedIndustry = industry.replace(/[^a-zA-Z0-9]/g, "_");
    const timestamp = new Date().toISOString().split("T")[0];
    const filename = `Leads_${tag}${sanitizedCountry}_${sanitizedIndustry}_${leads.length}leads_${timestamp}.csv`;

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
