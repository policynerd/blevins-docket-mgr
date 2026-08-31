'use strict';

// The running of a meeting, as distinct from the writing of its agenda.
//
// An agenda is a plan. A meeting departs from it: items are taken out of
// order, and items are laid on the table and never reached at all. The record
// had no way to say either. `sort_order` is the order the agenda was written
// in, and there was no field anywhere for the order things were actually taken
// — so the minutes could report what was decided but not that item 7 was taken
// before item 4. And 'Tabled' existed only as a *matter* status, inferred by
// regex from whatever action text a clerk typed, so an item laid on the table
// went on reading 'pending' beside items genuinely still to come.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proc-test-')), 'test.db');

const { init } = require('../src/db');
init();
const repo = require('../src/repo');
const live = require('../src/live');

const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Body', seats: 3 });
const people = ['A', 'B', 'C'].map((n) =>
  repo.people.insert({ full_name: `${n} Governor`, email: `${n.toLowerCase()}@test.gov` }));
for (const id of people) repo.bodies.addMember(bodyId, id, 'Member', 1, {});

let seq = 0;
function newMeeting(itemCount) {
  const meetingId = repo.meetings.insert({
    body_id: bodyId, meeting_date: `2026-10-${String(++seq).padStart(2, '0')}`,
  });
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    const { id: matterId } = repo.matters.insertNumbered({
      type: 'Resolution', body_id: bodyId, status: 'On Agenda', title: `Item ${i + 1}`,
    });
    items.push(repo.meetings.addItem({
      meeting_id: meetingId, matter_id: matterId, section: 'New Business', requires_vote: 1,
    }));
  }
  return { meetingId, items };
}

function carry(itemId, choice = 'Yea') {
  for (const p of repo.bodies.votingRoll(bodyId)) {
    repo.voteLedger.append(itemId, p.id, choice, { source: 'MEMBER_TERMINAL' });
  }
}

// --- Laying an item on the table ---------------------------------------------

test('a tabled item says so on the item, not only on the file', () => {
  const { items } = newMeeting(2);
  const it = repo.voteAdmin.table(items[0], { reason: 'Pending counsel review' });
  assert.ok(it.tabled_at, 'the item carries the moment it was tabled');
  assert.equal(it.tabled_reason, 'Pending counsel review');
});

test('tabling takes the item off the board', () => {
  // The console shows the item that is before the body. A tabled item is not.
  const { items } = newMeeting(1);
  repo.voteAdmin.table(items[0]);
  assert.ok(repo.meetings.getItem(items[0]).cleared_at, 'it stops being the live item');
});

test('the file follows the item onto the table, and back off it', () => {
  const { items } = newMeeting(1);
  const matterId = repo.meetings.getItem(items[0]).matter_id;
  repo.voteAdmin.table(items[0]);
  assert.equal(repo.matters.get(matterId).status, 'Tabled');
  repo.voteAdmin.untable(items[0]);
  assert.equal(repo.matters.get(matterId).status, 'On Agenda');
});

test('taking it back up clears the table entirely', () => {
  const { items } = newMeeting(1);
  repo.voteAdmin.table(items[0], { reason: 'Sponsor absent' });
  const it = repo.voteAdmin.untable(items[0]);
  assert.equal(it.tabled_at, null);
  assert.equal(it.tabled_reason, null);
  assert.equal(it.cleared_at, null, 'and puts it back on the board');
});

test('an item cannot be tabled out from under an open roll', () => {
  // Members are voting. Tabling mid-roll would leave votes cast on an item the
  // record says was never taken up.
  const { items } = newMeeting(1);
  repo.voteAdmin.openRoll(items[0]);
  assert.throws(() => repo.voteAdmin.table(items[0]), /open roll/i);
  assert.equal(repo.meetings.getItem(items[0]).vote_status, 'open', 'the roll is untouched');
});

