'use strict';

const { html, raw, formatDate } = require('../util');
const { layout, card, emptyState, escapeText } = require('./layout');
const { ORG } = require('../org');
const auth = require('../auth');
const repo = require('../repo');

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

function primaryBody() {
  const all = repo.bodies.all();
  return all.find((b) => b.name === ORG.primaryBody)
    || all.find((b) => b.type === ORG.primaryBodyType)
    || all[0] || null;
}

function isSitting(m) {
  if (m.onRoll) return true;
  if (m.reason === 'holds the seat without a vote') return true;
  if (m.reason === 'term has not begun') return false;
  if (m.end_date) return false;
  return true;
}

const END_CAUSES = ['Retired', 'Term expired', 'Resigned', 'Removed', 'Deceased'];
const SEAT_ROLES = ['Member', 'Chair', 'Vice Chair', 'Alternate', 'Ex-Officio'];

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
  return layout({
    title: 'Bodies & committees',
    subtitle: 'The board and every committee it has constituted, with their seats.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Bodies & committees' }],
    actions: '<a class="btn primary" href="/admin/bodies/new">New body</a>',
    active: '/admin',
    body: html`${raw(card('All bodies', table))}`,
  });
}

function bodyForm(b) {
  const isEdit = !!b;
  const action = isEdit ? `/admin/bodies/${b.id}` : '/admin/bodies';
  const types = ['Governing Body', 'Standing Committee', 'Commission', 'Advisory Board', 'Subcommittee', 'Task Force'];
  const form = html`
    <form class="form" method="post" action="${action}">
      <label>Name<input type="text" name="name" required value="${b ? b.name : ''}" placeholder="Finance Committee"></label>
      <div class="form-row">
        <label>Type<select name="type">${raw(selectOptions(types, b ? b.type : ORG.primaryBodyType, { includeBlank: '\u2014' }))}</select></label>
        <label>Meets<input type="text" name="meets" value="${b && b.meets ? b.meets : ''}" placeholder="2nd Mondays, 4:00 PM"></label>
        <label>Authorized seats<input type="number" min="0" name="seats" value="${b && b.seats != null ? b.seats : ''}" placeholder="7"></label>
        <label>Accent<input type="color" name="accent_color" value="${b && b.accent_color ? b.accent_color : '#353D4F'}"></label>
      </div>
      <p class="hint muted">The accent carries this body in its lockup. The Board name stays slate.</p>
      <label>Meeting location<input type="text" name="meeting_location" value="${b && b.meeting_location ? b.meeting_location : ''}" placeholder="${escapeText(ORG.meetingLocation)}"></label>
      <label>Description<textarea name="description" rows="3">${b ? (b.description || '') : ''}</textarea></label>
      <div class="form-actions">
        <button type="submit" class="btn primary">${isEdit ? 'Save changes' : 'Create body'}</button>
        <a class="btn-link" href="/admin/bodies">Cancel</a>
      </div>
    </form>`;
  return layout({
    title: isEdit ? `Edit ${b.name}` : 'New body',
    subtitle: isEdit ? '' : 'Constitute a committee or another body of the Board.',
    crumbs: [{ href: '/admin/bodies', label: 'Bodies & committees' }, { label: isEdit ? b.name : 'New body' }],
    active: '/admin',
    body: html`${raw(card(isEdit ? 'Body details' : 'Create body', form))}`,
  });
}

function seatForm(bodies, people, opts = {}) {
  const bodyOpts = bodies.map((b) => ({ value: b.id, label: b.name }));
  const form = html`
    <form class="form" method="post" action="/govern/members/seat">
      <div class="form-row">
        <label>Body<select name="body_id" required>${raw(selectOptions(bodyOpts, opts.bodyId || '', { includeBlank: 'Select\u2026' }))}</select></label>
        <label>Seat<select name="seat_role">${raw(selectOptions(SEAT_ROLES, 'Member'))}</select></label>
      </div>
      <label>Who is being seated
        <select name="person_id">${raw(selectOptions(people, '', { includeBlank: '\u2014 someone not yet on file, below \u2014' }))}</select>
      </label>
      <fieldset>
        <legend>\u2026or someone new</legend>
        <div class="form-row">
          <label>Full name<input type="text" name="nominee_name" placeholder="Jane Doe"></label>
          <label>Title<input type="text" name="nominee_title" placeholder="${escapeText(ORG.memberTitle)}"></label>
        </div>
        <div class="form-row">
          <label>Email<input type="email" name="nominee_email" placeholder="jane@blevinsholdings.com"></label>
          <label>Seat / district<input type="text" name="nominee_district" placeholder="Seat Three"></label>
        </div>
      </fieldset>
      <div class="form-row">
        <label>Term begins<input type="date" name="effective_date" value="${escapeText(opts.today || '')}" required></label>
        <label>Term ends<input type="date" name="term_end_date"></label>
      </div>
      <label class="check">
        <input type="checkbox" name="seat_voting" value="1" checked> This seat votes
      </label>
      <label>Note for the record<input type="text" name="reason"></label>
      <div class="form-actions">
        <button type="submit" class="btn primary">Propose seating</button>
        <a class="btn-link" href="/govern/members">Cancel</a>
      </div>
    </form>`;
  return layout({
    title: 'Seat a governor',
    subtitle: 'Grant a seat, with the term it is granted for.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { href: '/govern/members', label: 'Membership' }, { label: 'Seat a governor' }],
    active: '/govern/members',
    body: html`<p class="muted">Nominate → Approve → Complete.</p>${raw(card('Appointment', form))}`,
  });
}

