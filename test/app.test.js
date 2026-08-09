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

// --- Agenda assembly ---------------------------------------------------------
test('agenda assembly: ready queue is scoped to the body and to live business', () => {
  const b = repo.bodies.insert({ name: 'Assembly Board', type: 'Governing Body', seats: 5 });
  const other = repo.bodies.insert({ name: 'Assembly Committee', type: 'Committee', seats: 3 });
  const mtId = repo.meetings.insert({ body_id: b, meeting_date: '2099-09-01' });

  const live1 = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Live one', status: 'Introduced', body_id: b });
  const live2 = repo.matters.insertNumbered({ type: 'Resolution', title: 'Live two', status: 'In Committee', body_id: b });
  const done = repo.matters.insertNumbered({ type: 'Motion', title: 'Finished', status: 'Enacted', body_id: b });
  const elsewhere = repo.matters.insertNumbered({ type: 'Motion', title: 'Other body', status: 'Introduced', body_id: other });
  const unassigned = repo.matters.insertNumbered({ type: 'Motion', title: 'No body yet', status: 'Introduced' });

  const ready = repo.meetings.readyForAgenda(mtId).map((m) => m.title);
  assert.deepEqual(ready.sort(), ['Live one', 'Live two', 'No body yet']);
  assert.ok(!ready.includes('Finished'));   // terminal status
  assert.ok(!ready.includes('Other body')); // belongs to another body

  // Bulk placement takes only what is eligible, and says how much it refused.
  const res = repo.meetings.addMatters(mtId, [live1.id, live2.id, done.id, elsewhere.id], { section: 'New Business' });
  assert.equal(res.added, 2);
  assert.equal(res.skipped, 2);

  // Scheduled business drops out of the queue; unassigned is still waiting.
  assert.deepEqual(repo.meetings.readyForAgenda(mtId).map((m) => m.title), ['No body yet']);
  assert.equal(repo.meetings.items(mtId).length, 2);
  void unassigned;
});

test('agenda assembly: a file heard in the past is eligible again', () => {
  const b = repo.bodies.insert({ name: 'Repeat Board', type: 'Governing Body', seats: 5 });
  const past = repo.meetings.insert({ body_id: b, meeting_date: '2000-01-01' });
  const future = repo.meetings.insert({ body_id: b, meeting_date: '2099-12-01' });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Continued item', status: 'In Committee', body_id: b });

  repo.meetings.addMatters(past, [m.id]);
  // Already heard, so it can come back for a second reading or a continuance.
  assert.ok(repo.meetings.readyForAgenda(future).some((x) => x.id === m.id));
  // But once it is on the future agenda it is not offered twice.
  repo.meetings.addMatters(future, [m.id]);
  assert.ok(!repo.meetings.readyForAgenda(future).some((x) => x.id === m.id));
});

// --- Supporting document assembly --------------------------------------------
test('packet: tabs go only to items carrying material, and renumber on exclusion', () => {
  const b = repo.bodies.insert({ name: 'Packet Board', type: 'Governing Body', seats: 5 });
  const mtId = repo.meetings.insert({ body_id: b, meeting_date: '2099-10-01' });
  const m1 = repo.matters.insertNumbered({ type: 'Ordinance', title: 'With docs', status: 'Introduced', body_id: b });
  const m2 = repo.matters.insertNumbered({ type: 'Resolution', title: 'Also with docs', status: 'Introduced', body_id: b });
  const bare = repo.matters.insertNumbered({ type: 'Motion', title: 'Nothing attached', status: 'Introduced', body_id: b });

  repo.meetings.addItem({ meeting_id: mtId, title: 'Call to Order', section: 'Call to Order' });
  repo.meetings.addMatters(mtId, [m1.id, m2.id, bare.id]);

  const items = repo.meetings.items(mtId);
  const i1 = items.find((i) => i.matter_id === m1.id);
  const i2 = items.find((i) => i.matter_id === m2.id);
  repo.matters.addAttachment({ matter_id: m1.id, name: 'Site plan', url: 'https://example.gov/plan.pdf' });
  repo.meetings.addItemDoc(i2.id, { name: 'Deck', url: 'https://example.gov/deck.pdf' });

  let packet = repo.meetings.packet(mtId);
  const byTitle = (t) => packet.find((r) => (r.item.matter_title || r.item.title) === t);

  // A procedural line produces nothing at all and takes no tab.
  assert.equal(byTitle('Call to Order').tab, null);
  assert.equal(byTitle('Call to Order').generated, 0);

  // A legislative file always takes a tab, because the system generates a
  // board letter for it whether or not anyone attached anything. Counting only
  // authored material left a drafted ordinance with no attachments untabbed,
  // and therefore never bound into the packet.
  assert.equal(byTitle('Nothing attached').material, 0);   // still nothing to read
  assert.ok(byTitle('Nothing attached').tab, 'a file on the agenda must take a tab');
  // An ordinance also generates the clean text, the redline and the notice.
  assert.equal(byTitle('With docs').generated, 4);
  assert.equal(byTitle('Also with docs').generated, 1);

  const firstTab = byTitle('With docs').tab;
  const secondTab = byTitle('Also with docs').tab;
  assert.ok(firstTab < secondTab, 'tabs follow agenda order');

  // Holding an item back moves the ones behind it up — tabs must stay
  // contiguous, since a member is told to turn to a physical divider.
  repo.meetings.setInPacket(i1.id, 0);
  packet = repo.meetings.packet(mtId);
  assert.equal(byTitle('With docs').included, false);
  assert.equal(byTitle('With docs').tab, null);
  assert.equal(byTitle('Also with docs').tab, secondTab - 1);
});

test('packet: item documents are scoped to the item and die with it', () => {
  const b = repo.bodies.insert({ name: 'Doc Board', type: 'Governing Body', seats: 5 });
  const mtId = repo.meetings.insert({ body_id: b, meeting_date: '2099-11-01' });
  repo.meetings.addItem({ meeting_id: mtId, title: 'Presentation', section: 'Reports' });
  const item = repo.meetings.items(mtId)[0];
  const docId = repo.meetings.addItemDoc(item.id, { name: 'Slides', url: 'https://example.gov/s.pdf' });
  assert.equal(repo.meetings.itemDocs(item.id).length, 1);
  assert.equal(repo.meetings.getItemDoc(docId).name, 'Slides');
  // A procedural item carries documents even though it has no legislative file.
  assert.equal(item.matter_id, null);
  repo.meetings.removeItem(item.id);
  assert.equal(repo.meetings.itemDocs(item.id).length, 0); // cascaded
});

