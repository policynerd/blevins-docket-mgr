'use strict';

// The documents when there is no browser to set them.
//
// Every printed document in this application is written once, as HTML. That
// leaves the question of what a machine with no Chromium prints, and the
// answer used to be: a second document, written by hand, in drawing calls,
// beside the first. Four of those pairs existed and every one had drifted.
//
// So what is tested here is the thing that replaced them — that the markup a
// document already produces can be drawn, and that drawing it does not lose
// what the document says. The strongest form of that is the last test in the
// first group: every word of the markup reaches the page, in order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-test-')), 'test.db');
// These read glyphs off the drawn page, so they must be the drawn page.
process.env.DOCKET_RENDER = 'off';

const { init } = require('../src/db');
init();
const repo = require('../src/repo');
const documents = require('../src/documents');
const docprint = require('../src/docprint');
const flow = require('../src/flow');

const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Body', seats: 5 });
const chair = repo.people.insert({ full_name: 'Ada Chair', email: 'a@t.gov', district: 'Seat 1' });
const plain = repo.people.insert({ full_name: 'Ben Member', email: 'b@t.gov', district: 'Seat 2' });
repo.bodies.addMember(bodyId, chair, 'Chair', 1, {});
repo.bodies.addMember(bodyId, plain, 'Member', 1, {});

function newMatter(over = {}) {
  const { id } = repo.matters.insertNumbered(Object.assign({
    type: 'Resolution', body_id: bodyId, status: 'On Agenda', title: 'A measure',
  }, over));
  return repo.matters.get(id);
}

// WinAnsiEncoding agrees with Latin-1 everywhere but 0x80-0x9F, where Latin-1
// has control characters and WinAnsi has the punctuation these documents
// actually use — the em dash in a file's title, the bullet in a clerk's list.
// Decoding those as Latin-1 is how a page carrying "260901 — A contract" reads
// back as "260901  A contract".
const WINANSI = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160',
  0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201c', 0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a', 0x9c: '\u0153',
  0x9e: '\u017e', 0x9f: '\u0178',
};
const chr = (b) => WINANSI[b] || String.fromCharCode(b);

// Read the text back off the page: inflate every content stream and collect
// the operands of each show-text operator. The base-14 fonts these documents
// are drawn in use one byte per character, so the hex strings decode directly.
function pdfText(bytes) {
  const buf = Buffer.from(bytes);
  const src = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(src))) {
    const s = m.index + m[0].length;
    const e = src.indexOf('endstream', s);
    if (e < 0) continue;
    let body;
    try { body = zlib.inflateSync(buf.subarray(s, e)).toString('latin1'); }
    catch { body = src.slice(s, e); }
    for (const g of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      const hex = g[1].replace(/\s/g, '');
      let word = '';
      for (let i = 0; i + 1 < hex.length; i += 2) {
        word += chr(parseInt(hex.substr(i, 2), 16));
      }
      out.push(word);
    }
    for (const g of body.matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)) {
      out.push(g[1].replace(/\\([()\\])/g, '$1').replace(/[\x80-\x9f]/g, (c) => chr(c.charCodeAt(0))));
    }
  }
  // Words are drawn one at a time at computed positions, so the stream carries
  // no spaces of its own.
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

const words = (s) => String(s).toLowerCase().match(/[a-z0-9$.,:—·()-]+/g) || [];

/** Whether every word of `wanted` appears in `got`, in order. */
function carries(got, wanted) {
  const hay = words(got);
  let i = 0;
  for (const w of words(wanted)) {
    while (i < hay.length && hay[i] !== w) i += 1;
    if (i >= hay.length) return w;   // the first word that never arrived
    i += 1;
  }
  return null;
}

// --- The letter ---------------------------------------------------------------

test('the head matter reaches the drawn page as a column', async () => {
  // The markup is a table; the drawn page has no tables, so it has to become
  // the label/value column the table was expressing. Space-padded labels are
  // what this replaces, and they aligned nothing.
  const m = newMatter();
  const txt = pdfText(await flow.flow(documents.boardLetterHtml(m, { date: '2026-07-15' }), {}));
  assert.match(txt, /DATE: July 15, 2026/);
  assert.match(txt, /TO: Board of Governors/);
  assert.match(txt, new RegExp(`FILE: ${m.file_number}`));
});

