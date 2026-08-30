'use strict';

// The consent calendar.
//
// A board disposing of twelve routine items ran twelve roll calls, because a
// roll is opened on an agenda item and there was no way to say "these twelve,
// together". The Consent Agenda section had existed from the beginning — items
// could be filed under it, and then still had to be voted one at a time.
//
// The design these tests pin down: the group is itself an agenda item, so
// there is exactly one roll, in the ledger, on one item, under one threshold,
// with one certification. What the group adds is that closing that roll
// disposes of every item pointing at it. Nothing about how a vote is recorded
// changes; what changes is how many items one recorded vote settles.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'consent-test-')), 'test.db');

const { init } = require('../src/db');
init();
const repo = require('../src/repo');

const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Body', seats: 5 });
const people = ['A', 'B', 'C', 'D', 'E'].map((n) =>
  repo.people.insert({ full_name: `${n} Governor`, email: `${n.toLowerCase()}@test.gov` }));
for (const id of people) repo.bodies.addMember(bodyId, id, 'Member', 1, {});

let meetingSeq = 0;
function newMeeting(itemCount) {
  const meetingId = repo.meetings.insert({
    body_id: bodyId, meeting_date: `2026-09-${String(++meetingSeq).padStart(2, '0')}`,
  });
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    const { id: matterId } = repo.matters.insertNumbered({
      type: 'Resolution', body_id: bodyId, status: 'On Agenda', title: `Routine item ${i + 1}`,
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

test('grouping creates one calendar item that the others point at', () => {
  const { meetingId, items } = newMeeting(4);
  const group = repo.meetings.groupIntoConsent(meetingId, items.slice(0, 3));
  assert.ok(group, 'a group should be created');
  assert.equal(group.is_consent_group, 1);
  assert.equal(group.section, 'Consent Agenda');

  const members = repo.meetings.consentMembers(group.id);
  assert.equal(members.length, 3);
  assert.deepEqual(members.map((m) => m.id).sort(), items.slice(0, 3).sort());
  // The fourth is untouched.
  assert.equal(repo.meetings.getItem(items[3]).consent_group_id, null);
});

test('a second grouping joins the calendar that is already there', () => {
  const { meetingId, items } = newMeeting(4);
  const first = repo.meetings.groupIntoConsent(meetingId, [items[0]]);
  const second = repo.meetings.groupIntoConsent(meetingId, [items[1], items[2]]);
  assert.equal(second.id, first.id, 'should reuse the open calendar, not open a second');
  assert.equal(repo.meetings.consentMembers(first.id).length, 3);
});

test('one roll disposes of every item on the calendar', () => {
  const { meetingId, items } = newMeeting(3);
  const group = repo.meetings.groupIntoConsent(meetingId, items);

  repo.voteAdmin.openRoll(group.id);
  carry(group.id, 'Yea');
  const outcome = repo.voteAdmin.closeRoll(group.id);
  assert.equal(outcome.result, 'Pass');

  for (const id of items) {
    const it = repo.meetings.getItem(id);
    assert.equal(it.result, 'Pass', 'each carried item takes the calendar result');
    assert.ok(it.result_computed_at, 'and is stamped as decided');
    assert.match(it.action, /consent calendar/i,
      'the action names how it was decided, not just that it was');
  }
  // Exactly one roll, on the group.
  const opened = repo.voteLedger.forMeeting(meetingId)
    .filter((e) => e.event_type === 'ROLL_OPENED');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].agenda_item_id, group.id);
});

test('a failed calendar carries the failure to every item on it', () => {
  const { meetingId, items } = newMeeting(2);
  const group = repo.meetings.groupIntoConsent(meetingId, items);
  repo.voteAdmin.openRoll(group.id);
  carry(group.id, 'Nay');
  assert.equal(repo.voteAdmin.closeRoll(group.id).result, 'Fail');
  for (const id of items) assert.equal(repo.meetings.getItem(id).result, 'Fail');
});

test('an item on the calendar cannot have its own roll opened', () => {
  // Two rolls on one item would leave two results with nothing saying which
  // governs. Take it off the calendar to consider it separately.
  const { meetingId, items } = newMeeting(2);
  repo.meetings.groupIntoConsent(meetingId, items);
  assert.throws(() => repo.voteAdmin.openRoll(items[0]), /consent calendar/i);
  assert.throws(() => repo.voteAdmin.reopen(items[0]), /consent calendar/i);
});

test('refusing to reopen a calendared item destroys nothing first', () => {
  // reopen() retracts the previous outcome before it opens anything, so the
  // guard has to come before that: a refusal that has already voided history
  // is not a refusal.
  const { meetingId, items } = newMeeting(2);
  const group = repo.meetings.groupIntoConsent(meetingId, items);
  repo.voteAdmin.openRoll(group.id);
  carry(group.id, 'Yea');
  repo.voteAdmin.closeRoll(group.id);

  const before = repo.meetings.getItem(items[0]).result;
  assert.throws(() => repo.voteAdmin.reopen(items[0]), /consent calendar/i);
  assert.equal(repo.meetings.getItem(items[0]).result, before, 'result survives the refusal');
});

test('taking the last item off removes the empty calendar', () => {
  const { meetingId, items } = newMeeting(2);
  const group = repo.meetings.groupIntoConsent(meetingId, [items[0]]);
  repo.meetings.ungroupConsent(items[0]);
  assert.equal(repo.meetings.getItem(group.id), undefined,
    'an empty calendar is furniture, not a record');
  assert.equal(repo.meetings.getItem(items[0]).consent_group_id, null);
});

test('a voted calendar survives having its items taken off', () => {
  // After a roll the calendar is part of the record and must not vanish.
  const { meetingId, items } = newMeeting(2);
  const group = repo.meetings.groupIntoConsent(meetingId, items);
  repo.voteAdmin.openRoll(group.id);
  carry(group.id, 'Yea');
  repo.voteAdmin.closeRoll(group.id);
  repo.meetings.ungroupConsent(items[0]);
  repo.meetings.ungroupConsent(items[1]);
  assert.ok(repo.meetings.getItem(group.id), 'the calendar that took the vote stays');
});

test('an already-decided item is not swept onto a calendar', () => {
  const { meetingId, items } = newMeeting(2);
  repo.voteAdmin.openRoll(items[0]);
  carry(items[0], 'Yea');
  repo.voteAdmin.closeRoll(items[0]);

  repo.meetings.groupIntoConsent(meetingId, items);
  assert.equal(repo.meetings.getItem(items[0]).consent_group_id, null,
    'a decided item must not be folded into a fresh roll');
  assert.ok(repo.meetings.getItem(items[1]).consent_group_id,
    'the undecided one still groups');
});

test('calendars do not nest', () => {
  const { meetingId, items } = newMeeting(3);
  const group = repo.meetings.groupIntoConsent(meetingId, [items[0], items[1]]);
  repo.meetings.groupIntoConsent(meetingId, [group.id, items[2]]);
  assert.equal(repo.meetings.getItem(group.id).consent_group_id, null,
    'a calendar cannot be put on a calendar');
});

test('grouping nothing does nothing', () => {
  const { meetingId } = newMeeting(1);
  assert.equal(repo.meetings.groupIntoConsent(meetingId, []), null);
  assert.equal(repo.meetings.items(meetingId).filter((i) => i.is_consent_group).length, 0,
    'no empty calendar is created for an empty selection');
});
