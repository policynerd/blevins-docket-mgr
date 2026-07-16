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

test('budget CSV: appropriation & project codes round-trip through import/export', () => {
  const importer = require('../src/import');
  const feeds = require('../src/exports');
  const bId = repo.budget.create({ fiscal_year: 'FY-CSV', status: 'Adopted' });
  const csv = 'category,name,kind,amount,appropriation_code,project_code\n' +
    'Ops,Paving,Expense,50000,100-4200-51000,CIP-2027-014\n';
  const res = importer.importBudgetLines(bId, csv);
  assert.equal(res.created, 1);
  const paving = repo.budget.lines(bId).find((l) => l.name === 'Paving');
  assert.equal(paving.appropriation_code, '100-4200-51000');
  assert.equal(paving.project_code, 'CIP-2027-014');
  // Export carries the same columns/values, so a re-import preserves the codes.
  const out = feeds.budgetCsv({ fiscal_year: 'FY-CSV' }, repo.budget.lines(bId));
  assert.match(out.split('\r\n')[0], /appropriation_code,project_code/);
  assert.match(out, /100-4200-51000,CIP-2027-014/);
});

test('appropriation ledger: rolls up budgeted/committed/spent and lists contributors', () => {
  const bId = repo.budget.create({ fiscal_year: 'FY-APP', status: 'Adopted' });
  const l1 = repo.budget.addLine({ budget_id: bId, name: 'Paving', kind: 'Expense', amount: 100000, appropriation_code: 'APP-1' });
  repo.budget.addLine({ budget_id: bId, name: 'Signals', kind: 'Expense', amount: 50000, appropriation_code: 'APP-1' });
  repo.budget.addLine({ budget_id: bId, name: 'Uncoded', kind: 'Expense', amount: 9999 }); // no code → excluded
  repo.budget.addTransaction({ budget_line_id: l1, tx_date: '2027-01-05', amount: 40000 });
  const m = repo.matters.insertNumbered({ type: 'Contract', title: 'Paving contract', status: 'Draft' });
  repo.matters.setFiscal(m.id, { fiscal_impact: 90000, budget_line_id: l1 });
  const sol = repo.procurement.create({ kind: 'IFB', title: 'Road paving', status: 'Open', budget_line_id: l1 });

  const roll = repo.budget.appropriationRollup().find((r) => r.code === 'APP-1');
  assert.equal(roll.line_count, 2);
  assert.equal(roll.adopted, 150000);
  assert.equal(roll.committed, 90000);
  assert.equal(roll.actual, 40000);
  assert.ok(!repo.budget.appropriationRollup().some((r) => r.code == null)); // uncoded excluded

  const det = repo.budget.appropriationDetail('APP-1');
  assert.equal(det.lines.length, 2);
  assert.equal(det.contracts.length, 1);
  assert.equal(det.contracts[0].file_number, m.file_number);
  assert.equal(det.solicitations.length, 1);
  assert.equal(det.solicitations[0].number, sol.number);
});

test('vendor findOrCreate backfills a missing email but never overwrites one', () => {
  const id1 = repo.vendors.findOrCreate('Backfill Co'); // no email
  assert.equal(repo.vendors.get(id1).email, null);
  const id2 = repo.vendors.findOrCreate('Backfill Co', 'contact@backfill.test');
  assert.equal(id2, id1);                                       // same vendor
  assert.equal(repo.vendors.get(id2).email, 'contact@backfill.test'); // backfilled
  repo.vendors.findOrCreate('Backfill Co', 'other@backfill.test');
  assert.equal(repo.vendors.get(id1).email, 'contact@backfill.test'); // not overwritten
});

test('procurement CSV exports carry headers and rows', () => {
  const feeds = require('../src/exports');
  const sol = repo.procurement.create({ kind: 'RFP', title: 'Export test', status: 'Open' });
  repo.procurement.addBid({ solicitation_id: sol.id, vendor_name: 'Bidder A', email: 'a@x.test', amount: 1000 });
  const list = feeds.solicitationsCsv(repo.procurement.list({ includeAll: true }));
  assert.match(list.split('\r\n')[0], /^number,kind,title,status/);
  const bids = feeds.bidsCsv(repo.procurement.get(sol.id), repo.procurement.bids(sol.id));
  assert.match(bids.split('\r\n')[0], /^solicitation,vendor,email,amount,note/);
  assert.match(bids, /Bidder A/);
});

test('TAS register: import upserts, searches, enriches, and round-trips CSV', () => {
  const imp = require('../src/import');
  const feeds = require('../src/exports');
  const csv = [
    'AID,Main,X-YEAR,TAS,Agency,Title,Fund Type,Independent Agencies,Last update',
    '020,0100,X,020-X-0100,Environmental Protection Agency,Salaries and Expenses,General,No,2026-01-01',
  ].join('\n');
  const r1 = imp.importTasRegister(csv);
  assert.equal(r1.created, 1);
  assert.equal(r1.updated, 0);
  const r2 = imp.importTasRegister(csv);              // same TAS → updates in place
  assert.equal(r2.created, 0);
  assert.equal(r2.updated, 1);

  const acct = repo.tas.byTas('020-X-0100');
  assert.equal(acct.agency, 'Environmental Protection Agency');
  assert.equal(acct.avail, 'X');                       // X-YEAR column → avail
  assert.equal(acct.fund_type, 'General');
  assert.equal(repo.tas.all({ q: 'salaries' }).length, 1); // search by title

  // A budget line whose appropriation code is this TAS links the two together.
  const bId = repo.budget.create({ fiscal_year: 'FY-TAS', status: 'Adopted' });
  repo.budget.addLine({ budget_id: bId, name: 'EPA ops', kind: 'Expense', amount: 500000, appropriation_code: '020-X-0100' });
  const det = repo.budget.appropriationDetail('020-X-0100');
  assert.equal(det.lines.length, 1);
  assert.equal(repo.tas.byTas(det.code).title, 'Salaries and Expenses');

  // Export carries the exact import columns, so the register round-trips.
  const out = feeds.tasCsv(repo.tas.all());
  assert.match(out.split('\r\n')[0], /^AID,Main,X-YEAR,TAS,Agency,Title,Fund Type,Independent Agencies,Last update$/);
  assert.match(out, /020-X-0100/);

  // A row without a TAS is rejected.
  const bad = imp.importTasRegister('AID,TAS\n020,\n');
  assert.ok(bad.errors.length >= 1);
});