test('a heading the stylesheet uppercases is uppercased here too', async () => {
  // `text-transform` is an instruction the browser carries out and a drawing
  // call does not. Ignoring it printed "Subject" as the only mixed-case
  // heading in a letter whose others read OVERVIEW and FISCAL IMPACT, which
  // reads as a fault in the document rather than in the renderer.
  const txt = pdfText(await flow.flow(documents.boardLetterHtml(newMatter(), {}), {}));
  assert.match(txt, /SUBJECT/);
  assert.doesNotMatch(txt, /\bSubject\b/);
});

test('the roster is drawn in the rail, and the text column clears it', async () => {
  const html = documents.boardLetterHtml(newMatter(), {});
  assert.equal(flow.hasRail(html), true, 'the letter carries a rail');
  const txt = pdfText(await flow.flow(html, {}));
  assert.match(txt, /MEMBERS/);
  assert.match(txt, /ADA CHAIR/);
  assert.match(txt, /Chair · Seat 1/, 'the office, which is why that one is first');
});

test('a clerk\'s list is a list on the drawn page', async () => {
  const m = newMatter();
  repo.letters.save(m.id, 'recommendation',
    '<p>It is recommended that the Board:</p><ul><li>Approve it.</li><li>Authorize it.</li></ul>');
  const txt = pdfText(await flow.flow(documents.boardLetterHtml(repo.matters.get(m.id), {}), {}));
  assert.match(txt, /It is recommended that the Board:/);
  assert.match(txt, /Approve it\./);
  assert.match(txt, /Authorize it\./);
});

test('every word of the markup reaches the page, in order', async () => {
  // This is the test the twins could not have: there is one definition of the
  // document now, so the drawn page can be checked against it rather than
  // against a second hand-written document that was free to disagree.
  const m = newMatter({ summary: 'A short summary of the measure.' });
  repo.letters.save(m.id, 'background', '<p>How this arrived here.</p>');
  repo.letters.save(m.id, 'recommendation', '<ul><li>Approve it.</li></ul>');
  const html = documents.boardLetterHtml(repo.matters.get(m.id), { date: '2026-07-15' });
  const missing = carries(pdfText(await flow.flow(html, {})), flow.textOf(flow.parse(html)));
  assert.equal(missing, null, `the drawn letter never says "${missing}"`);
});

// --- What the markup can carry that a drawing call could not ------------------

test('a redline keeps its struck and inserted text, inside the word', async () => {
  // An amendment reads "authoriz[ing][ed]" — three faces in one word. A block
  // of text set in one font cannot express that, which is why the drawn
  // documents had no redline of their own and why `rich()` breaks words
  // across the runs they span rather than at run boundaries.
  const html = docprint.page('T', docprint.section('Amendment',
    '<p>The Clerk is authoriz<s>ing</s><u>ed</u> to execute it.</p>'));
  const bytes = await flow.flow(html, {});
  assert.equal(carries(pdfText(bytes), 'The Clerk is authoriz ing ed to execute it.'), null);
  // Struck and inserted text is drawn with a rule through and under it; those
  // are the only lines on this page besides none at all.
  const src = Buffer.from(bytes).toString('latin1');
  let ops = '';
  for (const m of src.matchAll(/stream\r?\n/g)) {
    const s = m.index + m[0].length;
    const e = src.indexOf('endstream', s);
    try { ops += zlib.inflateSync(Buffer.from(bytes).subarray(s, e)).toString('latin1'); } catch { /* not a content stream */ }
  }
  const strokes = ops.split('\n').filter((l) => l.trim() === 'S').length;
  assert.ok(strokes >= 2, `a rule through and a rule under, got ${strokes}`);
});

test('a table is drawn as cells rather than flattened to "a | b"', async () => {
  const html = docprint.page('T', docprint.section('Fiscal note',
    '<table><tr><th>Year</th><th>Amount</th></tr><tr><td>2026</td><td>$40,000</td></tr></table>'));
  const txt = pdfText(await flow.flow(html, {}));
  assert.equal(carries(txt, 'Year Amount 2026 $40,000'), null);
  assert.doesNotMatch(txt, /\|/, 'the separator the flattener used is not a table');
});

