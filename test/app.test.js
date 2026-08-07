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

test('written consent: seeds signers, adopts on unanimity, declines on refusal', () => {
  const bId = repo.bodies.insert({ name: 'Consent Board', type: 'Governing Body', seats: 2 });
  const p1 = repo.people.insert({ full_name: 'Ada Signer', email: 'ada@test.gov' });
  const p2 = repo.people.insert({ full_name: 'Ben Signer', email: 'ben@test.gov' });
  repo.bodies.addMember(bId, p1, 'Chair');
  repo.bodies.addMember(bId, p2, 'Member');

  const { id, number } = repo.consents.create({ title: 'A Resolution by consent', body_html: '<p>Resolved.</p>', body_id: bId });
  assert.match(number, /^WC-\d{6}$/);
  assert.equal(repo.consents.get(id).signer_count, 2);
  const signers = repo.consents.signers(id);

  repo.consents.setStatus(id, 'Circulating');
  repo.consents.setSignerStatus(signers[0].id, 'Signed');
  assert.equal(repo.consents.get(id).status, 'Circulating');   // not yet unanimous
  repo.consents.setSignerStatus(signers[1].id, 'Signed');
  const adopted = repo.consents.get(id);
  assert.equal(adopted.status, 'Adopted');
  assert.ok(adopted.adopted_at);

  // A single decline sends it back.
  const d = repo.consents.create({ title: 'Another', body_id: bId });
  repo.consents.setStatus(d.id, 'Circulating');
  const ds = repo.consents.signers(d.id);
  repo.consents.setSignerStatus(ds[0].id, 'Signed');
  repo.consents.setSignerStatus(ds[1].id, 'Declined');
  assert.equal(repo.consents.get(d.id).status, 'Declined');

  // Provider (Adobe) sync: statuses arrive keyed by email.
  const e = repo.consents.create({ title: 'Third', body_id: bId });
  repo.consents.setStatus(e.id, 'Circulating');
  repo.consents.syncFromMembers(e.id, [
    { email: 'ada@test.gov', status: 'Signed' },
    { email: 'BEN@test.gov', status: 'Signed' },       // case-insensitive match
  ]);
  assert.equal(repo.consents.get(e.id).status, 'Adopted');
});

test('esign adapter: inert without config, maps statuses, exposes handshake id', () => {
  const esign = require('../src/esign');
  assert.equal(esign.isConfigured({}), false);
  assert.equal(esign.mapMemberStatus('SIGNED'), 'Signed');
  assert.equal(esign.mapMemberStatus('DECLINED'), 'Declined');
  assert.equal(esign.mapMemberStatus('WAITING_FOR_MY_SIGNATURE'), 'Pending');
  const cfg = {
    ADOBE_SIGN_BASE_URI: 'https://api.na1.adobesign.com', ADOBE_SIGN_CLIENT_ID: 'cid',
    ADOBE_SIGN_CLIENT_SECRET: 's', ADOBE_SIGN_REFRESH_TOKEN: 'r',
  };
  assert.equal(esign.isConfigured(cfg), true);
  assert.equal(esign.webhookClientId(cfg), 'cid');
});

test('adobe connect: saves credentials, builds authorize URL, connects/disconnects', () => {
  const esign = require('../src/esign');
  esign.saveCredentials({ clientId: 'CID', clientSecret: 'SECRET', region: 'eu1', webhookClientId: '' });
  let st = esign.status();
  assert.equal(st.hasCredentials, true);
  assert.equal(st.connected, false);
  assert.equal(st.region, 'eu1');
  assert.equal(st.baseUri, 'https://api.eu1.adobesign.com');
  assert.equal(esign.isConfigured(), false); // no refresh token yet

  const url = esign.authorizeUrl({ redirectUri: 'https://app.test/admin/integrations/adobe/callback', state: 'xyz' });
  assert.ok(url.startsWith('https://secure.eu1.adobesign.com/public/oauth/v2?'));
  assert.match(url, /client_id=CID/);
  assert.match(url, /response_type=code/);
  assert.match(url, /state=xyz/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fapp\.test/);

  // Emulate a completed token exchange (real exchangeCode needs a live Adobe call).
  db.prepare("INSERT INTO settings (key, value) VALUES ('adobe.refresh_token', 'RTOKEN') ON CONFLICT(key) DO UPDATE SET value = 'RTOKEN'").run();
  assert.equal(esign.status().connected, true);
  assert.equal(esign.isConfigured(), true);
  esign.disconnect();
  assert.equal(esign.status().connected, false);

  db.prepare("DELETE FROM settings WHERE key LIKE 'adobe.%'").run(); // clean up for other tests
});

