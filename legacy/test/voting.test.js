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

  const events = ballots(itemId);
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
  assert.equal(repo.voteLedger.verifyItem(itemId).ok, true);

  // Someone with database access flips a recorded vote — the exact attack a
  // mutable `votes` table has no answer to.
  const second = ballots(itemId)[1];
  db.prepare("UPDATE session_events SET choice = 'Yea' WHERE seq = ?").run(second.seq);

  const v = repo.voteLedger.verifyItem(itemId);
  assert.equal(v.ok, false, 'an edited vote passed verification');
  // Caught by the mirror check before the hash even runs: the indexed column
  // used for querying no longer agrees with the sealed payload.
  assert.match(v.reason, /disagree with the sealed payload|do not match/);
});

test('deleting an entry from the middle is detected too', () => {
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[1], 'Nay');
  repo.voteLedger.append(itemId, people[2], 'Yea');

  db.prepare('DELETE FROM session_events WHERE seq = ?').run(ballots(itemId)[1].seq);

  // Removing a Nay is the quietest way to change an outcome; the chain no
  // longer continues, so it cannot be done without leaving a mark.
  const v = repo.voteLedger.verifyItem(itemId);
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
  assert.equal(ballots(itemId).length, 1);
  assert.equal(repo.voteLedger.verifyItem(itemId).ok, true);
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

  const [e] = ballots(itemId);
  assert.equal(JSON.parse(e.payload_json).motionVersionId, v.id);

  // Repoint the vote at a different, entirely legitimate motion version — the
  // realistic version of this attack, since a dangling id is refused by the
  // foreign key anyway. What must catch it is the hash: the motion voted on is
  // part of the payload, so it cannot be swapped after the fact.
  const v2 = repo.motionVersions.ensure(itemId, { motionText: 'Approve as amended' });
  db.prepare("UPDATE session_events SET payload_json = json_set(payload_json, '$.motionVersionId', ?) WHERE seq = ?").run(v2.id, e.seq);
  assert.equal(repo.voteLedger.verifyItem(itemId).ok, false,
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
  assert.equal(ballots(itemId).length, 2);
  assert.equal(repo.voteLedger.current(itemId).size, 1);
  assert.equal(repo.voteLedger.verifyItem(itemId).ok, true);
});

/* ------------------------------------------- the tally is as of the close ---- */

/**
 * Lateness is a matter of position now, not of a clock.
 *
 * A ballot appended after ROLL_CLOSED occupies a later slot in the chain, and
 * nothing has to trust a timestamp for that to hold — which is the reason the
 * chain covers the whole session rather than one item at a time.
 */
const appendAt = (itemId, personId, choice) =>
  repo.voteLedger.append(itemId, personId, choice, { source: 'MEMBER_TERMINAL' });

/** Just the ballots: the chain also carries ROLL_* and RESULT_* events. */
const ballots = (itemId) => repo.voteLedger.forItem(itemId)
  .filter((e) => e.event_type === 'VOTE_CAST' || e.event_type === 'VOTE_CHANGED');

test('a vote received after the roll closed does not join the tally', () => {
  const { itemId } = newItem();
  appendAt(itemId, people[0], 'Yea');
  appendAt(itemId, people[1], 'Yea');
  repo.voteAdmin.closeRoll(itemId);

  const before = repo.eligibility.outcome(itemId);
  assert.equal(before.yea, 2);

  // A station retrying after the gavel. It happened, so it is recorded — but a
  // settled vote cannot be moved by it.
  appendAt(itemId, people[2], 'Nay');

  const after = repo.eligibility.outcome(itemId);
  assert.equal(after.yea, 2, 'a late arrival changed a closed tally');
  assert.equal(after.nay, 0, 'a late Nay was counted');
  assert.equal(after.result, before.result);
});

test('late arrivals are surfaced, not silently dropped', () => {
  const { itemId } = newItem();
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);
  appendAt(itemId, people[1], 'Nay');

  assert.equal(repo.eligibility.outcome(itemId).late, 1, 'the late event was hidden');
  assert.equal(repo.voteLedger.late(itemId).length, 1);
  // And it is still in the ledger, because it did happen.
  assert.equal(ballots(itemId).length, 2);
});

test('a closed tally recomputes to the same number however long after', () => {
  const { itemId } = newItem();
  appendAt(itemId, people[0], 'Yea');
  appendAt(itemId, people[1], 'Nay');
  appendAt(itemId, people[2], 'Yea');
  repo.voteAdmin.closeRoll(itemId);
  const onTheDay = repo.eligibility.outcome(itemId);

  // Months of later traffic against the same item.
  appendAt(itemId, people[3], 'Nay');
  appendAt(itemId, people[4], 'Nay');

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
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);
  appendAt(itemId, people[0], 'Nay');

  const o = repo.eligibility.outcome(itemId);
  assert.equal(o.yea, 1, 'the vote that counted was withdrawn by a late change');
  assert.equal(o.nay, 0);
});

test('while the roll is open there is no bound', () => {
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea');
  repo.voteLedger.append(itemId, people[1], 'Yea');
  const o = repo.eligibility.outcome(itemId);
  assert.equal(o.closed, false, 'an open roll was computed against a close');
  assert.equal(o.yea, 2);
});

