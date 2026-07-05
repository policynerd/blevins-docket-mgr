'use strict';

// Integration tests over a throwaway SQLite database. Each area exercises the
// repo layer the way the routes do; the DB file lives in the OS temp dir and
// is recreated per test run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-test-')), 'test.db');

const { init, db, ftsEnabled } = require('../src/db');
init();
const repo = require('../src/repo');
const auth = require('../src/auth');
const diff = require('../src/diff');
const { sanitizeHtml } = require('../src/sanitize');

// Minimal fixtures shared across tests.
const bodyId = repo.bodies.insert({ name: 'Test Board', type: 'Governing Body', seats: 3 });
const personId = repo.people.insert({ full_name: 'Pat Member', email: 'pat@test.gov' });
repo.bodies.addMember(bodyId, personId, 'Member');

test('file numbers: YYMMXX, receipt-ordered, collision-safe past 99', () => {
  const a = repo.matters.insertNumbered({ type: 'Ordinance', title: 'First', status: 'Draft' });
  assert.match(a.file_number, /^\d{6,}$/);
  const prefix = a.file_number.slice(0, 4);
  // Force the >99 boundary: verify numeric (not lexicographic) sequencing.
  db.prepare(`INSERT INTO matters (file_number, type, title, status) VALUES (?, 'Motion', 'x99', 'Draft')`)
    .run(prefix + '99');
  db.prepare(`INSERT INTO matters (file_number, type, title, status) VALUES (?, 'Motion', 'x100', 'Draft')`)
    .run(prefix + '100');
  const b = repo.matters.insertNumbered({ type: 'Motion', title: 'Next', status: 'Draft' });
  assert.equal(b.file_number, prefix + '101');
});

test('sessions: DB-backed, hashed, expiring, logout', () => {
  db.prepare(`INSERT INTO users (name, email, role) VALUES ('U', 'u@test.gov', 'clerk')`).run();
  const user = auth.findUserByEmail('u@test.gov');
  const sid = auth.createSession(user.id);
  // Raw sid must never be stored.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE sid_hash = ?').get(sid).n, 0);
  const fakeReq = { headers: { cookie: `docket_sid=${sid}` } };
  assert.equal(auth.currentUser(fakeReq).id, user.id);
  auth.logout(sid);
  assert.equal(auth.currentUser(fakeReq), null);
});

test('login throttling blocks after repeated failures', () => {
  for (let i = 0; i < 8; i++) auth.recordLoginFailure('1.2.3.4', 'x@y.z');
  assert.equal(auth.loginThrottled('1.2.3.4', 'x@y.z'), true);
  assert.equal(auth.loginThrottled('1.2.3.4', 'other@y.z'), false);
  auth.clearLoginFailures('1.2.3.4', 'x@y.z');
  assert.equal(auth.loginThrottled('1.2.3.4', 'x@y.z'), false);
});

test('FTS search finds words in body text; operators are inert', () => {
  if (!ftsEnabled()) return; // LIKE fallback environments
  const m = repo.matters.insertNumbered({ type: 'Resolution', title: 'Quiet title', status: 'Draft' });
  repo.matters.setBodyHtml(m.id, '<p>The xylophone procurement authorization</p>');
  assert.equal(repo.matters.search({ q: 'xylophone' }).length, 1);
  assert.equal(repo.matters.search({ q: 'xylo' }).length, 1); // prefix
  assert.doesNotThrow(() => repo.matters.search({ q: 'AND OR NEAR( "' }));
});

test('text versioning archives outgoing text and counts versions', () => {
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Versioned', status: 'Draft' });
  repo.matters.setBodyHtml(m.id, '<p>v1 text</p>');
  assert.equal(repo.matters.snapshotIfChanged(m.id, { body_html: '<p>v2 text</p>' }), true);
  repo.matters.setBodyHtml(m.id, '<p>v2 text</p>');
  assert.equal(repo.matters.snapshotIfChanged(m.id, { body_html: '<p>v2 text</p>' }), false); // no change
  const versions = repo.matters.versions(m.id);
  assert.equal(versions.length, 1);
  assert.match(versions[0].body_html, /v1 text/);
});

