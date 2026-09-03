'use strict';

/**
 * The printed documents, as HTML.
 *
 * These were drawn — text placed at computed coordinates by `pdfdoc.js`, one
 * word at a time. That is why a two-column head matter had to be built by
 * padding labels with spaces, and why it never lined up. Paged CSS already
 * knows how to set a table, hang an indent, keep a heading with the paragraph
 * under it, and break a page; a browser is a better typesetter than anything
 * worth hand-rolling here.
 *
 * The stylesheet is inlined into every document rather than linked. A linked
 * sheet is a network fetch inside the renderer, which is a way for a packet to
 * come out unstyled on the one morning the asset server is slow — and these
 * documents are printed once and read on paper, so there is nothing to cache.
 */

const { ORG } = require('./org');
const { escapeHtml } = require('./util');

/**
 * The measure of the page.
 *
 * A board letter carries a roster down the left rail on its first page, so the
 * page's left margin has to clear it. `@page` sets the sheet; the rail is
 * placed in that margin by pulling left out of the text column.
 */
const RAIL_W = '1.5in';

/**
 * The rail, and why it repeats.
 *
 * Chromium clips anything outside the page's content box and lays `fixed`
 * elements out relative to that box, not the sheet — so a rail positioned into
 * the page margin is simply not rendered. That was measured, not assumed: an
 * absolutely positioned rail at a negative offset vanished, while a fixed one
 * landed inside the text column and sat on top of the prose.
 *
 * So the rail lives inside the content box and the text is indented past it,
 * which means `position: fixed` puts it on every page. That is a change from
 * the drawn letter, which printed the roster once and merely kept the margin
 * on later pages. It is the behaviour a rail is for — a continuation sheet
 * that has come away from the letter still says whose board it is — and it is
 * what actual board letterhead does. The alternative, a roster on page one
 * only, has no reliable expression in paged CSS.
 *
 * What must not change between pages is the measure. The drawn letter dropped
 * its margin back on page 2, moving the text column 128pt left and widening it
 * by a third: one document set in two measures, which reads as a fault.
 */
const RAIL_PAGE_CSS = `body { padding-left: ${RAIL_W}; }`;

/**
 * Fonts, in the order they will actually be found.
 *
 * The container installs Noto; Liberation is what most Debian images carry;
 * Georgia and Times are for a developer's machine. A stack that ends at
 * `serif` cannot render as boxes, which is what an unconfigured container does
 * to a document that names one font and means it.
 */
const SERIF = '"Noto Serif", "Liberation Serif", Georgia, "Times New Roman", serif';
const SANS = '"Noto Sans", "Liberation Sans", "Helvetica Neue", Arial, sans-serif';