test('reopening lifts the bound so new votes count again', () => {
  const { itemId } = newItem();
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);
  assert.equal(repo.eligibility.outcome(itemId).yea, 1);

  repo.voteAdmin.reopen(itemId);
  assert.equal(repo.voteLedger.closedSeq(itemId), null,
    'the old close still bounds a reopened roll');

  repo.voteLedger.append(itemId, people[1], 'Yea');
  assert.equal(repo.eligibility.outcome(itemId).yea, 2, 'a vote after reopening did not count');
});

/* --------------------------------------------- the chain covers the session ---- */

test('the close occupies a slot, so lateness needs no trusted clock', () => {
  // The reason the chain spans the meeting rather than one item. ROLL_CLOSED
  // is *in* the sequence, so a ballot after it is provably after it by
  // position — even if every timestamp in the table were rewritten.
  const { itemId } = newItem();
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);
  appendAt(itemId, people[1], 'Nay');

  const closedSeq = repo.voteLedger.closedSeq(itemId);
  assert.ok(closedSeq > 0);

  // Backdate the late ballot to before the meeting began.
  db.prepare("UPDATE session_events SET received_at = '2000-01-01T00:00:00.000Z' WHERE choice = 'Nay'")
    .run();

  const o = repo.eligibility.outcome(itemId);
  assert.equal(o.nay, 0, 'a backdated ballot was counted into a closed vote');
  assert.equal(o.yea, 1);
});

test('events from the whole meeting share one chain', () => {
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);

  const types = repo.voteLedger.forMeeting(meetingId).map((e) => e.event_type);
  assert.deepEqual(types, ['ROLL_OPENED', 'VOTE_CAST', 'ROLL_CLOSED', 'RESULT_COMPUTED']);
  assert.equal(repo.voteLedger.verify(meetingId).ok, true);
});

test('a second item cannot be spliced into another item history unnoticed', () => {
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);
  assert.equal(repo.voteLedger.verify(meetingId).ok, true);

  // Re-point a recorded ballot at a real second item on the same meeting —
  // a dangling id is refused by the foreign key, so this is the version that
  // could actually happen. The indexed column is what queries read, and it no
  // longer agrees with what was sealed.
  const other = repo.meetings.addItem({ meeting_id: meetingId, title: 'Another item' });
  const ballot = ballots(itemId)[0];
  db.prepare('UPDATE session_events SET agenda_item_id = ? WHERE seq = ?').run(other, ballot.seq);
  assert.equal(repo.voteLedger.verify(meetingId).ok, false);
});

/* ------------------------------------------------------------ provenance ---- */

test('a clerk-entered vote is not disguised as one the member cast', () => {
  const { itemId } = newItem();
  repo.voteLedger.append(itemId, people[0], 'Yea', { source: 'MEMBER_TERMINAL' });
  repo.voteLedger.append(itemId, people[1], 'Nay', { source: 'CLERK_ENTRY', userId: null });

  const rows = ballots(itemId);
  assert.equal(rows[0].source, 'MEMBER_TERMINAL');
  assert.equal(rows[1].source, 'CLERK_ENTRY');
  // And the provenance is sealed, not merely stored beside the vote.
  db.prepare("UPDATE session_events SET source = 'MEMBER_TERMINAL' WHERE seq = ?").run(rows[1].seq);
  assert.equal(repo.voteLedger.verifyItem(itemId).ok, false,
    'a clerk entry could be relabelled as the member own vote');
});

test('an unknown source is refused', () => {
  const { itemId } = newItem();
  assert.throws(() => repo.voteLedger.append(itemId, people[0], 'Yea', { source: 'SOMEWHERE' }),
    /Not a vote source/);
});

/* ------------------------------------------------- the result lifecycle ---- */

test('computing, announcing, certifying and publishing are four acts', () => {
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  appendAt(itemId, people[1], 'Yea');
  repo.voteAdmin.closeRoll(itemId);

  let item = repo.meetings.getItem(itemId);
  assert.ok(item.result_computed_at, 'closing did not compute a result');
  assert.equal(item.result_announced_at, null);

  repo.voteAdmin.announce(itemId);
  repo.voteAdmin.certify(itemId, { userId: null });
  repo.voteAdmin.publish(itemId);

  item = repo.meetings.getItem(itemId);
  assert.ok(item.result_announced_at && item.result_certified_at && item.result_published_at);

  const types = repo.voteLedger.forMeeting(meetingId).map((e) => e.event_type);
  assert.deepEqual(types.slice(-4),
    ['RESULT_COMPUTED', 'RESULT_ANNOUNCED', 'RESULT_CERTIFIED', 'RESULT_PUBLISHED']);
});

test('a result cannot be published before it is certified', () => {
  const { itemId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);
  assert.throws(() => repo.voteAdmin.publish(itemId), /certified/);
});

test('certification pins what the record consisted of at that moment', () => {
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);

  const headBefore = repo.voteLedger.forMeeting(meetingId).at(-1).event_hash;
  repo.voteAdmin.certify(itemId, { userId: null });

  // "What did the Clerk attest to" resolves by hash rather than by inference.
  assert.equal(repo.meetings.getItem(itemId).certification_checkpoint, headBefore);
});

