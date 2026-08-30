'use strict';

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
