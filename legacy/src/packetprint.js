'use strict';

// Packet-only print furniture. Board letters, ordinances, reports and minutes
// keep their own document templates; this module owns only the packet cover,
// contents, tab dividers, attachment separators and incomplete-packet notice.
// Keeping that boundary lets the packet look like a professionally bound board
// book without changing the legal instruments inside it.

const { ORG } = require('./org');
const { escapeHtml } = require('./util');

// Requested house faces first. Liberation is installed in the production
// container as a metric-compatible fallback for Linux/Chromium.
const SERIF = '"Times New Roman", "Liberation Serif", Times, serif';
const SANS = 'Arial, "Liberation Sans", Helvetica, sans-serif';

const CSS = `
@page {
  size: Letter;
  margin: .68in .72in .78in .72in;
}
:root {
  --navy:#071b2f;
  --navy-soft:#173551;
  --gold:#b8952f;
  --ink:#111820;
  --body:#333b43;
  --muted:#66717d;
  --rule:#bcc4cc;
  --soft:#edf1f4;
  --paper:#fff;
}
* { box-sizing:border-box; }
html,body { margin:0; padding:0; }
body {
  color:var(--body);
  background:var(--paper);
  font:10.5pt/1.42 ${SERIF};
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

.packet-rule {
  height:3pt;
  margin:0 0 20pt;
  background:var(--navy);
  border-bottom:.8pt solid var(--gold);
}
.mast-org {
  color:var(--navy);
  font:700 10pt/1.2 ${SANS};
  letter-spacing:.08em;
  text-transform:uppercase;
}
.mast-kind {
  margin-top:3pt;
  color:var(--muted);
  font:700 8pt/1.2 ${SANS};
  letter-spacing:.12em;
  text-transform:uppercase;
}
.mast-body {
  margin-top:22pt;
  color:var(--ink);
  font:700 14pt/1.2 ${SERIF};
}
.packet-title {
  margin:7pt 0 0;
  color:var(--navy);
  font:700 29pt/1.02 ${SERIF};
  letter-spacing:-.015em;
}
.packet-when {
  margin-top:14pt;
  color:var(--ink);
  font:700 13pt/1.25 ${SERIF};
}
.packet-meta {
  width:100%;
  margin-top:18pt;
  border-collapse:collapse;
  border-top:.7pt solid var(--rule);
  border-bottom:.7pt solid var(--rule);
}
.packet-meta th,
.packet-meta td {
  padding:7pt 8pt 7pt 0;
  text-align:left;
  vertical-align:top;
  border-bottom:.35pt solid #d9dee3;
}
.packet-meta tr:last-child th,
.packet-meta tr:last-child td { border-bottom:0; }
.packet-meta th {
  width:1.22in;
  color:var(--muted);
  font:700 7.5pt/1.25 ${SANS};
  letter-spacing:.07em;
  text-transform:uppercase;
}
.packet-summary {
  display:table;
  width:100%;
  margin-top:22pt;
  border:1pt solid #c7d0d8;
  background:#f5f7f9;
}
.packet-summary-cell {
  display:table-cell;
  width:33.333%;
  padding:10pt 12pt;
  border-right:.5pt solid #d1d7dd;
}
.packet-summary-cell:last-child { border-right:0; }
.packet-summary-value {
  display:block;
  color:var(--navy);
  font:700 16pt/1 ${SANS};
}
.packet-summary-label {
  display:block;
  margin-top:4pt;
  color:var(--muted);
  font:700 7pt/1.2 ${SANS};
  letter-spacing:.07em;
  text-transform:uppercase;
}
.packet-note {
  margin-top:20pt;
  color:var(--muted);
  font:9pt/1.45 ${SERIF};
}

/* Contents */
.contents-heading {
  margin:18pt 0 4pt;
  color:var(--navy);
  font:700 20pt/1.1 ${SERIF};
}
.contents-sub {
  margin:0 0 14pt;
  color:var(--muted);
  font:9pt/1.35 ${SANS};
}
.contents {
  width:100%;
  border-collapse:collapse;
  table-layout:fixed;
}
.contents thead { display:table-header-group; }
.contents tr { break-inside:avoid; }
.contents th {
  padding:5pt 6pt;
  color:#fff;
  background:var(--navy-soft);
  border-right:.35pt solid rgba(255,255,255,.35);
  font:700 7.5pt/1.2 ${SANS};
  letter-spacing:.05em;
  text-align:left;
  text-transform:uppercase;
}
.contents td {
  padding:6pt;
  border-right:.35pt solid #d7dde2;
  border-bottom:.45pt solid #c9d0d6;
  vertical-align:top;
}
.contents tbody tr:nth-child(even) td { background:#f7f9fa; }
.contents .tab { width:.62in; font:700 9pt/1.25 ${SANS}; }
.contents .agenda { width:.72in; font:9pt/1.25 ${SANS}; }
.contents .page { width:.72in; text-align:right; font:700 9pt/1.25 ${SANS}; }
.contents .matter { color:var(--ink); font-weight:700; }
.contents .section { display:block; margin-top:2pt; color:var(--muted); font:7.5pt/1.25 ${SANS}; }

/* Tab divider */
.sheet {
  min-height:8.2in;
  display:flex;
  flex-direction:column;
  justify-content:center;
  text-align:left;
}
.sheet-tab {
  color:var(--navy);
  font:700 42pt/.95 ${SANS};
  letter-spacing:-.025em;
}
.sheet-kind {
  margin-top:13pt;
  color:var(--gold);
  font:700 8pt/1.25 ${SANS};
  letter-spacing:.11em;
  text-transform:uppercase;
}
.sheet-title {
  max-width:5.8in;
  margin-top:7pt;
  color:var(--ink);
  font:700 17pt/1.2 ${SERIF};
}
.sheet-section {
  margin-top:10pt;
  color:var(--muted);
  font:9pt/1.3 ${SANS};
}
.sheet-rule { width:1.25in; margin-top:18pt; border-top:1.5pt solid var(--navy); }
.sheet-note { max-width:5.5in; margin-top:12pt; color:var(--muted); font:9.5pt/1.4 ${SERIF}; }
.sheet-url { max-width:5.5in; margin-top:6pt; color:var(--muted); font:7.5pt/1.25 ${SANS}; word-break:break-all; }

/* Attachment separator */
.separator-box {
  margin-top:1.35in;
  padding:24pt;
  border:1pt solid var(--rule);
  border-top:4pt solid var(--navy);
}
.separator-box .sheet-kind { margin-top:0; }
.separator-box .sheet-title { font-size:15pt; }

/* Incomplete packet */
.warn-title {
  margin:18pt 0 8pt;
  color:#7a2525;
  font:700 18pt/1.1 ${SANS};
  text-transform:uppercase;
}
.warn-lede {
  padding:10pt 12pt;
  border-left:3pt solid #b34b4b;
  background:#fff5f5;
}
.warn-list { margin:14pt 0 0; padding-left:18pt; }
.warn-list li { margin-bottom:5pt; }
`;

