'use strict';

const { html, raw, formatDate, todayISO } = require('../util');
const { layout, card, statusBadge, emptyState, escapeText } = require('./layout');
const auth = require('../auth');
const repo = require('../repo');

function money(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Signed display for amendments: +$5,000.00 / −$2,000.00.
function signedMoney(n) {
  const v = Number(n) || 0;
  return (v >= 0 ? '+' : '−') + money(Math.abs(v));
}

// The organizational unit that holds an appropriation.
//
// `category` is the accounting grouping and stays as it is; this is the part
// of the organization answerable for the money. Without it the budget and the
// org chart were two lists of department names that could disagree with each
// other, and neither could be asked what the other knew.
function unitOpts(current) {
  return '<option value="">— unassigned —</option>'
    + repo.org.options().map((o) => `<option value="${o.value}"`
      + `${String(o.value) === String(current) ? ' selected' : ''}>`
      + `${escapeText(o.label)}</option>`).join('');
}

function selectOptions(values, current) {
  return values.map((v) => `<option value="${escapeText(v)}"${String(v) === String(current) ? ' selected' : ''}>${escapeText(v)}</option>`).join('');
}

// ---- Public + clerk list --------------------------------------------------
function budgetList(user) {
  const isClerk = auth.hasRole(user, 'clerk');
  const rows = repo.budget.all();
  const table = rows.length ? `<table class="data">
    <thead><tr><th>Fiscal year</th><th>Status</th><th>Lines</th><th class="num">Budgeted</th><th></th></tr></thead>
    <tbody>${rows.map((b) => html`
      <tr>
        <td><a href="/budget/${b.id}">${b.fiscal_year}</a></td>
        <td>${statusBadge(b.status)}</td>
        <td>${b.line_count}</td>
        <td class="num">${raw(money(b.budgeted))}</td>
        <td><a class="btn-link" href="/budget/${b.id}/dashboard">Dashboard</a></td>
      </tr>`).join('')}</tbody></table>` : emptyState('No budgets yet.');

  const links = [
    rows.length > 1 ? `<a href="/budget/compare?a=${rows[1].id}&amp;b=${rows[0].id}">Compare fiscal years →</a>` : '',
    repo.budget.appropriationCount() ? '<a href="/budget/appropriations">Appropriation accounts →</a>' : '',
    (repo.tas.count() || isClerk) ? '<a href="/budget/accounts">Account register (TAS) →</a>' : '',
  ].filter(Boolean);
  const compare = links.length ? `<p class="muted">${links.join(' &nbsp;·&nbsp; ')}</p>` : '';

  const newForm = isClerk ? card('New fiscal year', html`
    <form class="form inline-form" method="post" action="/admin/budget">
      <div class="form-row">
        <label>Fiscal year<input type="text" name="fiscal_year" required placeholder="FY2026"></label>
        <label>Status<select name="status">${raw(selectOptions(repo.BUDGET_STATUSES, 'Draft'))}</select></label>
      </div>
      <button type="submit" class="btn primary">Create budget</button>
    </form>`) : '';

  const body = html`
    <p class="muted">Adopted and proposed fiscal-year budgets. Legislative items with a fiscal impact roll up into the lines below.</p>
    ${raw(card('Budgets', table + compare))}
    ${raw(newForm)}`;
  return layout({ title: 'Budget', active: '/budget', subtitle: 'Fiscal-year budgets, amendments, and spending.', body });
}

function bar(used, total) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const over = used > total && total > 0;
  return `<div class="budget-bar"><span style="width:${pct}%" class="${over ? 'over' : ''}"></span></div>`;
}

// Category-grouped rows (with subtotals) for the detail grid.
// Columns: Line | Adopted | Amended | Current | Spent | Remaining | Used
function lineSection(lines) {
  const groups = new Map();
  for (const l of lines) {
    const cat = l.category || 'Uncategorized';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(l);
  }
  const t = { adopted: 0, amended: 0, current: 0, actual: 0 };
  const rows = [...groups.entries()].map(([cat, items]) => {
    const c = { adopted: 0, amended: 0, current: 0, actual: 0 };
    const r = items.map((l) => {
      const current = l.amount + l.amended;
      c.adopted += l.amount; c.amended += l.amended; c.current += current; c.actual += l.actual;
      t.adopted += l.amount; t.amended += l.amended; t.current += current; t.actual += l.actual;
      const codeTag = l.appropriation_code
        ? `<div class="sub muted"><a href="/budget/appropriations/${encodeURIComponent(l.appropriation_code)}">${escapeText(l.appropriation_code)}</a>${l.project_code ? ' · ' + escapeText(l.project_code) : ''}</div>`
        : '';
      // Who holds the money, linked. The budget and the org chart are the same
      // organization seen from two sides, and this is the seam between them.
      const unitTag = l.org_unit_id
        ? `<div class="sub muted">Held by <a href="/org/${l.org_unit_id}">${escapeText(l.org_unit_name || 'unit')}</a></div>`
        : '';
      return `<tr><td><a href="/budget/lines/${l.id}">${escapeText(l.name)}</a>${l.item_count
        ? ` <span class="muted">· ${l.item_count} file${l.item_count > 1 ? 's' : ''}</span>` : ''}${codeTag}${unitTag}</td>`
        + `<td class="num">${money(l.amount)}</td>`
        + `<td class="num">${l.amended ? signedMoney(l.amended) : '<span class="muted">—</span>'}</td>`
        + `<td class="num">${money(current)}</td>`
        + `<td class="num">${money(l.actual)}</td>`
        + `<td class="num">${money(current - l.actual)}</td>`
        + `<td>${bar(l.actual, current)}</td></tr>`;
    }).join('');
    return `<tr class="cat-row"><th colspan="7">${escapeText(cat)}</th></tr>${r}`
      + `<tr class="subtotal"><td>Subtotal — ${escapeText(cat)}</td><td class="num">${money(c.adopted)}</td>`
      + `<td class="num">${c.amended ? signedMoney(c.amended) : ''}</td><td class="num">${money(c.current)}</td>`
      + `<td class="num">${money(c.actual)}</td><td class="num">${money(c.current - c.actual)}</td><td></td></tr>`;
  }).join('');
  return { rows, t };
}

