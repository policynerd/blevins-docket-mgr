'use strict';

const { html, raw, formatDate } = require('../util');
const { layout, card, statusBadge, emptyState, escapeText } = require('./layout');
const { editorField } = require('./reports');
const repo = require('../repo');
const auth = require('../auth');

const POLICY_CATEGORIES = ['Governance', 'Finance', 'Human Resources', 'Ethics',
  'Operations', 'Risk & Compliance', 'Bylaws'];

function selectOptions(values, current, { includeBlank } = {}) {
  let out = includeBlank ? `<option value="">${escapeText(includeBlank)}</option>` : '';
  for (const v of values) {
    const value = typeof v === 'object' ? v.value : v;
    const label = typeof v === 'object' ? v.label : v;
    out += `<option value="${escapeText(value)}"${String(value) === String(current) ? ' selected' : ''}>${escapeText(label)}</option>`;
  }
  return out;
}

// ---- Public ---------------------------------------------------------------
function policiesList(user) {
  const isClerk = auth.hasRole(user, 'clerk');
  const rows = repo.policies.published();
  const groups = new Map();
  for (const p of rows) {
    const cat = p.category || 'General';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(p);
  }
  const sections = [...groups.entries()].map(([cat, items]) => `
    <h2 class="section-title">${escapeText(cat)}</h2>
    <table class="data"><thead><tr><th>No.</th><th>Title</th><th>Status</th><th>Effective</th></tr></thead>
    <tbody>${items.map((p) => html`
      <tr>
        <td>${p.policy_number || ''}</td>
        <td><a href="/policies/${p.id}">${p.title}</a></td>
        <td>${statusBadge(p.status)}</td>
        <td>${raw(formatDate(p.effective_date))}</td>
      </tr>`).join('')}</tbody></table>`).join('');

  const body = html`
    ${isClerk ? raw('<div class="admin-actions"><a class="btn" href="/admin/policies">Manage policies</a></div>') : ''}
    ${rows.length ? raw(sections) : raw(emptyState('No policies have been published yet.'))}`;
  return layout({ title: 'Policies', active: '/policies',
    subtitle: 'Adopted governance policies and bylaws of record.', body });
}

function policyDetail(policy) {
  const body = html`
    <p class="crumbs"><a href="/policies">Policies</a> / ${policy.title}</p>
    <article class="doc-view">
      <header class="doc-head">
        ${policy.category ? raw(`<span class="badge type">${escapeText(policy.category)}</span>`) : ''}
        ${statusBadge(policy.status)}
        <h1>${policy.title}</h1>
        <p class="muted">${policy.policy_number ? 'Policy ' + escapeText(policy.policy_number) + ' · ' : ''}${policy.effective_date ? 'Effective ' + formatDate(policy.effective_date) : ''}${policy.matter_file_number ? raw(` · Adopted by <a href="/legislation/${encodeURIComponent(policy.matter_file_number)}">${escapeText(policy.matter_file_number)}</a>`) : ''}</p>
      </header>
      <div class="doc-body">${raw(policy.body_html || '<p class="empty">This policy has no text yet.</p>')}</div>
    </article>`;
  return layout({ title: policy.title, active: '/policies', body });
}

// ---- Clerk admin ----------------------------------------------------------
function policiesAdmin() {
  const rows = repo.policies.all();
  const table = rows.length ? `<table class="data">
    <thead><tr><th>No.</th><th>Title</th><th>Category</th><th>Status</th><th>Effective</th><th></th></tr></thead>
    <tbody>${rows.map((p) => html`
      <tr>
        <td>${p.policy_number || ''}</td>
        <td><a href="/policies/${p.id}">${p.title}</a></td>
        <td>${p.category || ''}</td>
        <td>${statusBadge(p.status)}</td>
        <td>${raw(formatDate(p.effective_date))}</td>
        <td>
          <a class="btn-link" href="/admin/policies/${p.id}/edit">Edit</a>
          <form method="post" action="/admin/policies/${p.id}/delete" class="inline" onsubmit="return confirm('Delete this policy permanently?')">
            <button type="submit" class="btn-link danger">Delete</button>
          </form>
        </td>
      </tr>`).join('')}</tbody></table>` : emptyState('No policies yet.');

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Policies</p>
    <div class="detail-head">
      <h1>Policies</h1>
      <span class="head-actions"><a class="btn" href="/admin/policies/new">+ New policy</a></span>
    </div>
    ${raw(card('All policies', table))}`;
  return layout({ title: 'Policies', active: '/admin', body });
}

function policyForm(policy) {
  const isEdit = !!policy;
  const action = isEdit ? `/admin/policies/${policy.id}` : '/admin/policies';
  const matters = repo.matters.search({ limit: 300 })
    .map((m) => ({ value: m.id, label: `${m.file_number} — ${m.title}` }));

  const form = html`
    <form class="form" method="post" action="${action}" data-wp-form>
      <div class="form-row">
        <label>Policy number<input type="text" name="policy_number" value="${policy && policy.policy_number ? policy.policy_number : ''}" placeholder="GP-001"></label>
        <label>Status<select name="status">${raw(selectOptions(repo.POLICY_STATUSES, policy ? policy.status : 'Draft'))}</select></label>
      </div>
      <label>Title<input type="text" name="title" required value="${policy ? policy.title : ''}" placeholder="Conflict of Interest Policy"></label>
      <div class="form-row">
        <label>Category
          <input type="text" name="category" list="policy-cats" value="${policy && policy.category ? policy.category : ''}" placeholder="Governance">
          <datalist id="policy-cats">${raw(POLICY_CATEGORIES.map((c) => `<option value="${escapeText(c)}">`).join(''))}</datalist>
        </label>
        <label>Effective date<input type="date" name="effective_date" value="${policy && policy.effective_date ? policy.effective_date : ''}"></label>
      </div>
      <label>Adopted by (legislative file, optional)
        <select name="matter_id">${raw(selectOptions(matters, policy && policy.matter_id, { includeBlank: '—' }))}</select>
      </label>
      ${raw(editorField('body_html', policy ? policy.body_html : '', { label: 'Policy text', rows: 16 }))}
      <div class="form-actions">
        <button type="submit" class="btn primary">${isEdit ? 'Save policy' : 'Create policy'}</button>
        <a class="btn-link" href="/admin/policies">Cancel</a>
      </div>
    </form>
    <script src="/assets/editor.js" defer></script>`;

  const body = html`
    <p class="crumbs"><a href="/admin/policies">Policies</a> / ${isEdit ? policy.title : 'New policy'}</p>
    <h1>${isEdit ? 'Edit policy' : 'New policy'}</h1>
    ${raw(card('Policy', form))}`;
  return layout({ title: isEdit ? 'Edit policy' : 'New policy', active: '/admin', body });
}

module.exports = { policiesList, policyDetail, policiesAdmin, policyForm, POLICY_CATEGORIES };