test('agenda assembly: a duplicated id is placed once, not twice', () => {
  const b = repo.bodies.insert({ name: 'Dup Board', type: 'Governing Body', seats: 5 });
  const mtId = repo.meetings.insert({ body_id: b, meeting_date: '2099-09-15' });
  const m = repo.matters.insertNumbered({ type: 'Motion', title: 'Once only', status: 'Introduced', body_id: b });
  // The eligible set is computed once, so the same id submitted twice would
  // otherwise pass the check twice and land on the agenda twice.
  const res = repo.meetings.addMatters(mtId, [m.id, m.id, m.id]);
  assert.equal(res.added, 1);
  assert.equal(res.skipped, 2);
  assert.equal(repo.meetings.items(mtId).filter((i) => i.matter_id === m.id).length, 1);
});

test('agenda assembly: business booked on an earlier upcoming meeting is not offered', () => {
  const b = repo.bodies.insert({ name: 'Order Board', type: 'Governing Body', seats: 5 });
  const nov = repo.meetings.insert({ body_id: b, meeting_date: '2099-11-10' });
  const dec = repo.meetings.insert({ body_id: b, meeting_date: '2099-12-01' });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Spoken for', status: 'Introduced', body_id: b });

  repo.meetings.addMatters(nov, [m.id]);
  // November falls before December but has not happened, so the file is
  // already spoken for and must not be offered while building December.
  assert.ok(!repo.meetings.readyForAgenda(dec).some((x) => x.id === m.id));
});

test('agenda assembly: a closed-out meeting does not offer its own agenda back', () => {
  const b = repo.bodies.insert({ name: 'Final Board', type: 'Governing Body', seats: 5 });
  const mtId = repo.meetings.insert({ body_id: b, meeting_date: '2099-08-01' });
  const m = repo.matters.insertNumbered({ type: 'Motion', title: 'Already listed', status: 'Introduced', body_id: b });
  repo.meetings.addMatters(mtId, [m.id]);

  // Eligibility for this agenda must not depend on the meeting's own status;
  // otherwise editing a Final or Adjourned meeting offers duplicates of what
  // is already on it.
  for (const status of ['Scheduled', 'In Progress', 'Final', 'Adjourned', 'Cancelled']) {
    repo.meetings.update(mtId, { body_id: b, meeting_date: '2099-08-01', status });
    assert.ok(!repo.meetings.readyForAgenda(mtId).some((x) => x.id === m.id),
      `offered a duplicate while the meeting was ${status}`);
  }
});

test('reset() drops agenda_item_docs so documents cannot outlive their item', () => {
  // reset() runs with foreign keys off and a hard-coded drop list, so a table
  // missing from that list survives and can re-attach to a reused item id.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  const list = src.match(/function reset\(\)[\s\S]*?\];/);
  assert.ok(list, 'could not find the reset() drop list');
  assert.ok(list[0].includes("'agenda_item_docs'"), 'agenda_item_docs missing from reset()');
  assert.ok(list[0].indexOf("'agenda_item_docs'") < list[0].indexOf("'agenda_items'"),
    'agenda_item_docs must be dropped before agenda_items');
});

// --- Official document outputs ------------------------------------------------
// Structured after the artifacts a Legistar-backed board produces for one
// docket: board letter, clean ordinance, redline, published summary, approval
// log. These assert the parts that carry legal weight — that the instrument is
// identified, that its own effective-date clause is not duplicated, and that
// the provision tree survives into the PDF.
const documents = require('../src/documents');

async function pdfText(bytes) {
  // pdf-lib Flate-compresses content streams, so the drawn strings have to be
  // inflated before they can be read back. Doing it here keeps the test path
  // dependency-free rather than pulling in a PDF parser.
  const zlib = require('node:zlib');
  const buf = Buffer.from(bytes);
  const out = [];
  // Walk every stream object, inflate what inflates, and collect Tj operands.
  let idx = 0;
  for (;;) {
    const start = buf.indexOf('stream', idx);
    if (start === -1) break;
    let s = start + 6;
    if (buf[s] === 0x0d) s++;
    if (buf[s] === 0x0a) s++;
    const end = buf.indexOf('endstream', s);
    if (end === -1) break;
    idx = end + 9;
    let body;
    try { body = zlib.inflateSync(buf.subarray(s, end)).toString('latin1'); }
    catch { body = buf.subarray(s, end).toString('latin1'); }
    // pdf-lib emits hex strings (<4F52...> Tj) for embedded fonts and literal
    // strings for some paths, so both forms are read.
    for (const m of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      const hex = m[1].replace(/\s+/g, '');
      let str = '';
      for (let i = 0; i + 1 < hex.length; i += 2) str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      out.push(str);
    }
    for (const m of body.matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)) {
      out.push(m[1].replace(/\\([()\\])/g, '$1'));
    }
  }
  // Collapse the wrap: these assertions test that a phrase is present, not
  // where the line broke, and a title that wraps mid-phrase would otherwise
  // fail a match that is actually correct in the document.
  return out.join(' ').replace(/\s+/g, ' ');
}

test('documents: an ordinance carries its identity, enacting clause and provisions', async () => {
  const b = repo.bodies.insert({ name: 'Doc Board', type: 'Governing Body', seats: 5 });
  const m = repo.matters.insertNumbered({
    type: 'Ordinance', title: 'An Ordinance restricting single-use containers',
    status: 'Introduced', body_id: b,
  });
  db.prepare('UPDATE matters SET full_text=? WHERE id=?').run(
    'SECTION 1. Purpose.\nThe Board finds that this ordinance reduces waste.\n'
    + 'SECTION 2. Prohibition.\nNo establishment shall distribute prepared food as follows:\n'
    + '(a) This applies to all licensed establishments.\n'
    + '(1) Containers for raw meat are exempt.\n', m.id);

  const text = await pdfText(await documents.ordinance(repo.matters.get(m.id)));
  assert.match(text, /ORDINANCE NO\./);
  assert.match(text, /AN ORDINANCE RESTRICTING SINGLE-USE CONTAINERS/);
  assert.match(text, /ordains as follows/);
  // The enacting clause must not stutter when body and org are the same name.
  // The stutter is "The X of X ordains" — assert on the repeated name itself,
  // not on a leading "of" that the real string never has.
  const bodyName = require('../src/org').ORG.primaryBody;
  assert.ok(!text.includes(bodyName + ' of ' + bodyName), 'organisation name repeated in the enacting clause');
  // Provisions survive with their markers at every depth.
  assert.match(text, /SECTION 1\./);
  assert.match(text, /SECTION 2\./);
  assert.match(text, /\(a\)/);
  assert.match(text, /\(1\)/);
  assert.match(text, /APPROVED AS TO FORM AND LEGALITY/);
});