test('the rule that governed a roll is recorded with it', () => {
  const { itemId } = newItem({ threshold: 'two_thirds' });
  repo.voteAdmin.openRoll(itemId);
  assert.equal(repo.meetings.getItem(itemId).threshold_rule, 'two_thirds');

  // Standing orders change; a vote already taken must still evaluate under the
  // rule in force when it was taken.
  db.prepare("UPDATE agenda_items SET vote_threshold = 'majority' WHERE id = ?").run(itemId);
  assert.equal(repo.eligibility.outcome(itemId).threshold, 'two_thirds',
    'an old vote was re-judged under a rule adopted afterwards');
});

/* --------------------------------------- the room and the record agree ---- */

const live = require('../src/live');

test('the live board projects the same outcome the close will record', () => {
  // These were two separate implementations of the threshold, and they
  // disagreed about recusal: the board divided the full seat count while the
  // close divided the eligible members. A board reading "Passes" while the
  // minutes record "Fail" is the worst possible failure for this system, and
  // it is invisible until someone compares them.
  const { itemId, meetingId } = newItem({ threshold: 'majority_full' });
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  appendAt(itemId, people[1], 'Yea');
  appendAt(itemId, people[2], 'Recused');
  appendAt(itemId, people[3], 'Recused');

  const projected = live.snapshot(meetingId).active.projectedOutcome;
  const recorded = repo.voteAdmin.closeRoll(itemId).result;

  assert.equal(projected, 'Passes');
  assert.equal(recorded, 'Pass', 'the board and the record disagreed');
});

test('the board reports eligibility, not just raw counts', () => {
  const { itemId, meetingId } = newItem({ threshold: 'majority_full' });
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  appendAt(itemId, people[1], 'Recused');

  const a = live.snapshot(meetingId).active;
  assert.equal(a.present, 5);
  assert.equal(a.recused, 1);
  assert.equal(a.eligible, 4, 'the board still counts a recused member as eligible');
  assert.equal(a.required, 3);
  assert.equal(a.notVoted, 3);
  assert.match(a.basis, /eligible/);
});

test('the board shows a clerk-entered vote as clerk-entered', () => {
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  repo.voteLedger.append(itemId, people[0], 'Yea', { source: 'MEMBER_TERMINAL' });
  repo.voteLedger.append(itemId, people[1], 'Nay', { source: 'CLERK_ENTRY' });

  const roster = live.snapshot(meetingId).active.roster;
  assert.equal(roster.find((r) => r.person_id === people[0]).source, 'MEMBER_TERMINAL');
  assert.equal(roster.find((r) => r.person_id === people[1]).source, 'CLERK_ENTRY');
});

test('the board counts the ledger, not the mutable projection', () => {
  // The projection can be edited; the ledger cannot. What the room sees should
  // come from the account of record.
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');

  db.prepare('INSERT INTO votes (agenda_item_id, person_id, vote) VALUES (?,?,?)')
    .run(itemId, people[1], 'Yea');

  assert.equal(live.snapshot(meetingId).active.tally.Yea, 1,
    'a row inserted straight into the projection appeared on the board');
});

/* --------------------------------------------------- the chamber display ---- */

const displayViews = require('../src/views/display');

test('the board carries the lifecycle, not just a number', () => {
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');

  let a = live.snapshot(meetingId).active;
  assert.equal(a.closed, false);
  assert.equal(a.certified, false);

  repo.voteAdmin.closeRoll(itemId);
  // Closing ends the open roll, so the item is no longer "before the body".
  // The board reads the item directly once it is closed.
  const item = repo.meetings.getItem(itemId);
  assert.ok(item.result_computed_at);
  assert.equal(item.result_certified_at, null);

  repo.voteAdmin.certify(itemId, { userId: null });
  assert.ok(repo.meetings.getItem(itemId).result_certified_at);
});

test('the board renders without a stylesheet or a session', () => {
  // It hangs on a wall in a public room. It must not depend on the app's
  // navigation, on being signed in, or on /styles.css resolving.
  const { meetingId } = newItem();
  const meeting = repo.meetings.get(meetingId);
  const html = displayViews.displayBoard(meeting);

  assert.match(html, /<style>/, 'the board depends on an external stylesheet');
  assert.ok(!/styles\.css/.test(html), 'the board pulls in the application stylesheet');
  assert.ok(!/Sign-In|sidebar|sidenav/.test(html), 'the board carries application chrome');
  assert.match(html, /data-meeting="\d+"/);
});

test('the board markup escapes the body name', () => {
  const evilBody = repo.bodies.insert({ name: '<script>alert(1)</script>', type: 'Committee', seats: 1 });
  const mid = repo.meetings.insert({ body_id: evilBody, meeting_date: '2026-08-10' });
  const html = displayViews.displayBoard(repo.meetings.get(mid));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'the board interpolated markup unescaped');
});

