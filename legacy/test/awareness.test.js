'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aware-')), 'test.db');

const { init, db } = require('../src/db');
init();
const repo = require('../src/repo');
const awareness = require('../src/awareness');

const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Board' });
const { id: matterId } = repo.matters.insertNumbered({
  title: 'Awareness test file',
  type: 'Resolution',
  status: 'Introduced',
  body_id: bodyId,
  intro_date: '2026-09-01',
});
const matter = repo.matters.get(matterId);
db.prepare('UPDATE matters SET published_at = datetime(\'now\') WHERE id = ?').run(matterId);

const clerkId = Number(db.prepare(
  `INSERT INTO users (name, email, role) VALUES (?,?,?)`
).run('Clerk', 'clerk-aware@board.gov', 'clerk').lastInsertRowid);

test('recent actions include a recorded history row', () => {
  repo.matters.addHistory({
    matter_id: matterId,
    action_date: '2026-09-10',
    action: 'Introduced',
    body_id: bodyId,
    result: null,
  });
  const acts = awareness.recentActions({ publicOnly: true });
  assert.ok(acts.some((a) => a.file_number === matter.file_number && a.action === 'Introduced'));
});

test('a watch is moved only after a later action', () => {
  repo.watches.toggle(clerkId, matterId);
  const before = awareness.watchesFor(clerkId).find((w) => w.id === matterId);
  assert.ok(before);
  assert.equal(awareness.movedSinceWatch({
    last_action_date: '2026-01-01',
    watched_at: '2026-09-10T00:00:00',
  }), false);
  assert.equal(awareness.movedSinceWatch({
    last_action_date: '2026-09-11',
    watched_at: '2026-09-10T00:00:00',
  }), true);
});

test('desk for a clerk reports the watch list', () => {
  const desk = awareness.desk({ id: clerkId, role: 'clerk', name: 'Clerk' });
  assert.ok(desk.watches.length >= 1);
  assert.ok(Array.isArray(desk.recent));
});