test('announcement banner: set/get, trims, validates level, seeds once', () => {
  const ann = require('../src/announcement');
  ann.set({ text: '  Meeting moved to 11:30 a.m.  ', level: 'urgent', active: true });
  let a = ann.get();
  assert.equal(a.text, 'Meeting moved to 11:30 a.m.');   // trimmed
  assert.equal(a.level, 'urgent');
  assert.equal(a.active, true);

  ann.set({ text: '', level: 'info', active: true });     // blank text → off
  assert.equal(ann.get().active, false);

  ann.set({ text: 'x', level: 'bogus', active: true });   // unknown level → warning
  assert.equal(ann.get().level, 'warning');

  ann.set({ text: '', active: false });                   // clear before seeding
  ann.seedIfAbsent({ text: 'Seeded notice', level: 'warning' });
  assert.equal(ann.get().text, 'Seeded notice');
  assert.equal(ann.get().active, true);
  ann.seedIfAbsent({ text: 'Second seed', level: 'urgent' }); // guarded → no-op
  assert.equal(ann.get().text, 'Seeded notice');
});

test('legisdoc: parses the provision hierarchy with stable identifiers', () => {
  const L = require('../src/legisdoc');
  const doc = L.parse([
    'SECTION 1. Short title.',
    'SECTION 2. Program.',
    '(a) In general. A program is established.',
    '(1) It shall include grants.',
    '(A) Grants are capped.',
    '(i) A match is required.',
    '(ii) Review is quarterly.',
    '(2) Reporting is annual.',
    '(b) Definitions.',
  ].join('\n'));
  assert.equal(doc.sections.length, 2);
  const flat = L.flatten(doc);
  const ids = flat.map((n) => n.id);
  assert.ok(ids.includes('s2/a/1/A/i'), 'nested clause gets a stable id');
  assert.ok(ids.includes('s2/b'));
  // (i) after (A) is a clause, not a subsection — the roman/letter ambiguity.
  assert.equal(flat.find((n) => n.id === 's2/a/1/A/i').level, 'clause');
  assert.equal(L.cite('s2/a/1/A/i'), 'Sec. 2(a)(1)(A)(i)');
  assert.equal(L.find(doc, 's2/a/2').text, 'Reporting is annual.');
  // Round-trips through canonical text: the whole tree must survive, not just
  // the section count — ids, levels, markers, headings and text alike.
  const reparsed = L.parse(L.toText(doc));
  assert.deepEqual(L.flatten(reparsed), L.flatten(doc));
  assert.equal(L.validate(doc).length, 0);
});

test('legisdoc: validation flags sequence gaps and empty provisions', () => {
  const L = require('../src/legisdoc');
  // "(b)" carries no text and no children — an empty provision.
  const issues = L.validate(L.parse('SECTION 2. Out of order.\n(a) Fine.\n(b)\n(d) Skipped c.'));
  assert.ok(issues.some((i) => /consecutively/.test(i.msg)), 'section numbering gap flagged');
  assert.ok(issues.some((i) => /sequence/.test(i.msg)), 'subsection sequence gap flagged');
  const empty = issues.find((i) => /is empty/.test(i.msg));
  assert.ok(empty, 'empty provision flagged');
  assert.equal(empty.level, 'error');
  assert.equal(empty.id, 's2/b');
});

