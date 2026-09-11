'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spend-test-')), 'test.db');

const { init } = require('../src/db');
init();
const repo = require('../src/repo');
const spend = require('../src/spend');

const { db } = require('../src/db');
const insUser = db.prepare(`INSERT INTO users (name, email, role) VALUES (?,?,?)`);
const staff = { id: Number(insUser.run('Controller', 'controller@board.gov', 'staff').lastInsertRowid), name: 'Controller', role: 'staff' };
const clerk = { id: Number(insUser.run('Clerk of the Board', 'clerk@board.gov', 'clerk').lastInsertRowid), name: 'Clerk of the Board', role: 'clerk' };
const otherClerk = { id: Number(insUser.run('Deputy Clerk', 'deputy@board.gov', 'clerk').lastInsertRowid), name: 'Deputy Clerk', role: 'clerk' };

const budgetId = repo.budget.create({ fiscal_year: 'FY2026', status: 'Adopted' });
const theLine = repo.budget.addLine({
  budget_id: budgetId, name: 'Professional services', kind: 'Expense', amount: 50000,
});

test('a staff member can file a draft expense against a line', () => {
  const row = spend.create({
    title: 'Outside counsel invoice',
    amount: 1200,
    budget_line_id: theLine,
    kind: 'expense',
    vendor_name: 'Example LLP',
  }, staff);
  assert.equal(row.status, 'Draft');
  assert.equal(row.amount, 1200);
  assert.equal(row.requested_by_name, 'Controller');
});

test('a draft cannot be posted, and a submitted request reserves the line', () => {
  const row = spend.create({
    title: 'Translation',
    amount: 400,
    budget_line_id: theLine,
  }, staff);
  assert.throws(() => spend.post(row.id, clerk), /approved/);
  spend.submit(row.id, staff);
  assert.equal(spend.get(row.id).status, 'Submitted');
  assert.ok(spend.reservedOnLine(theLine) >= 400);
});

test('the filer cannot approve their own request', () => {
  const row = spend.create({
    title: 'Self deal',
    amount: 50,
    budget_line_id: theLine,
  }, clerk);
  spend.submit(row.id, clerk);
  assert.throws(() => spend.decide(row.id, { status: 'Approved' }, clerk), /cannot approve/);
});

test('a different clerk approves and posts, which writes a ledger row', () => {
  const row = spend.create({
    title: 'Stenographer',
    amount: 800,
    budget_line_id: theLine,
    vendor_name: 'Record Co',
  }, staff);
  spend.submit(row.id, staff);
  spend.decide(row.id, { status: 'Approved', note: 'Within the line.' }, clerk);
  const posted = spend.post(row.id, clerk);
  assert.equal(posted.status, 'Posted');
  assert.ok(posted.posted_tx_id);
  const tx = repo.budget.getTransaction(posted.posted_tx_id);
  assert.equal(tx.amount, 800);
  assert.match(tx.description, /Stenographer/);
  assert.equal(tx.spend_request_id, posted.id);
});

test('a posted request cannot be voided', () => {
  const posted = spend.list({ status: 'Posted' })[0];
  assert.ok(posted);
  assert.throws(() => spend.voidRequest(posted.id, clerk), /posted expense stays/);
});

test('staff cannot decide or post', () => {
  const row = spend.create({
    title: 'Toner',
    amount: 30,
    budget_line_id: theLine,
  }, staff);
  spend.submit(row.id, staff);
  assert.throws(() => spend.decide(row.id, { status: 'Approved' }, staff), /clerk must decide/i);
});

test('another clerk may deny', () => {
  const row = spend.create({
    title: 'Unused software',
    amount: 9000,
    budget_line_id: theLine,
  }, staff);
  spend.submit(row.id, staff);
  const denied = spend.decide(row.id, { status: 'Denied', note: 'Not in the adopted program.' }, otherClerk);
  assert.equal(denied.status, 'Denied');
});
