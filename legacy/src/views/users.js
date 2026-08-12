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

// Which governor a login speaks for.
//
// Shown by name, never by number alone. The id is what gets typed, and a
// mistyped one links the wrong governor — after which that person's votes are
// recorded under someone else's name, which is worse than an account that
// cannot vote at all. The name here is how an admin sees they hit the right
// row, and setPerson refuses an id that names nobody rather than quietly
// storing a link to no one.
function personCell(u) {
  const person = u.person_id ? repo.people.get(u.person_id) : null;
  const current = person
    ? `<strong>${escapeText(person.full_name)}</strong> <span class="muted">#${person.id}</span>`
    : '<span class="muted">Not linked — cannot vote</span>';
  return `${current}
    <form class="inline" method="post" action="/admin/users/${u.id}/person">
      <input type="number" min="1" name="person_id" value="${u.person_id || ''}"
             placeholder="id" style="width:6em" aria-label="Board member id">
      <button type="submit" class="btn-link">Link</button>
    </form>`;
}

function linkNotice(link) {
  if (!link) return '';
  const [kind, who] = String(link).split(':');
  const msg = kind === 'taken'
    ? `That board member already has an account${who ? ` (${who})` : ''}. One login per governor — otherwise two people can cast the same vote.`
    : kind === 'no_such_person'
      ? 'No board member has that id. Nothing was linked.'
      : 'The link could not be set.';
  return `<p class="flash bad">${escapeText(msg)}</p>`;
}

function usersAdmin(currentUser, link) {
  const rows = repo.users.all();
  const list = rows.length ? `<table class="data">
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Board member</th><th>Provider</th><th>Status</th><th>Update</th></tr></thead>
    <tbody>${rows.map((u) => {
    const self = currentUser && currentUser.id === u.id;
    return html`
      <tr class="${u.active ? '' : 'row-inactive'}">
        <td>${u.name}${self ? raw(' <span class="muted">(you)</span>') : ''}</td>
        <td>${u.email}</td>
        <td>${raw(personCell(u))}</td>
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
        <label>Board member id<input type="number" min="1" name="person_id" placeholder="optional"></label>
      </div>
      <button type="submit" class="btn primary">Add user</button>
    </form>`;

  // The ids, beside the field that wants them. Looking a number up in another
  // screen and carrying it back is how the wrong governor gets linked.
  const roster = repo.people.all().filter((p) => p.active !== 0);
  const rosterList = roster.length
    ? `<ul class="id-roster">${roster.map((p) =>
      `<li><span class="muted">#${p.id}</span> ${escapeText(p.full_name)}</li>`).join('')}</ul>`
    : emptyState('No people on file.');

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Users &amp; roles</p>
    <h1>Users &amp; roles</h1>
    ${raw(linkNotice(link))}
    ${raw(card('Roles', roleKey))}
    ${raw(card('Accounts', list))}
    ${raw(card('Add a user', addForm))}
    ${raw(card('Board member ids', rosterList))}`;
  return layout({ title: 'Users & roles', active: '/admin', body });
}

module.exports = { usersAdmin };
