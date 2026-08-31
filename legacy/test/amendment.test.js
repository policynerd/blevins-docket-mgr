'use strict';

// A motion, amended, and voted on twice.
//
// This is the thing the record could not do. `agenda_items` carries one
// motion_text, one mover, one threshold and one result, so a question that was
// moved, amended, and then adopted as amended could be recorded only as its
// final state: the minutes said what was adopted and never that it had been
// changed, by whom, or that the amendment was itself voted on first. The
// motion_versions table has existed since the vote ledger did and nothing
// wrote to it.
//
// What these tests hold in place is the one thing that makes the sequence
// safe: two rolls on one item must not contaminate each other. A member who
// voted Yea on the amendment and Nay on the measure as amended has answered
// two questions, not changed their mind, and each tally must count only the
// ballots cast on its own question.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amend-test-')), 'test.db');

const { init, db } = require('../src/db');
init();
const repo = require('../src/repo');

const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Body', seats: 5 });
const people = ['A', 'B', 'C', 'D', 'E'].map((n) =>
  repo.people.insert({ full_name: `${n} Governor`, email: `${n.toLowerCase()}@test.gov` }));
for (const id of people) repo.bodies.addMember(bodyId, id, 'Member', 1, {});

let seq = 0;
function newItem(title = 'A measure') {
  const meetingId = repo.meetings.insert({
    body_id: bodyId, meeting_date: `2026-11-${String(++seq).padStart(2, '0')}`,
  });
  const { id: matterId } = repo.matters.insertNumbered({
    type: 'Resolution', body_id: bodyId, status: 'On Agenda', title,
  });
  const itemId = repo.meetings.addItem({
    meeting_id: meetingId, matter_id: matterId, section: 'New Business', requires_vote: 1,
  });
  return { meetingId, matterId, itemId };
}

// Cast one choice per member, in order, so a test can say "3 Yea, 2 Nay".
function cast(itemId, choices) {
  choices.forEach((c, i) => repo.voteLedger.append(itemId, people[i], c, { source: 'CLERK_ENTRY' }));
}

test('the amendment and the measure as amended are two rolls that do not mix', () => {
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, {
    motionText: 'That Resolution 260802 be adopted', moverId: people[0], seconderId: people[1],
  });

  // The amendment: carried 4–1.
  const amendment = repo.motionVersions.amend(itemId, {
    motionText: 'That the resolution be amended by striking section 3',
    moverId: people[2], seconderId: people[3], kind: 'amendment',
  });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea', 'Yea', 'Nay']);
  assert.equal(repo.voteAdmin.closeRoll(itemId).result, 'Pass');

  // The main question, as amended: two for, two against, and one member who
  // voted on the amendment does not vote on the measure at all.
  //
  // That last member is the case that discriminates. Bounding the window by
  // sequence alone gets the arithmetic right whenever everybody votes twice,
  // because the second ballot supersedes the first — but a member who votes
  // once has nothing superseding their amendment ballot, so it is read into
  // the vote on the measure. Their Yea on striking section 3 would be counted
  // as a Yea on adopting the resolution, which they never cast.
  const main = repo.motionVersions.amend(itemId, {
    motionText: 'That Resolution 260802 be adopted as amended',
    moverId: people[0], seconderId: people[1], kind: 'main',
  });
  repo.voteAdmin.reopen(itemId);
  cast(itemId, ['Yea', 'Yea', 'Nay', 'Nay']);
  assert.equal(repo.voteAdmin.closeRoll(itemId).result, 'Fail');

  // Each version keeps its own result.
  assert.equal(repo.motionVersions.get(amendment.id).result, 'Pass');
  assert.equal(repo.motionVersions.get(main.id).result, 'Fail');

  // And each tally counts only its own ballots. Without the version window the
  // second roll would read the first roll's four Yeas and carry a measure the
  // body defeated.
  const onAmendment = repo.voteLedger.current(itemId, { motionVersionId: amendment.id });
  const onMain = repo.voteLedger.current(itemId, { motionVersionId: main.id });
  assert.equal([...onAmendment.values()].filter((e) => e.choice === 'Yea').length, 4);
  assert.equal([...onMain.values()].filter((e) => e.choice === 'Yea').length, 2);
  assert.equal(onMain.size, 4, 'the member who did not vote on the measure did not vote');
  assert.equal(onMain.has(people[4]), false,
    'a ballot cast on the amendment was counted on the measure');
});