test('documents: the standard effective-date clause is not added when the text has one', async () => {
  const b = repo.bodies.insert({ name: 'Eff Board', type: 'Governing Body', seats: 3 });
  const withOwn = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Has its own', status: 'Introduced', body_id: b });
  db.prepare('UPDATE matters SET full_text=? WHERE id=?').run(
    'SECTION 1. Purpose.\nA purpose.\nSECTION 2. Effective Date.\nThis ordinance shall take effect immediately.', withOwn.id);
  const withOwnText = await pdfText(await documents.ordinance(repo.matters.get(withOwn.id)));
  // Two effective-date clauses is the ambiguity the clause exists to remove.
  assert.equal((withOwnText.match(/EFFECTIVE DATE/g) || []).length, 0,
    'boilerplate heading added on top of the drafted one');

  const without = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Has none', status: 'Introduced', body_id: b });
  db.prepare('UPDATE matters SET full_text=? WHERE id=?').run('SECTION 1. Purpose.\nA purpose only.', without.id);
  const withoutText = await pdfText(await documents.ordinance(repo.matters.get(without.id)));
  assert.match(withoutText, /EFFECTIVE DATE/, 'standard clause missing when the text supplies none');
});

test('documents: an undrafted ordinance says so rather than printing an empty instrument', async () => {
  const b = repo.bodies.insert({ name: 'Empty Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Not yet drafted', status: 'Draft', body_id: b });
  const text = await pdfText(await documents.ordinance(repo.matters.get(m.id)));
  assert.match(text, /has not been drafted/i);
});

test('documents: the board letter states fiscal impact even when there is none', async () => {
  const b = repo.bodies.insert({ name: 'BL Board', type: 'Governing Body', seats: 3 });
  const p = repo.people.insert({ full_name: 'Dana Sponsor', email: 'dana@test.gov' });
  repo.bodies.addMember(b, p, 'Chair');
  const m = repo.matters.insertNumbered({
    type: 'Resolution', title: 'A Resolution of thanks', status: 'Introduced',
    body_id: b, summary: 'Thanks the retiring clerk.',
  });
  repo.matters.addSponsor(m.id, p);

  const text = await pdfText(await documents.boardLetter(repo.matters.get(m.id)));
  assert.match(text, /AGENDA ITEM/);
  assert.match(text, /SUBJECT/);
  assert.match(text, /OVERVIEW/);
  // A board acts on the number; silence reads as "not considered".
  assert.match(text, /FISCAL IMPACT/);
  assert.match(text, /no fiscal impact/i);
  assert.match(text, /DANA SPONSOR/); // roster rail
});

test('documents: the approval log reproduces the routing record', async () => {
  const b = repo.bodies.insert({ name: 'Log Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Routed item', status: 'Introduced', body_id: b });
  repo.workflow.start(m.id, []);
  const text = await pdfText(await documents.approvalLog(repo.matters.get(m.id)));
  assert.match(text, /BOARD LETTER APPROVAL LOG/);
  assert.match(text, /Routed item/);
  const steps = repo.workflow.forMatter(m.id);
  assert.ok(steps.length > 0, 'expected a default route');
  // Every routed step appears; a log that silently omits one is worse than none.
  for (const s of steps) assert.ok(text.includes(s.name), `step missing from log: ${s.name}`);
});

test('documents: the published summary carries the meeting it gives notice of', async () => {
  const b = repo.bodies.insert({ name: 'Notice Board', type: 'Governing Body', seats: 3 });
  const mtId = repo.meetings.insert({ body_id: b, meeting_date: '2099-07-04', meeting_time: '9:00 AM', location: 'Boardroom' });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'A noticed ordinance', status: 'Introduced', body_id: b });
  const text = await pdfText(await documents.summaryForPublication(
    repo.matters.get(m.id), repo.meetings.get(mtId), { authority: 'Bylaws Article VII' }));
  assert.match(text, /SUMMARY OF PROPOSED ORDINANCE/);
  assert.match(text, /Notice is hereby given/);
  assert.match(text, /A NOTICED ORDINANCE/);
  assert.match(text, /Boardroom/);
  assert.match(text, /Bylaws Article VII/);
});