const CSS = `
@page {
  size: Letter;
  margin: 0.85in 1in 1in 1in;
}
:root {
  --ink: #0f1217;
  --muted: #6b7585;
  --rule: #c9ccd2;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font: 10.5pt/1.42 ${SERIF};
  color: var(--ink);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* --- Masthead ------------------------------------------------------------ */
.mast-org { font-size: 13pt; font-weight: 700; letter-spacing: .01em; }
.mast-kind { font: 600 10pt/1.3 ${SANS}; color: var(--muted); text-transform: uppercase;
  letter-spacing: .06em; margin-top: 2pt; }
.mast-body { font-size: 11pt; font-weight: 700; margin-top: 3pt; }
.mast-rule { border: 0; border-top: 0.6pt solid var(--rule); margin: 10pt 0 14pt; }

/* --- The roster in the left rail --------------------------------------
   Inside the content box, because Chromium clips what is outside it. See
   RAIL_PAGE_CSS above for why this repeats on every page. */
.rail {
  position: fixed;
  top: 0;
  left: 0;
  width: calc(${RAIL_W} - 16pt);
  font: 7.5pt/1.3 ${SANS};
}
.rail-label { font-weight: 700; font-size: 7pt; letter-spacing: .08em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 8pt; }
.rail-member { margin-bottom: 7pt; break-inside: avoid; }
.rail-name { font-weight: 700; font-size: 8pt; text-transform: uppercase; letter-spacing: .01em; }
.rail-role { color: var(--muted); }

/* --- Head matter: a real table, so the values are a column ---------------
   This is the layout that space-padding was imitating. Three values that
   landed at x=232.0, 219.4 and 227.7 now land wherever the column is, because
   there is a column. */
.headmatter { border-collapse: collapse; margin-bottom: 14pt; }
.headmatter th {
  width: 52pt;
  text-align: left;
  font-weight: 400;
  vertical-align: top;
  padding: 0 0 4pt 0;
}
.headmatter td { vertical-align: top; padding: 0 0 4pt 0; }

/* --- Sections ------------------------------------------------------------ */
h2.sec {
  font-size: 11pt;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
  margin: 14pt 0 5pt;
  /* A heading at the foot of a page with its text overleaf reads as an empty
     section. */
  break-after: avoid;
  break-inside: avoid;
}
.sec-body p { margin: 0 0 7pt; orphans: 2; widows: 2; }
.sec-body ul { margin: 0 0 7pt; padding-left: 16pt; }
.sec-body li { margin-bottom: 3pt; }
.sec-body table { border-collapse: collapse; width: 100%; margin: 0 0 7pt; }
.sec-body td, .sec-body th { border: 0.5pt solid var(--rule); padding: 3pt 5pt;
  text-align: left; vertical-align: top; }
.subject { font-weight: 700; text-transform: uppercase; }

/* --- Signature ----------------------------------------------------------- */
.sign { margin-top: 22pt; break-inside: avoid; }
.sign-line { border-top: 0.6pt solid var(--ink); width: 2.9in; margin-top: 26pt; }
.sign-role { font: 8.5pt/1.3 ${SANS}; color: var(--muted); margin-top: 3pt; }

.muted { color: var(--muted); }

/* --- The packet's front matter -------------------------------------------
   The contents is a table because it is one: a tab column and an entry. It
   was built by padding a tab label with spaces, so a tabbed row read
   "Tab 1 5.A. 260802 — …" with the two run together while an untabbed row
   started flush at its number — two left edges in one list, and no column to
   scan down. An item carrying nothing leaves the tab column blank, which says
   "nothing behind this one" without claiming anything. */
.contents { border-collapse: collapse; width: 100%; margin-top: 4pt; }
.contents td { vertical-align: top; padding: 0 0 4pt 0; }
.contents .tab { width: 52pt; white-space: nowrap; }
.cover-when { font-size: 12pt; margin-bottom: 4pt; }
.cover-meta { color: var(--muted); font-size: 10pt; margin-bottom: 2pt; }

/* --- Divider and separator sheets ----------------------------------------
   A packet opened at random has to say where it is. These are the only pages
   in the document that are centred, because they are signposts rather than
   text. */
.sheet { text-align: center; margin-top: 2.4in; }
.sheet-tab { font-size: 28pt; font-weight: 700; letter-spacing: .02em; }
.sheet-kind { font: 600 10pt/1.3 ${SANS}; color: var(--muted);
  text-transform: uppercase; letter-spacing: .06em; margin-top: 12pt; }
.sheet-title { font-size: 13pt; margin-top: 8pt; }
.sheet-note { font-size: 10.5pt; font-style: italic; color: var(--muted);
  margin: 10pt auto 0; max-width: 4.6in; }
.sheet-url { font-size: 9pt; color: var(--muted); margin-top: 6pt; word-break: break-all; }

/* --- The page that says the packet is short ------------------------------
   Set larger than a section heading because it is not a section: it is the
   page that tells a clerk the packet is incomplete before it goes out. */
.warn-title { font-size: 14pt; font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; margin: 0 0 8pt; }
.warn-list { margin: 0 0 10pt; padding-left: 16pt; }
.warn-list li { margin-bottom: 4pt; }
`;

/**
 * A complete document.
 *
 * `title` reaches the PDF's own metadata, which is what a reader's file
 * manager and a document management system show — a packet full of files all
 * named "untitled" is a packet nobody can search.
 */
function page(title, bodyHtml, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<title>${escapeHtml(title)}</title>`
    + `<style>${CSS}${extraCss}</style></head>`
    + `<body>${bodyHtml}</body></html>`;
}

/**
 * The running footer, in Chromium's own header/footer band.
 *
 * It sits outside the page box, so it cannot collide with the text however
 * long the last paragraph runs — which the drawn version could. `pageNumber`
 * and `totalPages` are filled in by the browser after pagination, which is the
 * only moment either number is knowable.
 *
 * This carries what the running header used to: enough to identify a page that
 * has come away from the rest of the document.
 */
function footer(identity) {
  // The band is a separate document with its own stylesheet, and Chromium
  // gives it `font-size: 0` — a template that inherits its size renders as an
  // invisible smudge, which is what the first attempt produced. Size and
  // padding are stated in px because that band is laid out in CSS pixels
  // whatever the sheet is measured in.
  // A two-cell table rather than flexbox: the band's own layout does not honour
  // `justify-content` reliably, and the first attempt printed
  // "Board of Governors · 260804Page 1 of 1" with the two runs touching.
  return `<table style="width:100%;padding:0 0.75in;font-size:9px;`
    + `font-family:${SANS};color:#6b7585;border-collapse:collapse;">`
    + `<tr><td style="text-align:left;">${escapeHtml(identity)}</td>`
    + `<td style="text-align:right;">Page <span class="pageNumber"></span>`
    + ` of <span class="totalPages"></span></td></tr></table>`;
}

/**
 * A footer carrying only the document's identity.
 *
 * The packet's front matter does not know how long the packet is — it is
 * bound before the rest exists — and printing its own length there read
 * "Page 1 of 1" on the cover of a twelve-page packet. Packet-wide numbering is
 * stamped across every sheet after the merge, which is the number a chair
 * means by "turn to page 40".
 */
function footerPlain(identity) {
  return `<div style="width:100%;padding:0 0.75in;font-size:9px;`
    + `font-family:${SANS};color:#6b7585;">${escapeHtml(identity)}</div>`;
}

