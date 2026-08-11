'use strict';

// The vote ledger, eligibility arithmetic, and undoing a vote.
//
// These cover the part of the system that has to be right when someone asks,
// months later, what the Board actually decided.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vote-test-')), 'test.db');

const { init, db } = require('../src/db');
init();
const repo = require('../src/repo');
const ledger = require('../src/ledger');

// A body of five, a meeting, and an item to vote on.
const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Body', seats: 5 });
const people = ['A Governor', 'B Governor', 'C Governor', 'D Governor', 'E Governor']
  .map((n) => repo.people.insert({ full_name: n, email: `${n[0].toLowerCase()}@test.gov` }));
for (const id of people) repo.bodies.addMember(bodyId, id, 'Member');

function newItem({ threshold = 'majority' } = {}) {
  const meetingId = repo.meetings.insert({ body_id: bodyId, meeting_date: '2026-08-10' });
  const matter = repo.matters.insertNumbered({
    type: 'Ordinance', title: 'Acquisition of Building X', status: 'Introduced',
  });
  // body_id is the meeting's; agenda_items carries no such column.
  const itemId = repo.meetings.addItem({
    meeting_id: meetingId, matter_id: matter.id, title: 'Acquisition of Building X',
  });
  db.prepare('UPDATE agenda_items SET vote_threshold = ? WHERE id = ?').run(threshold, itemId);
  return { meetingId, itemId, matterId: matter.id };
}

/* ------------------------------------------------------------- the ledger ---- */

test('a vote is appended, never overwritten — the earlier one survives', () => {
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[0], 'Nay');

  const events = repo.voteLedger.forItem(itemId);
  assert.equal(events.length, 2, 'changing a vote destroyed the first one');
  assert.deepEqual(events.map((e) => e.choice), ['Yea', 'Nay']);

  // The second names the first, so the record shows a change rather than two
  // unrelated votes.
  assert.equal(events[1].supersedes_event_id, events[0].event_id);

  const current = repo.voteLedger.current(itemId);
  assert.equal(current.get(people[0]).choice, 'Nay', 'the standing vote is not the latest');
});

test('the chain verifies, and says where it breaks when a row is altered', () => {
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[1], 'Nay');
  repo.voteLedger.append(itemId, people[2], 'Yea');
  assert.deepEqual(repo.voteLedger.verify(itemId), { ok: true, length: 3 });

  // Someone with database access flips a recorded vote — the exact attack a
  // mutable `votes` table has no answer to.
  const second = repo.voteLedger.forItem(itemId)[1];
  db.prepare("UPDATE vote_events SET choice = 'Yea' WHERE id = ?").run(second.id);

  const v = repo.voteLedger.verify(itemId);
  assert.equal(v.ok, false, 'an edited vote passed verification');
  assert.equal(v.brokenAt, 1, 'the wrong entry was blamed');
  assert.match(v.reason, /do not match/);
});

test('deleting an entry from the middle is detected too', () => {
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[1], 'Nay');
  repo.voteLedger.append(itemId, people[2], 'Yea');

  db.prepare('DELETE FROM vote_events WHERE id = ?').run(repo.voteLedger.forItem(itemId)[1].id);

  // Removing a Nay is the quietest way to change an outcome; the chain no
  // longer continues, so it cannot be done without leaving a mark.
  const v = repo.voteLedger.verify(itemId);
  assert.equal(v.ok, false, 'a deleted vote went unnoticed');
  assert.equal(v.brokenAt, 1);
});

test('a forged signature does not pass', () => {
  const key = 'k'.repeat(32);
  const payload = { agendaItemId: 1, choice: 'Yea', personId: 7 };
  const built = ledger.buildEntry({ payload, key, sequence: 1 });
  const rows = [{
    previous_event_hash: built.previousEventHash,
    payload_hash: built.payloadHash,
    entry_hash: built.entryHash,
    server_signature: built.serverSignature,
    payload,
  }];
  assert.equal(ledger.verifyChain(rows, key).ok, true);

  rows[0].server_signature = 'f'.repeat(64);
  const v = ledger.verifyChain(rows, key);
  assert.equal(v.ok, false);
  assert.match(v.reason, /signature/);
});

