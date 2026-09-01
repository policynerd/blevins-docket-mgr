'use strict';

// The printed documents, set as HTML and printed by the browser.
//
// Two things are worth holding in place here, and they are different kinds of
// thing.
//
// The markup is a string this application produces, so it is asserted as a
// string: that the head matter is a table rather than three lines hoping to
// line up, that the roster says what it is, that a clerk's list survives as a
// list. That is the part that can regress silently.
//
// The rendering is the browser's job, so what is tested is the contract with
// it: that a PDF comes out, that a machine without a browser falls back to the
// drawn document rather than failing a meeting, and that nothing is left
// running afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'render-test-')), 'test.db');

const { init } = require('../src/db');
init();
const repo = require('../src/repo');
const documents = require('../src/documents');
const render = require('../src/render');

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

// --- The markup ---------------------------------------------------------------

test('the head matter is a table, so its values are a column', () => {
  // The defect this replaces: `DATE:  ${when}` padded with spaces, in a layout
  // that draws word by word and discards the padding. Three values landed at
  // x=232.0, 219.4 and 227.7. A column is a column because there is a column.
  const html = documents.boardLetterHtml(newMatter(), { date: '2026-07-15' });
  assert.match(html, /<table class="headmatter">/);
  for (const label of ['DATE:', 'TO:', 'FILE:']) {
    assert.ok(html.includes(`<th>${label}</th>`), `${label} should be a header cell`);
  }
  assert.doesNotMatch(html, /DATE:\s{2,}/, 'no padding pretending to align anything');
});

test('the roster says what it is, and why it is in that order', () => {
  // Names alone in a margin do not say whether they are the membership, the
  // distribution list, or the sponsors. And the roster is ordered Chair, then
  // Vice Chair, then by name, so printing only the district made the order
  // look arbitrary — "Seat 1, Seat 2, At-Large, Seat 3, Seat 5" reads as a
  // sorting bug rather than as precedence.
  const html = documents.boardLetterHtml(newMatter(), {});
  assert.match(html, /class="rail-label">Members</);
  assert.match(html, /Ada Chair/);
  assert.match(html, /Chair · Seat 1/, 'the office explains why this one is first');
  assert.match(html, /Seat 2/, 'and a member with no office keeps their seat');
  assert.doesNotMatch(html, /Member · Seat 2/, 'the generic role is not an office');
});

test('a clerk\'s list reaches the page as a list', () => {
  // The drawn document flattened stored markup through paragraphs(), so a list
  // became "• item" strings and a table became "a | b". That flattening is why
  // one section could look like two different things on screen and on paper.
  const m = newMatter();
  repo.letters.save(m.id, 'recommendation',
    '<p>It is recommended that the Board:</p><ul><li>Approve it.</li><li>Authorize it.</li></ul>');
  const html = documents.boardLetterHtml(repo.matters.get(m.id), {});
  assert.match(html, /<ul><li>Approve it\.<\/li><li>Authorize it\.<\/li><\/ul>/,
    'the markup survives instead of being re-marked with bullet characters');
});

test('sections keep their configured order, and blanks are omitted', () => {
  const m = newMatter({ summary: 'A short summary.' });
  repo.letters.save(m.id, 'background', '<p>How this arrived here.</p>');
  const html = documents.boardLetterHtml(repo.matters.get(m.id), {});
  // The labels come from the letter's configured sections, which carry their
  // own casing; the stylesheet does the rest.
  const at = (s) => html.indexOf(`<h2 class="sec">${s}</h2>`);
  assert.ok(at('OVERVIEW') > -1 && at('BACKGROUND') > -1, 'both written sections appear');
  assert.ok(at('OVERVIEW') < at('BACKGROUND'), 'the configured order is kept');
  // A heading with nothing under it asserts a question was answered.
  assert.doesNotMatch(html, /<h2 class="sec">[^<]*<\/h2><div class="sec-body"><\/div>/);
});

test('an unwritten fiscal section still states the cost', () => {
  // Silence on cost reads as "not considered", and a board acts on the number.
  const html = documents.boardLetterHtml(newMatter(), {});
  assert.match(html, /no fiscal impact associated with this action/);
});