test('the display client cannot send anything to the server', () => {
  // Structural, not stylistic: a screen in a public room that can act is a
  // screen a passer-by can act through.
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '../public/assets/display.js'), 'utf8');
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'navigator.sendBeacon', '<form', 'method="post"']) {
    assert.ok(!src.includes(forbidden), `the display client contains ${forbidden}`);
  }
});

test('the board holds the result up after the roll closes', () => {
  // A board that empties when the gavel falls never shows the outcome — the
  // moment the room is actually waiting for.
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  appendAt(itemId, people[1], 'Yea');
  repo.voteAdmin.closeRoll(itemId);

  const a = live.snapshot(meetingId).active;
  assert.ok(a, 'the board went blank the instant the vote closed');
  assert.equal(a.closed, true);
  assert.equal(a.result, 'Pass');
});

test('a closed board shows the official tally, not a running one', () => {
  // Once closed, the wall and the minutes must report the same number even if
  // a late ballot lands.
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);
  appendAt(itemId, people[1], 'Nay');

  const a = live.snapshot(meetingId).active;
  assert.equal(a.tally.Nay, 0, 'a late ballot appeared on the board after the close');
  assert.equal(a.late, 1, 'the late ballot was not surfaced');
});

test('an open roll takes the board back from a closed result', () => {
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  repo.voteAdmin.closeRoll(itemId);

  const second = repo.meetings.addItem({ meeting_id: meetingId, title: 'Next item' });
  repo.voteAdmin.openRoll(second);

  const a = live.snapshot(meetingId).active;
  assert.equal(a.id, second, 'the board stayed on the finished item after the chair moved on');
  assert.equal(a.closed, false);
});

test('the board uses the Board own seal when one is supplied', () => {
  const { meetingId } = newItem();
  const meeting = repo.meetings.get(meetingId);

  // Falls back to the drawn seal when no artwork is configured.
  assert.match(displayViews.displayBoard(meeting), /--seal: url\("data:image\/svg/);

  const org = require('../src/org');
  const before = org.ORG.logoLightUrl;
  try {
    org.ORG.logoLightUrl = '/brand/seal-light.png';
    const html = displayViews.displayBoard(meeting);
    assert.match(html, /--seal: url\("\/brand\/seal-light\.png"\)/,
      'the supplied seal was ignored');
  } finally {
    org.ORG.logoLightUrl = before;
  }
});

test('a seal URL cannot break out of the CSS it sits in', () => {
  const org = require('../src/org');
  const before = org.ORG.logoLightUrl;
  try {
    // logoLightUrl is admin-editable, so it is attacker-adjacent: a quote would
    // otherwise close the url() and let arbitrary CSS follow it.
    org.ORG.logoLightUrl = '/x.png"); } body { display: none } :root { --x: url("';
    const html = displayViews.displayBoard(repo.meetings.get(newItem().meetingId));
    assert.ok(!html.includes('body { display: none }'), 'a seal URL injected CSS');
  } finally {
    org.ORG.logoLightUrl = before;
  }
});

/* -------------------------------------------------- the clerk's console ---- */

test('the snapshot reports whether the record still verifies', () => {
  // The clerk needs to know during the meeting, while ballots can still be
  // re-taken — not months later in an audit.
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  assert.equal(live.snapshot(meetingId).chain.ok, true);

  db.prepare("UPDATE session_events SET choice = 'Nay' WHERE choice = 'Yea' AND agenda_item_id = ?")
    .run(itemId);

  const chain = live.snapshot(meetingId).chain;
  assert.equal(chain.ok, false, 'a tampered record still reported as verified');
  assert.ok(chain.reason, 'the console was told it is broken but not why');
});

test('the console is given the figures the close will use', () => {
  const { itemId, meetingId } = newItem({ threshold: 'majority_full' });
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  appendAt(itemId, people[1], 'Recused');

  const a = live.snapshot(meetingId).active;
  // Everything the clerk mockup asks for, from the same source as the outcome.
  for (const k of ['present', 'eligible', 'recused', 'notVoted', 'required', 'basis']) {
    assert.ok(a[k] !== undefined, `the console cannot show ${k}`);
  }
  assert.equal(a.eligible, 4);
  assert.equal(a.required, 3);
});

test('the console knows how far through the lifecycle an item is', () => {
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);

  let a = live.snapshot(meetingId).active;
  assert.equal(a.closed, true);
  assert.equal(a.announced, false);
  assert.equal(a.certified, false);
  assert.equal(a.published, false);

  repo.voteAdmin.announce(itemId);
  repo.voteAdmin.certify(itemId, { userId: null });
  a = live.snapshot(meetingId).active;
  assert.equal(a.announced, true);
  assert.equal(a.certified, true);
  assert.equal(a.published, false, 'certifying should not publish');
});

test('the console surfaces ballots that arrived after the close', () => {
  const { itemId, meetingId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  appendAt(itemId, people[0], 'Yea');
  repo.voteAdmin.closeRoll(itemId);
  appendAt(itemId, people[1], 'Nay');

  assert.equal(live.snapshot(meetingId).active.late, 1,
    'a ballot after the close was invisible to the clerk');
});

// --- The keep-alive has to be visible to the page ----------------------------
//
// The chamber display raises a staleness overlay when it has not heard from the
// server for a minute. That is only meaningful if the keep-alive reaches the
// page: an SSE comment (`: ping`) holds the socket open but fires no listener,
// so a quiet meeting was indistinguishable from a dead stream and the board
// told a room full of people it could not vouch for numbers that were correct.

test('the stream keep-alive is a named event, not an invisible comment', async () => {
  const { meetingId } = newItem();
  const writes = [];
  const res = { writeHead() {}, write(chunk) { writes.push(String(chunk)); } };
  const handlers = {};
  const req = { on(ev, fn) { handlers[ev] = fn; } };

  live.subscribe(meetingId, req, res, { keepAliveMs: 15 });
  await new Promise((r) => setTimeout(r, 45));
  handlers.close();

  const pings = writes.filter((w) => w.startsWith('event: ping'));
  assert.ok(pings.length > 0, 'no keep-alive reached the client');
  assert.ok(!writes.some((w) => w.trimStart().startsWith(':')),
    'keep-alive sent as an SSE comment, which fires no EventSource listener');
  assert.equal(pings[0], 'event: ping\ndata: {}\n\n');
});

test('the chamber display listens for the event the server actually sends', () => {
  const client = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'assets', 'display.js'), 'utf8');
  assert.match(client, new RegExp(`addEventListener\\('${live.KEEPALIVE_EVENT}'`),
    'the display does not handle the keep-alive, so its staleness clock only '
    + 'resets when the tally changes');
});