test('the same facts always hash the same, whatever order they arrive in', () => {
  // Canonicalisation is what stops the chain breaking for reasons that have
  // nothing to do with tampering.
  const a = ledger.payloadHash({ choice: 'Yea', personId: 3, agendaItemId: 9 });
  const b = ledger.payloadHash({ agendaItemId: 9, personId: 3, choice: 'Yea' });
  assert.equal(a, b);
  assert.notEqual(a, ledger.payloadHash({ agendaItemId: 9, personId: 3, choice: 'Nay' }));
});

test('a choice outside the vocabulary is refused', () => {
  const { itemId } = newItem();
  assert.throws(() => repo.voteLedger.append(itemId, people[0], 'Maybe'), /Not a vote/);
});

/* --------------------------------------------------------- eligibility ---- */

test('a recused member leaves the denominator', () => {
  const { itemId } = newItem({ threshold: 'majority_full' });
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[1], 'Yea');
  repo.voteLedger.append(itemId, people[2], 'Nay');
  repo.voteLedger.append(itemId, people[3], 'Recused');

  const o = repo.eligibility.outcome(itemId);
  assert.equal(o.seated, 5);
  assert.equal(o.recused, 1);
  assert.equal(o.eligible, 4, 'recusal did not reduce the eligible count');
  // Majority of 4 eligible is 3, not 3 of 5 seats.
  assert.equal(o.required, 3);
});

test('recusing no longer counts as a vote against', () => {
  // The old arithmetic divided the full seat count, so a member stepping back
  // for a conflict of interest pushed the motion toward failure exactly as a
  // No would have. That inverts the purpose of recusing.
  const { itemId } = newItem({ threshold: 'majority_full' });
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[1], 'Yea');
  repo.voteLedger.append(itemId, people[2], 'Yea');
  repo.voteLedger.append(itemId, people[3], 'Recused');
  repo.voteLedger.append(itemId, people[4], 'Recused');

  const o = repo.eligibility.outcome(itemId);
  assert.equal(o.eligible, 3);
  assert.equal(o.required, 2, 'majority of three eligible should be two');
  assert.equal(o.passes, true, 'three Yeas of three eligible failed');
});

test('an absent member is present in neither count', () => {
  const { itemId, meetingId } = newItem({ threshold: 'majority_full' });
  repo.meetings.setAttendance(meetingId, [{ person_id: people[4], status: 'Absent' }]);
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[1], 'Yea');

  const o = repo.eligibility.outcome(itemId);
  assert.equal(o.present, 4, 'an absent member was counted present');
  assert.equal(o.eligible, 4);
  assert.equal(o.required, 3);
});

test('the roll reports who has not voted yet', () => {
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[2], 'Nay');

  const o = repo.eligibility.outcome(itemId);
  assert.equal(o.notVoted, 3);
  assert.equal(o.roll.filter((r) => r.choice === null).length, 3);
  assert.equal(o.yea, 1);
  assert.equal(o.nay, 1);
});

test('the outcome states the basis it was decided on', () => {
  const { itemId } = newItem({ threshold: 'two_thirds' });
  for (const p of people.slice(0, 3)) repo.voteLedger.append(itemId, p, 'Yea');
  repo.voteLedger.append(itemId, people[3], 'Nay');

  const o = repo.eligibility.outcome(itemId);
  // Three of four cast is 75%, over the two-thirds bar.
  assert.equal(o.required, 3);
  assert.equal(o.passes, true);
  assert.match(o.basis, /two-thirds/);
});

test('a changed vote is flagged on the roll', () => {
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[0], 'Nay');
  const o = repo.eligibility.outcome(itemId);
  const row = o.roll.find((r) => r.person_id === people[0]);
  assert.equal(row.choice, 'Nay');
  assert.equal(row.changed, true, 'a changed vote looked identical to a first vote');
});

