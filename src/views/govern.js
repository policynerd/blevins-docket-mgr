'use strict';

const { html, raw, formatDate } = require('../util');
const { layout, card, emptyState, escapeText } = require('./layout');
const { ORG, FIELDS, EDITABLE } = require('../org');
const auth = require('../auth');
const repo = require('../repo');

// Status badge as a plain HTML string (motionCard builds raw markup, so it
// can't use layout.statusBadge, which returns a raw() wrapper object).
function badge(status) {
  const cls = 'st-' + String(status || '').toLowerCase().replace(/[^a-z]+/g, '-');
  return `<span class="badge ${cls}">${escapeText(status)}</span>`;
}

function selectOptions(values, current, { includeBlank } = {}) {
  let out = includeBlank ? `<option value="">${escapeText(includeBlank)}</option>` : '';
  for (const v of values) {
    const value = typeof v === 'object' ? v.value : v;
    const label = typeof v === 'object' ? v.label : v;
    out += `<option value="${escapeText(value)}"${String(value) === String(current) ? ' selected' : ''}>${escapeText(label)}</option>`;
  }
  return out;
}

// Identify the primary legislative body (best effort).
function primaryBody() {
  const all = repo.bodies.all();
  return all.find((b) => b.name === ORG.primaryBody)
    || all.find((b) => b.type === ORG.primaryBodyType)
    || all[0] || null;
}

// ===========================================================================
// Bodies CRUD (clerk)
// ===========================================================================
function bodiesAdmin() {
  const rows = repo.bodies.all().map((b) => {
    const refs = repo.bodies.references(b.id);
    const blocked = refs.meetings + refs.matters + refs.history > 0;
    const memberCount = repo.bodies.members(b.id).length;
    const delControl = blocked
      ? `<span class="muted" title="Referenced by ${refs.meetings} meeting(s), ${refs.matters} file(s)">Has records</span>`
      : `<form method="post" action="/admin/bodies/${b.id}/delete" onsubmit="return confirm('Permanently delete this body? This cannot be undone.')" class="inline">
           <button type="submit" class="btn-link danger">Delete</button></form>`;
    return html`
      <tr class="${b.active ? '' : 'row-inactive'}">
        <td><a href="/bodies/${b.id}">${b.name}</a>${b.active ? '' : raw(' <span class="badge st-inactive">Inactive</span>')}</td>
        <td>${b.type || ''}</td>
        <td>${memberCount}</td>
        <td>
          <a class="btn-link" href="/admin/bodies/${b.id}/edit">Edit</a>
          <form method="post" action="/admin/bodies/${b.id}/active" class="inline">
            <input type="hidden" name="active" value="${b.active ? 0 : 1}">
            <button type="submit" class="btn-link">${b.active ? 'Deactivate' : 'Reactivate'}</button>
          </form>
          ${raw(delControl)}
        </td>
      </tr>`;
  }).join('');

  const table = rows
    ? `<table class="data"><thead><tr><th>Name</th><th>Type</th><th>Members</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
    : emptyState('No bodies yet. Add the board and its committees.');

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Bodies &amp; committees</p>
    <div class="detail-head">
      <h1>Bodies &amp; committees</h1>
      <span class="head-actions"><a class="btn" href="/admin/bodies/new">+ New body</a></span>
    </div>
    ${raw(card('All bodies', table))}`;
  return layout({ title: 'Bodies & committees', active: '/admin', body });
}

function bodyForm(b) {
  const isEdit = !!b;
  const action = isEdit ? `/admin/bodies/${b.id}` : '/admin/bodies';
  const types = ['Governing Board', 'Primary Legislative Body', 'Standing Committee',
    'Commission', 'Board', 'Advisory Committee', 'Subcommittee', 'Task Force'];
  const form = html`
    <form class="form" method="post" action="${action}">
      <label>Name<input type="text" name="name" required value="${b ? b.name : ''}" placeholder="Finance Committee"></label>
      <div class="form-row">
        <label>Type<select name="type">${raw(selectOptions(types, b ? b.type : ORG.primaryBodyType, { includeBlank: '—' }))}</select></label>
        <label>Meets<input type="text" name="meets" value="${b && b.meets ? b.meets : ''}" placeholder="2nd Mondays, 4:00 PM"></label>
      </div>
      <label>Meeting location<input type="text" name="meeting_location" value="${b && b.meeting_location ? b.meeting_location : ''}" placeholder="${escapeText(ORG.meetingLocation)}"></label>
      <label>Description<textarea name="description" rows="3">${b ? (b.description || '') : ''}</textarea></label>
      <div class="form-actions">
        <button type="submit" class="btn primary">${isEdit ? 'Save changes' : 'Create body'}</button>
        <a class="btn-link" href="/admin/bodies">Cancel</a>
      </div>
    </form>`;
  const body = html`
    <p class="crumbs"><a href="/admin/bodies">Bodies</a> / ${isEdit ? b.name : 'New body'}</p>
    <h1>${isEdit ? 'Edit ' + b.name : 'New body'}</h1>
    ${raw(card(isEdit ? 'Body details' : 'Create body', form))}`;
  return layout({ title: isEdit ? 'Edit body' : 'New body', active: '/admin', body });
}

