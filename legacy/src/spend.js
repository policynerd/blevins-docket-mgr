'use strict';

// Spend and expense against an adopted appropriation.
//
// Governance decides. The budget names the authority. This module is the
// request to use the money: an expense or a commitment that a person submits,
// another person approves, and the ledger only records once it is posted.
//
// A clerk typing a transaction straight onto a line is still allowed — that
// is how imported actuals arrive. A request is what an employee of Blevins
// Holdings uses when the spend has to survive a question.

const { db } = require('./db');
const auth = require('./auth');

const KINDS = ['expense', 'commitment', 'reimbursement'];
const STATUSES = ['Draft', 'Submitted', 'Approved', 'Denied', 'Posted', 'Voided'];
const OPEN = new Set(['Submitted', 'Approved']);

function canSubmit(user) {
  return auth.hasRole(user, 'staff') || auth.hasRole(user, 'clerk');
}

function canDecide(user) {
  return auth.hasRole(user, 'clerk');
}

function get(id) {
  return db.prepare(`
    SELECT s.*, bl.name AS line_name, bl.kind AS line_kind, b.fiscal_year,
           b.id AS budget_id, ou.name AS org_unit_name,
           m.file_number, m.title AS matter_title
    FROM spend_requests s
    LEFT JOIN budget_lines bl ON bl.id = s.budget_line_id
    LEFT JOIN budgets b ON b.id = bl.budget_id
    LEFT JOIN org_units ou ON ou.id = s.org_unit_id
    LEFT JOIN matters m ON m.id = s.matter_id
    WHERE s.id = ?`).get(id);
}

function list({ status = null, budgetLineId = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('s.status = ?'); args.push(status); }
  if (budgetLineId) { where.push('s.budget_line_id = ?'); args.push(budgetLineId); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  args.push(limit);
  return db.prepare(`
    SELECT s.*, bl.name AS line_name, b.fiscal_year
    FROM spend_requests s
    LEFT JOIN budget_lines bl ON bl.id = s.budget_line_id
    LEFT JOIN budgets b ON b.id = bl.budget_id
    ${clause}
    ORDER BY s.id DESC LIMIT ?`).all(...args);
}

function reservedOnLine(lineId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS n
    FROM spend_requests
    WHERE budget_line_id = ? AND status IN ('Submitted', 'Approved')`).get(lineId);
  return row ? row.n : 0;
}

function create(s, actor) {
  if (!canSubmit(actor)) throw Object.assign(new Error('Staff or clerk may file a spend request.'), { code: 'FORBIDDEN' });
  const title = String(s.title || '').trim();
  const amount = Number(s.amount);
  if (!title) throw new Error('A spend request needs a title.');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be a positive number.');
  const kind = KINDS.includes(s.kind) ? s.kind : 'expense';
  const id = db.prepare(`
    INSERT INTO spend_requests
      (kind, status, budget_line_id, org_unit_id, matter_id, vendor_name,
       title, purpose, amount, requested_by, requested_by_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    kind, 'Draft',
    s.budget_line_id || null, s.org_unit_id || null, s.matter_id || null,
    (s.vendor_name || '').trim() || null,
    title, (s.purpose || '').trim() || null, amount,
    actor && actor.id || null, actor && actor.name || null).lastInsertRowid;
  return get(id);
}

function submit(id, actor) {
  const row = get(id);
  if (!row) throw new Error('Spend request not found.');
  if (row.status !== 'Draft') throw new Error('Only a draft can be submitted.');
  if (!canSubmit(actor)) throw Object.assign(new Error('Not permitted.'), { code: 'FORBIDDEN' });
  if (!row.budget_line_id) throw new Error('Choose the appropriation line before submitting.');
  db.prepare(`UPDATE spend_requests SET status='Submitted', submitted_at=datetime('now') WHERE id=?`)
    .run(id);
  return get(id);
}

function decide(id, { status, note }, actor) {
  const row = get(id);
  if (!row) throw new Error('Spend request not found.');
  if (row.status !== 'Submitted') throw new Error('Only a submitted request can be decided.');
  if (!canDecide(actor)) throw Object.assign(new Error('A clerk must decide this request.'), { code: 'FORBIDDEN' });
  if (row.requested_by && actor && actor.id && Number(row.requested_by) === Number(actor.id)) {
    throw new Error('The person who filed a spend request cannot approve it.');
  }
  if (status !== 'Approved' && status !== 'Denied') throw new Error('Decide by approving or denying.');
  db.prepare(`
    UPDATE spend_requests
    SET status=?, decided_by=?, decided_by_name=?, decided_at=datetime('now'), decision_note=?
    WHERE id=?`).run(status, actor && actor.id || null, actor && actor.name || null,
    (note || '').trim() || null, id);
  return get(id);
}

function post(id, actor) {
  const row = get(id);
  if (!row) throw new Error('Spend request not found.');
  if (row.status !== 'Approved') throw new Error('Only an approved request can be posted to the ledger.');
  if (!canDecide(actor)) throw Object.assign(new Error('A clerk must post this request.'), { code: 'FORBIDDEN' });
  if (!row.budget_line_id) throw new Error('The request has no appropriation line.');
  const desc = [row.title, row.vendor_name ? `(${row.vendor_name})` : null].filter(Boolean).join(' ');
  const txId = db.prepare(`
    INSERT INTO budget_transactions
      (budget_line_id, tx_date, description, amount, spend_request_id)
    VALUES (?,?,?,?,?)`).run(
    row.budget_line_id,
    new Date().toISOString().slice(0, 10),
    desc,
    row.amount,
    row.id).lastInsertRowid;
  db.prepare(`UPDATE spend_requests SET status='Posted', posted_tx_id=? WHERE id=?`).run(txId, id);
  return get(id);
}

function voidRequest(id, actor) {
  const row = get(id);
  if (!row) throw new Error('Spend request not found.');
  if (row.status === 'Posted') throw new Error('A posted expense stays on the ledger; reverse it with a new transaction.');
  if (!canDecide(actor)) throw Object.assign(new Error('A clerk must void this request.'), { code: 'FORBIDDEN' });
  db.prepare(`UPDATE spend_requests SET status='Voided' WHERE id=?`).run(id);
  return get(id);
}

module.exports = {
  KINDS, STATUSES, OPEN,
  canSubmit, canDecide,
  get, list, reservedOnLine,
  create, submit, decide, post, voidRequest,
};