test('a table and an untable are both in the ledger', () => {
  // The tabling of a measure is a decision of the body. It belongs in the
  // hash-chained record beside the votes, not only in a column that the next
  // write overwrites.
  const { meetingId, items } = newMeeting(1);
  repo.voteAdmin.table(items[0], { reason: 'Deferred' });
  repo.voteAdmin.untable(items[0]);
  const called = repo.voteLedger.forMeeting(meetingId)
    .filter((e) => e.event_type === 'AGENDA_ITEM_CALLED');
  assert.equal(called.length, 2);
  const payloads = called.map((e) => JSON.parse(e.payload_json));
  assert.equal(payloads[0].tabled, true);
  assert.equal(payloads[0].reason, 'Deferred');
  assert.equal(payloads[1].tabled, false);
});

test('opening a roll on a tabled item takes it back up', () => {
  // Calling the question on a tabled item is taking it from the table. The
  // alternative is an item that is simultaneously tabled and being voted on.
  const { items } = newMeeting(1);
  repo.voteAdmin.table(items[0], { reason: 'Deferred' });
  repo.voteAdmin.openRoll(items[0]);
  const it = repo.meetings.getItem(items[0]);
  assert.equal(it.tabled_at, null);
  assert.equal(it.tabled_reason, null);
});

test('untabling something that was never tabled does nothing', () => {
  const { items } = newMeeting(1);
  assert.equal(repo.voteAdmin.untable(items[0]), null);
});

// --- The order things were actually taken -------------------------------------

test('an item records when the body reached it', () => {
  const { items } = newMeeting(2);
  assert.equal(repo.meetings.getItem(items[0]).reached_at, null, 'not reached until called');
  repo.voteAdmin.openRoll(items[0]);
  assert.ok(repo.meetings.getItem(items[0]).reached_at);
});

test('reopening a roll does not say the body arrived a second time', () => {
  // A reopened roll is the same item being reconsidered, not the meeting
  // reaching it again. Overwriting reached_at would reorder the record of the
  // meeting every time a clerk corrected a tally.
  const { items } = newMeeting(1);
  repo.voteAdmin.openRoll(items[0]);
  const first = repo.meetings.getItem(items[0]).reached_at;
  carry(items[0], 'Yea');
  repo.voteAdmin.closeRoll(items[0]);
  repo.voteAdmin.reopen(items[0]);
  assert.equal(repo.meetings.getItem(items[0]).reached_at, first);
});

test('items taken out of order keep the order they were taken in', () => {
  const { items } = newMeeting(3);
  repo.voteAdmin.openRoll(items[2]);
  repo.voteAdmin.openRoll(items[0]);
  const reached = items.map((id) => repo.meetings.getItem(id).reached_at);
  assert.ok(reached[2], 'the third was reached');
  assert.ok(reached[0], 'then the first');
  assert.equal(reached[1], null, 'the second never was');
  assert.ok(reached[2] <= reached[0], 'and the record says which came first');
});

// --- What the console is told -------------------------------------------------

test('the live snapshot carries tabling, so a screen can show it', () => {
  // The fault this pins: the repo knew an item was tabled and the console did
  // not, because the snapshot did not carry the field. Every one of these is
  // the same shape of bug — the system computing an answer and not telling the
  // part that needs it.
  const { meetingId, items } = newMeeting(2);
  repo.voteAdmin.table(items[0], { reason: 'Awaiting the sponsor' });
  const snap = live.snapshot(meetingId);
  const row = snap.items.find((i) => i.id === items[0]);
  assert.equal(row.tabled, true);
  assert.equal(row.tabledReason, 'Awaiting the sponsor');
  assert.equal(snap.items.find((i) => i.id === items[1]).tabled, false);
});

test('a tabled item is not the item before the body', () => {
  const { meetingId, items } = newMeeting(1);
  repo.voteAdmin.table(items[0]);
  assert.equal(live.snapshot(meetingId).active, null);
});

// --- The roster against the roll ----------------------------------------------