test('amend: comparative print and codification against the Board Code', () => {
  const amend = require('../src/amend');
  const mId = repo.matters.insert({
    file_number: '269901', title: 'An Ordinance amending the code', type: 'Ordinance', status: 'Introduced',
  });
  repo.code.insertSection({ citation: '90-1', heading: 'Definitions', body_text: 'SECTION 1. Definitions.\n(a) "Tree" means a tree.' });
  repo.code.insertSection({ citation: '90-9', heading: 'Old rule', body_text: 'SECTION 1. Repeal me.' });
  repo.code.addAmendment(mId, { op: 'amend', citation: '90-1', new_text: 'SECTION 1. Definitions.\n(a) "Tree" means a woody perennial.' });
  repo.code.addAmendment(mId, { op: 'add', citation: '90-20', heading: 'New program', new_text: 'SECTION 1. Program.\n(a) Established.' });
  repo.code.addAmendment(mId, { op: 'repeal', citation: '90-9' });

  const impact = amend.codeImpact(mId);
  assert.deepEqual([impact.add, impact.amend, impact.repeal], [1, 1, 1]);

  // (2) bill vs current law — a diff per instruction, before enactment
  const print = amend.comparativePrint(mId);
  assert.equal(print.length, 3);
  const amended = print.find((p) => p.citation === '90-1');
  assert.ok(amended.stats.added > 0, 'reports added words');
  assert.ok(/woody perennial/.test(amended.proposedText));
  assert.equal(repo.code.byCitation('90-1').body_text.includes('woody perennial'), false,
    'the Code is untouched until enactment');

  // Only an enacted measure may change the Code.
  const refused = amend.codify(mId, { effectiveDate: '2026-09-01' });
  assert.deepEqual([refused.added, refused.amended, refused.repealed], [0, 0, 0]);
  assert.ok(/Only an enacted measure/.test(refused.errors[0]), 'refuses a non-enacted measure');
  assert.equal(repo.code.byCitation('90-1').body_text.includes('woody perennial'), false);

  // Codify: apply the instructions
  repo.matters.setStatus(mId, 'Enacted');
  const res = amend.codify(mId, { effectiveDate: '2026-09-01' });
  assert.deepEqual([res.added, res.amended, res.repealed], [1, 1, 1]);
  assert.ok(repo.code.byCitation('90-1').body_text.includes('woody perennial'));
  assert.equal(repo.code.byCitation('90-9').status, 'Repealed');
  assert.ok(repo.code.byCitation('90-20'), 'new section created');

  // Authority trail + point-in-time
  const sec = repo.code.byCitation('90-1');
  const hist = repo.code.historyFor(sec.id);
  assert.equal(hist[0].matter_id, mId, 'records which measure changed it');
  assert.ok(/means a tree/.test(amend.asOf(sec.id, '2026-01-01')), 'point-in-time returns the prior text');

  // A repealed section is not in force today, but its text is recoverable.
  const gone = repo.code.byCitation('90-9');
  assert.equal(amend.asOf(gone.id, '2026-12-31'), null, 'repealed section reads as absent after repeal');
  assert.ok(/Repeal me/.test(amend.asOf(gone.id, '2026-01-01')), 'text before the repeal is recoverable');

  // Idempotent — re-running applies nothing
  assert.deepEqual(Object.values(amend.codify(mId)).slice(0, 3), [0, 0, 0]);
});

// Exercises onStatusChange — the hook the routes actually call — so that
// removing the wiring, or dropping the enacting-status guard, fails here.
test('amend: the enactment hook codifies only at an enacting status', () => {
  const amend = require('../src/amend');
  const mId = repo.matters.insert({
    file_number: '269904', title: 'An Ordinance reaching enactment', type: 'Ordinance', status: 'In Committee',
  });
  repo.code.insertSection({ citation: '93-1', heading: 'Target', body_text: 'SECTION 1. Original.' });
  repo.code.addAmendment(mId, { op: 'amend', citation: '93-1', new_text: 'SECTION 1. Revised.' });

  // Routine transitions return null — no Code change, and no error to report.
  for (const s of ['Draft', 'In Committee', 'On Agenda']) {
    repo.matters.setStatus(mId, s);
    assert.equal(amend.onStatusChange(mId, s, '2026-09-01'), null, `${s} must be a no-op`);
    assert.ok(/Original/.test(repo.code.byCitation('93-1').body_text), `${s} must not touch the Code`);
  }

  repo.matters.setStatus(mId, 'Enacted');
  const res = amend.onStatusChange(mId, 'Enacted', '2026-09-01');
  assert.equal(res.amended, 1);
  assert.deepEqual(res.errors, []);
  assert.ok(/Revised/.test(repo.code.byCitation('93-1').body_text), 'enactment applies the instruction');

  // Re-saving the same status writes no duplicate history.
  amend.onStatusChange(mId, 'Enacted', '2026-09-01');
  assert.equal(repo.code.historyFor(repo.code.byCitation('93-1').id).length, 1);
});

