'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kind-')), 'test.db');
const { init } = require('../src/db');
init();
const repo = require('../src/repo');
const kind = require('../src/procedure-kind');
kind.install();

const bodyId = repo.bodies.insert({ name: 'Board', type: 'Primary Legislative Body', seats: 5 });
const meetingId = repo.meetings.insert({ body_id: bodyId, meeting_date: '2026-09-14' });

test('an information item cannot open a roll and is received instead', () => {
  const id = repo.meetings.addItem({
    meeting_id: meetingId, title: 'Director briefing', item_type: 'Information',
  });
  assert.equal(repo.meetings.getItem(id).requires_vote, 0);
  assert.throws(() => repo.voteAdmin.openRoll(id), /received, not put/);
  const out = kind.receive(id);
  assert.equal(out.result, 'Received');
  assert.equal(out.vote_status, 'closed');
});

test('a discussion item is heard, not rolled', () => {
  const id = repo.meetings.addItem({
    meeting_id: meetingId, title: 'Workshop', item_type: 'Discussion',
  });
  assert.throws(() => repo.voteAdmin.openRoll(id), /heard, not put/);
  assert.equal(kind.receive(id).result, 'Heard');
});

test('an action item still opens a roll', () => {
  const id = repo.meetings.addItem({
    meeting_id: meetingId, title: 'Adopt the fee', item_type: 'Action', requires_vote: 1,
  });
  assert.equal(repo.voteAdmin.openRoll(id).vote_status, 'open');
});
