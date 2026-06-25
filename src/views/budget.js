'use strict';

const { html, raw } = require('../util');
const { layout, card, statusBadge, emptyState, escapeText } = require('./layout');
const auth = require('../auth');
const repo = require('../repo');

function money(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function selectOptions(values, current) {
  return values.map((v) => `<option value="${escapeText(v)}"${String(v) === String(current) ? ' selected' : ''}>${escapeText(v)}</option>`).join('');
}

// ---- Public + clerk list --------------------------------------------------
function budgetList(user) {
  const isClerk = auth.hasRole(user, 'clerk');
  const rows = repo.budget.all();
  const table = rows.length ? `<table class="data">
    <thead><tr><th>Fiscal year</th><th>Status</th><th>Lines</th><th class="num">Budgeted</th></tr></thead>
    <tbody>${rows.map((b) => html`
      <tr>
        <td><a href="/budget/${b.id}">${b.fiscal_year}</a></td>
        <td>${statusBadge(b.status)}</td>
        <td>${b.line_count}</td>
        <td class="num">${raw(money(b.budgeted))}</td>
      </tr>`).join('')}</tbody></table>` : emptyState('No budgets yet.');

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
    ${raw(card('Budgets', table))}
    ${raw(newForm)}`;
  return layout({ title: 'Budget', active: '/budget', subtitle: 'Fiscal-year budgets and line items.', body });
}

function bar(committed, budgeted) {
  const pct = budgeted > 0 ? Math.min(100, Math.round((committed / budgeted) * 100)) : 0;
  const over = committed > budgeted && budgeted > 0;
  return `<div class="budget-bar"><span style="width:${pct}%" class="${over ? 'over' : ''}"></span></div>`;
}

// ---- Detail (read for all; manage controls for clerk) ---------------------
function budgetDetail(b, user) {
  const isClerk = auth.hasRole(user, 'clerk');
  const lines = repo.budget.lines(b.id);
  const sum = repo.budget.summary(b.id);

  // Group by category for the read view.
  const groups = new Map();
  for (const l of lines) {
    const cat = l.category || 'Uncategorized';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(l);
  }
  const readRows = [...groups.entries()].map(([cat, items]) => {
    let cB = 0; let cC = 0;
    const rows = items.map((l) => {
      cB += l.amount; cC += l.committed;
      return html`
        <tr>
          <td>${l.name}${l.kind === 'Revenue' ? raw(' <span class="badge type">Revenue</span>') : ''}
            ${l.item_count ? raw(`<span class="muted"> · ${l.item_count} item${l.item_count > 1 ? 's' : ''}</span>`) : ''}</td>
          <td class="num">${raw(money(l.amount))}</td>
          <td class="num">${raw(money(l.committed))}</td>
          <td class="num">${raw(money(l.amount - l.committed))}</td>
          <td>${raw(bar(l.committed, l.amount))}</td>
        </tr>`;
    }).join('');
    return `<tr class="cat-row"><th colspan="5">${escapeText(cat)}</th></tr>${rows}
      <tr class="subtotal"><td>Subtotal — ${escapeText(cat)}</td>
        <td class="num">${money(cB)}</td><td class="num">${money(cC)}</td>
        <td class="num">${money(cB - cC)}</td><td></td></tr>`;
  }).join('');

  const readTable = lines.length ? `<table class="data budget-table">
    <thead><tr><th>Line item</th><th class="num">Budgeted</th><th class="num">Committed</th><th class="num">Remaining</th><th>Used</th></tr></thead>
    <tbody>${readRows}
      <tr class="grand"><td>Total</td><td class="num">${money(sum.budgeted)}</td>
        <td class="num">${money(sum.committed)}</td><td class="num">${money(sum.remaining)}</td><td></td></tr>
    </tbody></table>` : emptyState('No line items yet.');

  const summaryCard = card('Summary', `
    <div class="budget-summary">
      <div><span class="bs-n">${escapeText(money(sum.budgeted))}</span><span class="bs-l">Budgeted</span></div>
      <div><span class="bs-n">${escapeText(money(sum.committed))}</span><span class="bs-l">Committed</span></div>
      <div><span class="bs-n">${escapeText(money(sum.remaining))}</span><span class="bs-l">Remaining</span></div>
    </div>${bar(sum.committed, sum.budgeted)}`);

  // Clerk management: add line + per-line edit/delete.
  let manage = '';
  if (isClerk) {
    const addLine = `
      <form class="form inline-form" method="post" action="/admin/budget/${b.id}/lines">
        <div class="form-row">
          <label>Category<input type="text" name="category" placeholder="Operations"></label>
          <label>Line item<input type="text" name="name" required placeholder="Staffing"></label>
        </div>
        <div class="form-row">
          <label>Kind<select name="kind">${selectOptions(repo.BUDGET_KINDS, 'Expense')}</select></label>
          <label>Budgeted amount<input type="number" step="0.01" name="amount" value="0"></label>
        </div>
        <button type="submit" class="btn">Add line</button>
      </form>`;
    const editRows = lines.length ? lines.map((l) => `
      <form class="form line-edit" method="post" action="/admin/budget-lines/${l.id}">
        <input type="text" name="category" value="${escapeText(l.category || '')}" placeholder="Category" aria-label="Category">
        <input type="text" name="name" value="${escapeText(l.name)}" required aria-label="Name">
        <select name="kind" aria-label="Kind">${selectOptions(repo.BUDGET_KINDS, l.kind)}</select>
        <input type="number" step="0.01" name="amount" value="${escapeText(l.amount)}" aria-label="Amount">
        <button type="submit" class="btn-link">Save</button>
        <button type="submit" formaction="/admin/budget-lines/${l.id}/delete" class="btn-link danger"
          onclick="return confirm('Delete this line?')">Delete</button>
      </form>`).join('') : '<p class="muted">No lines yet — add one above.</p>';
    const meta = `
      <form class="form inline-form" method="post" action="/admin/budget/${b.id}">
        <div class="form-row">
          <label>Fiscal year<input type="text" name="fiscal_year" value="${escapeText(b.fiscal_year)}" required></label>
          <label>Status<select name="status">${selectOptions(repo.BUDGET_STATUSES, b.status)}</select></label>
        </div>
        <label>Notes<input type="text" name="notes" value="${escapeText(b.notes || '')}"></label>
        <div class="form-actions">
          <button type="submit" class="btn">Save budget</button>
          <button type="submit" formaction="/admin/budget/${b.id}/delete" class="btn danger-btn"
            onclick="return confirm('Delete this whole budget and its lines?')">Delete budget</button>
        </div>
      </form>`;
    manage = card('Add line item', addLine) + card('Manage line items', editRows) + card('Budget settings', meta);
  }

  const body = html`
    <p class="crumbs"><a href="/budget">Budget</a> / ${b.fiscal_year}</p>
    <div class="detail-head"><h1>${b.fiscal_year} Budget ${statusBadge(b.status)}</h1></div>
    ${b.notes ? raw(`<p class="muted">${escapeText(b.notes)}</p>`) : ''}
    ${raw(summaryCard)}
    ${raw(card('Line items', readTable))}
    ${raw(manage)}`;
  return layout({ title: b.fiscal_year + ' Budget', active: '/budget', body });
}

module.exports = { budgetList, budgetDetail, money };