/** The packet cover, and what is in it. */
function packetCover(meeting, when, entries) {
  let out = masthead('Agenda packet', meeting.body_name);
  out += `<div class="cover-when">${escapeHtml(when)}</div>`;
  if (meeting.location) out += `<div class="cover-meta">${escapeHtml(meeting.location)}</div>`;
  if (meeting.status) out += `<div class="cover-meta">Status: ${escapeHtml(meeting.status)}</div>`;
  out += `<h2 class="sec">Contents</h2>`;
  if (!entries.length) {
    return page('Agenda packet', out
      + `<p class="muted"><em>No item on this agenda carries supporting material.</em></p>`);
  }
  out += '<table class="contents">' + entries.map((e) =>
    `<tr><td class="tab">${escapeHtml(e.tab || '')}</td>`
    + `<td>${escapeHtml(e.label)}</td></tr>`).join('') + '</table>';
  return page('Agenda packet', out);
}

/** A tab divider, so a packet opened at random is navigable. */
function divider({ tab, agendaNumber, title, section }) {
  let out = `<div class="sheet"><div class="sheet-tab">TAB ${escapeHtml(String(tab))}</div>`;
  if (agendaNumber) out += `<div class="sheet-kind">Agenda item ${escapeHtml(agendaNumber)}</div>`;
  out += `<div class="sheet-title">${escapeHtml(title || '')}</div>`;
  if (section) out += `<div class="sheet-kind">${escapeHtml(section)}</div>`;
  return page(`Tab ${tab}`, out + '</div>');
}

/**
 * The sheet that stands in front of a bound document, or in place of one that
 * could not be bound. A gap the reader has to notice is worse than a page
 * saying what is missing.
 */
function separator({ kind, name, note, url }) {
  let out = `<div class="sheet"><div class="sheet-kind">${escapeHtml(kind)}</div>`
    + `<div class="sheet-tab" style="font-size:14pt">${escapeHtml(name || '')}</div>`;
  if (note) out += `<div class="sheet-note">${escapeHtml(note)}</div>`;
  if (url) out += `<div class="sheet-url">${escapeHtml(url)}</div>`;
  return page(name || 'Document', out + '</div>');
}

/**
 * The page that says what could not be bound.
 *
 * Inserted after the cover rather than appended, because a page at the back of
 * a forty-page packet is a page nobody reads until the meeting. This is the
 * one that has to be seen before distribution.
 */
function problems(list) {
  const n = list.length;
  return page('Incomplete packet',
    `<div class="warn-title">Incomplete packet</div>`
    + `<p>${n} document${n === 1 ? '' : 's'} could not be included:</p>`
    + `<ul class="warn-list">${list.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
    + `<p><em>Resolve these before distributing the packet.</em></p>`);
}

/** The masthead every printed document opens with. */
function masthead(kind, bodyName) {
  let out = `<div class="mast-org">${escapeHtml(String(ORG.name || '').toUpperCase())}</div>`;
  out += `<div class="mast-kind">${escapeHtml(kind)}</div>`;
  // The organisation and the body are usually configured to the same name, and
  // printing both reads as a stutter rather than as two facts.
  if (bodyName && String(bodyName).toUpperCase() !== String(ORG.name || '').toUpperCase()) {
    out += `<div class="mast-body">${escapeHtml(String(bodyName).toUpperCase())}</div>`;
  }
  return out + '<hr class="mast-rule">';
}

/**
 * The roster down the rail.
 *
 * Labelled, because names alone in a margin do not say whether they are the
 * membership, the distribution list, or the sponsors. And labelled with the
 * office where there is one: the roster is ordered Chair, Vice Chair, then by
 * name, so printing only the district made it read "Seat 1, Seat 2, At-Large,
 * Seat 3, Seat 5…" — an order with no visible reason, which reads as a bug.
 */
function rail(members) {
  if (!members || !members.length) return '';
  const rows = members.map((m) => {
    const office = m.role && m.role !== 'Member' ? m.role : '';
    const sub = office && m.district ? `${office} · ${m.district}` : (office || m.district || '');
    return `<div class="rail-member">`
      + `<div class="rail-name">${escapeHtml(m.full_name || '')}</div>`
      + (sub ? `<div class="rail-role">${escapeHtml(sub)}</div>` : '')
      + `</div>`;
  }).join('');
  return `<aside class="rail"><div class="rail-label">Members</div>${rows}</aside>`;
}

/** One label/value row of head matter. */
function headMatter(rows) {
  const body = rows.filter(Boolean).map(([label, value]) =>
    `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value == null ? '' : String(value))}</td></tr>`)
    .join('');
  return `<table class="headmatter">${body}</table>`;
}

/** A titled section, omitted when nobody wrote it. */
function section(label, html) {
  if (!html) return '';
  return `<h2 class="sec">${escapeHtml(label)}</h2><div class="sec-body">${html}</div>`;
}

module.exports = {
  page, footer, footerPlain, masthead, rail, headMatter, section,
  packetCover, divider, separator, problems,
  CSS, RAIL_PAGE_CSS, SERIF, SANS,
};
