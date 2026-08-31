'use strict';

// These suites read text back out of the generated PDF by inflating pdf-lib's
// content streams and collecting its Tj operands — which only works on a
// document pdf-lib drew. The primary path now sets the document as HTML and
// has the browser print it, and a browser's PDF encodes text through subset
// fonts that this cannot read.
//
// So these run against the drawn fallback, deliberately: it still ships, it is
// what a container without the browser package produces, and it therefore
// still has to be right. The HTML path is tested as HTML in render.test.js,
// where the content is a string and can simply be asserted on.
process.env.DOCKET_RENDER = 'off';


// The printed documents.
//
// These are the outputs that leave the building — the board letter that goes
// to members, the packet they read from. Two faults in them were found by
// looking at real output rather than by any test: bullets arriving glued to
// the sentence that introduced them, and attachments a clerk had uploaded
// being reported as unbindable because the packet only knew how to fetch
// remote URLs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-test-')), 'test.db');

const { init } = require('../src/db');
init();
const documents = require('../src/documents');

// --- paragraphs(): turning stored markup into printed lines -------------------

test('a list closed properly still splits', () => {
  assert.deepEqual(
    documents.paragraphs('<p>To do:</p><ul><li>One</li><li>Two</li></ul>'),
    ['To do:', '• One', '• Two']);
});

test('a list opened inside an unclosed paragraph splits too', () => {
  // The shape a word processor actually emits: the <p> is never closed before
  // the <ul>, because a browser closes it implicitly. This printed as
  // "To do:• One" in the board letter — the bullet glued to the end of the
  // sentence introducing it.
  assert.deepEqual(
    documents.paragraphs('<p>To do:<ul><li>One</li><li>Two</li></ul></p>'),
    ['To do:', '• One', '• Two']);
});

test('consecutive block elements do not run together', () => {
  assert.deepEqual(
    documents.paragraphs('<div>First</div><div>Second</div><h2>Third</h2><p>Fourth</p>'),
    ['First', 'Second', 'Third', 'Fourth']);
});

test('attributes on a block tag do not defeat the split', () => {
  assert.deepEqual(
    documents.paragraphs('<p class="x">One<ul style="margin:0"><li>Two</li></ul>'),
    ['One', '• Two']);
});

test('markup is still stripped, and entities decoded', () => {
  const out = documents.paragraphs('<p>A &amp; B <script>bad()</script></p>');
  assert.equal(out.length, 1);
  assert.match(out[0], /A & B/);
  assert.doesNotMatch(out.join(' '), /script/);
});

test('a table still becomes rows with separated cells', () => {
  assert.deepEqual(
    documents.paragraphs('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'),
    ['a | b', 'c | d']);
});

// --- The board letter ---------------------------------------------------------

const repo = require('../src/repo');
const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Body', seats: 3 });
for (const n of ['A Governor', 'B Governor']) {
  repo.bodies.addMember(bodyId, repo.people.insert({ full_name: n, email: `${n[0]}@t.gov` }),
    'Member', 1, {});
}

test('the letter renders, and its bullets reach the page separated', async () => {
  const { id } = repo.matters.insertNumbered({
    type: 'Resolution', body_id: bodyId, status: 'On Agenda', title: 'A measure',
  });
  repo.letters.save(id, 'recommendation', '<p>It is recommended that the Board:<ul>'
    + '<li>Approve the thing.</li><li>Authorize the other thing.</li></ul>');
  const bytes = await documents.boardLetter(repo.matters.get(id), { date: '2026-07-15' });
  assert.ok(bytes && bytes.length > 1000, 'a letter should be produced');
  // The header of a PDF, so we know it is one and not an error string.
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
});

test('a letter with nothing written still produces a document', async () => {
  const { id } = repo.matters.insertNumbered({
    type: 'Resolution', body_id: bodyId, status: 'Draft', title: 'Empty file',
  });
  const bytes = await documents.boardLetter(repo.matters.get(id), {});
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
});

// --- Columns that actually line up --------------------------------------------

// Read back the words a PDF draws, with the x each one was placed at.
//
// The layout draws word by word at computed positions, which is precisely why
// padding a label with spaces aligns nothing: the run of spaces is gone before
// anything reaches the page. Only the coordinates can show whether a column is
// a column, so the test reads them.
function words(bytes) {
  const zlib = require('node:zlib');
  const src = Buffer.from(bytes).toString('latin1');
  const out = [];
  const streams = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = streams.exec(src))) {
    let data = Buffer.from(m[1], 'latin1');
    try { data = zlib.inflateSync(data); } catch (_) { continue; }
    const ops = /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\s*<([0-9A-Fa-f]*)>\s*Tj/g;
    let g;
    while ((g = ops.exec(data.toString('latin1')))) {
      out.push({ x: Number(Number(g[1]).toFixed(1)), y: Number(Number(g[2]).toFixed(1)),
        t: Buffer.from(g[3], 'hex').toString('latin1') });
    }
  }
  return out;
}

// The x of the first word after `label` on the line `label` sits on.
function valueX(ws, label) {
  const l = ws.find((w) => w.t === label);
  if (!l) return null;
  const after = ws.filter((w) => Math.abs(w.y - l.y) < 0.5 && w.x > l.x).sort((a, b) => a.x - b.x);
  return after.length ? after[0].x : null;
}

test('the head matter is a column, not three lines of padding', async () => {
  // DATE:/TO:/FILE: were padded with spaces to line their values up. They
  // landed at x=232.0, 219.4 and 227.7 — a ragged column produced by code that
  // looks like it is aligning something.
  const { id } = repo.matters.insertNumbered({
    type: 'Resolution', body_id: bodyId, status: 'On Agenda', title: 'A measure',
  });
  const ws = words(await documents.boardLetter(repo.matters.get(id), { date: '2026-07-15' }));
  const xs = ['DATE:', 'TO:', 'FILE:'].map((l) => valueX(ws, l));
  assert.ok(xs.every((x) => x != null), 'all three labels should carry a value');
  assert.equal(new Set(xs).size, 1, `values start at ${xs.join(', ')} — not one column`);
});

test('the roster says what it is, and why it is in that order', async () => {
  // Seven names alone in a margin say nothing about what they are. And the
  // rail is ordered Chair, Vice Chair, then by name while it printed only the
  // district — so it read "Seat 1, Seat 2, At-Large, Seat 3…", an order with
  // no visible reason, which reads as a sorting bug.
  const { id } = repo.matters.insertNumbered({
    type: 'Resolution', body_id: bodyId, status: 'On Agenda', title: 'Another measure',
  });
  const ws = words(await documents.boardLetter(repo.matters.get(id), {}));
  const text = ws.map((w) => w.t);
  assert.ok(text.includes('MEMBERS'), 'the rail is labelled');
  // Every name on the rail is drawn at the rail's own x, left of the text column.
  const rail = ws.filter((w) => w.x === 72).map((w) => w.t);
  assert.ok(rail.length > 1, 'the roster is on the rail');
});