test('attachments are lettered so they can be cited', () => {
  const m = newMatter();
  const { db } = require('../src/db');
  for (const n of ['First.pdf', 'Second.pdf']) {
    db.prepare('INSERT INTO attachments (matter_id,name,file_path) VALUES (?,?,?)')
      .run(m.id, n, n);
  }
  const html = documents.boardLetterHtml(repo.matters.get(m.id), {});
  assert.match(html, /Attachment A: First\.pdf/);
  assert.match(html, /Attachment B: Second\.pdf/);
});

test('the document carries a title, so a packet is not full of untitled files', () => {
  const m = newMatter({ title: 'Authorizing a contract' });
  const html = documents.boardLetterHtml(m, {});
  assert.match(html, new RegExp(`<title>${m.file_number} — Authorizing a contract</title>`));
});

test('a value that could close a tag is escaped', () => {
  const m = newMatter({ title: 'Regarding <script>alert(1)</script> matters' });
  const html = documents.boardLetterHtml(m, {});
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

// --- The contract with the browser --------------------------------------------

test('DOCKET_RENDER=off is honoured, and sends every caller to the fallback', () => {
  const before = process.env.DOCKET_RENDER;
  process.env.DOCKET_RENDER = 'off';
  try {
    assert.equal(render.available(), false);
  } finally {
    if (before === undefined) delete process.env.DOCKET_RENDER;
    else process.env.DOCKET_RENDER = before;
  }
});

test('a letter is produced with no browser at all', async () => {
  // The fallback is the whole reason it is safe to depend on a browser: a
  // container that came back without the package still prints the meeting.
  const before = process.env.DOCKET_RENDER;
  process.env.DOCKET_RENDER = 'off';
  try {
    const bytes = await documents.boardLetter(newMatter(), { date: '2026-07-15' });
    assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
  } finally {
    if (before === undefined) delete process.env.DOCKET_RENDER;
    else process.env.DOCKET_RENDER = before;
  }
});

test('the browser prints a real PDF, and lets the process end afterwards',
  { skip: render.available() ? false : 'no browser on this machine' }, async () => {
    const bytes = await render.render(
      '<style>@page{size:Letter;margin:1in}</style><h1>Printed</h1>');
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(bytes.length > 500, 'a real document, not an empty one');
    // Nothing here holds the process open: the module closes an idle browser,
    // which is what stops a test run hanging after its last assertion.
    render.shutdown();
  });

test('a rendered letter is a PDF',
  { skip: render.available() ? false : 'no browser on this machine' }, async () => {
    const m = newMatter({ summary: 'A short summary.' });
    const bytes = await documents.boardLetter(m, { date: '2026-07-15' });
    assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
    render.shutdown();
  });

// --- Saying so when it falls back ---------------------------------------------

test('the renderer reports which path it is on, and why', () => {
  // The fallback was built silent, and that was the mistake this fixes. A
  // container with Chromium installed can still fall back — the binary is
  // somewhere this does not look, it is killed for memory, it will not start
  // under the container's namespaces — and the packet then comes out looking
  // exactly as it did before, correct and unremarkable, with nothing anywhere
  // saying why. The only tell was the Producer string inside a PDF.
  const before = process.env.DOCKET_RENDER;
  process.env.DOCKET_RENDER = 'off';
  try {
    const off = render.status();
    assert.equal(off.mode, 'fallback');
    assert.equal(off.disabled, true);
    assert.ok(off.reason, 'a fallback always carries a reason');
  } finally {
    if (before === undefined) delete process.env.DOCKET_RENDER;
    else process.env.DOCKET_RENDER = before;
  }

  const on = render.status();
  assert.ok(['browser', 'fallback'].includes(on.mode));
  if (on.mode === 'fallback') {
    // Whatever the machine is, an operator can read why rather than open a PDF
    // and inspect its metadata.
    assert.ok(on.reason);
    assert.ok(Array.isArray(on.searched), 'and where it looked');
  } else {
    assert.ok(on.binary, 'the browser path is named when one is in use');
  }
});

test('a machine with no browser names the paths it searched', () => {
  // "No Chromium found" is not actionable; "not at any of these four paths" is
  // the difference between a guess and a fix.
  const before = process.env.CHROMIUM_PATH;
  const st = render.status();
  if (st.mode === 'fallback' && st.searched) {
    assert.ok(st.searched.length >= 3);
    assert.ok(st.searched.some((p) => /chromium/.test(p)));
  }
  if (before === undefined) delete process.env.CHROMIUM_PATH;
  else process.env.CHROMIUM_PATH = before;
});