test('the keep-alive fires well inside the display staleness window', () => {
  const client = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'assets', 'display.js'), 'utf8');
  const window = Number((client.match(/lastUpdate\s*<\s*(\d+)/) || [])[1]);
  assert.ok(window > 0, 'could not read the staleness window from the display');
  assert.ok(live.KEEPALIVE_MS * 2 <= window,
    `keep-alive every ${live.KEEPALIVE_MS}ms cannot keep a ${window}ms window open`);
});

// --- The board on the wall validates its branding like everything else -------

test('the chamber display falls back to the drawn seal on an unusable brand value', () => {
  const { ORG } = require('../src/org');
  const displayViews = require('../src/views/display');
  const meeting = { id: 1, body_name: 'Board of Governors' };
  const original = ORG.logoLightUrl;

  try {
    for (const bad of [
      'https://example.com/a.png\n); } body { display: none } .x { y: url(z',
      'http://example.com/insecure.png',
      '/etc/passwd',
      '/brand/../../secret.png',
      'not a url at all',
    ]) {
      ORG.logoLightUrl = bad;
      const html = displayViews.displayBoard(meeting);
      assert.ok(html.includes('--seal: url("data:image/svg+xml'),
        `display did not fall back for: ${JSON.stringify(bad)}`);
      assert.ok(!html.includes(bad),
        'the rejected branding value was interpolated into the board anyway');
    }

    ORG.logoLightUrl = '/brand/seal-light.png';
    assert.match(displayViews.displayBoard(meeting),
      /--seal: url\("\/brand\/seal-light\.png"\)/,
      'a valid local path should be used as supplied');
  } finally {
    ORG.logoLightUrl = original;
  }
});

// --- The chamber display has to be reachable ---------------------------------
// It is deliberately absent from the navigation — it is not a page anyone
// browses — which left it reachable only by typing the URL from memory, with
// the meeting id in it. The clerk console is where the room gets set up, so
// that is where the route to the wall screen belongs.

test('the clerk console offers the chamber display; the public board does not', () => {
  const liveViews = require('../src/views/live');
  const { meetingId } = newItem();
  const meeting = repo.meetings.get(meetingId);

  const console_ = liveViews.clerkConsole(meeting, { person_id: null });
  assert.match(console_, new RegExp(`href="/display/${meetingId}"`),
    'the clerk had no way to open the display but to type its URL');

  // The board is unauthenticated by design, but it is the clerk's instrument.
  // Offering it from the public page invites the room to put it up themselves.
  const publicBoard = liveViews.publicLive(meeting, null);
  assert.doesNotMatch(publicBoard, new RegExp(`href="/display/${meetingId}"`),
    'the public live board should not hand out the chamber display');
});

// --- Who may have a ballot recorded for them ---------------------------------
// The roll is built from the body's seated members, so a ballot for anyone else
// is counted by nothing and appears in no roster — while still sealing an entry
// into the ledger, which is the authoritative account. Both cast routes ask
// this question; they ask it in one place so their answers cannot drift.

test('a ballot for someone not seated is counted by nothing but still seals an entry', () => {
  const { itemId, meetingId } = newItem();
  const outsider = repo.people.insert({ full_name: 'Not A Member' });
  repo.voteAdmin.openRoll(itemId);

  appendAt(itemId, people[0], 'Yea');
  const before = repo.voteLedger.forItem(itemId).length;
  repo.voteLedger.append(itemId, outsider, 'Yea');

  const o = repo.eligibility.outcome(itemId, { throughSeq: null });
  assert.equal(o.yea, 1, 'a vote from off the roster reached the tally');
  assert.equal(o.roll.some((r) => r.person_id === outsider), false,
    'someone not seated appeared in the roll');
  // This is why the routes have to refuse it rather than lean on the tally:
  // the entry is permanent and invisible, and the chain cannot be edited.
  assert.equal(repo.voteLedger.forItem(itemId).length, before + 1,
    'the uncounted ballot was still written to the ledger');
  assert.equal(live.snapshot(meetingId).active.tally.Yea, 1);
});

