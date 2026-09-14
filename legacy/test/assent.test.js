'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'assent-')), 'test.db');
const { init } = require('../src/db');
init();
const repo = require('../src/repo');
require('../src/assent');

const { id } = repo.matters.insertNumbered({
  type: 'Resolution', title: 'A quiet assent', status: 'Introduced',
});

test('assent is refused until the body has passed the file', () => {
  assert.throws(() => repo.matters.assent(id, { actorName: 'Chair' }), /has not passed/);
});

test('assent after a pass enacts the file and names the source', () => {
  repo.matters.setStatus(id, 'Passed');
  const out = repo.matters.assent(id, { actorId: null, actorName: 'Chair' });
  assert.equal(out.status, 'Enacted');
  assert.ok(out.assented_at);
  assert.equal(out.assented_by_name, 'Chair');
  const hist = repo.matters.history(id);
  assert.ok(hist.some((h) => h.action === 'Assented'));
});

test('a second assent does not overwrite the first', () => {
  assert.throws(() => repo.matters.assent(id, { actorName: 'Someone else' }), /Already assented/);
});