const GRID_HEAD = '<thead><tr><th>Line item</th><th class="num">Adopted</th><th class="num">Amended</th>'
  + '<th class="num">Current</th><th class="num">Spent</th><th class="num">Remaining</th><th>Used</th></tr></thead>';

// ---- Detail (read for all; manage controls for clerk) ---------------------
function budgetDetail(b, user) {
  const isClerk = auth.hasRole(user, 'clerk');
  const lines = repo.budget.lines(b.id);
  const sum = repo.budget.summary(b.id);
  const expenses = lines.filter((l) => l.kind !== 'Revenue');
  const revenues = lines.filter((l) => l.kind === 'Revenue');

  const grand = (t, label) => `<tr class="grand"><td>${label}</td><td class="num">${money(t.adopted)}</td>`
    + `<td class="num">${t.amended ? signedMoney(t.amended) : ''}</td><td class="num">${money(t.current)}</td>`
    + `<td class="num">${money(t.actual)}</td><td class="num">${money(t.current - t.actual)}</td><td></td></tr>`;

  const expSec = lineSection(expenses);
  const expTable = expenses.length
    ? `<table class="data budget-table">${GRID_HEAD}<tbody>${expSec.rows}${grand(expSec.t, 'Total expenses')}</tbody></table>`
    : emptyState('No expense line items yet.');
  const revSec = lineSection(revenues);
  const revTable = revenues.length
    ? `<table class="data budget-table">${GRID_HEAD.replace('Spent', 'Received')}<tbody>${revSec.rows}${grand(revSec.t, 'Total revenue')}</tbody></table>`
    : '';

  const adoptedBy = b.adopted_matter_id ? repo.matters.get(b.adopted_matter_id) : null;
  const summaryCard = card('Summary', `
    <div class="budget-summary">
      <div><span class="bs-n">${escapeText(money(sum.expBudgeted))}</span><span class="bs-l">Adopted (expenses)</span></div>
      <div><span class="bs-n">${escapeText(money(sum.expCurrent))}</span><span class="bs-l">Current (after amendments)</span></div>
      <div><span class="bs-n">${escapeText(money(sum.expActual))}</span><span class="bs-l">Spent to date</span></div>
      <div><span class="bs-n">${escapeText(money(sum.expRemaining))}</span><span class="bs-l">Remaining</span></div>
      ${sum.hasRevenue ? `<div><span class="bs-n">${escapeText(money(sum.revActual))}</span><span class="bs-l">Revenue received</span></div>` : ''}
    </div>${bar(sum.expActual, sum.expCurrent)}
    ${adoptedBy ? `<p class="muted">Adopted by <a href="/legislation/${encodeURIComponent(adoptedBy.file_number)}">${escapeText(adoptedBy.file_number)}</a> — ${escapeText(adoptedBy.title)}</p>` : ''}`);

  // Budget-wide amendment log (the legislative history of the numbers).
  const amendments = repo.budget.amendmentsForBudget(b.id);
  const amendLog = amendments.length
    ? `<table class="data compact"><thead><tr><th>Date</th><th>Line</th><th class="num">Amount</th><th>Authorized by</th><th>Note</th></tr></thead>
       <tbody>${amendments.map((a) => html`<tr>
         <td>${raw(formatDate(a.created_at))}</td>
         <td>${a.line_category ? a.line_category + ' — ' : ''}${a.line_name}</td>
         <td class="num">${raw(signedMoney(a.amount))}</td>
         <td>${a.file_number ? raw(`<a href="/legislation/${encodeURIComponent(a.file_number)}">${escapeText(a.file_number)}</a>`) : raw('<span class="muted">—</span>')}</td>
         <td>${a.note || ''}</td></tr>`).join('')}</tbody></table>`
    : emptyState('No amendments recorded — the adopted amounts are unchanged.');

  // Clerk management.
  let manage = '';
  if (isClerk) {
    const isDraft = b.status === 'Draft';
    const addLine = `
      <form class="form inline-form" method="post" action="/admin/budget/${b.id}/lines">
        <div class="form-row">
          <label>Category<input type="text" name="category" placeholder="Operations"></label>
          <label>Line item<input type="text" name="name" required placeholder="Staffing"></label>
        </div>
        <div class="form-row">
          <label>Kind<select name="kind">${selectOptions(repo.BUDGET_KINDS, 'Expense')}</select></label>
          <label>${isDraft ? 'Budgeted amount' : 'Adopted amount'}<input type="number" step="0.01" name="amount" value="0"></label>
        </div>
        <div class="form-row">
          <label>Appropriation code<input type="text" name="appropriation_code" placeholder="100-4200-51000"></label>
          <label>Project code<input type="text" name="project_code" placeholder="CIP-2027-014"></label>
        </div>
        <label>Held by<select name="org_unit_id">${unitOpts('')}</select></label>
        <button type="submit" class="btn">Add line</button>
      </form>`;
    const editRows = lines.length ? lines.map((l) => `
      <form class="form line-edit" method="post" action="/admin/budget-lines/${l.id}">
        <input type="text" name="category" value="${escapeText(l.category || '')}" placeholder="Category" aria-label="Category">
        <input type="text" name="name" value="${escapeText(l.name)}" required aria-label="Name">
        <input type="text" name="appropriation_code" value="${escapeText(l.appropriation_code || '')}" placeholder="Approp. code" aria-label="Appropriation code">
        <input type="text" name="project_code" value="${escapeText(l.project_code || '')}" placeholder="Project code" aria-label="Project code">
        <select name="org_unit_id" aria-label="Held by">${unitOpts(l.org_unit_id)}</select>
        <select name="kind" aria-label="Kind">${selectOptions(repo.BUDGET_KINDS, l.kind)}</select>
        ${isDraft
    ? `<input type="number" step="0.01" name="amount" value="${escapeText(l.amount)}" aria-label="Amount">`
    : `<input type="hidden" name="amount" value="${escapeText(l.amount)}"><span class="line-locked" title="Adopted amounts change only by amendment">${money(l.amount)} 🔒</span>`}
        <button type="submit" class="btn-link">Save</button>
        <button type="submit" formaction="/admin/budget-lines/${l.id}/delete" class="btn-link danger"
          onclick="return confirm('Delete this line?')">Delete</button>
      </form>`).join('') : '<p class="muted">No lines yet — add one above.</p>';
    const lockNote = isDraft ? ''
      : '<p class="muted">This budget is past Draft: adopted amounts are locked and change only through '
        + 'amendments recorded on each line\'s page, preserving the adopted figures as public record.</p>';
    const matterOpts = repo.matters.search({ limit: 300 })
      .map((m) => `<option value="${m.id}"${b.adopted_matter_id === m.id ? ' selected' : ''}>${escapeText(m.file_number + ' — ' + m.title.slice(0, 70))}</option>`).join('');
    const meta = `
      <form class="form inline-form" method="post" action="/admin/budget/${b.id}">
        <div class="form-row">
          <label>Fiscal year<input type="text" name="fiscal_year" value="${escapeText(b.fiscal_year)}" required></label>
          <label>Status<select name="status">${selectOptions(repo.BUDGET_STATUSES, b.status)}</select></label>
        </div>
        <label>Adopted by (file)
          <select name="adopted_matter_id"><option value="">— none —</option>${matterOpts}</select>
        </label>
        <label>Notes<input type="text" name="notes" value="${escapeText(b.notes || '')}"></label>
        <div class="form-actions">
          <button type="submit" class="btn">Save budget</button>
          <button type="submit" formaction="/admin/budget/${b.id}/delete" class="btn danger-btn"
            onclick="return confirm('Delete this whole budget and its lines?')">Delete budget</button>
        </div>
      </form>`;
    const importForms = `
      <p class="muted">Bulk-load from the accounting system. Lines: <code>category,name,kind,amount</code>
        (optional <code>appropriation_code,project_code</code>).
        Transactions: <code>date,line,description,amount</code> (line matched by name, YYYY-MM-DD dates).</p>
      <div class="form-row">
        <form class="form" method="post" action="/admin/budget/${b.id}/import-lines">
          <label>Line items CSV<textarea name="csv" rows="5" placeholder="Operations,Staffing,Expense,250000"></textarea></label>
          <button type="submit" class="btn">Import lines</button>
        </form>
        <form class="form" method="post" action="/admin/budget/${b.id}/import-tx">
          <label>Transactions CSV<textarea name="csv" rows="5" placeholder="2026-07-01,Staffing,July payroll,18400.22"></textarea></label>
          <button type="submit" class="btn">Import transactions</button>
        </form>
      </div>`;
    manage = card('Add line item', addLine)
      + card('Manage line items', lockNote + editRows)
      + card('Import (CSV)', importForms)
      + card('Budget settings', meta);
  }

  const body = html`
    <p class="crumbs"><a href="/budget">Budget</a> / ${b.fiscal_year}</p>
    <div class="detail-head">
      <h1>${b.fiscal_year} Budget ${statusBadge(b.status)}</h1>
      <span class="head-actions">
        <a class="btn" href="/budget/${b.id}/dashboard">📊 Dashboard</a>
        <a class="btn" href="/budget/${b.id}.csv">⬇ CSV</a>
      </span>
    </div>
    ${b.notes ? raw(`<p class="muted">${escapeText(b.notes)}</p>`) : ''}
    ${raw(summaryCard)}
    ${raw(card('Expenses', expTable))}
    ${revTable ? raw(card('Revenue', revTable)) : ''}
    ${raw(card(`Amendment history (${amendments.length})`, amendLog))}
    ${raw(manage)}`;
  return layout({ title: b.fiscal_year + ' Budget', active: '/budget', body });
}