test('isSeated answers for the body asked about, and refuses junk', () => {
  const other = repo.bodies.insert({ name: 'Some Other Body', type: 'Committee', seats: 3 });

  assert.equal(repo.bodies.isSeated(bodyId, people[0]), true);
  assert.equal(repo.bodies.isSeated(other, people[0]), false,
    'a member of one body was treated as seated on another');

  const outsider = repo.people.insert({ full_name: 'Also Not A Member' });
  assert.equal(repo.bodies.isSeated(bodyId, outsider), false);

  // The clerk route takes person_id off the request, so these are the shapes
  // that actually arrive when a stale page posts a chip that no longer exists.
  for (const junk of [undefined, null, '', 'abc', NaN, 0, -1, 1.5]) {
    assert.equal(repo.bodies.isSeated(bodyId, junk), false,
      `isSeated admitted ${JSON.stringify(junk)}`);
  }
});

// --- Who the live board offers a ballot to -----------------------------------
// Roles rank: public, member, staff, clerk, admin. This page compared the role
// string instead, so everyone senior to a member fell through to 'public' and
// was shown no way to vote — including the Chair, whom auth.js seeds as staff.

test('the live board offers a ballot to every rank at or above member', () => {
  const liveViews = require('../src/views/live');
  const { meetingId } = newItem();
  const meeting = repo.meetings.get(meetingId);
  const person = people[0];

  for (const role of ['member', 'staff', 'clerk', 'admin']) {
    const page = liveViews.publicLive(meeting, { role, person_id: person });
    assert.match(page, /data-role="member"/,
      `a ${role} was shown the board as a member of the public`);
    assert.match(page, new RegExp(`data-person="${person}"`));
  }

  const publicView = liveViews.publicLive(meeting, null);
  assert.match(publicView, /data-role="public"/);
});

test('a sign-in with no person behind it is not offered a ballot', () => {
  const liveViews = require('../src/views/live');
  const { meetingId } = newItem();
  const meeting = repo.meetings.get(meetingId);

  // What SSO provisions: a real account, a real role, no link to a person on
  // the board. The cast route rejects it as having no member identity, so the
  // page must not offer buttons that post a ballot destined to be refused.
  const page = liveViews.publicLive(meeting, { role: 'member', person_id: null });
  assert.match(page, /data-role="public"/,
    'an account with no person behind it was offered a ballot');
  assert.doesNotMatch(page, /data-person=/);
});

// --- Who is on the roll ------------------------------------------------------
// The roll used to be a plain select over body_members, which counted a member
// whose term had run out and an ex-officio member who does not vote — both
// toward the quorum and both into the majority_full denominator.

test('a non-voting member counts toward neither the vote nor the quorum', () => {
  const b = repo.bodies.insert({ name: 'Ex Officio Body', type: 'Committee', seats: 4 });
  const voters = ['P', 'Q', 'R'].map((n) => repo.people.insert({ full_name: `${n} Member` }));
  voters.forEach((id) => repo.bodies.addMember(b, id, 'Member'));
  const exOfficio = repo.people.insert({ full_name: 'X Officio' });
  repo.bodies.addMember(b, exOfficio, 'Member', 0);

  const roll = repo.bodies.votingRoll(b);
  assert.equal(roll.length, 3, 'an ex-officio member was counted into the body');
  assert.equal(roll.some((r) => r.id === exOfficio), false);
  assert.equal(repo.bodies.isSeated(b, exOfficio), false,
    'a ballot would be accepted for someone the tally will not count');
});

test('a member holds over until a successor takes the seat', () => {
  const b = repo.bodies.insert({ name: 'Holdover Body', type: 'Committee', seats: 3 });
  const sitting = ['S', 'T'].map((n) => repo.people.insert({ full_name: `${n} Member` }));
  sitting.forEach((id) => repo.bodies.addMember(b, id, 'Member'));
  const expired = repo.people.insert({ full_name: 'U Member' });
  repo.bodies.addMember(b, expired, 'Member');
  db.prepare("UPDATE body_members SET end_date = '2020-01-01' WHERE person_id = ?").run(expired);

  // Three seats, two current members: the seat is not yet filled, so the
  // member whose term ran out keeps voting.
  assert.equal(repo.bodies.votingRoll(b).length, 3, 'a holdover was dropped with the seat still empty');
  assert.equal(repo.bodies.isSeated(b, expired), true);

  // Seat the successor and the holdover goes.
  const successor = repo.people.insert({ full_name: 'V Member' });
  repo.bodies.addMember(b, successor, 'Member');
  const after = repo.bodies.votingRoll(b);
  assert.equal(after.length, 3, 'the body grew past its authorized seats');
  assert.equal(after.some((r) => r.id === expired), false, 'the holdover survived their successor');
  assert.equal(after.some((r) => r.id === successor), true);
});