test('documents: the redline draws both sides of a code amendment', async () => {
  const b = repo.bodies.insert({ name: 'Redline Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'An Ordinance amending the Code', status: 'Introduced', body_id: b });
  db.prepare('UPDATE matters SET full_text=? WHERE id=?').run('SECTION 1. Purpose.\nTo amend.', m.id);
  repo.code.addAmendment(m.id, {
    op: 'amend', citation: '4.03',
    new_text: 'The Director shall publish the schedule each January.',
  });

  const redline = await pdfText(await documents.ordinance(repo.matters.get(m.id), { redline: true }));
  // comparativePrint() returns currentText/proposedText. Reading `current` and
  // `proposed` produced a redline that drew neither side while still looking
  // like a complete instrument — the failure this document exists to prevent.
  assert.match(redline, /CHANGES TO THE CODE/);
  assert.match(redline, /4\.03/);
  assert.match(redline, /The Director shall publish the schedule each January/);

  const clean = await pdfText(await documents.ordinance(repo.matters.get(m.id)));
  assert.match(clean, /SECTIONS AMENDED/);
  assert.match(clean, /The Director shall publish the schedule each January/);
  assert.ok(!/\(no text\)/.test(clean), 'amendment text rendered as a placeholder');
});

test('documents: recitals survive into the ordinance', async () => {
  const b = repo.bodies.insert({ name: 'Recital Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'An Ordinance with recitals', status: 'Introduced', body_id: b });
  // parse() keeps everything before the first section in `preamble`; flatten()
  // returns only sections, so recitals were being dropped silently.
  db.prepare('UPDATE matters SET full_text=? WHERE id=?').run(
    'WHEREAS the Board has determined that action is necessary; and\n'
    + 'WHEREAS notice was duly given;\n'
    + 'SECTION 1. Purpose.\nTo act.', m.id);
  const text = await pdfText(await documents.ordinance(repo.matters.get(m.id)));
  assert.match(text, /WHEREAS the Board has determined/);
  assert.match(text, /WHEREAS notice was duly given/);
  // Recitals come before the enacting clause.
  assert.ok(text.indexOf('WHEREAS the Board') < text.indexOf('ordains as follows'),
    'recitals must precede the enacting clause');

  // A recitals-only draft is drafted, not empty.
  const only = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Recitals only', status: 'Draft', body_id: b });
  db.prepare('UPDATE matters SET full_text=? WHERE id=?').run('WHEREAS something is true;', only.id);
  const onlyText = await pdfText(await documents.ordinance(repo.matters.get(only.id)));
  assert.ok(!/has not been drafted/i.test(onlyText), 'a recitals-only draft reported as undrafted');
});

test('documents: a summary cannot be produced without the meeting it notices', async () => {
  const b = repo.bodies.insert({ name: 'NoMeet Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Unnoticed', status: 'Introduced', body_id: b });
  await assert.rejects(() => documents.summaryForPublication(repo.matters.get(m.id), null),
    /requires the meeting/);
});

test('pdf layout: an oversized word is split wherever it lands, not only at line start', () => {
  const { Doc } = require('../src/pdfdoc');
  // A URL longer than the measure arriving mid-paragraph used to be pushed
  // whole, running off the page edge.
  const long = 'https://records.example.gov/' + 'x'.repeat(160) + '/notice.pdf';
  const fake = {
    contentW: 400,
    wrap: Doc.prototype.wrap,
    f: null,
  };
  const font = { widthOfTextAtSize: (s, size) => s.length * size * 0.5 };
  const lines = Doc.prototype.wrap.call(fake, 'See the notice at ' + long + ' for details.',
    { width: 200, size: 10, font });
  for (const l of lines) {
    assert.ok(font.widthOfTextAtSize(l, 10) <= 200,
      `line overflows the measure: ${l.slice(0, 40)}… (${font.widthOfTextAtSize(l, 10)}pt)`);
  }
  assert.ok(lines.join('').includes('notice.pdf'), 'the split lost part of the word');
});

test('legislation page offers only the documents its type can actually produce', () => {
  const pages = require('../src/views/pages');
  const b = repo.bodies.insert({ name: 'Offer Board', type: 'Governing Body', seats: 3 });
  const ord = repo.matters.insertNumbered({ type: 'Ordinance', title: 'An offered ordinance', status: 'Introduced', body_id: b });
  const res = repo.matters.insertNumbered({ type: 'Resolution', title: 'An offered resolution', status: 'Introduced', body_id: b });

  const linksFor = (m) => {
    const html = pages.matterDetail(repo.matters.get(m.id), {}, null);
    return [...String(html).matchAll(/\/legislation\/[^"']*\/doc\/([a-z-]+\.pdf)/g)].map((x) => x[1]);
  };

  // Ordinance instruments are gated by matter type at the route, so offering
  // them for a Resolution would link the page straight at a 404.
  const resLinks = linksFor(res);
  assert.ok(resLinks.includes('board-letter.pdf'));
  assert.ok(resLinks.includes('approval-log.pdf'));
  for (const gated of ['ordinance.pdf', 'ordinance-redline.pdf', 'summary.pdf']) {
    assert.ok(!resLinks.includes(gated), `a Resolution was offered ${gated}`);
  }

  const ordLinks = linksFor(ord);
  assert.ok(ordLinks.includes('ordinance.pdf'));
  assert.ok(ordLinks.includes('ordinance-redline.pdf'));

  // The summary names its meeting as the hearing, so it may only be offered
  // against a meeting this ordinance is actually on. An unrelated meeting
  // existing in the database must not produce a link — this test file shares
  // one database and earlier tests leave future meetings behind, so a global
  // "next meeting" lookup would appear to work here while being wrong.
  const otherBody = repo.bodies.insert({ name: 'Unrelated Body', type: 'Committee', seats: 3 });
  repo.meetings.insert({ body_id: otherBody, meeting_date: '2099-01-05' });
  assert.ok(!linksFor(ord).includes('summary.pdf'),
    'offered a notice against a meeting this ordinance is not on');

  // Once it is set down for a hearing, the link appears and carries that
  // meeting's id rather than any other.
  const hearing = repo.meetings.insert({ body_id: b, meeting_date: '2099-02-10' });
  repo.meetings.addItem({ meeting_id: hearing, matter_id: ord.id, section: 'Ordinances' });
  const html = String(pages.matterDetail(repo.matters.get(ord.id), {}, null));
  assert.match(html, /summary\.pdf\?meeting=/);
  const picked = html.match(/summary\.pdf\?meeting=(\d+)/);
  assert.equal(Number(picked[1]), Number(hearing),
    'the notice named a meeting other than the one this ordinance is set for');
});

test('notice: the meeting must be one the ordinance is actually set for', () => {
  const b = repo.bodies.insert({ name: 'Notice Guard Board', type: 'Governing Body', seats: 3 });
  const other = repo.bodies.insert({ name: 'Notice Other Body', type: 'Committee', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Guarded notice', status: 'Introduced', body_id: b });
  const heard = repo.meetings.insert({ body_id: b, meeting_date: '2099-03-01' });
  const unrelated = repo.meetings.insert({ body_id: other, meeting_date: '2099-03-02' });
  repo.meetings.addItem({ meeting_id: heard, matter_id: m.id });

  assert.equal(repo.meetings.isOnAgenda(heard, m.id), true);
  assert.equal(repo.meetings.isOnAgenda(unrelated, m.id), false);
  assert.equal(repo.meetings.nextAppearance(m.id, '2026-01-01').id, heard);
  // A cancelled hearing is not a hearing.
  repo.meetings.update(heard, { body_id: b, meeting_date: '2099-03-01', status: 'Cancelled' });
  assert.equal(repo.meetings.nextAppearance(m.id, '2026-01-01'), undefined);
});

// --- Board letter sections ----------------------------------------------------
test('letter: sections compose in configured order and blanks are omitted', async () => {
  const b = repo.bodies.insert({ name: 'Letter Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({
    type: 'Ordinance', title: 'A lettered ordinance', status: 'Introduced', body_id: b,
    summary: 'A short summary of the item.',
  });
  repo.letters.save(m.id, 'background', 'How this arrived here.');
  repo.letters.save(m.id, 'recommendation', 'Approve the introduction.');

  const text = await pdfText(await documents.boardLetter(repo.matters.get(m.id)));
  const order = ['OVERVIEW', 'RECOMMENDATION(S)', 'FISCAL IMPACT', 'BACKGROUND'];
  let at = -1;
  for (const label of order) {
    const i = text.indexOf(label);
    assert.ok(i > at, `${label} is out of order in the letter`);
    at = i;
  }
  // A section nobody answered is left out; an empty heading asserts an answer
  // was given.
  for (const blank of ['EQUITY IMPACT STATEMENT', 'BUSINESS IMPACT STATEMENT', 'LINKAGE']) {
    assert.ok(!text.includes(blank), `${blank} printed with nothing under it`);
  }
});

test('letter: required sections are reported until written', () => {
  const b = repo.bodies.insert({ name: 'Missing Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Incomplete', status: 'Draft', body_id: b });
  const required = repo.letters.sections().filter((s) => s.required).map((s) => s.label);
  assert.deepEqual(repo.letters.missing(m.id), required);

  for (const s of repo.letters.sections()) {
    if (s.required) repo.letters.save(m.id, s.key, 'Answered.');
  }
  assert.deepEqual(repo.letters.missing(m.id), []);
});

test('letter: a section key outside the configured list is refused', () => {
  const b = repo.bodies.insert({ name: 'Key Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Motion', title: 'Keyed', status: 'Draft', body_id: b });
  // Filing text under a key nothing renders loses it silently.
  assert.equal(repo.letters.save(m.id, 'not-a-section', 'text'), false);
  assert.equal(repo.letters.save(m.id, 'background', 'text'), true);
  assert.equal(repo.letters.forMatter(m.id)['not-a-section'], undefined);
});

test('letter: overview and fiscal fall back to the file when unwritten', async () => {
  const b = repo.bodies.insert({ name: 'Fallback Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({
    type: 'Resolution', title: 'Falls back', status: 'Introduced', body_id: b,
    summary: 'The summary standing in for an overview.',
  });
  repo.matters.setFiscal(m.id, { fiscal_impact: 12500, fiscal_recurring: 1 });
  const text = await pdfText(await documents.boardLetter(repo.matters.get(m.id)));
  assert.match(text, /The summary standing in for an overview/);
  assert.match(text, /12,500\.00/);
  assert.match(text, /ongoing annual cost/);
  // The fallback must land in its configured slot, not after everything else.
  assert.ok(text.indexOf('OVERVIEW') < text.indexOf('FISCAL IMPACT'));
});

test('letter: attachments are lettered so they can be cited', async () => {
  const b = repo.bodies.insert({ name: 'Attach Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'With attachments', status: 'Introduced', body_id: b });
  repo.matters.addAttachment({ matter_id: m.id, name: 'Clean ordinance', url: 'https://example.gov/a.pdf' });
  repo.matters.addAttachment({ matter_id: m.id, name: 'Redline ordinance', url: 'https://example.gov/b.pdf' });
  repo.matters.addAttachment({ matter_id: m.id, name: 'Summary of proposed ordinance', url: 'https://example.gov/c.pdf' });
  const text = await pdfText(await documents.boardLetter(repo.matters.get(m.id)));
  assert.match(text, /ATTACHMENT\(S\)/);
  assert.match(text, /Attachment A: Clean ordinance/);
  assert.match(text, /Attachment B: Redline ordinance/);
  assert.match(text, /Attachment C: Summary of proposed ordinance/);
});

test('letter config: a bad row rejects the whole list rather than dropping a section', () => {
  const P = repo.letters.parseSectionList;
  // A row without a delimiter used to be filtered out silently, removing that
  // section from the form and orphaning everything authored under it.
  const bad = P('overview | OVERVIEW | required\nRECOMMENDATIONS\nbackground | BACKGROUND');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Line 2/);

  // The same answer must not render under two headings.
  const dup = P('overview | OVERVIEW\noverview | SECOND OVERVIEW');
  assert.equal(dup.ok, false);
  assert.match(dup.error, /more than once/);

  assert.equal(P('').ok, false);
  assert.equal(P('bad key! | LABEL').ok, false);
  assert.equal(P('overview | OVERVIEW | maybe').ok, false);

  const good = P('overview | OVERVIEW | required | What is before the body.\nnotes | NOTES | optional');
  assert.equal(good.ok, true);
  assert.equal(good.list.length, 2);
  assert.equal(good.list[0].required, true);
  assert.equal(good.list[0].hint, 'What is before the body.');
  assert.equal(good.list[1].required, false);
});

test('letter config: saving the list unchanged preserves every field', () => {
  const drafting = require('../src/views/drafting');
  const before = repo.letters.sections();
  // Round-trip the rendered form through the parser. A serialisation narrower
  // than the parser silently strips whatever it omits — here, every hint.
  const html = String(drafting.letterSectionsAdmin(false));
  const text = html.slice(html.indexOf('<textarea'), html.indexOf('</textarea>'));
  // One pass over the entities. Chained replaces decoding &amp; first turn
  // "&amp;lt;" into "<" — the escaped text for "&lt;" comes back as a real
  // tag. A single pass cannot re-read what it has already written.
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  const body = text.slice(text.indexOf('>') + 1)
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITIES[e]);
  const parsed = repo.letters.parseSectionList(body);
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.list.map((s) => s.key), before.map((s) => s.key));
  assert.deepEqual(parsed.list.map((s) => s.required), before.map((s) => s.required));
  for (const s of parsed.list) {
    const orig = before.find((o) => o.key === s.key);
    assert.equal(s.hint, orig.hint || '', `hint lost for ${s.key}`);
    assert.equal(s.label, orig.label);
  }
});

test('letter: attachment labels continue past Z', async () => {
  const b = repo.bodies.insert({ name: 'Many Attach Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Many attachments', status: 'Introduced', body_id: b });
  for (let i = 0; i < 28; i++) {
    repo.matters.addAttachment({ matter_id: m.id, name: `Exhibit ${i + 1}`, url: 'https://example.gov/x.pdf' });
  }
  const text = await pdfText(await documents.boardLetter(repo.matters.get(m.id)));
  assert.match(text, /Attachment Z: Exhibit 26/);
  // fromCharCode(65 + 26) is "[", which is not a citable label.
  assert.match(text, /Attachment AA: Exhibit 27/);
  assert.match(text, /Attachment AB: Exhibit 28/);
  assert.ok(!text.includes('Attachment ['), 'lettering ran past the alphabet');
});

test('legislation page links to board letter authoring', () => {
  const pages = require('../src/views/pages');
  const b = repo.bodies.insert({ name: 'Reach Board', type: 'Governing Body', seats: 3 });
  const m = repo.matters.insertNumbered({ type: 'Ordinance', title: 'Reachable', status: 'Introduced', body_id: b });
  // A screen with no link into it is not shipped, whatever its routes do.
  const html = String(pages.matterDetail(repo.matters.get(m.id), {}, { role: 'clerk', id: 1 }));
  assert.match(html, new RegExp(`/admin/legislation/${m.file_number}/letter`),
    'no way to reach the board letter authoring screen');
});

// --- The packet binds documents, not names -----------------------------------
test('packet: each item\'s material is bound behind its tab', async () => {
  const pdfGen = require('../src/pdf');
  const b = repo.bodies.insert({ name: 'Bind Board', type: 'Governing Body', seats: 3 });
  const mtId = repo.meetings.insert({ body_id: b, meeting_date: '2099-06-01', meeting_time: '6:00 PM', location: 'Boardroom' });
  const ord = repo.matters.insertNumbered({ type: 'Ordinance', title: 'A bound ordinance', status: 'Introduced', body_id: b });
  const res = repo.matters.insertNumbered({ type: 'Resolution', title: 'A bound resolution', status: 'Introduced', body_id: b });
  db.prepare('UPDATE matters SET full_text=? WHERE id=?').run('SECTION 1. Purpose.\nTo bind.', ord.id);
  db.prepare('INSERT INTO reports (matter_id,title,kind,body_html) VALUES (?,?,?,?)')
    .run(res.id, 'Fiscal Note', 'Fiscal Note', '<p>No net cost.</p>');

  repo.meetings.addItem({ meeting_id: mtId, title: 'Call to Order', section: 'Call to Order' });
  repo.meetings.addMatters(mtId, [ord.id, res.id]);

  const text = await pdfText(await pdfGen.generatePacket(repo.meetings.get(mtId)));

  // The packet used to be a listing of document names. These assert the
  // documents themselves are present.
  assert.match(text, /AGENDA PACKET/);
  assert.match(text, /CONTENTS/);
  assert.match(text, /TAB 1/);
  assert.match(text, /AGENDA ITEM/, 'no board letter bound');
  assert.match(text, /ORDINANCE NO\./, 'no ordinance bound');
  assert.match(text, /REDLINE/, 'no redline bound');
  assert.match(text, /SUMMARY OF PROPOSED ORDINANCE/, 'no notice bound');
  assert.match(text, /No net cost/, 'no staff report bound');

  // The resolution must not be bound as an ordinance.
  const ordCount = (text.match(/ORDINANCE NO\./g) || []).length;
  assert.equal(ordCount, 2, 'expected clean + redline for the one ordinance only');

  // A procedural item keeps its place in the contents but takes no tab.
  assert.match(text, /Call to Order/);
});

test('packet: a document that cannot be bound is named, not silently dropped', async () => {
  const pdfGen = require('../src/pdf');
  const b = repo.bodies.insert({ name: 'Gap Board', type: 'Governing Body', seats: 3 });
  const mtId = repo.meetings.insert({ body_id: b, meeting_date: '2099-06-02' });
  const m = repo.matters.insertNumbered({ type: 'Motion', title: 'Has an unreachable exhibit', status: 'Introduced', body_id: b });
  repo.matters.addAttachment({ matter_id: m.id, name: 'Exhibit 1 — Map', url: 'https://example.invalid/nowhere.pdf' });
  repo.meetings.addMatters(mtId, [m.id]);

  const text = await pdfText(await pdfGen.generatePacket(repo.meetings.get(mtId)));
  // A gap the reader has to notice is the failure mode; the packet says so.
  assert.match(text, /INCOMPLETE PACKET/);
  assert.match(text, /Exhibit 1/);
  assert.match(text, /could not be/i);
});

test('packet: an item held back contributes nothing and closes the tabs up', async () => {
  const pdfGen = require('../src/pdf');
  const b = repo.bodies.insert({ name: 'Held Board', type: 'Governing Body', seats: 3 });
  const mtId = repo.meetings.insert({ body_id: b, meeting_date: '2099-06-03' });
  const one = repo.matters.insertNumbered({ type: 'Motion', title: 'Held back item', status: 'Introduced', body_id: b });
  const two = repo.matters.insertNumbered({ type: 'Motion', title: 'Kept item', status: 'Introduced', body_id: b });
  repo.meetings.addMatters(mtId, [one.id, two.id]);
  const items = repo.meetings.items(mtId);
  db.prepare('INSERT INTO reports (matter_id,title,kind,body_html) VALUES (?,?,?,?)')
    .run(one.id, 'R1', 'Report', '<p>Withheld content marker.</p>');
  db.prepare('INSERT INTO reports (matter_id,title,kind,body_html) VALUES (?,?,?,?)')
    .run(two.id, 'R2', 'Report', '<p>Kept content marker.</p>');

  repo.meetings.setInPacket(items.find((i) => i.matter_id === one.id).id, 0);
  const text = await pdfText(await pdfGen.generatePacket(repo.meetings.get(mtId)));
  assert.ok(!text.includes('Withheld content marker'), 'held-back material was bound anyway');
  assert.match(text, /Kept content marker/);
  // The kept item takes tab 1, not tab 2.
  assert.match(text, /TAB 1/);
  assert.ok(!/TAB 2/.test(text), 'tabs did not close up after the held-back item');
});

// --- The seal ------------------------------------------------------------------
test('seal: the legend fits its arc at any name length', () => {
  const seal = require('../src/seal');
  const size = (svg) => Number((svg.match(/font-size="([\d.]+)" letter-spacing/) || [])[1]);
  // SVG stops drawing at the end of a path, so a legend that does not fit is
  // not compressed — it loses its head and tail and reads as nonsense. The
  // type has to shrink, not just the tracking.
  const short = seal.sealSvg({ size: 150, legend: 'Board of Governors' });
  const long = seal.sealSvg({ size: 150, legend: 'Board of Governors of Blevins Holdings Corporation' });
  assert.ok(size(long) < size(short), 'a longer legend must be set smaller');

  // Past the readable floor the name is cut at a word boundary and marked,
  // rather than left for the renderer to drop silently.
  const huge = seal.sealSvg({ size: 150,
    legend: 'Board of Governors of Blevins Holdings Corporation and its Subsidiaries' });
  assert.match(huge, /\u2026/, 'an unfittable legend must be visibly truncated');

  // Whatever the length, the estimated run has to fit the arc it is set on.
  for (const legend of ['BG', 'Finance Committee', 'Board of Governors',
    'Board of Governors of Blevins Holdings Corporation and its Subsidiaries']) {
    const svg = seal.sealSvg({ size: 150, legend });
    const fs2 = size(svg);
    const track = Number((svg.match(/font-size="[\d.]+" letter-spacing="([\d.-]+)"/) || [])[1]);
    // Measure what is actually set, which for a very long name is a
    // deliberately truncated form rather than the whole thing.
    const set = (svg.match(/text-anchor="middle">([^<]*)<\/textPath>/) || [])[1] || '';
    const run = set.length * (0.62 * fs2 + track);
    assert.ok(run <= Math.PI * 42.4 * 0.85,
      `"${legend}" needs ${run.toFixed(1)} units on an arc of ${(Math.PI * 42.4 * 0.84).toFixed(1)}`);
  }
});

test('seal: gives way to the cipher where a legend could not be read', () => {
  const seal = require('../src/seal');
  assert.match(seal.sealSvg({ size: 96 }), /seal-svg/);
  // A ring legend at 40px is ornament pretending to be information.
  assert.match(seal.sealSvg({ size: 40 }), /monogram-svg/);
  assert.match(seal.sealSvg({ size: 63 }), /monogram-svg/);
});

test('seal: the ground names the surface, and the device reverses onto it', () => {
  const seal = require('../src/seal');
  // layout.js reads `variant: light` as light-coloured artwork FOR a dark
  // ground — the opposite of this module's reading. The two conventions
  // meeting put a white disc on the navy rail, so this asserts the direction.
  const onDark = seal.sealSvg({ size: 96, ground: 'dark' });
  const onLight = seal.sealSvg({ size: 96, ground: 'light' });
  assert.match(onDark, /#D9B450/, 'a device on a dark ground is brass');
  assert.ok(!/fill="#FFFFFF"/.test(onDark), 'a device on a dark ground leaves its field open');
  assert.match(onLight, /#353D4F/, 'a device on paper is navy');
  assert.match(onLight, /fill="#FFFFFF"/, 'a device on paper carries a white field');
});

test('seal: the cipher is built from the words that carry the name', () => {
  const seal = require('../src/seal');
  // "BOG" reads as a word, not a cipher — articles and conjunctions are skipped.
  assert.equal(seal.initials('Board of Governors'), 'BG');
  assert.equal(seal.initials('Finance Committee'), 'FC');
  assert.equal(seal.initials('Department of Public Works and Utilities'), 'DPW');
  assert.equal(seal.initials(''), 'BG');
});

test('seal: the legend is escaped, not interpolated', () => {
  const seal = require('../src/seal');
  // The legend is the organisation name, which is admin-editable.
  const svg = seal.sealSvg({ size: 96, legend: '<script>alert(1)</script>', counter: 'A & B' });
  assert.ok(!svg.includes('<script>'), 'markup survived into the seal');
  assert.match(svg, /&amp;/);
});

// --- Typesetting: justification and footnotes ---------------------------------
// Word positions in drawing order, read straight from each Tm/Tj pair in the
// content stream. text() now draws one word per operator (needed to place a
// justified gap or a superscript marker between words), so this is what lets
// a test tell a stretched line from a natural one without a PDF renderer.
function pdfWordRuns(bytes) {
  const zlib = require('node:zlib');
  const buf = Buffer.from(bytes);
  const runs = [];
  let idx = 0;
  for (;;) {
    const start = buf.indexOf('stream', idx);
    if (start === -1) break;
    let s = start + 6;
    if (buf[s] === 0x0d) s++;
    if (buf[s] === 0x0a) s++;
    const end = buf.indexOf('endstream', s);
    if (end === -1) break;
    idx = end + 9;
    let body;
    try { body = zlib.inflateSync(buf.subarray(s, end)).toString('latin1'); }
    catch { continue; }
    if (!body.includes(' Tm')) continue; // not a page content stream
    const pageRuns = [];
    const re = /1 0 0 1 ([-\d.]+) ([-\d.]+) Tm\s*\n(?:<([0-9A-Fa-f\s]+)>|\(((?:\\.|[^()\\])*)\))\s*Tj/g;
    for (const m of body.matchAll(re)) {
      let text;
      if (m[3]) {
        const hex = m[3].replace(/\s+/g, '');
        text = '';
        for (let i = 0; i + 1 < hex.length; i += 2) text += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      } else {
        text = m[4].replace(/\\([()\\])/g, '$1');
      }
      pageRuns.push({ x: Number(m[1]), y: Number(m[2]), text });
    }
    if (pageRuns.length) runs.push(pageRuns);
  }
  return runs; // one array per page
}

test('typesetting: justify stretches every line but the last to reach the full measure', async () => {
  const { Doc } = require('../src/pdfdoc');
  const words = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november '
    + 'oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one';
  const probe = await Doc.create({});
  const wordWidth = (w) => probe.f.r.widthOfTextAtSize(w, 11);

  const build = async (justify) => {
    const doc = await Doc.create({});
    doc.text(words, { size: 11, justify });
    return doc.save();
  };
  const ragged = pdfWordRuns(await build(false))[0];
  const justified = pdfWordRuns(await build(true))[0];

  const rightEdge = 72 + probe.contentW; // margin.left + contentW
  const lineEnd = (runs, y) => {
    const onLine = runs.filter((r) => r.y === y);
    const last = onLine[onLine.length - 1];
    return last.x + wordWidth(last.text);
  };
  const firstLineY = ragged[0].y;

  // Same text, same wrap points — justification changes spacing, not where a
  // line breaks — so both must still wrap identically.
  assert.deepEqual(ragged.map((r) => r.text), justified.map((r) => r.text));

  // Unjustified: natural word-spacing leaves the first line short of the
  // margin, same as any ordinary word processor set left-aligned.
  assert.ok(lineEnd(ragged, firstLineY) < rightEdge - 5,
    `expected the unjustified line to fall short of the margin (ended at ${lineEnd(ragged, firstLineY).toFixed(1)}, margin ${rightEdge})`);

  // Justified: the line's own right edge — start of the last word plus that
  // word's real width — lands on the margin, not merely somewhere further
  // right than before.
  assert.ok(Math.abs(lineEnd(justified, firstLineY) - rightEdge) < 1.5,
    `justified line did not reach the margin (ended at ${lineEnd(justified, firstLineY).toFixed(1)}, margin ${rightEdge})`);

  // The last line of the block must stay ragged even with justify:true —
  // stretching a paragraph's final, often short, line is the one thing full
  // justification is not supposed to do.
  const lastLineY = Math.min(...ragged.map((r) => r.y));
  assert.equal(lineEnd(justified, lastLineY), lineEnd(ragged, lastLineY),
    'the last line of the paragraph was stretched; only interior lines should justify');
});

test('typesetting: a hanging line justifies to the same right edge as the first', async () => {
  const { Doc } = require('../src/pdfdoc');
  const probe = await Doc.create({});
  const wordWidth = (w) => probe.f.r.widthOfTextAtSize(w, 11);
  const indent = 22;
  const hanging = 18;

  const doc = await Doc.create({});
  // A hanging block long enough to wrap to three lines: first line at
  // `indent`, continuation lines at `indent + hanging` — a narrower measure,
  // rendered further right. Both must still reach the same right edge once
  // justified, which only happens if the first line is justified against the
  // *wider* target (margin.left + indent + width) rather than the narrower
  // one it was wrapped against.
  doc.text('(a) A statutory subsection long enough to run past two full lines so that the '
    + 'hanging indent actually engages more than once and every continuation line has its '
    + 'own right edge to check against the first',
  { size: 11, indent, hanging, justify: true });
  const runs = pdfWordRuns(await doc.save())[0];
  const byLine = [...new Set(runs.map((r) => r.y))].sort((a, b) => b - a);
  assert.ok(byLine.length >= 3, `expected at least three lines, wrapped to ${byLine.length}`);

  const lineEnd = (y) => {
    const onLine = runs.filter((r) => r.y === y);
    const last = onLine[onLine.length - 1];
    return last.x + wordWidth(last.text);
  };
  // The right edge every interior line should reach: margin + indent + width,
  // derived independently of how text() computed it internally.
  const expectedEdge = probe.margin.left + indent + (probe.contentW - indent);
  for (const y of byLine.slice(0, -1)) {
    assert.ok(Math.abs(lineEnd(y) - expectedEdge) < 1.5,
      `interior line at y=${y} ended at ${lineEnd(y).toFixed(1)}, expected ${expectedEdge.toFixed(1)}`);
  }
});

test('typesetting: a footnote marker prints where it is registered, and only the last line is exempt from justification', async () => {
  const { Doc } = require('../src/pdfdoc');
  const doc = await Doc.create({});
  doc.text('This clause cites the statute^1 as its basis.',
    { size: 11, justify: true, notes: { 1: 'The cited statute, in full.' } });
  const bytes = await doc.save();
  const text = await pdfText(bytes);
  assert.match(text, /statute/);
  assert.match(text, /1\. The cited statute, in full\./, 'the footnote text was not printed');
  // The marker digit is its own run, drawn immediately after the word it
  // footnotes and raised — not literally concatenated into "statute1".
  const runs = pdfWordRuns(bytes)[0];
  const wordIdx = runs.findIndex((r) => r.text === 'statute');
  assert.ok(wordIdx >= 0, 'the footnoted word was not found as its own run');
  const marker = runs[wordIdx + 1];
  assert.equal(marker.text, '1');
  assert.ok(marker.y > runs[wordIdx].y, 'the marker was not raised above the baseline');
});

test('typesetting: need() treats a registered footnote as part of the bottom margin', async () => {
  const { Doc } = require('../src/pdfdoc');
  const doc = await Doc.create({});
  doc.text('A cited clause^1.', { size: 11, notes: { 1: 'A note.' } });
  assert.ok(doc.footnoteReserve > 0, 'registering a note did not reserve any space');

  const pagesBefore = doc.pages.length;
  // Placed exactly far enough above the reserved band that ignoring the
  // reserve would say this fits, and honouring it would not.
  doc.y = doc.margin.bottom + doc.footnoteReserve + 2;
  doc.need(10);
  assert.equal(doc.pages.length, pagesBefore + 1,
    'need() let body text run into the space reserved for this page\'s footnote');
});

test('typesetting: a footnote registered on a later page prints on that page, not the first', async () => {
  const { Doc } = require('../src/pdfdoc');
  const doc = await Doc.create({});
  // Fill page 1 to force a break, then register a note — it must not bleed
  // onto the page it was nowhere near.
  for (let i = 0; i < 40; i++) doc.text(`Filler line number ${i} to consume the page.`, { size: 11, after: 4 });
  doc.text('A cited clause^1 on the second page.', { size: 11, notes: { 1: 'Second-page note text.' } });
  const bytes = await doc.save();
  const pages = pdfWordRuns(bytes);
  assert.ok(pages.length >= 2, 'expected the filler to force a second page');
  const hasNote = (page) => page.some((r) => r.text.includes('Second-page'));
  assert.ok(!hasNote(pages[0]), 'the footnote leaked onto the first page');
  assert.ok(pages.slice(1).some(hasNote), 'the footnote never appeared on any later page');
});