test('org import: builds units with leaders and resolves parents by name', () => {
  const imp = require('../src/import');
  const csv = [
    'level,name,parent,leader_name,leader_title,leader_email',
    'Division,Executive Office,,Jane Roe,Executive Director,jroe@x.gov',
    'Department,Finance,Executive Office,John Doe,Finance Director,jdoe@x.gov',
  ].join('\n');
  const res = imp.importOrgUnits(csv);
  assert.equal(res.created, 2);
  assert.equal(res.errors.length, 0);
  const all = repo.org.all();
  const exec = all.find((u) => u.name === 'Executive Office');
  const fin = all.find((u) => u.name === 'Finance');
  assert.equal(exec.leader_name, 'Jane Roe');
  assert.equal(exec.leader_title, 'Executive Director');
  assert.equal(fin.parent_id, exec.id);          // parent resolved by name
  assert.equal(fin.leader_email, 'jdoe@x.gov');
  // Invalid level and an unknown parent are each reported.
  const bad = imp.importOrgUnits('level,name,parent\nBogus,X,\nDepartment,Y,Nowhere\n');
  assert.equal(bad.created, 0);
  assert.equal(bad.errors.length, 2);
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

test('procurement: sequential numbering, visibility, Q&A, bids, award linkage', () => {
  // Numbering is SOL-YYMM##; the suffix must increment without swallowing the
  // final month digit (regression for the substr(number, 8) off-by-one).
  const s1 = repo.procurement.create({ kind: 'RFP', title: 'Sol one', status: 'Open' });
  const s2 = repo.procurement.create({ kind: 'RFQ', title: 'Sol two', status: 'Draft' });
  assert.match(s1.number, /^SOL-\d{6}$/);
  assert.equal(s1.number.slice(0, 8), s2.number.slice(0, 8));            // same SOL-YYMM prefix
  assert.equal(Number(s2.number.slice(-2)), Number(s1.number.slice(-2)) + 1);

  // Public listing hides Draft; admin listing shows everything.
  const publicNums = repo.procurement.list().map((s) => s.number);
  assert.ok(publicNums.includes(s1.number));
  assert.ok(!publicNums.includes(s2.number));
  assert.ok(repo.procurement.list({ includeAll: true }).map((s) => s.number).includes(s2.number));

  // Q&A: question stored, answer round-trips.
  const qid = repo.procurement.addQuestion({ solicitation_id: s1.id, name: 'Ada', question: 'Scope?' });
  assert.equal(repo.procurement.questions(s1.id).length, 1);
  repo.procurement.answerQuestion(qid, 'See section 2.');
  assert.equal(repo.procurement.getQuestion(qid).answer, 'See section 2.');

  // Bids order cheapest-first.
  repo.procurement.addBid({ solicitation_id: s1.id, vendor_name: 'Acme', amount: 500 });
  repo.procurement.addBid({ solicitation_id: s1.id, vendor_name: 'Globex', amount: 300 });
  const bids = repo.procurement.bids(s1.id);
  assert.equal(bids.length, 2);
  assert.equal(bids[0].vendor_name, 'Globex');

  // Award links a vendor + contract; re-recording preserves the contract link.
  const vendorId = repo.vendors.findOrCreate('Globex');
  const contract = repo.matters.insertNumbered({ type: 'Contract', title: 'Award', status: 'Draft' });
  repo.procurement.award(s1.id, { vendorId, amount: 300, matterId: contract.id });
  let got = repo.procurement.get(s1.id);
  assert.equal(got.status, 'Awarded');
  assert.equal(got.awarded_vendor_id, vendorId);
  assert.equal(got.matter_id, contract.id);
  repo.procurement.award(s1.id, { vendorId, amount: 350, matterId: got.matter_id }); // as the route now does
  got = repo.procurement.get(s1.id);
  assert.equal(got.matter_id, contract.id);
  assert.equal(got.award_amount, 350);
});

test('procurement: biddable respects status and the posted date window', () => {
  const past = '2000-01-01';
  const future = '2999-12-31';
  assert.equal(repo.procurement.biddable({ status: 'Open' }), true);
  assert.equal(repo.procurement.biddable({ status: 'Draft' }), false);
  assert.equal(repo.procurement.biddable({ status: 'Closed' }), false);
  assert.equal(repo.procurement.biddable({ status: 'Open', open_date: future }), false); // not yet open
  assert.equal(repo.procurement.biddable({ status: 'Open', close_date: past }), false);  // already closed
  assert.equal(repo.procurement.biddable({ status: 'Open', open_date: past, close_date: future }), true);
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