// ---- Line drill-down --------------------------------------------------------
function budgetLinePage(line, user) {
  const isClerk = auth.hasRole(user, 'clerk');
  const current = line.amount + line.amended;
  const amendments = repo.budget.amendments(line.id);
  const txs = repo.budget.transactions(line.id);
  const matters = repo.budget.lineMatters(line.id);
  const isRevenue = line.kind === 'Revenue';

  const codes = (line.appropriation_code || line.project_code)
    ? `<p class="muted">${line.appropriation_code ? 'Appropriation <strong>' + escapeText(line.appropriation_code) + '</strong>' : ''}${line.appropriation_code && line.project_code ? ' · ' : ''}${line.project_code ? 'Project <strong>' + escapeText(line.project_code) + '</strong>' : ''}</p>`
    : '';
  const meta = card('Line summary', `${codes}
    <div class="budget-summary">
      <div><span class="bs-n">${escapeText(money(line.amount))}</span><span class="bs-l">Adopted</span></div>
      <div><span class="bs-n">${line.amended ? escapeText(signedMoney(line.amended)) : '—'}</span><span class="bs-l">Amendments</span></div>
      <div><span class="bs-n">${escapeText(money(current))}</span><span class="bs-l">Current</span></div>
      <div><span class="bs-n">${escapeText(money(line.actual))}</span><span class="bs-l">${isRevenue ? 'Received' : 'Spent'}</span></div>
      <div><span class="bs-n">${escapeText(money(current - line.actual))}</span><span class="bs-l">${isRevenue ? 'Outstanding' : 'Remaining'}</span></div>
      ${line.committed ? `<div><span class="bs-n">${escapeText(money(line.committed))}</span><span class="bs-l">Committed by legislation</span></div>` : ''}
    </div>${bar(line.actual, current)}`);

  const amendList = amendments.length
    ? `<table class="data compact"><thead><tr><th>Date</th><th class="num">Amount</th><th>Authorized by</th><th>Note</th></tr></thead>
       <tbody>${amendments.map((a) => html`<tr>
        <td>${raw(formatDate(a.created_at))}</td>
        <td class="num">${raw(signedMoney(a.amount))}</td>
        <td>${a.file_number ? raw(`<a href="/legislation/${encodeURIComponent(a.file_number)}">${escapeText(a.file_number)}</a>`) : raw('<span class="muted">—</span>')}</td>
        <td>${a.note || ''}</td></tr>`).join('')}</tbody></table>`
    : emptyState('No amendments — the adopted amount stands.');
  const amendForm = isClerk ? `
    <form class="form inline-form" method="post" action="/admin/budget-lines/${line.id}/amend">
      <div class="form-row">
        <label>Amount (+ increase / − decrease)<input type="number" step="0.01" name="amount" required placeholder="-5000.00"></label>
        <label>Authorizing file
          <select name="matter_id"><option value="">— none —</option>${repo.matters.search({ limit: 300 })
    .map((m) => `<option value="${m.id}">${escapeText(m.file_number + ' — ' + m.title.slice(0, 60))}</option>`).join('')}</select>
        </label>
      </div>
      <label>Note<input type="text" name="note" placeholder="Transfer to Capital / Supplemental appropriation…"></label>
      <button type="submit" class="btn">Record amendment</button>
    </form>` : '';

  const txTable = txs.length
    ? `<table class="data compact"><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th>${isClerk ? '<th></th>' : ''}</tr></thead>
       <tbody>${txs.map((t) => html`<tr>
        <td>${raw(formatDate(t.tx_date))}</td>
        <td>${t.description || ''}</td>
        <td class="num">${raw(money(t.amount))}</td>
        ${isClerk ? raw(`<td><form method="post" action="/admin/budget-tx/${t.id}/delete" class="inline">
          <button type="submit" class="btn-link danger">remove</button></form></td>`) : ''}
        </tr>`).join('')}</tbody></table>`
    : emptyState(isRevenue ? 'No receipts recorded.' : 'No expenditures recorded.');
  const txForm = isClerk ? `
    <form class="form inline-form" method="post" action="/admin/budget-lines/${line.id}/tx">
      <div class="form-row">
        <label>Date<input type="date" name="tx_date" value="${todayISO()}" required></label>
        <label>Description<input type="text" name="description" placeholder="${isRevenue ? 'Q1 tax distribution' : 'July payroll'}"></label>
        <label>Amount<input type="number" step="0.01" name="amount" required></label>
      </div>
      <button type="submit" class="btn">Record ${isRevenue ? 'receipt' : 'expenditure'}</button>
    </form>` : '';

  const matterList = matters.length
    ? `<ul class="attach-list">${matters.map((m) => html`
        <li><a href="/legislation/${encodeURIComponent(m.file_number)}">${m.file_number}</a> — ${m.title}
          ${m.fiscal_impact != null ? raw(`<span class="muted">(${escapeText(money(m.fiscal_impact))})</span>`) : ''}
          ${statusBadge(m.status)}</li>`).join('')}</ul>`
    : emptyState('No legislation tied to this line.');

  const body = html`
    <p class="crumbs"><a href="/budget">Budget</a> /
      <a href="/budget/${line.budget_id}">${line.fiscal_year}</a> / ${line.name}</p>
    <h1>${line.category ? line.category + ' — ' : ''}${line.name}
      <span class="badge type">${line.kind}</span></h1>
    ${raw(meta)}
    ${raw(card(`Amendments (${amendments.length})`, amendList + amendForm))}
    ${raw(card(`${isRevenue ? 'Receipts' : 'Expenditures'} (${txs.length})`, txTable + txForm))}
    ${raw(card(`Linked legislation (${matters.length})`, matterList))}`;
  return layout({ title: line.name, active: '/budget', body });
}