test('amend: the hook reports refused instructions rather than swallowing them', () => {
  const amend = require('../src/amend');
  const mId = repo.matters.insert({
    file_number: '269905', title: 'An Ordinance with a bad instruction', type: 'Ordinance', status: 'Enacted',
  });
  repo.code.addAmendment(mId, { op: 'amend', citation: '94-nope', new_text: 'SECTION 1. Text.' });
  const res = amend.onStatusChange(mId, 'Enacted', '2026-09-01');
  assert.ok(res, 'an enacting status returns a result');
  assert.equal(res.skipped, 1);
  assert.ok(res.errors.length, 'the failure is reported to the caller, not only logged');
});

test('nav: every privileged role sees the Workspace, admin most of all', () => {
  const { navFor } = require('../src/views/layout');
  const ws = (role) => {
    const g = navFor(role ? { id: 1, role } : null).find((x) => x.label === 'Workspace');
    return g ? g.items.map((i) => i.href) : [];
  };

  assert.deepEqual(ws(null), [], 'an anonymous visitor has no workspace');
  assert.deepEqual(ws('public'), [], 'the public role has no workspace');
  assert.ok(ws('member').includes('/member'));
  assert.ok(ws('staff').includes('/govern/members'));
  assert.ok(ws('clerk').includes('/admin'));

  // The regression: `admin` was absent from a rank table this view kept of its
  // own, so it scored 0 and the whole group disappeared for the most
  // privileged account.
  const admin = ws('admin');
  assert.ok(admin.length, 'admin sees a Workspace at all');
  for (const href of ws('clerk')) {
    assert.ok(admin.includes(href), `admin keeps the clerk link ${href}`);
  }
  assert.ok(admin.includes('/admin/users'), 'admin gets the admin-only links');

  // Privilege is cumulative all the way up.
  assert.ok(ws('clerk').length > ws('staff').length);
  assert.ok(ws('admin').length > ws('clerk').length);
});

test('drafting forms: every form parses into a valid provision tree', () => {
  const tpl = require('../src/doc-templates');
  const L = require('../src/legisdoc');
  const forms = tpl.draftingDefaults();
  assert.ok(Object.keys(forms).length >= 8, 'a form for each legislative type');

  for (const [type, text] of Object.entries(forms)) {
    const doc = L.parse(text);
    assert.ok(doc.sections.length >= 1, `${type}: produces at least one SECTION`);
    // The whole point: a form must yield structure the workbench can use.
    const errors = L.validate(doc).filter((i) => i.level === 'error');
    assert.deepEqual(errors, [], `${type}: no structural errors — got ${JSON.stringify(errors)}`);
    assert.ok(L.flatten(doc).every((n) => n.id), `${type}: every provision is citable`);
  }

  // A resolution keeps its WHEREAS clauses as a preamble, ahead of SECTION 1.
  const res = L.parse(forms.Resolution);
  assert.ok(res.preamble.some((p) => /WHEREAS/.test(p)), 'resolution preamble survives');
  assert.equal(res.sections[0].marker, '1');

  // The amendatory form is well formed too, and names the target section.
  const am = L.parse(tpl.amendatoryForm('12-4'));
  assert.deepEqual(L.validate(am).filter((i) => i.level === 'error'), []);
  assert.ok(/12-4/.test(tpl.amendatoryForm('12-4')), 'cites the section being amended');
});