/* ------------------------------------------------------ undoing a vote ---- */

function close(itemId, matterId) {
  const o = repo.eligibility.outcome(itemId);
  repo.meetings.setItemResult(itemId, 'Motion', o.result);
  repo.meetings.setVoteStatus(itemId, 'closed');
  repo.matters.addHistory({
    matter_id: matterId, action_date: '2026-08-10', body_id: bodyId,
    action: 'Vote taken in live session', result: o.result, agenda_item_id: itemId,
  });
  return o;
}

test('reopening retracts the outcome the close recorded', () => {
  const { itemId, matterId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  close(itemId, matterId);
  assert.equal(repo.meetings.getItem(itemId).result, 'Pass');

  repo.voteAdmin.reopen(itemId);

  const item = repo.meetings.getItem(itemId);
  assert.equal(item.result, null, 'the item still shows an outcome while voting is open again');
  assert.equal(item.vote_status, 'open');

  const live = repo.matters.liveHistoryForItem(itemId);
  assert.equal(live.length, 0, 'the superseded history entry still stands');
});

test('a retracted history entry is struck, not deleted', () => {
  const { itemId, matterId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  close(itemId, matterId);
  repo.voteAdmin.reopen(itemId);

  // What the Board did and then undid is itself part of the record.
  const all = repo.matters.history(matterId);
  const struck = all.filter((h) => h.voided_at);
  assert.equal(struck.length, 1, 'the entry vanished instead of being marked');
  assert.match(struck[0].void_reason, /reopened/);
});

test('closing twice does not leave two live outcomes in the history', () => {
  const { itemId, matterId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  close(itemId, matterId);
  repo.voteAdmin.reopen(itemId);
  repo.voteLedger.append(itemId, people[1], 'Nay');
  repo.voteLedger.append(itemId, people[2], 'Nay');
  close(itemId, matterId);

  const live = repo.matters.liveHistoryForItem(itemId);
  assert.equal(live.length, 1, 'the matter carries more than one standing outcome');
  assert.equal(live[0].result, 'Fail');
});

test('voiding requires a reason', () => {
  const { itemId } = newItem();
  assert.throws(() => repo.voteAdmin.void(itemId, { reason: '   ' }), /reason is required/);
  assert.throws(() => repo.voteAdmin.void(itemId), /reason is required/);
});

test('voiding clears the ballots and records why', () => {
  const { itemId, matterId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.votes.record(itemId, people[0], 'Yea');
  close(itemId, matterId);

  repo.voteAdmin.void(itemId, { reason: 'Motion was not properly seconded' });

  const item = repo.meetings.getItem(itemId);
  assert.equal(item.result, null);
  assert.equal(item.vote_status, 'pending');
  assert.equal(repo.votes.forItem(itemId).length, 0, 'members remain on record for a void vote');

  const history = repo.matters.history(matterId);
  assert.ok(history.some((h) => h.action === 'Vote voided' && /not properly seconded/.test(h.notes)),
    'the voiding itself was not recorded');
  assert.ok(history.some((h) => h.voided_at && h.result === 'Pass'),
    'the original outcome was not struck');
});

test('the ledger keeps the ballots a void removed', () => {
  const { itemId, matterId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  close(itemId, matterId);
  repo.voteAdmin.void(itemId, { reason: 'Wrong item called' });

  // Clearing the projection must not touch the account of what happened.
  assert.equal(repo.voteLedger.forItem(itemId).length, 1);
  assert.equal(repo.voteLedger.verify(itemId).ok, true);
});

/* --------------------------------------------------- motion versions ---- */

test('a motion is versioned, so a vote binds to the text on the floor', () => {
  const { itemId } = newItem();
  const v1 = repo.motionVersions.ensure(itemId, { motionText: 'Approve staff recommendation' });
  const same = repo.motionVersions.ensure(itemId, { motionText: 'Approve staff recommendation' });
  assert.equal(same.id, v1.id, 'an unchanged motion made a new version');

  const v2 = repo.motionVersions.ensure(itemId, { motionText: 'Approve as amended' });
  assert.equal(v2.seq, 2);
  assert.equal(repo.motionVersions.all(itemId).length, 2);
});

test('the event records which motion version was voted on', () => {
  const { itemId } = newItem();
  const v = repo.motionVersions.ensure(itemId, { motionText: 'Approve staff recommendation' });
  repo.voteLedger.append(itemId, people[0], 'Yea', { motionVersionId: v.id });

  const [e] = repo.voteLedger.forItem(itemId);
  assert.equal(e.motion_version_id, v.id);

  // Repoint the vote at a different, entirely legitimate motion version — the
  // realistic version of this attack, since a dangling id is refused by the
  // foreign key anyway. What must catch it is the hash: the motion voted on is
  // part of the payload, so it cannot be swapped after the fact.
  const v2 = repo.motionVersions.ensure(itemId, { motionText: 'Approve as amended' });
  db.prepare('UPDATE vote_events SET motion_version_id = ? WHERE id = ?').run(v2.id, e.id);
  assert.equal(repo.voteLedger.verify(itemId).ok, false,
    'the motion a vote was cast on could be swapped without detection');
});

/* ------------------------------------------------- no way round the ledger ---- */

test('the projection and the ledger cannot disagree about who voted', () => {
  // Every writer of `votes` has to append first. A row that reaches the
  // projection without an event is a vote the chain cannot vouch for, and it
  // would be invisible in exactly the audit the chain exists to serve.
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.votes.record(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[1], 'Nay');
  repo.votes.record(itemId, people[1], 'Nay');

  const projected = repo.votes.forItem(itemId)
    .map((v) => `${v.person_id}:${v.vote}`).sort();
  const ledgered = [...repo.voteLedger.current(itemId).values()]
    .map((e) => `${e.person_id}:${e.choice}`).sort();
  assert.deepEqual(projected, ledgered);
});

test('a vote survives being recorded twice with the same value', () => {
  // Pressing the same button again is not a change of mind, but it is still an
  // event: the record should show that the member confirmed, not silently
  // swallow it.
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[0], 'Yea');
  assert.equal(repo.voteLedger.forItem(itemId).length, 2);
  assert.equal(repo.voteLedger.current(itemId).size, 1);
  assert.equal(repo.voteLedger.verify(itemId).ok, true);
});

/* ------------------------------------------- the tally is as of the close ---- */

/** Append an event with a chosen received_at, to stand in for a late arrival. */
function appendAt(itemId, personId, choice, receivedAt) {
  const r = repo.voteLedger.append(itemId, personId, choice);
  db.prepare('UPDATE vote_events SET received_at = ? WHERE event_id = ?')
    .run(receivedAt, r.eventId);
  return r;
}

test('a vote received after the roll closed does not join the tally', () => {
  const { itemId } = newItem();
  appendAt(itemId, people[0], 'Yea', '2026-08-10T10:00:00.000Z');
  appendAt(itemId, people[1], 'Yea', '2026-08-10T10:00:01.000Z');
  repo.voteAdmin.closeRoll(itemId);
  db.prepare("UPDATE agenda_items SET vote_closed_at = ? WHERE id = ?")
    .run('2026-08-10T10:00:02.000Z', itemId);

  const before = repo.eligibility.outcome(itemId);
  assert.equal(before.yea, 2);

  // A station retrying after the gavel. It happened, so it is recorded — but a
  // settled vote cannot be moved by it.
  appendAt(itemId, people[2], 'Nay', '2026-08-10T10:05:00.000Z');

  const after = repo.eligibility.outcome(itemId);
  assert.equal(after.yea, 2, 'a late arrival changed a closed tally');
  assert.equal(after.nay, 0, 'a late Nay was counted');
  assert.equal(after.result, before.result);
});

test('late arrivals are surfaced, not silently dropped', () => {
  const { itemId } = newItem();
  appendAt(itemId, people[0], 'Yea', '2026-08-10T10:00:00.000Z');
  repo.voteAdmin.closeRoll(itemId);
  db.prepare("UPDATE agenda_items SET vote_closed_at = ? WHERE id = ?")
    .run('2026-08-10T10:00:02.000Z', itemId);
  appendAt(itemId, people[1], 'Nay', '2026-08-10T11:00:00.000Z');

  assert.equal(repo.eligibility.outcome(itemId).late, 1, 'the late event was hidden');
  assert.equal(repo.voteLedger.late(itemId).length, 1);
  // And it is still in the ledger, because it did happen.
  assert.equal(repo.voteLedger.forItem(itemId).length, 2);
});

test('a closed tally recomputes to the same number however long after', () => {
  const { itemId } = newItem();
  appendAt(itemId, people[0], 'Yea', '2026-08-10T10:00:00.000Z');
  appendAt(itemId, people[1], 'Nay', '2026-08-10T10:00:01.000Z');
  appendAt(itemId, people[2], 'Yea', '2026-08-10T10:00:02.000Z');
  repo.voteAdmin.closeRoll(itemId);
  db.prepare("UPDATE agenda_items SET vote_closed_at = ? WHERE id = ?")
    .run('2026-08-10T10:00:03.000Z', itemId);
  const onTheDay = repo.eligibility.outcome(itemId);

  // Months of later traffic against the same item.
  appendAt(itemId, people[3], 'Nay', '2026-11-01T09:00:00.000Z');
  appendAt(itemId, people[4], 'Nay', '2027-02-01T09:00:00.000Z');

  const later = repo.eligibility.outcome(itemId);
  assert.equal(later.yea, onTheDay.yea);
  assert.equal(later.nay, onTheDay.nay);
  assert.equal(later.result, onTheDay.result, 'the minutes and the system now disagree');
});

test('a change that arrives late cannot retract the vote that counted', () => {
  // The subtle one: if a late event were allowed to supersede, it would erase
  // the ballot it claims to replace while being ineligible to replace it —
  // costing the member their vote entirely rather than leaving it standing.
  const { itemId } = newItem();
  appendAt(itemId, people[0], 'Yea', '2026-08-10T10:00:00.000Z');
  repo.voteAdmin.closeRoll(itemId);
  db.prepare("UPDATE agenda_items SET vote_closed_at = ? WHERE id = ?")
    .run('2026-08-10T10:00:02.000Z', itemId);
  appendAt(itemId, people[0], 'Nay', '2026-08-10T10:09:00.000Z');

  const o = repo.eligibility.outcome(itemId);
  assert.equal(o.yea, 1, 'the vote that counted was withdrawn by a late change');
  assert.equal(o.nay, 0);
});

test('while the roll is open there is no bound', () => {
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[1], 'Yea');
  const o = repo.eligibility.outcome(itemId);
  assert.equal(o.asOf, null, 'an open roll was computed against a closing instant');
  assert.equal(o.yea, 2);
});

test('reopening lifts the bound so new votes count again', () => {
  const { itemId } = newItem();
  appendAt(itemId, people[0], 'Yea', '2026-08-10T10:00:00.000Z');
  repo.voteAdmin.closeRoll(itemId);
  db.prepare("UPDATE agenda_items SET vote_closed_at = ? WHERE id = ?")
    .run('2026-08-10T10:00:02.000Z', itemId);
  assert.equal(repo.eligibility.outcome(itemId).yea, 1);

  repo.voteAdmin.reopen(itemId);
  assert.equal(repo.meetings.getItem(itemId).vote_closed_at, null,
    'the old close still bounds a reopened roll');

  repo.voteLedger.append(itemId, people[1], 'Yea');
  assert.equal(repo.eligibility.outcome(itemId).yea, 2, 'a vote after reopening did not count');
});