// ===========================================================================
// Board membership workflow: Nominate -> Approve -> Seat  (staff+)
// ===========================================================================
function motionCard(m, user) {
  const isClerk = auth.hasRole(user, 'clerk');
  const canApprove = auth.hasRole(user, 'staff') && user && user.id !== m.nominated_by;
  const subject = repo.memberMotions.subjectName(m);
  const verb = m.action === 'seat' ? 'Seat' : 'Remove';

  const trail = [
    `Nominated by ${escapeText(m.nominated_by_name || '—')}${m.nominated_at ? ' · ' + formatDate(m.nominated_at) : ''}`,
    m.approved_by_name ? `Approved by ${escapeText(m.approved_by_name)}${m.approved_at ? ' · ' + formatDate(m.approved_at) : ''}` : '',
    m.completed_by_name ? `Completed by ${escapeText(m.completed_by_name)}${m.completed_at ? ' · ' + formatDate(m.completed_at) : ''}` : '',
  ].filter(Boolean).map((t) => `<li>${t}</li>`).join('');

  let actions = '';
  if (m.status === 'Nominated') {
    if (canApprove) {
      actions = `
        <form class="form inline-form" method="post" action="/govern/member-motions/${m.id}/approve">
          <label>Decision note<input type="text" name="notes" placeholder="Optional"></label>
          <div class="form-actions">
            <button type="submit" class="btn primary">Approve</button>
          </div>
        </form>
        <form method="post" action="/govern/member-motions/${m.id}/reject" class="inline">
          <button type="submit" class="btn">Reject</button>
        </form>`;
    } else {
      actions = `<p class="muted">Awaiting approval by someone other than the nominator${isClerk ? ' (you nominated this).' : '.'}</p>`;
    }
  } else if (m.status === 'Approved') {
    const seatBtn = isClerk
      ? `<form method="post" action="/govern/member-motions/${m.id}/complete" class="inline">
           <button type="submit" class="btn primary">${verb === 'Seat' ? 'Seat member' : 'Remove member'}</button>
         </form>`
      : '<span class="muted">Approved — awaiting the Clerk to execute.</span>';
    const rejectBtn = `<form method="post" action="/govern/member-motions/${m.id}/reject" class="inline">
        <button type="submit" class="btn">Reject</button></form>`;
    actions = seatBtn + ' ' + rejectBtn;
  }

  return `<div class="motion-card">
    <div class="motion-head">
      <strong>${escapeText(verb)}: ${escapeText(subject)}</strong>
      ${badge(m.status)}
    </div>
    <p class="sub">${escapeText(m.body_name || '')}${m.seat_role && m.action === 'seat' ? ' · as ' + escapeText(m.seat_role) : ''}${m.reason ? ' · ' + escapeText(m.reason) : ''}</p>
    <ul class="motion-trail">${trail}</ul>
    ${m.decision_notes ? `<p class="sub">Note: ${escapeText(m.decision_notes)}</p>` : ''}
    ${actions}
  </div>`;
}