test('drafting forms: placeholders are filled as plain text, not escaped HTML', () => {
  const tpl = require('../src/doc-templates');
  const out = tpl.draftingTemplate('Ordinance', {
    file_number: '260701', title: 'An Ordinance concerning parks & recreation',
  });
  assert.ok(/parks & recreation/.test(out), 'ampersand stays literal in drafting text');
  assert.ok(!/&amp;/.test(out), 'no HTML escaping leaks into the document');
  assert.ok(!/\{\{/.test(out), 'no placeholder left unfilled');
});

test('mimetype: identifies extensionless art from its header bytes', () => {
  const mt = require('../src/mimetype');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(10)]);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(10)]);
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

  assert.equal(mt.sniffType(png), 'image/png');
  assert.equal(mt.sniffType(jpg), 'image/jpeg');
  assert.equal(mt.sniffType(gif), 'image/gif');
  assert.equal(mt.sniffType(webp), 'image/webp');
  assert.equal(mt.sniffType(svg), 'image/svg+xml');
  assert.equal(mt.sniffType(Buffer.alloc(64)), mt.FALLBACK, 'unknown data stays a generic blob');
  assert.equal(mt.sniffType(Buffer.from([1, 2])), mt.FALLBACK, 'too short to identify');

  // A known extension wins; a missing one falls back to the bytes.
  assert.equal(mt.typeFor('.png', Buffer.alloc(0)), 'image/png');
  assert.equal(mt.typeFor('', png), 'image/png', 'extensionless brand art still serves as an image');
  assert.equal(mt.typeFor('.bogus', png), 'image/png');
});