function retireForm(member, body, opts = {}) {
  const person = member ? repo.people.get(member.person_id) : null;
  const form = html`
    <form class="form" method="post" action="/govern/members/retire">
      <input type="hidden" name="member_id" value="${member.id}">
      <p class="muted">On <strong>${escapeText(body.name)}</strong> as ${escapeText(member.role || 'Member')}.</p>
      <div class="form-row">
        <label>Last day of service<input type="date" name="effective_date" value="${escapeText(opts.today || '')}" required></label>
        <label>How the service ended<select name="cause">${raw(selectOptions(END_CAUSES, 'Retired'))}</select></label>
      </div>
      <label>Note for the record<input type="text" name="reason"></label>
      <div class="form-actions">
        <button type="submit" class="btn primary">Propose retirement</button>
        <a class="btn-link" href="/govern/members">Cancel</a>
      </div>
    </form>`;
  const who = (person && person.full_name) || 'a governor';
  return layout({
    title: `Retire ${who}`,
    subtitle: 'Close the term and keep the service on the record.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { href: '/govern/members', label: 'Membership' }, { label: 'Retire' }],
    active: '/govern/members',
    body: html`${raw(card('Retirement', form))}`,
  });
}

function motionCard(m, user) {
  const isClerk = auth.hasRole(user, 'clerk');
  const canApprove = auth.hasRole(user, 'staff') && user && user.id !== m.nominated_by;
  const subject = repo.memberMotions.subjectName(m);
  const verb = m.action === 'seat' ? 'Seat' : 'Remove';
  const trail = [
    `Nominated by ${escapeText(m.nominated_by_name || '\u2014')}${m.nominated_at ? ' \u00b7 ' + formatDate(m.nominated_at) : ''}`,
    m.approved_by_name ? `Approved by ${escapeText(m.approved_by_name)}${m.approved_at ? ' \u00b7 ' + formatDate(m.approved_at) : ''}` : '',
    m.completed_by_name ? `Completed by ${escapeText(m.completed_by_name)}${m.completed_at ? ' \u00b7 ' + formatDate(m.completed_at) : ''}` : '',
  ].filter(Boolean).map((t) => `<li>${t}</li>`).join('');
  let actions = '';
  if (m.status === 'Nominated') {
    actions = canApprove
      ? `<form class="form inline-form" method="post" action="/govern/member-motions/${m.id}/approve">
           <label>Decision note<input type="text" name="notes"></label>
           <div class="form-actions"><button type="submit" class="btn primary">Approve</button></div>
         </form>
         <form method="post" action="/govern/member-motions/${m.id}/reject" class="inline">
           <button type="submit" class="btn">Reject</button></form>`
      : `<p class="muted">Awaiting approval by someone other than the nominator.</p>`;
  } else if (m.status === 'Approved') {
    actions = (isClerk
      ? `<form method="post" action="/govern/member-motions/${m.id}/complete" class="inline">
           <button type="submit" class="btn primary">${verb === 'Seat' ? 'Seat member' : 'Remove member'}</button></form>`
      : '<span class="muted">Approved \u2014 awaiting the Clerk.</span>')
      + ` <form method="post" action="/govern/member-motions/${m.id}/reject" class="inline"><button type="submit" class="btn">Reject</button></form>`;
  }
  return `<div class="motion-card">
    <div class="motion-head"><strong>${escapeText(verb)}: ${escapeText(subject)}</strong> ${badge(m.status)}</div>
    <p class="sub">${escapeText(m.body_name || '')}${m.seat_role && m.action === 'seat' ? ' \u00b7 as ' + escapeText(m.seat_role) : ''}</p>
    <ul class="motion-trail">${trail}</ul>
    ${actions}
  </div>`;
}

