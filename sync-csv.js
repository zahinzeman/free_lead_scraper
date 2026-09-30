const fs = require('fs');
const path = require('path');

function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

const headers = [
  'City', 'Industry', 'Business Name', 'Address', 'Phone',
  'Website Status', 'Confidence', 'Source Provider', 'Source URL',
  'Social Profile', 'Verification Evidence'
];

const rows = [headers.join(',')];
let count = 0;

const files = fs.readdirSync(__dirname).filter(f => f.startsWith('results-') && f.endsWith('.jsonl'));
for (const f of files) {
  const filePath = path.join(__dirname, f);
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const lead = JSON.parse(line);
      if (lead.websiteCheckStatus === 'Confirmed no website' || lead.websiteCheckStatus === 'No website found (social only, bio unread)') {
        count++;
        rows.push([
          escapeCsv(lead.runCity || lead.city),
          escapeCsv(lead.runIndustry || lead.industry),
          escapeCsv(lead.name),
          escapeCsv(lead.address || `${lead.city || ''}, UK`),
          escapeCsv(lead.phone || ''),
          escapeCsv(lead.websiteCheckStatus),
          escapeCsv(lead.confidence),
          escapeCsv(lead.sourceProvider || ''),
          escapeCsv(lead.sourceUrl || ''),
          escapeCsv(lead.socialProfile || ''),
          escapeCsv(lead.websiteEvidence || '')
        ].join(','));
      }
    } catch (e) {}
  }
}

fs.writeFileSync(path.join(__dirname, 'no-website-leads-to-check.csv'), rows.join('\n'), 'utf8');
console.log(`Exported ${count} no-website leads to no-website-leads-to-check.csv`);