// ---- Reporting dashboard ------------------------------------------------------
function budgetDashboard(b) {
  const sum = repo.budget.summary(b.id);
  const lines = repo.budget.lines(b.id);
  const expenses = lines.filter((l) => l.kind !== 'Revenue');
  const pctUsed = sum.expCurrent > 0 ? Math.round((sum.expActual / sum.expCurrent) * 100) : 0;

  const tiles = `
    <div class="stat-grid">
      <div class="stat"><span class="stat-n">${escapeText(money(sum.expBudgeted))}</span><span class="stat-l">Adopted</span></div>
      <div class="stat"><span class="stat-n">${escapeText(money(sum.expCurrent))}</span><span class="stat-l">Current budget</span></div>
      <div class="stat"><span class="stat-n">${escapeText(money(sum.expActual))}</span><span class="stat-l">Spent to date</span></div>
      <div class="stat"><span class="stat-n">${escapeText(money(sum.expRemaining))}</span><span class="stat-l">Remaining</span></div>
      <div class="stat"><span class="stat-n">${pctUsed}%</span><span class="stat-l">Budget used</span></div>
      ${sum.hasRevenue ? `<div class="stat"><span class="stat-n">${escapeText(money(sum.revActual))}</span><span class="stat-l">Revenue received</span></div>` : ''}
    </div>`;

  // Spend by category: current budget vs actual, with usage bars.
  const cats = new Map();
  for (const l of expenses) {
    const cat = l.category || 'Uncategorized';
    const c = cats.get(cat) || { current: 0, actual: 0, committed: 0 };
    c.current += l.amount + l.amended;
    c.actual += l.actual;
    c.committed += l.committed;
    cats.set(cat, c);
  }
  const catRows = [...cats.entries()].sort((x, y) => y[1].current - x[1].current).map(([cat, c]) => `
    <tr><td>${escapeText(cat)}</td>
      <td class="num">${money(c.current)}</td>
      <td class="num">${money(c.actual)}</td>
      <td class="num">${money(c.committed)}</td>
      <td class="num">${c.current > 0 ? Math.round((c.actual / c.current) * 100) : 0}%</td>
      <td class="bar-col">${bar(c.actual, c.current)}</td></tr>`).join('');
  const catTable = cats.size
    ? `<table class="data compact"><thead><tr><th>Category</th><th class="num">Current budget</th>
        <th class="num">Spent</th><th class="num">Committed</th><th class="num">Used</th><th></th></tr></thead>
        <tbody>${catRows}</tbody></table>`
    : emptyState('No expense lines yet.');

  // Monthly actuals (spend trend + receipts when present).
  const months = repo.budget.monthlyActuals(b.id);
  const maxSpend = Math.max(1, ...months.map((m) => m.spent));
  const monthRows = months.map((m) => `
    <tr><td>${escapeText(m.month)}</td>
      <td class="num">${money(m.spent)}</td>
      ${sum.hasRevenue ? `<td class="num">${money(m.received)}</td>` : ''}
      <td class="bar-col">${bar(m.spent, maxSpend)}</td></tr>`).join('');
  const monthTable = months.length
    ? `<table class="data compact"><thead><tr><th>Month</th><th class="num">Spent</th>
        ${sum.hasRevenue ? '<th class="num">Received</th>' : ''}<th></th></tr></thead><tbody>${monthRows}</tbody></table>`
    : emptyState('No transactions recorded yet — the trend appears as expenditures are entered.');

  // Watch list: lines closest to (or over) their budget.
  const hot = expenses
    .map((l) => ({ ...l, current: l.amount + l.amended }))
    .filter((l) => l.current > 0)
    .map((l) => ({ ...l, pct: l.actual / l.current }))
    .sort((x, y) => y.pct - x.pct)
    .slice(0, 8);
  const hotRows = hot.map((l) => `
    <tr class="${l.pct > 1 ? 'over-row' : ''}"><td><a href="/budget/lines/${l.id}">${escapeText((l.category ? l.category + ' — ' : '') + l.name)}</a></td>
      <td class="num">${money(l.current)}</td><td class="num">${money(l.actual)}</td>
      <td class="num">${Math.round(l.pct * 100)}%</td><td class="bar-col">${bar(l.actual, l.current)}</td></tr>`).join('');
  const hotTable = hot.length
    ? `<table class="data compact"><thead><tr><th>Line</th><th class="num">Current</th><th class="num">Spent</th>
        <th class="num">Used</th><th></th></tr></thead><tbody>${hotRows}</tbody></table>`
    : emptyState('No expense lines with a budget yet.');

  const body = html`
    <p class="crumbs"><a href="/budget">Budget</a> / <a href="/budget/${b.id}">${b.fiscal_year}</a> / Dashboard</p>
    <div class="detail-head">
      <h1>${b.fiscal_year} — Budget dashboard ${statusBadge(b.status)}</h1>
      <span class="head-actions"><a class="btn" href="/budget/${b.id}.csv">⬇ CSV</a></span>
    </div>
    ${raw(tiles)}
    ${raw(card('Spending by category', catTable))}
    ${raw(card('Monthly actuals', monthTable))}
    ${raw(card('Lines to watch (highest budget usage)', hotTable))}`;
  return layout({ title: b.fiscal_year + ' dashboard', active: '/budget', body });
}