test('voting the other way on the second question is not changing a vote', () => {
  // A ballot on a new question supersedes nothing. Reading the standing
  // position across versions would file the second ballot as a retraction of
  // the first, and the ledger would show a member who "changed their vote"
  // when they did no such thing.
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  const a = repo.motionVersions.amend(itemId, { motionText: 'That it be amended' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea']);
  repo.voteAdmin.closeRoll(itemId);

  repo.motionVersions.amend(itemId, { motionText: 'That it be adopted as amended', kind: 'main' });
  repo.voteAdmin.reopen(itemId);
  cast(itemId, ['Nay']);

  const ballots = repo.voteLedger.forItem(itemId)
    .filter((e) => e.event_type === 'VOTE_CAST' || e.event_type === 'VOTE_CHANGED');
  assert.equal(ballots.length, 2);
  assert.ok(ballots.every((e) => e.event_type === 'VOTE_CAST'),
    'answering a second question is not a change of vote');
  assert.ok(ballots.every((e) => !e.supersedes_event_id));
  // The amendment's Yea still stands.
  assert.equal(repo.voteLedger.current(itemId, { motionVersionId: a.id }).get(people[0]).choice, 'Yea');
});

test('putting the main question does not retract the amendment', () => {
  // reopen() strips certification and voids the matter's history rows for the
  // superseded outcome. The amendment's result is not superseded by the vote
  // that follows it — the body did vote on the amendment, and that stands.
  const { itemId, matterId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  const a = repo.motionVersions.amend(itemId, { motionText: 'That it be amended' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  repo.voteAdmin.closeRoll(itemId);
  const historyBefore = repo.matters.history(matterId).length;

  repo.motionVersions.amend(itemId, { motionText: 'That it be adopted as amended', kind: 'main' });
  const r = repo.voteAdmin.reopen(itemId);
  assert.equal(r.reopened, false, 'this is a new question, not a reopening');
  assert.equal(repo.motionVersions.get(a.id).result, 'Pass', 'the amendment carried and still has');
  assert.equal(repo.matters.history(matterId).length, historyBefore,
    'nothing in the file\'s history was voided');
});

test('reopening the same question is still a reopening', () => {
  // The distinction must not swallow the case it was carved out of: with no
  // new motion put, reopening retracts as it always did.
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  repo.voteAdmin.closeRoll(itemId);
  assert.equal(repo.voteAdmin.reopen(itemId).reopened, true);
});

test('a reopened roll re-reads the ballots of the question it is on', () => {
  // Reopening to correct one member's vote must not make the clerk re-enter
  // every other. Same version, same ballots.
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Nay']);
  repo.voteAdmin.closeRoll(itemId);
  repo.voteAdmin.reopen(itemId);
  const standing = repo.voteLedger.current(itemId, { throughSeq: null });
  assert.equal(standing.size, 3, 'the ballots already cast are still standing');
  // Correcting one is a change of vote, because it is the same question.
  repo.voteLedger.append(itemId, people[2], 'Yea', { source: 'CLERK_ENTRY' });
  const changed = repo.voteLedger.forItem(itemId).filter((e) => e.event_type === 'VOTE_CHANGED');
  assert.equal(changed.length, 1);
});

test('an item with no motion recorded votes exactly as it always did', () => {
  // Every item in the record predates this. None has a motion version, and
  // none may start windowing differently because the feature now exists.
  const { itemId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea', 'Nay', 'Nay']);
  const outcome = repo.voteAdmin.closeRoll(itemId);
  assert.equal(outcome.result, 'Pass');
  assert.equal(outcome.yea, 3);
  assert.equal(repo.voteLedger.current(itemId).size, 5);
});

test('a motion replaced before the question was put is still recorded', () => {
  // A substitute replaces the question itself. The motion it displaced took no
  // roll and is superseded — not deleted: the record of a meeting includes
  // what was moved and given up on.
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.motionVersions.amend(itemId, {
    motionText: 'That it be referred to committee', kind: 'substitute' });
  const all = repo.motionVersions.all(itemId);
  assert.equal(all.length, 2);
  assert.ok(all[0].superseded_at, 'a motion that took no roll is superseded, not deleted');
  assert.equal(all[0].motion_text, 'That it be adopted');
  assert.equal(repo.motionVersions.narrative(itemId)[0].outcome,
    'Withdrawn before the question was put');
});

test('an amendment does not withdraw the motion it amends', () => {
  // Marking the main motion superseded the moment an amendment was moved made
  // the minutes read "Main motion: … Withdrawn before the question was put",
  // which is the opposite of what happened: the body was about to vote on it,
  // as amended. An amendment is subsidiary to the question, not a replacement
  // for it.
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.motionVersions.amend(itemId, { motionText: 'That it be amended', kind: 'amendment' });
  const all = repo.motionVersions.all(itemId);
  assert.equal(all[0].superseded_at, null, 'the main motion is still pending');
  assert.equal(repo.motionVersions.narrative(itemId)[0].outcome, null,
    'and nothing is claimed about its fate');
});

test('a motion the body amended is not reported as withdrawn', () => {
  // Putting the main question as amended does supersede the version first
  // moved — but what happened to it was that it was amended, and the amendment
  // is right there in the sequence saying so.
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.motionVersions.amend(itemId, { motionText: 'That it be amended', kind: 'amendment' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  repo.voteAdmin.closeRoll(itemId);
  repo.motionVersions.amend(itemId, {
    motionText: 'That it be adopted as amended', kind: 'main' });

  const seq = repo.motionVersions.narrative(itemId);
  assert.ok(repo.motionVersions.all(itemId)[0].superseded_at, 'it was replaced');
  assert.equal(seq[0].outcome, null, 'but not withdrawn');
  assert.equal(seq[1].outcome, 'Carried');
});

test('the sequence names who moved and who seconded each version', () => {
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, {
    motionText: 'That it be adopted', moverId: people[0], seconderId: people[1] });
  repo.motionVersions.amend(itemId, {
    motionText: 'That it be amended', moverId: people[2], seconderId: people[3] });
  const all = repo.motionVersions.all(itemId);
  assert.equal(all[0].mover_name, 'A Governor');
  assert.equal(all[0].seconder_name, 'B Governor');
  assert.equal(all[1].mover_name, 'C Governor');
  assert.equal(all[1].seconder_name, 'D Governor');
});

test('every version and every roll is in the hash-chained record', () => {
  const { meetingId, itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.motionVersions.amend(itemId, { motionText: 'That it be amended' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  repo.voteAdmin.closeRoll(itemId);

  const types = repo.voteLedger.forMeeting(meetingId).map((e) => e.event_type);
  assert.ok(types.includes('MOTION_CREATED'), 'the motion as moved');
  assert.ok(types.includes('MOTION_AMENDED'), 'and as amended');
  assert.equal(repo.voteLedger.verify(meetingId).ok, true);
});

test('the ledger column and the hashed payload agree about the motion', () => {
  // The column is an index over what the payload already carried. If they can
  // drift, windowing by the column stops being a claim the hash protects.
  const { itemId } = newItem();
  const v = repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea']);
  for (const e of repo.voteLedger.forItem(itemId)) {
    const payload = JSON.parse(e.payload_json);
    if (payload.motionVersionId === undefined) continue;
    assert.equal(e.motion_version_id ?? null, payload.motionVersionId ?? null,
      `${e.event_type} disagrees with its own payload`);
  }
  assert.equal(repo.voteLedger.current(itemId).get(people[0]).motion_version_id, v.id);
});

// --- When a new question may be put -------------------------------------------

test('a question may be replaced before anybody has voted on it', () => {
  // The chair opens the roll; a member moves to amend before a single ballot
  // is cast. Ordinary, and nothing is lost by putting the new question.
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.voteAdmin.openRoll(itemId);
  const v = repo.motionVersions.amend(itemId, { motionText: 'That it be amended' });
  assert.equal(v.seq, 2);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  assert.equal(repo.voteAdmin.closeRoll(itemId).result, 'Pass');
  assert.equal(repo.motionVersions.get(v.id).result, 'Pass');
});

test('a question members have already voted on is not replaced under them', () => {
  // A new version windows the existing ballots out of every tally: they would
  // stay in the ledger and be counted by nothing. Voiding is the way to
  // abandon a question, and it leaves a reason on the record.
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea']);
  assert.throws(
    () => repo.motionVersions.amend(itemId, { motionText: 'That it be amended' }),
    /already voted/i);
  assert.equal(repo.motionVersions.all(itemId).length, 1, 'and no version was created');
});

test('voiding the roll frees the question to be replaced', () => {
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea']);
  repo.voteAdmin.void(itemId, { reason: 'An amendment was moved before the question was put' });
  const v = repo.motionVersions.amend(itemId, { motionText: 'That it be amended' });
  assert.equal(v.seq, 2);
});

test('voiding lets the motion be restated rather than refusing it as decided', () => {
  // void() clears the item's result. It has to clear the version's too, or the
  // next attempt to state the motion is refused as an edit to something
  // already voted on — a vote the board has said did not happen.
  const { itemId } = newItem();
  repo.motionVersions.ensure(itemId, { motionText: 'That it be adopted' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  repo.voteAdmin.closeRoll(itemId);
  repo.voteAdmin.void(itemId, { reason: 'Wrong item called' });
  const v = repo.motionVersions.ensure(itemId, { motionText: 'That it be referred' });
  assert.equal(v.motion_text, 'That it be referred');
  assert.equal(v.result, null);
});

// --- What the console is told --------------------------------------------------

test('the live snapshot carries the whole motion sequence', () => {
  // The console reading the item alone shows the final wording with nothing
  // saying it was ever anything else — and the clerk taking the second roll
  // cannot see the result of the first.
  const live = require('../src/live');
  const { meetingId, itemId } = newItem();
  repo.motionVersions.ensure(itemId, {
    motionText: 'That it be adopted', moverId: people[0], seconderId: people[1] });
  repo.motionVersions.amend(itemId, {
    motionText: 'That it be amended', moverId: people[2], kind: 'amendment' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  repo.voteAdmin.closeRoll(itemId);

  const snap = live.snapshot(meetingId);
  assert.equal(snap.active.id, itemId);
  const ms = snap.active.motions;
  assert.equal(ms.length, 2);
  assert.equal(ms[0].kind, 'main');
  assert.equal(ms[0].superseded, false, 'an amendment does not withdraw the main motion');
  assert.equal(ms[0].current, true, 'which is still pending before the body');
  assert.equal(ms[1].kind, 'amendment');
  assert.equal(ms[1].result, 'Pass');
  assert.equal(ms[1].mover, 'C Governor');
});

// --- Voiding, and what it stops counting --------------------------------------

test('a voided vote stops counting, and stays in the record', () => {
  // void() cleared the mutable `votes` projection and left the ledger
  // projection — which is what every screen and the outcome arithmetic
  // actually read — untouched. So a clerk voided a vote, the item's result
  // went to null, and the roster went on showing every member's Yea while the
  // outcome bar projected "Passes". The Board had said the vote did not
  // happen and the board on the wall disagreed.
  const { itemId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  repo.voteAdmin.closeRoll(itemId);
  assert.equal(repo.voteLedger.current(itemId).size, 3);

  repo.voteAdmin.void(itemId, { reason: 'Wrong item called' });
  assert.equal(repo.voteLedger.current(itemId).size, 0, 'a struck ballot does not project');
  assert.deepEqual(repo.eligibility.forItem(itemId).roll.map((r) => r.choice),
    people.map(() => null), 'and no member is left on record for it');
  assert.equal(repo.meetings.getItem(itemId).result, null);

  // And the account of what happened is untouched.
  const ballots = repo.voteLedger.forItem(itemId)
    .filter((e) => e.event_type === 'VOTE_CAST' || e.event_type === 'VOTE_CHANGED');
  assert.equal(ballots.length, 3, 'the ledger keeps what happened');
  assert.equal(repo.voteLedger.verifyItem(itemId).ok, true);
});

test('the striking of a vote is its own kind of event', () => {
  // This borrowed CORRECTION_APPROVED because there was nothing else, which
  // left striking a vote indistinguishable from an approved minutes
  // correction — and left nothing for the projection to key on.
  const { meetingId, itemId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea']);
  repo.voteAdmin.void(itemId, { reason: 'Called in error' });
  const voided = repo.voteLedger.forMeeting(meetingId).filter((e) => e.event_type === 'VOTE_VOIDED');
  assert.equal(voided.length, 1);
  assert.equal(JSON.parse(voided[0].payload_json).reason, 'Called in error');
  assert.equal(repo.voteLedger.verify(meetingId).ok, true);
});

test('a fresh roll after a void counts its own ballots', () => {
  // The void bounds the ballots before it. It must not bound the ones after,
  // or an item voided once could never be voted again.
  const { itemId } = newItem();
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Nay', 'Nay', 'Nay']);
  repo.voteAdmin.void(itemId, { reason: 'Wrong item called' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  const outcome = repo.voteAdmin.closeRoll(itemId);
  assert.equal(outcome.yea, 3);
  assert.equal(outcome.nay, 0, 'the struck ballots did not come back');
  assert.equal(outcome.result, 'Pass');
});

// --- What the printed record says ---------------------------------------------

test('the minutes record the sequence, not only the surviving wording', () => {
  // This is what minutes are for, and it is why a clerk still typed this part
  // by hand: an item carries one motion_text, so a measure moved, amended and
  // adopted as amended appeared as its final wording with nothing saying it
  // had ever been anything else — no amendment, no mover for it, and no
  // record that it was voted on first.
  const minutes = require('../src/minutes');
  const { meetingId, itemId } = newItem('A measure of some substance');
  repo.motionVersions.ensure(itemId, {
    motionText: 'That the measure be adopted', moverId: people[0], seconderId: people[1] });
  repo.motionVersions.amend(itemId, {
    motionText: 'That the measure be amended by striking section 3',
    moverId: people[2], seconderId: people[3], kind: 'amendment' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea', 'Yea', 'Nay']);
  repo.voteAdmin.closeRoll(itemId);
  repo.motionVersions.amend(itemId, {
    motionText: 'That the measure be adopted as amended',
    moverId: people[0], seconderId: people[1], kind: 'main' });
  repo.voteAdmin.reopen(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea', 'Nay', 'Nay']);
  repo.voteAdmin.closeRoll(itemId);

  const html = minutes.generate(meetingId);
  assert.match(html, /striking section 3/, 'the amendment is in the minutes');
  assert.match(html, /Moved by C Governor, seconded by D Governor/,
    'and who moved it');
  assert.match(html, /adopted as amended/, 'and the question as it was finally put');
  assert.match(html, /Amendment:/);
  assert.match(html, /Main motion:/);
  // Both rolls, with their own arithmetic.
  assert.match(html, /Yea 4/);
  assert.match(html, /Yea 3/);
});

test('the minutes say an item was laid on the table', () => {
  // A tabled item was indistinguishable from one the meeting never got to:
  // both printed a heading and then nothing. The body decided about one.
  const minutes = require('../src/minutes');
  const { meetingId, itemId } = newItem('Deferred business');
  repo.voteAdmin.table(itemId, { reason: 'Pending counsel review' });
  const html = minutes.generate(meetingId);
  assert.match(html, /Laid on the table/);
  assert.match(html, /Pending counsel review/);
});

test('an unamended item still reads as one motion, not a sequence of one', () => {
  const minutes = require('../src/minutes');
  const { meetingId, itemId } = newItem('Ordinary business');
  repo.motionVersions.ensure(itemId, {
    motionText: 'That it be adopted', moverId: people[0], seconderId: people[1] });
  repo.meetings.setMotion(itemId, {
    mover_id: people[0], seconder_id: people[1], motion_text: 'That it be adopted' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  repo.voteAdmin.closeRoll(itemId);
  const html = minutes.generate(meetingId);
  assert.match(html, /Motion: That it be adopted/);
  assert.doesNotMatch(html, /Main motion:/, 'no elaborate way of saying "one motion"');
});

test('a motion is punctuated once, wherever it is printed', () => {
  // narrative() gives a motion the full stop clerks do not type, and the
  // minutes added another: "That it be adopted.. Moved by Ada Governor."
  const minutes = require('../src/minutes');
  const { meetingId, itemId } = newItem('Punctuation');
  repo.motionVersions.ensure(itemId, {
    motionText: 'That it be adopted', moverId: people[0] });
  repo.motionVersions.amend(itemId, { motionText: 'That it be amended', kind: 'amendment' });
  repo.voteAdmin.openRoll(itemId);
  cast(itemId, ['Yea', 'Yea', 'Yea']);
  repo.voteAdmin.closeRoll(itemId);

  const html = minutes.generate(meetingId);
  assert.doesNotMatch(html, /\.\./, 'no double full stop');
  assert.match(html, /That it be adopted\. Moved by A Governor\./);

  // A motion the clerk did punctuate is not given a second one either.
  const other = newItem('Already punctuated');
  repo.motionVersions.ensure(other.itemId, { motionText: 'That it be adopted.' });
  repo.motionVersions.amend(other.itemId, { motionText: 'That it be amended.' });
  assert.equal(repo.motionVersions.narrative(other.itemId)[0].text, 'That it be adopted.');
});
