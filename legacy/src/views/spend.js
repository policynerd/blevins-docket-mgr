'use strict';

const { html, raw } = require('../util');
const { layout, card, statusBadge, escapeText } = require('./layout');
const spend = require('../spend');
const repo = require('../repo');

function listPage(user, { error } = {}) {
  const rows = spend.list({});
  let lineOpts = '<option value="">— appropriation line —</option>';
  try {
    for (const b of repo.budget.all()) {
      for (const l of repo.budget.lines(b.id)) {
        lineOpts += `<option value="${l.id}">${escapeText(b.fiscal_year + ' · ' + l.name)}</option>`;
      }
    }
  } catch (_) { /* */ }
  const table = rows.length
    ? `<table class="data"><thead><tr><th>#</th><th>Title</th><th>Line</th><th>Amount</th><th>Status</th></tr></thead><tbody>${rows.map((r) =>
      `<tr><td>${r.id}</td><td><a href="/spend/${r.id}">${escapeText(r.title)}</a></td><td>${escapeText(r.line_name || '—')}</td><td>${escapeText(String(r.amount))}</td><td>${statusBadge(r.status)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty">No spend requests yet.</p>';
  const form = spend.canSubmit(user) ? `<form class="form" method="post" action="/spend">
      <label>Title <input name="title" required></label>
      <label>Amount <input name="amount" type="number" step="0.01" min="0" required></label>
      <label>Kind <select name="kind"><option value="expense">Expense</option><option value="commitment">Commitment</option><option value="reimbursement">Reimbursement</option></select></label>
      <label>Appropriation <select name="budget_line_id">${lineOpts}</select></label>
      <label>Vendor <input name="vendor_name"></label>
      <label>Purpose <textarea name="purpose" rows="3"></textarea></label>
      <button class="btn primary" type="submit">File request</button></form>` : '<p class="muted">Staff or clerk may file a request.</p>';
  return layout({ title: 'Spend', active: '/budget', subtitle: 'Requests against an adopted appropriation.',
    body: html`${error ? raw(`<p class="form-warn">${escapeText(error)}</p>`) : ''}${raw(card('Requests', table))}${raw(card('New request', form))}` });
}

function detailPage(row, user, { error } = {}) {
  const actions = [];
  if (row.status === 'Draft' && spend.canSubmit(user)) {
    actions.push(`<form method="post" action="/spend/${row.id}/submit" class="inline"><button class="btn primary">Submit</button></form>`);
  }
  if (row.status === 'Submitted' && spend.canDecide(user)) {
    actions.push(`<form method="post" action="/spend/${row.id}/decide" class="inline"><input type="hidden" name="status" value="Approved"><button class="btn primary">Approve</button></form>`);
    actions.push(`<form method="post" action="/spend/${row.id}/decide" class="inline"><input type="hidden" name="status" value="Denied"><button class="btn">Deny</button></form>`);
  }
  if (row.status === 'Approved' && spend.canDecide(user)) {
    actions.push(`<form method="post" action="/spend/${row.id}/post" class="inline"><button class="btn primary">Post to ledger</button></form>`);
  }
  if (row.status !== 'Posted' && spend.canDecide(user)) {
    actions.push(`<form method="post" action="/spend/${row.id}/void" class="inline"><button class="btn">Void</button></form>`);
  }
  return layout({ title: row.title, active: '/budget',
    crumbs: [{ href: '/spend', label: 'Spend' }, { label: String(row.id) }],
    body: html`${error ? raw(`<p class="form-warn">${escapeText(error)}</p>`) : ''}${raw(card(row.title, `<dl class="meta"><dt>Status</dt><dd>${statusBadge(row.status)}</dd><dt>Amount</dt><dd>${escapeText(String(row.amount))}</dd><dt>Line</dt><dd>${escapeText(row.line_name || '—')}</dd><dt>Vendor</dt><dd>${escapeText(row.vendor_name || '—')}</dd><dt>Filed by</dt><dd>${escapeText(row.requested_by_name || '—')}</dd></dl><p>${escapeText(row.purpose || '')}</p><div class="form-actions">${actions.join(' ')}</div>`))}` });
}

function instrumentPage(matter, { saved, error } = {}) {
  const inst = require('../instrument');
  const parts = inst.get(matter.id) || {};
  const issues = inst.validate({ citations: parts.citations, recitals: parts.recitals, articles: matter.full_text });
  const fn = encodeURIComponent(matter.file_number);
  return layout({
    title: 'Instrument — ' + matter.file_number, active: '/legislation', h1: matter.title,
    crumbs: [{ href: '/legislation', label: 'Legislation' }, { href: `/legislation/${fn}`, label: matter.file_number }, { label: 'Instrument' }],
    body: html`${saved ? raw('<p class="saved-banner">Instrument saved.</p>') : ''}${error ? raw(`<p class="form-warn">${escapeText(error)}</p>`) : ''}${raw(card('Form of the act', `<ul class="val-list">${issues.map((i) => `<li class="val-${escapeText(i.level)}">${escapeText(i.msg)}</li>`).join('') || '<li>Guide form looks complete.</li>'}</ul><form class="form" method="post" action="/admin/legislation/${fn}/instrument"><label>Citations <textarea name="citations" rows="4" class="mono">${escapeText(parts.citations || '')}</textarea></label><label>Recitals <textarea name="recitals" rows="6" class="mono">${escapeText(parts.recitals || '')}</textarea></label><label>Enacting formula <input name="enacting_formula" value="${escapeText(parts.formula || inst.DEFAULT_FORMULA)}"></label><button class="btn primary" type="submit">Save instrument</button></form>`))}${matter.status === 'Passed' && !matter.assented_at ? raw(`<form method="post" action="/admin/matters/${matter.id}/assent"><button class="btn primary" type="submit">Assent</button></form>`) : ''}${matter.assented_at ? raw(`<p class="muted">Assented ${escapeText(String(matter.assented_at))}${matter.assented_by_name ? ' · ' + escapeText(matter.assented_by_name) : ''}</p>`) : ''}`,
  });
}

module.exports = { listPage, detailPage, instrumentPage };