function membersPage(user) {
  const isClerk = auth.hasRole(user, 'clerk');
  const allBodies = repo.bodies.all(true);
  const people = repo.people.all(true).map((p) => ({ value: p.id, label: p.full_name + (p.title ? ` (${p.title})` : '') }));
  const pending = repo.memberMotions.pending();
  const pendingHtml = pending.length ? pending.map((m) => motionCard(m, user)).join('') : emptyState('No pending membership changes.');
  const expiring = repo.bodies.expiringTerms(120);
  const vacancies = repo.bodies.vacancies();
  const today = new Date().toISOString().slice(0, 10);
  const expRows = expiring.length ? expiring.map((t) => html`
    <tr class="${t.end_date < today ? 'over-row' : ''}">
      <td><a href="/people/${t.person_id}">${t.full_name}</a></td>
      <td>${t.body_name}</td>
      <td>${t.role || 'Member'}</td>
      <td>${raw(formatDate(t.end_date))}${t.end_date < today ? raw(' <span class="badge st-failed">expired</span>') : ''}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="muted">No terms end within 120 days.</td></tr>';
  const vacRows = vacancies.length ? vacancies.map((v) => html`
    <tr><td><a href="/bodies/${v.id}">${v.name}</a></td>
      <td>${v.filled} of ${v.seats} seats filled</td>
      <td><span class="badge st-failed">${v.seats - v.filled} vacant</span></td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No vacancies \u2014 all authorized seats are filled.</td></tr>';
  const termsCard = card('Terms & vacancies', `
    <h3 class="tab-h">Terms ending soon</h3>
    <table class="data compact"><thead><tr><th>Member</th><th>Body</th><th>Role</th><th>Term ends</th></tr></thead><tbody>${expRows}</tbody></table>
    <h3 class="tab-h">Vacant seats</h3>
    <table class="data compact"><thead><tr><th>Body</th><th>Filled</th><th></th></tr></thead><tbody>${vacRows}</tbody></table>`);
  const rosterCards = allBodies.map((b) => {
    const members = repo.bodies.seatStatus(b.id);
    const sitting = members.filter(isSitting);
    const rows = members.length ? members.map((mm) => html`
      <tr class="${mm.onRoll ? '' : 'off-roll'}">
        <td><a href="/people/${mm.person_id}">${mm.full_name}</a></td>
        <td>${mm.role || 'Member'}${mm.onRoll ? '' : raw(`<div class="muted seat-why">${escapeText(mm.reason)}</div>`)}</td>
        <td>${isClerk ? raw(`
          <form class="inline term-form" method="post" action="/govern/members/${mm.id}/term">
            <input type="date" name="start_date" value="${escapeText(mm.start_date || '')}">
            <input type="date" name="end_date" value="${escapeText(mm.end_date || '')}">
            <button type="submit" class="btn-link">save term</button>
          </form>`) : raw(mm.end_date ? `Term ends ${escapeText(mm.end_date)}` : '')}</td>
        <td>${isClerk ? raw(mm.end_date
    ? `<span class="muted">Concluded ${escapeText(mm.end_date)}${mm.end_reason ? ` \u00b7 ${escapeText(mm.end_reason)}` : ''}</span>`
    : `<a class="btn-link" href="/govern/members/retire?member=${mm.id}">Retire\u2026</a>`) : ''}</td>
      </tr>`).join('') : `<tr><td colspan="4" class="muted">No members.</td></tr>`;
    const voting = sitting.filter((m) => m.onRoll).length;
    const seatNote = b.seats != null
      ? ` \u2014 ${sitting.length}/${b.seats} seats${b.seats > sitting.length ? `, ${b.seats - sitting.length} vacant` : ''}`
        + (voting === sitting.length ? '' : `, ${voting} voting`)
      : '';
    return card(b.name + seatNote,
      `<table class="data compact"><thead><tr><th>Member</th><th>Role</th><th>Term</th><th></th></tr></thead><tbody>${rows}</tbody></table>`);
  }).join('');
  const seatLink = isClerk ? card('Seat a governor', html`<p><a class="btn primary" href="/govern/members/seat">Seat a governor \u2192</a></p>`) : '';
  return layout({
    title: 'Board membership',
    subtitle: 'Who holds which seat, on what term, and what changes are in flight.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Membership' }],
    actions: '<a class="btn primary" href="/govern/members/seat">Seat a governor</a>',
    active: '/govern/members',
    body: html`
      <p class="muted">Nominate \u2192 Approve \u2192 Seat.</p>
      ${raw(card('Pending changes', pendingHtml))}
      ${raw(termsCard)}
      ${raw(seatLink)}
      <h2 class="section-title">Current rosters</h2>
      ${raw(rosterCards)}`,
  });
}

module.exports = {
  badge, selectOptions, primaryBody, isSitting,
  END_CAUSES, SEAT_ROLES,
  retireForm, seatForm, bodiesAdmin, bodyForm, membersPage, motionCard,
};