function membersPage(user) {
  const isClerk = auth.hasRole(user, 'clerk');
  const allBodies = repo.bodies.all(true);
  const bodyOpts = allBodies.map((b) => ({ value: b.id, label: b.name }));
  const pb = primaryBody();
  const people = repo.people.all(true).map((p) => ({ value: p.id, label: p.full_name + (p.title ? ` (${p.title})` : '') }));

  // Pending workflow
  const pending = repo.memberMotions.pending();
  const pendingHtml = pending.length
    ? pending.map((m) => motionCard(m, user)).join('')
    : emptyState('No pending membership changes.');

  // Current rosters with remove-propose (clerk only)
  const rosterCards = allBodies.map((b) => {
    const members = repo.bodies.members(b.id);
    const rows = members.length ? members.map((mm) => html`
      <tr>
        <td><a href="/people/${mm.person_id}">${mm.full_name}</a></td>
        <td>${mm.role || 'Member'}</td>
        <td>${isClerk ? raw(`
          <form class="inline remove-form" method="post" action="/govern/members/nominate">
            <input type="hidden" name="action" value="remove">
            <input type="hidden" name="body_id" value="${b.id}">
            <input type="hidden" name="member_id" value="${mm.id}">
            <input type="hidden" name="person_id" value="${mm.person_id}">
            <input type="text" name="reason" placeholder="Reason (optional)" class="reason-inp">
            <button type="submit" class="btn-link danger">Propose removal</button>
          </form>`) : ''}</td>
      </tr>`).join('') : `<tr><td colspan="3" class="muted">No members.</td></tr>`;
    return card(b.name, `<table class="data compact"><thead><tr><th>Member</th><th>Role</th><th></th></tr></thead><tbody>${rows}</tbody></table>`);
  }).join('');

  // Nominate-to-seat form (clerk only)
  const nominateForm = isClerk ? card('Nominate a member to seat', html`
    <form class="form" method="post" action="/govern/members/nominate">
      <input type="hidden" name="action" value="seat">
      <div class="form-row">
        <label>Body<select name="body_id" required>${raw(selectOptions(bodyOpts, pb ? pb.id : '', { includeBlank: 'Select…' }))}</select></label>
        <label>Seat role<select name="seat_role">${raw(selectOptions(['Member', 'Chair', 'Vice Chair', 'Alternate', 'Ex-Officio'], 'Member'))}</select></label>
      </div>
      <label>Existing person (optional)
        <select name="person_id">${raw(selectOptions(people, '', { includeBlank: '— new person below —' }))}</select>
      </label>
      <fieldset>
        <legend>…or a new person</legend>
        <div class="form-row">
          <label>Full name<input type="text" name="nominee_name" placeholder="Jane Doe"></label>
          <label>Title<input type="text" name="nominee_title" placeholder="${escapeText(ORG.memberTitle)}"></label>
        </div>
        <div class="form-row">
          <label>Email<input type="email" name="nominee_email" placeholder="jane@example.gov"></label>
          <label>District / seat<input type="text" name="nominee_district" placeholder="Seat 3"></label>
        </div>
      </fieldset>
      <label>Reason / note<input type="text" name="reason" placeholder="Appointment context (optional)"></label>
      <button type="submit" class="btn primary">Submit nomination</button>
    </form>`) : '';

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Membership</p>
    <h1>Board membership</h1>
    <p class="muted">Changes follow <strong>Nominate → Approve → Seat</strong>. The Clerk nominates and executes; approval must come from someone other than the nominator.</p>
    ${raw(card('Pending changes', pendingHtml))}
    ${raw(nominateForm)}
    <h2 class="section-title">Current rosters</h2>
    ${raw(rosterCards)}`;
  return layout({ title: 'Board membership', active: '/govern/members', body });
}

// ===========================================================================
// Branding settings (clerk)
// ===========================================================================
function brandingPage({ saved = false } = {}) {
  const field = (key, label, hint, type = 'text') => {
    const f = FIELDS[key];
    const placeholder = f ? (process.env[f.env] || f.def) : '';
    const val = ORG[key] == null ? '' : ORG[key];
    const input = type === 'color'
      ? `<input type="color" name="${key}" value="${escapeText(val || placeholder || '#15569e')}">`
      : `<input type="${type}" name="${key}" value="${escapeText(val)}" placeholder="${escapeText(placeholder)}">`;
    return `<label>${escapeText(label)}${hint ? ` <span class="muted">(${escapeText(hint)})</span>` : ''}${input}</label>`;
  };

  const form = html`
    <form class="form" method="post" action="/admin/branding">
      <fieldset><legend>Identity</legend>
        ${raw(field('name', 'Organization name'))}
        ${raw(field('tagline', 'Tagline'))}
        <div class="form-row">
          ${raw(field('logoUrl', 'Logo URL', 'shown instead of the seal', 'url'))}
          ${raw(field('primaryColor', 'Primary color', '', 'color'))}
        </div>
        ${raw(field('seal', 'Seal glyph', 'used when no logo set'))}
      </fieldset>
      <fieldset><legend>Bodies &amp; roles</legend>
        <div class="form-row">
          ${raw(field('primaryBody', 'Primary body'))}
          ${raw(field('primaryBodyType', 'Primary body type'))}
        </div>
        ${raw(field('membersLabel', 'Members label', 'nav + listing'))}
        <div class="form-row">
          ${raw(field('chairTitle', 'Chair title'))}
          ${raw(field('viceChairTitle', 'Vice-chair title'))}
        </div>
        <div class="form-row">
          ${raw(field('memberTitle', 'Member title'))}
          ${raw(field('clerkTitle', 'Clerk title'))}
        </div>
        ${raw(field('clerkOffice', 'Clerk office'))}
      </fieldset>
      <fieldset><legend>Operations</legend>
        <div class="form-row">
          ${raw(field('meetingLocation', 'Default meeting location'))}
          ${raw(field('emailDomain', 'Email domain'))}
        </div>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn primary">Save branding</button>
      </div>
      <p class="muted">Leave a field blank to fall back to its environment value or built-in default.</p>
    </form>`;

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Branding</p>
    <h1>Branding &amp; identity</h1>
    ${saved ? raw('<p class="form-ok">Branding saved.</p>') : ''}
    ${raw(card('Edit branding', form))}`;
  return layout({ title: 'Branding', active: '/admin', body });
}

module.exports = { bodiesAdmin, bodyForm, membersPage, brandingPage };