test('a seat held by a non-voting member is still a seat that can be filled', () => {
  // The mistake this pins: filtering the non-voting out before working out
  // occupancy hides their seat, so the body looks short and a holdover stays
  // on the roll after they have in fact been replaced.
  const b = repo.bodies.insert({ name: 'Occupancy Body', type: 'Committee', seats: 3 });
  const a1 = repo.people.insert({ full_name: 'A One' });
  repo.bodies.addMember(b, a1, 'Member');
  const ex = repo.people.insert({ full_name: 'B Two' });
  repo.bodies.addMember(b, ex, 'Member', 0);
  const gone = repo.people.insert({ full_name: 'C Three' });
  repo.bodies.addMember(b, gone, 'Member');
  db.prepare("UPDATE body_members SET end_date = '2020-01-01' WHERE person_id = ?").run(gone);

  // Seats: A One, the ex-officio, and one free — so the holdover keeps voting.
  assert.equal(repo.bodies.isSeated(b, gone), true);

  const successor = repo.people.insert({ full_name: 'D Four' });
  repo.bodies.addMember(b, successor, 'Member');
  assert.equal(repo.bodies.isSeated(b, gone), false,
    'the ex-officio seat was not counted, so the holdover outlived their successor');
  assert.deepEqual(repo.bodies.votingRoll(b).map((r) => r.full_name), ['A One', 'D Four']);
});

test('the tally counts the same roll that admits the ballots', () => {
  const b = repo.bodies.insert({ name: 'Tally Body', type: 'Governing Body', seats: 5 });
  const ids = ['G', 'H', 'I'].map((n) => repo.people.insert({ full_name: `${n} Member` }));
  ids.forEach((id) => repo.bodies.addMember(b, id, 'Member'));
  const ex = repo.people.insert({ full_name: 'J Officio' });
  repo.bodies.addMember(b, ex, 'Member', 0);

  const mt = repo.meetings.insert({ body_id: b, meeting_date: '2026-08-10' });
  const m = repo.matters.insertNumbered({ type: 'Motion', title: 'Tally probe', status: 'Introduced', body_id: b });
  const item = repo.meetings.addItem({ meeting_id: mt, matter_id: m.id });
  db.prepare("UPDATE agenda_items SET vote_threshold = 'majority_full' WHERE id = ?").run(item);
  repo.voteAdmin.openRoll(item);
  repo.voteLedger.append(item, ids[0], 'Yea');
  repo.voteLedger.append(item, ids[1], 'Yea');
  repo.voteLedger.append(item, ids[2], 'Nay');

  const o = repo.eligibility.outcome(item, { throughSeq: null });
  // Three members entitled to vote; two of them in favour. The old base of
  // four (counting the ex-officio) required three and recorded this as Fail.
  assert.equal(o.eligible, 3, 'the denominator counted someone who cannot vote');
  assert.equal(o.required, 2);
  assert.equal(o.result, 'Pass', 'a motion carried 2-1 was recorded as failed');
});

// --- Retiring a governor -----------------------------------------------------
// Retirement is the ordinary way service ends, and it used to DELETE the
// body_members row — destroying the record that the governor ever sat, term
// dates and all. Their votes survived, keyed on the person, but "who sat on
// this body in March 2025" became unanswerable. The rest of the record works
// the other way round: a voided vote is struck and kept.

test('retiring a governor closes the term and keeps the seat on the record', () => {
  const b = repo.bodies.insert({ name: 'Retiring Body', type: 'Committee', seats: 3 });
  const p = repo.people.insert({ full_name: 'Retiring Governor' });
  const memberId = repo.bodies.addMember(b, p, 'Member');

  const motion = repo.memberMotions.nominate({
    action: 'remove', body_id: b, person_id: p, member_id: memberId,
    effective_date: '2026-03-31', cause: 'Retired', nominated_by: null,
  });
  repo.memberMotions.approve(motion, null, null);
  repo.memberMotions.complete(motion, null);

  const row = repo.bodies.memberById(memberId);
  assert.ok(row, 'the seat was deleted; the body can no longer say who served');
  assert.equal(row.end_date, '2026-03-31', 'the last day of service is the date given, not today');
  assert.equal(row.end_reason, 'Retired');
});

test('a retired governor leaves the roll, the quorum and the denominator', () => {
  const b = repo.bodies.insert({ name: 'Quorum Body', type: 'Committee', seats: 3 });
  const ids = ['P', 'Q', 'R'].map((n) => repo.people.insert({ full_name: `${n} Governor` }));
  const memberIds = ids.map((id) => repo.bodies.addMember(b, id, 'Member'));

  assert.equal(repo.bodies.votingRoll(b).length, 3);

  const motion = repo.memberMotions.nominate({
    action: 'remove', body_id: b, person_id: ids[2], member_id: memberIds[2],
    effective_date: '2020-01-01', cause: 'Retired', nominated_by: null,
  });
  repo.memberMotions.approve(motion, null, null);
  repo.memberMotions.complete(motion, null);

  // Three seats, two sitting: the retired member holds over only until someone
  // takes the seat, so the roll is unchanged until a successor arrives.
  assert.equal(repo.bodies.votingRoll(b).length, 3, 'a holdover should keep the seat while it is free');
  const successor = repo.people.insert({ full_name: 'S Governor' });
  repo.bodies.addMember(b, successor, 'Member');
  const roll = repo.bodies.votingRoll(b).map((r) => r.id);
  assert.equal(roll.includes(ids[2]), false, 'the retired governor kept a seat that was filled');
  assert.equal(roll.includes(successor), true);
  assert.equal(repo.bodies.isSeated(b, ids[2]), false, 'a retired governor could still be cast for');
});