test('entities are decoded, so no document prints "&amp;"', async () => {
  const html = docprint.page('T', docprint.section('Parties',
    '<p>Smith &amp; Sons &#8212; approved &#x2014; today</p>'));
  const txt = pdfText(await flow.flow(html, {}));
  assert.match(txt, /Smith & Sons/);
  assert.doesNotMatch(txt, /&amp;|&#/);
  assert.ok(txt.includes('—'), 'both spellings of an em dash decode');
});

test('a value that could close a tag never becomes markup', async () => {
  const m = newMatter({ title: 'Regarding <script>alert(1)</script> matters' });
  const txt = pdfText(await flow.flow(documents.boardLetterHtml(m, {}), {}));
  // Escaped on the way in, decoded on the way out: it prints as the words it
  // is, and never parsed as a tag.
  assert.match(txt, /REGARDING <SCRIPT>ALERT\(1\)<\/SCRIPT> MATTERS/);
});

test('a word wider than the measure is broken rather than run off the page', async () => {
  const long = 'https://example.gov/' + 'segment/'.repeat(30);
  const html = docprint.page('T', docprint.section('Link', `<p>${long}</p>`));
  const bytes = await flow.flow(html, {});
  const src = Buffer.from(bytes).toString('latin1');
  let ops = '';
  for (const m of src.matchAll(/stream\r?\n/g)) {
    const s = m.index + m[0].length;
    const e = src.indexOf('endstream', s);
    try { ops += zlib.inflateSync(Buffer.from(bytes).subarray(s, e)).toString('latin1'); } catch { /* not a content stream */ }
  }
  const xs = [...ops.matchAll(/1 0 0 1 ([\d.-]+) [\d.-]+ Tm/g)].map((m) => Number(m[1]));
  assert.ok(xs.length > 1, 'the URL was split across lines');
  assert.ok(Math.max(...xs) < 612 - 72, 'nothing was drawn past the right margin');
});

// --- The packet's own sheets --------------------------------------------------

test('the packet cover, divider and separator all draw from their markup', async () => {
  const cover = docprint.packetCover(
    { body_name: 'Board of Governors', location: 'Room 200', status: 'Scheduled' },
    'Monday, July 20, 2026 at 6:00 PM',
    [{ tab: 'Tab 1', label: '5.A. 260901 — Authorizing a contract' }, { tab: '', label: '6. Adjournment' }]);
  const coverTxt = pdfText(await flow.flow(cover, {}));
  assert.equal(carries(coverTxt, 'AGENDA PACKET Monday, July 20, 2026 at 6:00 PM Room 200'), null);
  // The tab is its own column: an item carrying nothing leaves it blank rather
  // than running the label into the agenda number.
  assert.match(coverTxt, /Tab 1/);
  assert.match(coverTxt, /Adjournment/);

  const div = pdfText(await flow.flow(docprint.divider(
    { tab: '1', agendaNumber: '5.A.', title: '260901 — A contract', section: 'New Business' }), {}));
  assert.equal(carries(div, 'TAB 1 AGENDA ITEM 5.A. 260901 — A contract NEW BUSINESS'), null);

  const sep = pdfText(await flow.flow(docprint.separator(
    { kind: 'Attachment', name: 'Scope.docx', note: 'This document is not a PDF.', url: null }), {}));
  assert.equal(carries(sep, 'ATTACHMENT Scope.docx This document is not a PDF.'), null);
});

test('the incomplete-packet page names every document that was left out', async () => {
  // This page is why a clerk finds out before distribution rather than in the
  // room, so it has to carry the whole list and not a count.
  const txt = pdfText(await flow.flow(docprint.problems([
    '260901: Scope.docx is not a PDF and was not bound',
    '260902: Exhibit A could not be bound',
  ]), {}));
  assert.match(txt, /INCOMPLETE PACKET/);
  assert.match(txt, /2 documents could not be included/);
  assert.equal(carries(txt, 'Scope.docx is not a PDF and was not bound'), null);
  assert.equal(carries(txt, 'Exhibit A could not be bound'), null);
});

// --- The parser ---------------------------------------------------------------

test('unbalanced markup does not lose the rest of the document', async () => {
  // The markup this reads is generated and balanced, but "generated" has been
  // wrong before: a stray closer should cost its own tag, not everything after
  // it.
  const html = docprint.page('T', '<p>First.</p></div><p>Second.</p>');
  assert.match(pdfText(await flow.flow(html, {})), /First\. Second\./);
});

test('the stylesheet and the title never print', async () => {
  // Both sit inside <head> in every document, and a parser that treats them as
  // text prints the entire stylesheet on page one.
  const txt = pdfText(await flow.flow(documents.boardLetterHtml(newMatter(), {}), {}));
  assert.doesNotMatch(txt, /font-family|@page|border-collapse/);
});