function page(title, bodyHtml, extraCss = '') {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<title>${escapeHtml(title)}</title>`
    + `<style>${CSS}${extraCss}</style></head><body>${bodyHtml}</body></html>`;
}

function header(kind, bodyName) {
  let out = `<div class="mast-org">${escapeHtml(String(ORG.name || '').toUpperCase())}</div>`;
  out += `<div class="mast-kind">${escapeHtml(kind)}</div>`;
  if (bodyName && String(bodyName).toUpperCase() !== String(ORG.name || '').toUpperCase()) {
    out += `<div class="mast-body">${escapeHtml(bodyName)}</div>`;
  }
  out += '<div class="packet-rule"></div>';
  return out;
}

function footerPlain(identity) {
  return `<table style="width:100%;padding:0 .55in;font-size:8px;font-family:${SANS};`
    + 'color:#66717d;border-collapse:collapse;">'
    + `<tr><td style="text-align:left;">${escapeHtml(identity)}</td>`
    + '<td style="text-align:right;">Official agenda packet</td></tr></table>';
}

function cover(meeting, when, { itemCount = 0, tabCount = 0, documentCount = 0 } = {}) {
  let out = header('Board meeting materials', '');
  out += '<div class="packet-title">AGENDA PACKET</div>';
  if (meeting.body_name) out += `<div class="mast-body">${escapeHtml(meeting.body_name)}</div>`;
  out += `<div class="packet-when">${escapeHtml(when)}</div>`;
  out += '<table class="packet-meta">';
  if (meeting.location) out += `<tr><th>Location</th><td>${escapeHtml(meeting.location)}</td></tr>`;
  if (meeting.status) out += `<tr><th>Status</th><td>${escapeHtml(meeting.status)}</td></tr>`;
  out += `<tr><th>Prepared by</th><td>${escapeHtml(ORG.name)}</td></tr>`;
  out += '</table>';
  out += '<div class="packet-summary">'
    + `<div class="packet-summary-cell"><span class="packet-summary-value">${itemCount}</span><span class="packet-summary-label">Agenda items</span></div>`
    + `<div class="packet-summary-cell"><span class="packet-summary-value">${tabCount}</span><span class="packet-summary-label">Material tabs</span></div>`
    + `<div class="packet-summary-cell"><span class="packet-summary-value">${documentCount}</span><span class="packet-summary-label">Packet documents</span></div>`
    + '</div>';
  out += '<p class="packet-note">This packet is assembled in agenda order. Packet page numbers run continuously across the cover, contents, generated documents, and bound supporting material.</p>';
  return page('Agenda Packet', out);
}