test('the retirement form asks for the things the inline box could not', () => {
  const govern = require('../src/views/govern');
  const b = repo.bodies.insert({ name: 'Form Body', type: 'Committee', seats: 3 });
  const p = repo.people.insert({ full_name: 'Formal Governor' });
  const memberId = repo.bodies.addMember(b, p, 'Member');

  const page = govern.retireForm(repo.bodies.memberById(memberId), repo.bodies.get(b), { today: '2026-08-12' });
  assert.match(page, /Retire Formal Governor/);
  assert.match(page, /name="effective_date"/, 'the last day of service must be askable');
  assert.match(page, /name="cause"/, 'how the service ended must be a category, not a sentence');
  assert.match(page, /Retired/);
  // The word matters: this is usually an honourable exit, not a dismissal.
  assert.doesNotMatch(page, /Propose removal/);
  assert.match(page, /not deleted/, 'the form should say the record is preserved');
});

// --- Seating a governor ------------------------------------------------------
// The counterpart to retiring one. It used to grant a seat and record no term
// for it: addMember took neither date, so the dates were a separate inline
// form afterwards and a governor seated properly still had no start date until
// somebody remembered. The roll reads start_date to decide who was seated when.

test('seating a governor grants the term along with the seat', () => {
  const b = repo.bodies.insert({ name: 'Seating Body', type: 'Committee', seats: 5 });
  const p = repo.people.insert({ full_name: 'Incoming Governor' });

  const motion = repo.memberMotions.nominate({
    action: 'seat', body_id: b, person_id: p, seat_role: 'Member',
    effective_date: '2026-09-01', term_end_date: '2030-08-31',
    seat_voting: 1, nominated_by: null,
  });
  repo.memberMotions.approve(motion, null, null);
  repo.memberMotions.complete(motion, null);

  const seat = repo.bodies.members(b).find((m) => m.person_id === p);
  assert.ok(seat, 'nobody was seated');
  assert.equal(seat.start_date, '2026-09-01', 'the seat was granted with no start date');
  assert.equal(seat.end_date, '2030-08-31');
  assert.equal(seat.voting, 1);
});

test('an ex-officio seat is granted without a vote', () => {
  const b = repo.bodies.insert({ name: 'Ex Officio Body', type: 'Committee', seats: 4 });
  const voting = repo.people.insert({ full_name: 'Voting Governor' });
  const exo = repo.people.insert({ full_name: 'Ex Officio Attendee' });

  for (const [person, votes] of [[voting, 1], [exo, 0]]) {
    const m = repo.memberMotions.nominate({
      action: 'seat', body_id: b, person_id: person,
      seat_role: votes ? 'Member' : 'Ex-Officio',
      effective_date: '2026-01-01', seat_voting: votes, nominated_by: null,
    });
    repo.memberMotions.approve(m, null, null);
    repo.memberMotions.complete(m, null);
  }

  // They hold a seat; they are not in the arithmetic.
  const roll = repo.bodies.votingRoll(b).map((r) => r.id);
  assert.deepEqual(roll, [voting]);
  assert.equal(repo.bodies.isSeated(b, exo), false,
    'a ballot could be recorded for a seat that does not vote');
  assert.equal(repo.bodies.members(b).length, 2, 'the ex-officio seat should still exist');
});

test('a term that has not begun is not yet a seat on the roll', () => {
  const b = repo.bodies.insert({ name: 'Future Body', type: 'Committee', seats: 3 });
  const now = repo.people.insert({ full_name: 'Sitting Governor' });
  const later = repo.people.insert({ full_name: 'Governor Elect' });
  repo.bodies.addMember(b, now, 'Member', 1, { start_date: '2020-01-01' });
  repo.bodies.addMember(b, later, 'Member', 1, { start_date: '2099-01-01' });

  const roll = repo.bodies.votingRoll(b).map((r) => r.id);
  assert.deepEqual(roll, [now], 'a governor whose term has not started was counted');
  assert.equal(repo.bodies.isSeated(b, later), false);
});

test('the seating form asks for the term and the vote', () => {
  const govern = require('../src/views/govern');
  const page = govern.seatForm(
    [{ id: 1, name: 'Some Body' }], [{ value: 1, label: 'A Person' }], { today: '2026-08-14' },
  );
  assert.match(page, /Seat a governor/);
  assert.match(page, /name="effective_date"/, 'the term start must be granted with the seat');
  assert.match(page, /name="term_end_date"/, 'a fixed term must be recordable at appointment');
  assert.match(page, /name="seat_voting"/, 'whether the seat votes must be settled here');
  assert.match(page, /Nominate → Approve → Complete/);
});