test('diff produces ins/del runs and safe html', () => {
  const html = diff.diffHtml('fee is ten dollars', 'fee is <b>twelve</b> dollars');
  assert.match(html, /<del class="df-del">ten <\/del>/);
  assert.match(html, /<ins class="df-ins">/);
  assert.ok(!html.includes('<b>')); // tokens escaped
});

test('public comments: pending until approved, tally counts positions', () => {
  const m = repo.matters.insertNumbered({ type: 'Motion', title: 'Commented', status: 'Draft' });
  const cid = repo.comments.add({ matter_id: m.id, name: 'Ada', body: 'Support this', position: 'Support' });
  assert.equal(repo.comments.approvedForMatter(m.id).length, 0);
  repo.comments.setStatus(cid, 'Approved');
  assert.equal(repo.comments.approvedForMatter(m.id).length, 1);
  assert.equal(repo.comments.tally(m.id).Support, 1);
});

test('budget: adopted amount + amendments + actuals roll up', () => {
  const bId = repo.budget.create({ fiscal_year: 'FY-T', status: 'Adopted' });
  const lineId = repo.budget.addLine({ budget_id: bId, name: 'Widgets', kind: 'Expense', amount: 1000 });
  repo.budget.addAmendment({ budget_line_id: lineId, amount: 250, note: 'supplemental' });
  repo.budget.addTransaction({ budget_line_id: lineId, tx_date: '2026-07-01', amount: 400 });
  const line = repo.budget.lineFull(lineId);
  assert.equal(line.amount, 1000);          // adopted untouched
  assert.equal(line.amended, 250);
  assert.equal(line.actual, 400);
  const sum = repo.budget.summary(bId);
  assert.equal(sum.expCurrent, 1250);
  assert.equal(sum.expRemaining, 850);
});

test('workflow routing: assignees and inbox scoping', () => {
  db.prepare(`INSERT INTO users (name, email, role) VALUES ('Assignee', 'a@test.gov', 'member')`).run();
  const assignee = auth.findUserByEmail('a@test.gov');
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Routed', status: 'Draft' });
  repo.workflow.start(m.id, [assignee.id]); // step 1 to assignee, rest unassigned
  assert.equal(repo.workflow.inboxFor(assignee.id, false).length, 1);
  assert.equal(repo.workflow.inboxFor(999, false).length, 0);
  const current = repo.workflow.current(m.id);
  repo.workflow.act(current.id, { status: 'Approved', userId: assignee.id });
  // Next step is unassigned: visible to clerks, not to the member.
  assert.equal(repo.workflow.inboxFor(assignee.id, false).length, 0);
  assert.ok(repo.workflow.inboxFor(assignee.id, true).length >= 1);
});

test('sanitizer strips scripts and event handlers, keeps allowed tags', () => {
  const out = sanitizeHtml('<p onclick="x()">ok</p><script>evil()</script><h2>t</h2><a href="javascript:x">l</a>');
  assert.ok(!/script|onclick|javascript:/i.test(out));
  assert.match(out, /<p>ok<\/p>/);
  assert.match(out, /<h2>t<\/h2>/);
});

test('terms & vacancies: expiring window and seat math', () => {
  const memberId = db.prepare('SELECT id FROM body_members WHERE body_id = ?').get(bodyId).id;
  repo.bodies.setMemberTerm(memberId, { start_date: '2024-01-01', end_date: '2026-08-01' });
  assert.ok(repo.bodies.expiringTerms(120).some((t) => t.id === memberId));
  const vac = repo.bodies.vacancies().find((v) => v.id === bodyId);
  assert.equal(vac.seats - vac.filled, 2); // 3 seats, 1 member
});

test('notifications: no-op unconfigured, queues when configured', () => {
  const notify = require('../src/notify');
  delete process.env.SMTP_HOST;
  notify.queue('x@y.z', 's', 'b');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mail_outbox').get().n, 0);
  process.env.SMTP_HOST = 'smtp.test';
  process.env.SMTP_FROM = 'from@test';
  notify.queue('x@y.z', 's', 'b');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mail_outbox').get().n, 1);
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
});