function contents(meeting, entries) {
  let out = header('Agenda packet', meeting.body_name);
  out += '<div class="contents-heading">PACKET CONTENTS</div>';
  out += '<p class="contents-sub">Tabs follow the agenda sequence. Packet page numbers refer to the continuous numbering printed at the foot of every sheet.</p>';
  if (!entries.length) {
    out += '<p><em>No agenda item in this packet carries supporting material.</em></p>';
    return page('Packet Contents', out);
  }
  out += '<table class="contents"><thead><tr>'
    + '<th class="tab">Tab</th><th class="agenda">Agenda</th><th>Item / material</th><th class="page">Page</th>'
    + '</tr></thead><tbody>';
  out += entries.map((e) => {
    const matter = e.fileNumber
      ? `<span class="matter">${escapeHtml(e.fileNumber)}</span> — ${escapeHtml(e.title || '')}`
      : escapeHtml(e.title || '(item)');
    const section = e.section ? `<span class="section">${escapeHtml(e.section)}</span>` : '';
    return '<tr>'
      + `<td class="tab">${e.tab ? escapeHtml(String(e.tab)) : '—'}</td>`
      + `<td class="agenda">${escapeHtml(e.agendaNumber || '')}</td>`
      + `<td>${matter}${section}</td>`
      + `<td class="page">${e.page ? escapeHtml(String(e.page)) : '—'}</td>`
      + '</tr>';
  }).join('');
  out += '</tbody></table>';
  return page('Packet Contents', out);
}

function divider({ tab, agendaNumber, title, section }) {
  let out = '<div class="sheet">'
    + `<div class="sheet-tab">TAB ${escapeHtml(String(tab))}</div>`;
  if (agendaNumber) out += `<div class="sheet-kind">AGENDA ITEM ${escapeHtml(agendaNumber)}</div>`;
  out += `<div class="sheet-title">${escapeHtml(title || '')}</div>`;
  if (section) out += `<div class="sheet-section">${escapeHtml(section)}</div>`;
  out += '<div class="sheet-rule"></div>';
  out += '<div class="sheet-note">Supporting material for this agenda item follows.</div>';
  out += '</div>';
  return page(`Tab ${tab}`, out);
}

function separator({ kind, name, note, url }) {
  let out = '<div class="separator-box">'
    + `<div class="sheet-kind">${escapeHtml(String(kind || 'Supporting document').toUpperCase())}</div>`
    + `<div class="sheet-title">${escapeHtml(name || 'Document')}</div>`;
  if (note) out += `<div class="sheet-note">${escapeHtml(note)}</div>`;
  if (url) out += `<div class="sheet-url">${escapeHtml(url)}</div>`;
  out += '</div>';
  return page(name || 'Document', out);
}

function problems(list) {
  const n = list.length;
  let out = header('Packet quality control', '');
  out += '<div class="warn-title">INCOMPLETE PACKET</div>';
  out += `<div class="warn-lede">${n} document${n === 1 ? '' : 's'} could not be bound into this packet. Resolve the item${n === 1 ? '' : 's'} below before distribution whenever possible.</div>`;
  out += `<ul class="warn-list">${list.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
  return page('Incomplete Packet', out);
}

module.exports = { cover, contents, divider, separator, problems, footerPlain };