test('the roster says which of its rows count toward a quorum', () => {
  // The membership screen listed body_members and the quorum denominator came
  // from votingRoll() — a different list — with nothing saying which was
  // which. A body could show eight members and take its quorum from five, and
  // both numbers were right about different questions.
  const b = repo.bodies.insert({ name: 'Audit Committee', type: 'Committee', seats: 4 });
  const seated = repo.people.insert({ full_name: 'S Member', email: 's@t.gov' });
  const exOfficio = repo.people.insert({ full_name: 'X Officio', email: 'x@t.gov' });
  const future = repo.people.insert({ full_name: 'F Uture', email: 'f@t.gov' });
  repo.bodies.addMember(b, seated, 'Member', 1, {});
  repo.bodies.addMember(b, exOfficio, 'Member', 0, {});
  repo.bodies.addMember(b, future, 'Member', 1, { start_date: '2099-01-01' });

  const rows = repo.bodies.seatStatus(b);
  const by = Object.fromEntries(rows.map((r) => [r.person_id, r]));
  assert.equal(rows.length, 3, 'every seat is still listed');
  assert.equal(by[seated].onRoll, true);
  assert.equal(by[exOfficio].onRoll, false);
  assert.match(by[exOfficio].reason, /without a vote/);
  assert.equal(by[future].onRoll, false);
  assert.match(by[future].reason, /not begun/);
  assert.equal(repo.bodies.votingRoll(b).length, 1, 'and the roll agrees');
});

test('a title that contradicts the seat record is reported, not obeyed', () => {
  // What put a former governor in a live quorum: people.title is prose a clerk
  // types, and it said "Former Member" while the seat it describes had no end
  // date. The seat record governs — a title is not a resignation — so the
  // disagreement is surfaced rather than silently resolved either way.
  const b = repo.bodies.insert({ name: 'Finance Committee', type: 'Committee', seats: 3 });
  const p = repo.people.insert({ full_name: 'D Blevins', email: 'd@t.gov', title: 'Former Member' });
  repo.bodies.addMember(b, p, 'Member', 1, {});

  const row = repo.bodies.seatStatus(b)[0];
  assert.equal(row.onRoll, true, 'the seat record still governs the roll');
  assert.ok(row.contradiction, 'and the contradiction is reported');
  assert.match(row.contradiction, /Former Member/);
  assert.match(row.contradiction, /quorum/);
});

test('an ordinary title is not mistaken for a contradiction', () => {
  const b = repo.bodies.insert({ name: 'Rules Committee', type: 'Committee', seats: 3 });
  const p = repo.people.insert({ full_name: 'C Hair', email: 'c@t.gov', title: 'Chair' });
  repo.bodies.addMember(b, p, 'Member', 1, {});
  assert.equal(repo.bodies.seatStatus(b)[0].contradiction, null);
});

// --- Business taken out of order ----------------------------------------------

test('the minutes say when business was taken out of order', () => {
  // The minutes are laid out in agenda order, which is right — a reader
  // follows the printed agenda — but a meeting departs from it, and the record
  // had no way to say so. This is what reached_at is for; without it the
  // column is decoration.
  const minutes = require('../src/minutes');
  const { meetingId, items } = newMeeting(3);
  repo.voteAdmin.openRoll(items[2]);
  carry(items[2], 'Yea');
  repo.voteAdmin.closeRoll(items[2]);
  repo.voteAdmin.openRoll(items[0]);
  carry(items[0], 'Yea');
  repo.voteAdmin.closeRoll(items[0]);

  const html = minutes.generate(meetingId);
  assert.equal((html.match(/Taken out of order/g) || []).length, 1,
    'exactly the item that jumped is marked');
  // It is the first item — reached after the third, which is printed below it.
  const first = html.indexOf('Item 1');
  const note = html.indexOf('Taken out of order');
  const second = html.indexOf('Item 2');
  assert.ok(first < note && note < second, 'and it is marked on that item');
});

test('a meeting taken in its printed order says nothing about order', () => {
  // Marking every item in a meeting that once departed from its agenda would
  // say nothing at all.
  const minutes = require('../src/minutes');
  const { meetingId, items } = newMeeting(3);
  for (const id of items) {
    repo.voteAdmin.openRoll(id);
    carry(id, 'Yea');
    repo.voteAdmin.closeRoll(id);
  }
  assert.doesNotMatch(minutes.generate(meetingId), /Taken out of order/);
});