test('amend: rejects malformed instructions and stale pending notices', () => {
  const amend = require('../src/amend');
  const mId = repo.matters.insert({
    file_number: '269902', title: 'An Ordinance with a bad instruction', type: 'Ordinance', status: 'Enacted',
  });
  repo.code.addAmendment(mId, { op: 'add', citation: '91-1', heading: 'Empty', new_text: '   ' });
  repo.code.addAmendment(mId, { op: 'amend', citation: '91-2', new_text: 'SECTION 1. Fine.\n(a)' });

  const res = amend.codify(mId);
  assert.equal(res.added, 0);
  assert.equal(res.skipped, 2, 'both malformed instructions are refused');
  assert.equal(repo.code.byCitation('91-1'), undefined, 'no empty section is created');
  assert.ok(res.errors.some((e) => /carries no text/.test(e)));
  assert.ok(res.errors.some((e) => /not well formed/.test(e)));

  // A defeated measure's instructions must not linger as pending legislation.
  const dead = repo.matters.insert({
    file_number: '269903', title: 'A withdrawn ordinance', type: 'Ordinance', status: 'Introduced',
  });
  repo.code.insertSection({ citation: '92-1', heading: 'Target', body_text: 'SECTION 1. Text.' });
  repo.code.addAmendment(dead, { op: 'amend', citation: '92-1', new_text: 'SECTION 1. Changed.' });
  assert.equal(repo.code.pendingFor('92-1').length, 1);
  repo.matters.setStatus(dead, 'Withdrawn');
  assert.equal(repo.code.pendingFor('92-1').length, 0, 'withdrawn measures drop out of pending');
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

// --- Branding: local asset paths ---------------------------------------------
test('branding: a local /brand path cannot spell a traversal', () => {
  const { isBrandSrc } = require('../src/views/layout');
  // Legitimate shapes.
  assert.equal(isBrandSrc('/brand/seal.png'), true);
  assert.equal(isBrandSrc('/brand/fonts/FTSterlingTrial-Light.woff2'), true);
  assert.equal(isBrandSrc('/assets/logo-light.svg'), true);
  assert.equal(isBrandSrc('https://cdn.example.gov/seal.png'), true);
  // Traversal and its near neighbours.
  assert.equal(isBrandSrc('/brand/../../etc/passwd'), false);
  assert.equal(isBrandSrc('/brand/..'), false);
  assert.equal(isBrandSrc('/brand/sub/../../secret'), false);
  assert.equal(isBrandSrc('/brand//etc/passwd'), false);   // empty segment
  assert.equal(isBrandSrc('/brand/.hidden'), false);       // leading dot
  assert.equal(isBrandSrc('/brand/'), false);              // no segment at all
  assert.equal(isBrandSrc('/brand'), false);
  // Other schemes and hosts stay out.
  assert.equal(isBrandSrc('http://example.gov/seal.png'), false);
  assert.equal(isBrandSrc('javascript:alert(1)'), false);
  assert.equal(isBrandSrc('/etc/passwd'), false);
});

// --- Branding: @font-face declarations match what is actually deployed --------
// Two failure modes this catches. A face declared without its file costs a 404
// on every page load; and the trial cut of FT Sterling carries only 66 glyphs,
// so a unicode-range wider than the font's own cmap hands the browser
// characters it cannot draw.
test('branding: every @font-face src resolves, and unicode-range matches the cmap', () => {
  const cssPath = path.join(__dirname, '..', 'public', 'styles.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  const publicDir = path.join(__dirname, '..', 'public');

  const faces = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  assert.ok(faces.length > 0, 'expected at least one @font-face');

  for (const face of faces) {
    for (const m of face.matchAll(/url\('([^']+)'\)/g)) {
      const file = path.join(publicDir, m[1].replace(/^\//, ''));
      assert.ok(fs.existsSync(file), `@font-face points at a missing file: ${m[1]}`);
    }
    // Every declared range must be covered by the font it is declared against.
    const range = (face.match(/unicode-range:\s*([^;]+);/) || [])[1];
    if (!range) continue;
    const src = (face.match(/url\('([^']+\.otf)'\)/) || [])[1];
    if (!src) continue;
    const covered = cmapOf(path.join(publicDir, src.replace(/^\//, '')));
    for (const part of range.split(',')) {
      const [lo, hi] = part.trim().replace(/^U\+/i, '').split('-')
        .map((h) => parseInt(h, 16));
      for (let c = lo; c <= (hi === undefined ? lo : hi); c++) {
        assert.ok(covered.has(c), `unicode-range claims U+${c.toString(16).toUpperCase()} but ${src} has no glyph for it`);
      }
    }
  }
});

// Read the codepoints an OpenType file actually maps, straight from its cmap.
function cmapOf(file) {
  const b = fs.readFileSync(file);
  const numTables = b.readUInt16BE(4);
  let cmapOff = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (b.slice(rec, rec + 4).toString('latin1') === 'cmap') cmapOff = b.readUInt32BE(rec + 8);
  }
  assert.ok(cmapOff, `no cmap table in ${file}`);
  const out = new Set();
  const nSub = b.readUInt16BE(cmapOff + 2);
  for (let i = 0; i < nSub; i++) {
    const sub = cmapOff + b.readUInt32BE(cmapOff + 4 + i * 8 + 4);
    const fmt = b.readUInt16BE(sub);
    if (fmt === 4) {
      const segX2 = b.readUInt16BE(sub + 6);
      const endO = sub + 14;
      const startO = endO + segX2 + 2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = b.readUInt16BE(endO + s * 2);
        const start = b.readUInt16BE(startO + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end && c < 0xffff; c++) out.add(c);
      }
    } else if (fmt === 12) {
      const nGroups = b.readUInt32BE(sub + 12);
      for (let g = 0; g < nGroups; g++) {
        const r = sub + 16 + g * 12;
        for (let c = b.readUInt32BE(r); c <= b.readUInt32BE(r + 4); c++) out.add(c);
      }
    }
  }
  return out;
}

// --- Branding: status tints stay legible --------------------------------------
// The house palette's amber and brass are brand inks chosen against white, and
// both fall under WCAG AA when set as 11px badge type on their own dim tint.
// Each pair below is one that the stylesheet actually paints; darker -ink steps
// exist for exactly this reason, and this keeps them from being reverted to the
// brand value by someone tidying up "duplicate" tokens.
test('branding: text-on-tint token pairs clear WCAG AA', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const token = (name) => {
    const m = css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(m, `token --${name} is not defined as a literal hex`);
    return m[1];
  };
  const relLum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const pairs = [
    ['warn-ink', 'warn-dim'],
    ['gold-ink', 'gold-dim'], // status chips, and every .card-head masthead
    ['good', 'good-dim'], ['bad', 'bad-dim'], ['cobalt', 'cobalt-dim'],
  ];
  for (const [ink, tint] of pairs) {
    const r = ratio(token(ink), token(tint));
    assert.ok(r >= 4.5, `--${ink} on --${tint} is ${r.toFixed(2)}:1, under the 4.5:1 AA floor`);
  }
});
