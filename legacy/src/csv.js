'use strict';

// Minimal RFC4180-style CSV parser (no dependencies). Returns an array of
// objects keyed by the lower-cased header row. Handles quoted fields,
// embedded commas/newlines, and "" escaped quotes.
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // ignore — handled with the following \n
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseCsv(text) {
  const rows = parseRows(text).filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (rows.length < 1) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const obj = {};
    header.forEach((h, j) => { obj[h] = (r[j] == null ? '' : String(r[j])).trim(); });
    out.push(obj);
  }
  return out;
}

module.exports = { parseCsv };
