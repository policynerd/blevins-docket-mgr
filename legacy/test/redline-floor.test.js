'use strict';

// Line-numbered comparative prints, and the floor.
//
// Two small things with one sharp edge each. The redline's is that a deletion
// can span a line break, so a numbered print built by cutting the finished
// HTML at newlines would open a <del> in one row and close it in another —
// which browsers repair, differently, and the redline would stop meaning what
// it says. The floor's is that only one person can hold it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rl-test-')), 'test.db');

const { init } = require('../src/db');
init();
const repo = require('../src/repo');
const diff = require('../src/diff');

// --- The numbered comparative print ------------------------------------------

function balanced(html, tag) {
  const open = (html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  return open === close && open > 0;
}

test('a numbered print numbers every line of the result', () => {
  const out = diff.diffHtml('one\ntwo\nthree', 'one\ntwo\nthree', { lineNumbers: true });
  const nums = [...out.matchAll(/class="rl-n">(\d+)</g)].map((m) => m[1]);
  assert.deepEqual(nums, ['1', '2', '3']);
});

test('a deletion spanning line breaks stays balanced in every row', () => {
  // The edge this exists for. One <del> run covers two lines; each row must
  // carry its own opened-and-closed element.
  const out = diff.diffHtml(
    'Section 1.\nThe old paragraph\nspans two lines.\nSection 2.',
    'Section 1.\nSection 2.',
    { lineNumbers: true });
  assert.ok(balanced(out, 'del'), '<del> elements must not cross a row');
  const rows = out.split('rl-line').length - 1;
  assert.equal(rows, 4, 'every line of the longer side is still a row');
});

test('an insertion spanning line breaks stays balanced too', () => {
  const out = diff.diffHtml('A\nB', 'A\nnew first\nnew second\nB', { lineNumbers: true });
  assert.ok(balanced(out, 'ins'));
});

test('blank lines are numbered, so the margin matches a hand count', () => {
  const out = diff.diffHtml('a\n\nb', 'a\n\nb', { lineNumbers: true });
  const nums = [...out.matchAll(/class="rl-n">(\d+)</g)].map((m) => m[1]);
  assert.deepEqual(nums, ['1', '2', '3']);
});

test('the unnumbered print is unchanged', () => {
  const plain = diff.diffHtml('one two', 'one three');
  assert.doesNotMatch(plain, /rl-line/);
  assert.match(plain, /<del class="df-del">/);
  assert.match(plain, /<ins class="df-ins">/);
});

test('markup in the source is escaped, numbered or not', () => {
  for (const opts of [{}, { lineNumbers: true }]) {
    const out = diff.diffHtml('<script>alert(1)</script>', 'safe', opts);
    assert.doesNotMatch(out, /<script/);
    assert.match(out, /&lt;script&gt;/);
  }
});

// --- The floor ---------------------------------------------------------------

const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Body', seats: 3 });
const meetingId = repo.meetings.insert({ body_id: bodyId, meeting_date: '2026-09-01' });

function signUp(name) {
  const id = repo.speakers.add({ meeting_id: meetingId, name });
  repo.speakers.setStatus(id, 'Approved');
  return id;
}

test('nobody holds the floor until the chair gives it', () => {
  signUp('First Speaker');
  assert.equal(repo.speakers.speaking(meetingId), undefined);
  assert.equal(repo.speakers.queue(meetingId).length, 1);
});

test('giving the floor starts a clock and takes them out of the queue', () => {
  const a = signUp('Second Speaker');
  repo.speakers.startSpeaking(a);
  const holder = repo.speakers.speaking(meetingId);
  assert.equal(holder.id, a);
  assert.ok(holder.started_at, 'a start time is what a countdown counts from');
  assert.equal(repo.speakers.queue(meetingId).some((q) => q.id === a), false);
});

test('only one person holds the floor', () => {
  // Handing it on must close the previous speaker out, or the board counts two
  // clocks and the record cannot say when the first sat down.
  const b = signUp('Third Speaker');
  const previous = repo.speakers.speaking(meetingId);
  repo.speakers.startSpeaking(b);

  const holder = repo.speakers.speaking(meetingId);
  assert.equal(holder.id, b);
  assert.equal(repo.speakers.get(previous.id).status, 'Spoke',
    'the previous holder is marked as having spoken');
});

test('a rejected request never reaches the queue', () => {
  const r = repo.speakers.add({ meeting_id: meetingId, name: 'Not Approved' });
  repo.speakers.setStatus(r, 'Rejected');
  assert.equal(repo.speakers.queue(meetingId).some((q) => q.id === r), false);
});
