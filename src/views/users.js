'use strict';

const { html, raw, formatDate } = require('../util');
const { layout, card, emptyState, escapeText } = require('./layout');
const repo = require('../repo');

const ROLE_LABELS = {
  admin: 'Admin — full system control',
  clerk: 'Clerk — runs the docket',
  staff: 'Staff — can approve membership',
  member: 'Member — board member access',
};

function roleSelect(name, current) {
  return `<select name="${name}">${repo.USER_ROLES.map((r) =>
    `<option value="${r}"${r === current ? ' selected' : ''}>${escapeText(r)}</option>`).join('')}</select>`;
}

function usersAdmin(currentUser) {
  const rows = repo.users.all();
  const list = rows.length ? `<table class="data">
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Provider</th><th>Status</th><th>Update</th></tr></thead>
    <tbody>${rows.map((u) => {
    const self = currentUser && currentUser.id === u.id;
    return html`
      <tr class="${u.active ? '' : 'row-inactive'}">
        <td>${u.name}${self ? raw(' <span class="muted">(you)</span>') : ''}</td>
        <td>${u.email}</td>
        <td>${u.role}</td>
        <td>${u.auth_provider || 'local'}</td>
        <td>${u.active ? 'Active' : 'Disabled'}</td>
        <td>${self ? raw('<span class="muted">—</span>') : raw(`
          <form class="inline" method="post" action="/admin/users/${u.id}/role">
            ${roleSelect('role', u.role)}
            <button type="submit" class="btn-link">Set</button>
          </form>
          <form class="inline" method="post" action="/admin/users/${u.id}/active">
            <input type="hidden" name="active" value="${u.active ? 0 : 1}">
            <button type="submit" class="btn-link">${u.active ? 'Disable' : 'Enable'}</button>
          </form>`)}</td>
      </tr>`;
  }).join('')}</tbody></table>` : emptyState('No login accounts yet.');

  const roleKey = `<ul class="role-key">${Object.entries(ROLE_LABELS).map(([r, d]) =>
    `<li><strong>${escapeText(r)}</strong> — ${escapeText(d.split('— ')[1] || d)}</li>`).join('')}</ul>`;

  const addForm = html`
    <form class="form" method="post" action="/admin/users">
      <p class="muted">Pre-add a login by email. The person signs in with Microsoft and is matched to this account.</p>
      <div class="form-row">
        <label>Name<input type="text" name="name" placeholder="Jane Smith"></label>
        <label>Email<input type="email" name="email" required placeholder="jane@blevinsholdings.com"></label>
        <label>Role${raw(roleSelect('role', 'member'))}</label>
      </div>
      <button type="submit" class="btn primary">Add user</button>
    </form>`;

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Users &amp; roles</p>
    <h1>Users &amp; roles</h1>
    ${raw(card('Roles', roleKey))}
    ${raw(card('Accounts', list))}
    ${raw(card('Add a user', addForm))}`;
  return layout({ title: 'Users & roles', active: '/admin', body });
}

module.exports = { usersAdmin };