// ---- Year-over-year comparison -------------------------------------------------
function budgetComparePage(query = {}) {
  const budgets = repo.budget.all();
  const a = budgets.find((x) => String(x.id) === String(query.a)) || budgets[1] || budgets[0];
  const b = budgets.find((x) => String(x.id) === String(query.b)) || budgets[0];
  if (!a || !b) {
    return layout({ title: 'Compare budgets', active: '/budget',
      body: html`<h1>Compare budgets</h1>${raw(emptyState('Need at least one budget to compare.'))}` });
  }
  const rows = repo.budget.compareYears(a.id, b.id);
  const cell = (l) => (l == null ? '<span class="muted">—</span>' : money(l.amount + l.amended));
  const delta = (r) => {
    if (!r.a || !r.b) return '<span class="muted">new/removed</span>';
    const d = (r.b.amount + r.b.amended) - (r.a.amount + r.a.amended);
    if (!d) return '<span class="muted">no change</span>';
    const pct = (r.a.amount + r.a.amended) !== 0 ? ` (${d > 0 ? '+' : ''}${Math.round((d / (r.a.amount + r.a.amended)) * 100)}%)` : '';
    return `${signedMoney(d)}${pct}`;
  };
  const table = rows.length
    ? `<table class="data compact"><thead><tr><th>Line</th><th>Kind</th>
        <th class="num">${escapeText(a.fiscal_year)}</th><th class="num">${escapeText(b.fiscal_year)}</th>
        <th class="num">Change</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${escapeText((r.category ? r.category + ' — ' : '') + r.name)}</td>
          <td>${escapeText(r.kind)}</td>
          <td class="num">${cell(r.a)}</td><td class="num">${cell(r.b)}</td>
          <td class="num">${delta(r)}</td></tr>`).join('')}</tbody></table>`
    : emptyState('No lines to compare.');
  const opts = (sel) => budgets.map((x) => `<option value="${x.id}"${x.id === sel.id ? ' selected' : ''}>${escapeText(x.fiscal_year)}</option>`).join('');
  const picker = `
    <form class="form inline-form" method="get" action="/budget/compare">
      <div class="form-row">
        <label>From<select name="a">${opts(a)}</select></label>
        <label>To<select name="b">${opts(b)}</select></label>
        <button type="submit" class="btn">Compare</button>
      </div>
    </form>`;
  const body = html`
    <p class="crumbs"><a href="/budget">Budget</a> / Compare</p>
    <h1>Budget comparison — ${a.fiscal_year} → ${b.fiscal_year}</h1>
    ${raw(card('Fiscal years', picker))}
    ${raw(card('Line comparison (current amounts, after amendments)', table))}`;
  return layout({ title: 'Compare budgets', active: '/budget', body });
}

// ---- Appropriation ledger (follow the money) ------------------------------
// One row per appropriation account, rolled up across every fiscal year it
// appears in: budgeted → committed (contracts/legislation) → spent → available.
function appropriationReport() {
  const rows = repo.budget.appropriationRollup();
  const t = { current: 0, committed: 0, actual: 0 };
  const table = rows.length ? `<table class="data">
    <thead><tr><th>Appropriation</th><th class="num">Years</th><th class="num">Budgeted</th>
      <th class="num">Committed</th><th class="num">Spent</th><th class="num">Available</th><th>Spent</th></tr></thead>
    <tbody>${rows.map((r) => {
      const current = (r.adopted || 0) + (r.amended || 0);
      const available = current - (r.committed || 0);
      t.current += current; t.committed += (r.committed || 0); t.actual += (r.actual || 0);
      return `<tr>
        <td><a href="/budget/appropriations/${encodeURIComponent(r.code)}">${escapeText(r.code)}</a>
          <div class="sub muted">${r.line_count} line${r.line_count > 1 ? 's' : ''}</div></td>
        <td class="num">${r.year_count}</td>
        <td class="num">${money(current)}</td>
        <td class="num">${money(r.committed || 0)}</td>
        <td class="num">${money(r.actual || 0)}</td>
        <td class="num ${available < 0 ? 'over' : ''}">${money(available)}</td>
        <td>${bar(r.actual || 0, current)}</td></tr>`;
    }).join('')}
    <tr class="subtotal"><td>All appropriations</td><td></td>
      <td class="num">${money(t.current)}</td><td class="num">${money(t.committed)}</td>
      <td class="num">${money(t.actual)}</td><td class="num">${money(t.current - t.committed)}</td><td></td></tr>
    </tbody></table>`
    : emptyState('No appropriation codes yet. Add one to a budget line to start tracking spending by account.');
  const body = html`${raw(card('Accounts', table))}`;
  return layout({
    title: 'Appropriations',
    h1: 'Appropriation accounts',
    active: '/budget',
    crumbs: [{ label: 'Budget', href: '/budget' }, { label: 'Appropriations' }],
    subtitle: 'Spending tracked by appropriation account across all fiscal years — '
      + 'budgeted, committed against contracts and legislation, and actually spent.',
    body,
  });
}

function appropriationDetailPage(detail) {
  const { code, lines, contracts, solicitations } = detail;
  const t = lines.reduce((acc, l) => {
    const current = l.amount + l.amended;
    acc.current += current; acc.committed += l.committed; acc.actual += l.actual;
    return acc;
  }, { current: 0, committed: 0, actual: 0 });

  const linesTable = lines.length ? `<table class="data compact">
    <thead><tr><th>Fiscal year</th><th>Line</th><th class="num">Budgeted</th>
      <th class="num">Committed</th><th class="num">Spent</th></tr></thead>
    <tbody>${lines.map((l) => `<tr>
      <td>${escapeText(l.fiscal_year)}</td>
      <td><a href="/budget/lines/${l.id}">${escapeText((l.category ? l.category + ' — ' : '') + l.name)}</a>${l.project_code ? ` <span class="muted">· ${escapeText(l.project_code)}</span>` : ''}</td>
      <td class="num">${money(l.amount + l.amended)}</td>
      <td class="num">${money(l.committed)}</td>
      <td class="num">${money(l.actual)}</td></tr>`).join('')}</tbody></table>`
    : emptyState('No budget lines.');

  const contractsTable = contracts.length ? `<table class="data compact">
    <thead><tr><th>File</th><th>Title</th><th>Type</th><th>Status</th><th class="num">Fiscal impact</th></tr></thead>
    <tbody>${contracts.map((m) => `<tr>
      <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${escapeText(m.file_number)}</a></td>
      <td>${escapeText(m.title)}</td><td>${escapeText(m.type)}</td>
      <td>${statusBadge(m.status)}</td>
      <td class="num">${money(m.fiscal_impact)}</td></tr>`).join('')}</tbody></table>`
    : emptyState('No contracts or legislation charged to this account yet.');

  const solicitationsTable = solicitations.length ? `<table class="data compact">
    <thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Status</th><th class="num">Award</th></tr></thead>
    <tbody>${solicitations.map((s) => `<tr>
      <td><a href="/procurement/${s.id}">${escapeText(s.number)}</a></td>
      <td>${escapeText(s.title)}${s.awarded_vendor_name ? ` <span class="muted">· ${escapeText(s.awarded_vendor_name)}</span>` : ''}</td>
      <td>${escapeText(s.kind)}</td><td>${statusBadge(s.status)}</td>
      <td class="num">${s.award_amount != null ? money(s.award_amount) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>`
    : emptyState('No solicitations against this account.');

  const available = t.current - t.committed;
  const summary = `<dl class="meta record-header">
    <dt>Budgeted</dt><dd>${money(t.current)}</dd>
    <dt>Committed</dt><dd>${money(t.committed)}</dd>
    <dt>Spent</dt><dd>${money(t.actual)}</dd>
    <dt>Available</dt><dd class="${available < 0 ? 'over' : ''}">${money(available)}</dd></dl>`;

  // Enrich with the Treasury Account Symbol register (source of truth) if this
  // appropriation code matches a catalogued account.
  const acct = repo.tas.byTas(code);
  const tasCard = acct ? card('Treasury Account Symbol', `<dl class="meta record-header">
    <dt>TAS</dt><dd>${escapeText(acct.tas)}</dd>
    ${acct.title ? `<dt>Title</dt><dd>${escapeText(acct.title)}</dd>` : ''}
    ${acct.agency ? `<dt>Agency</dt><dd>${escapeText(acct.agency)}${acct.aid ? ` <span class="muted">(AID ${escapeText(acct.aid)})</span>` : ''}</dd>` : ''}
    ${acct.fund_type ? `<dt>Fund type</dt><dd>${escapeText(acct.fund_type)}</dd>` : ''}
    ${acct.avail ? `<dt>Availability</dt><dd>${escapeText(acct.avail)}</dd>` : ''}
    ${acct.main ? `<dt>Main account</dt><dd>${escapeText(acct.main)}</dd>` : ''}
    ${acct.independent_agencies ? `<dt>Grouping</dt><dd>${escapeText(acct.independent_agencies)}</dd>` : ''}
  </dl><p class="muted"><a href="/budget/accounts">← Account register</a></p>`) : '';

  const body = html`
    <p class="crumbs"><a href="/budget">Budget</a> / <a href="/budget/appropriations">Appropriations</a> / ${escapeText(code)}</p>
    <h1>Appropriation ${escapeText(code)}</h1>
    ${raw(tasCard)}
    ${raw(card('Account totals', summary))}
    ${raw(card('Budget lines', linesTable))}
    ${raw(card(`Contracts & legislation (${contracts.length})`, contractsTable))}
    ${raw(card(`Solicitations (${solicitations.length})`, solicitationsTable))}`;
  return layout({ title: `Appropriation ${code}`, active: '/budget', body });
}

// ---- Treasury Account Symbol register (chart of accounts) -----------------
function tasRegister(query = {}, user = null) {
  const isClerk = auth.hasRole(user, 'clerk');
  const q = String(query.q || '').trim();
  const rows = repo.tas.all({ q });
  const table = rows.length ? `<table class="data">
    <thead><tr><th>TAS</th><th>Agency</th><th>Title</th><th>Fund type</th><th>Availability</th></tr></thead>
    <tbody>${rows.map((a) => `<tr>
      <td><a href="/budget/appropriations/${encodeURIComponent(a.tas)}">${escapeText(a.tas)}</a></td>
      <td>${escapeText(a.agency || '')}${a.aid ? ` <span class="muted">(${escapeText(a.aid)})</span>` : ''}</td>
      <td>${escapeText(a.title || '')}</td>
      <td>${escapeText(a.fund_type || '')}</td>
      <td>${escapeText(a.avail || '')}</td></tr>`).join('')}</tbody></table>`
    : emptyState(q ? `No accounts match "${escapeText(q)}".` : 'No accounts registered yet.');

  const search = `<form class="form inline-form" method="get" action="/budget/accounts">
    <div class="form-row">
      <label>Search<input type="search" name="q" value="${escapeText(q)}" placeholder="TAS, agency, or title"></label>
      <button type="submit" class="btn">Search</button>
      ${q ? '<a class="btn-link" href="/budget/accounts">Clear</a>' : ''}
    </div>
  </form>`;

  const importForm = isClerk ? card('Import register (clerk)', `
    <p class="muted">Upload the Treasury Account Symbol catalog. Columns:
      <code>AID,Main,X-YEAR,TAS,Agency,Title,Fund Type,Independent Agencies,Last update</code>.
      TAS is the key — re-importing a TAS updates it in place.</p>
    <form class="form" method="post" action="/admin/budget/accounts/import">
      <label>Register CSV<textarea name="csv" rows="6" placeholder="020,0100,X,020-X-0100,Independent Agencies,Salaries and Expenses,General,Yes,2026-01-01"></textarea></label>
      <button type="submit" class="btn primary">Import register</button>
    </form>`) : '';

  const body = html`
    ${raw(card('Accounts', search + table))}
    ${raw(importForm)}`;
  return layout({
    title: 'Account register',
    h1: 'Account register (TAS)',
    active: '/budget',
    crumbs: [{ label: 'Budget', href: '/budget' }, { label: 'Account register' }],
    actions: `${rows.length ? '<a class="btn" href="/budget/accounts.csv">Export CSV</a>' : ''}`
      + '<a class="btn" href="/budget/appropriations">Appropriation ledger</a>',
    subtitle: 'Treasury Account Symbol catalog — the source of truth for appropriation structure. '
      + "A budget line's appropriation code links to a TAS here.",
    body,
  });
}

module.exports = {
  budgetList, budgetDetail, budgetLinePage, budgetDashboard, budgetComparePage,
  appropriationReport, appropriationDetailPage, tasRegister, money,
};
