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
  const types = ['Governing Body', 'Standing Committee', 'Commission',
    'Advisory Board', 'Subcommittee', 'Task Force'];
  const form = html`
    <form class="form" method="post" action="${action}">
      <label>Name<input type="text" name="name" required value="${b ? b.name : ''}" placeholder="Finance Committee"></label>
      <div class="form-row">
        <label>Type<select name="type">${raw(selectOptions(types, b ? b.type : ORG.primaryBodyType, { includeBlank: '—' }))}</select></label>
        <label>Meets<input type="text" name="meets" value="${b && b.meets ? b.meets : ''}" placeholder="2nd Mondays, 4:00 PM"></label>
        <label>Authorized seats<input type="number" min="0" name="seats" value="${b && b.seats != null ? b.seats : ''}" placeholder="7"></label>
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

  // Terms & vacancies: expiring/expired terms plus unfilled authorized seats.
  const expiring = repo.bodies.expiringTerms(120);
  const vacancies = repo.bodies.vacancies();
  const today = new Date().toISOString().slice(0, 10);
  const expRows = expiring.length ? expiring.map((t) => html`
    <tr class="${t.end_date < today ? 'over-row' : ''}">
      <td><a href="/people/${t.person_id}">${t.full_name}</a></td>
      <td>${t.body_name}</td>
      <td>${t.role || 'Member'}</td>
      <td>${raw(formatDate(t.end_date))}${t.end_date < today ? raw(' <span class="badge st-failed">expired</span>') : ''}</td>
    </tr>`).join('')
    : '<tr><td colspan="4" class="muted">No terms end within 120 days.</td></tr>';
  const vacRows = vacancies.length ? vacancies.map((v) => html`
    <tr><td><a href="/bodies/${v.id}">${v.name}</a></td>
      <td>${v.filled} of ${v.seats} seats filled</td>
      <td><span class="badge st-failed">${v.seats - v.filled} vacant</span></td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No vacancies — all authorized seats are filled.</td></tr>';
  const termsCard = card('Terms & vacancies', `
    <h3 class="tab-h">Terms ending soon</h3>
    <table class="data compact"><thead><tr><th>Member</th><th>Body</th><th>Role</th><th>Term ends</th></tr></thead>
      <tbody>${expRows}</tbody></table>
    <h3 class="tab-h">Vacant seats</h3>
    <table class="data compact"><thead><tr><th>Body</th><th>Filled</th><th></th></tr></thead>
      <tbody>${vacRows}</tbody></table>
    <p class="muted">Set authorized seats on each body (Admin → Bodies), and term dates in the rosters below.</p>`);

  // Current rosters with remove-propose (clerk only)
  const rosterCards = allBodies.map((b) => {
    const members = repo.bodies.members(b.id);
    const rows = members.length ? members.map((mm) => html`
      <tr>
        <td><a href="/people/${mm.person_id}">${mm.full_name}</a></td>
        <td>${mm.role || 'Member'}</td>
        <td>${isClerk ? raw(`
          <form class="inline term-form" method="post" action="/govern/members/${mm.id}/term" title="Term dates">
            <input type="date" name="start_date" value="${escapeText(mm.start_date || '')}" aria-label="Term start">
            <input type="date" name="end_date" value="${escapeText(mm.end_date || '')}" aria-label="Term end">
            <button type="submit" class="btn-link">save term</button>
          </form>`) : raw(mm.end_date ? `Term ends ${escapeText(mm.end_date)}` : '')}</td>
        <td>${isClerk ? raw(`
          <form class="inline remove-form" method="post" action="/govern/members/nominate">
            <input type="hidden" name="action" value="remove">
            <input type="hidden" name="body_id" value="${b.id}">
            <input type="hidden" name="member_id" value="${mm.id}">
            <input type="hidden" name="person_id" value="${mm.person_id}">
            <input type="text" name="reason" placeholder="Reason (optional)" class="reason-inp">
            <button type="submit" class="btn-link danger">Propose removal</button>
          </form>`) : ''}</td>
      </tr>`).join('') : `<tr><td colspan="4" class="muted">No members.</td></tr>`;
    const seatNote = b.seats != null
      ? ` — ${members.length}/${b.seats} seats${b.seats > members.length ? `, ${b.seats - members.length} vacant` : ''}` : '';
    return card(b.name + seatNote,
      `<table class="data compact"><thead><tr><th>Member</th><th>Role</th><th>Term</th><th></th></tr></thead><tbody>${rows}</tbody></table>`);
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
    ${raw(termsCard)}
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
          ${raw(field('logoUrl', 'Seal / logo', 'https://… or /brand/seal.png'))}
          ${raw(field('logoLightUrl', 'Reversed seal', 'for the dark sidebar — /brand/seal-light.png'))}
        </div>
        ${raw(field('logoLockupUrl', 'Horizontal lockup', 'optional — replaces the seal and name in the sidebar'))}
        <div class="form-row">
          ${raw(field('primaryColor', 'Primary color', '', 'color'))}
          ${raw(field('seal', 'Seal glyph', 'fallback when no artwork is set'))}
        </div>
        <div class="form-row">
          ${raw(field('faviconUrl', 'Favicon', 'tab icon; defaults to the seal'))}
        </div>
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

// ===========================================================================
// Roster import (CSV "data populate" / direct-seat bootstrap) — clerk
// ===========================================================================
function importPage({ result = null } = {}) {
  const example = `name,email,login_role,committee,committee_role
Benjamin Blevins,benjamin.blevins@blevinsholdings.com,clerk,,
Jane Smith,jane.smith@blevinsholdings.com,staff,Board of Governors,Chair
Jane Smith,jane.smith@blevinsholdings.com,,Committee on Appropriations and Budget,Member
John Doe,john.doe@blevinsholdings.com,member,Committee on Enterprise Operations,Member`;

  let summary = '';
  if (result) {
    const errs = result.errors.length
      ? `<div class="form-error"><strong>${result.errors.length} issue(s) (these rows were skipped):</strong>
         <ul>${result.errors.map((e) => `<li>${escapeText(e)}</li>`).join('')}</ul></div>`
      : '';
    summary = `<div class="import-result">
      ${result.errors.length ? '' : '<p class="form-ok">Import complete.</p>'}
      <ul class="import-stats">
        <li>Rows processed: <strong>${result.rows}</strong></li>
        <li>People created: <strong>${result.peopleCreated}</strong></li>
        <li>Committee seats added: <strong>${result.seats}</strong></li>
        <li>Committees created: <strong>${result.committeesCreated}</strong></li>
        <li>Logins created: <strong>${result.usersCreated}</strong>, updated: <strong>${result.usersUpdated}</strong></li>
      </ul>${errs}
    </div>`;
  }

  const form = html`
    <form class="form" method="post" action="/admin/import">
      <p class="muted">Bulk-create members, seat them on committees, and provision logins.
        Seating here is <strong>direct</strong> (it skips Nominate→Approve→Seat), so use it for initial setup.</p>
      <label>Choose a CSV file
        <input type="file" id="csvfile" accept=".csv,text/csv">
      </label>
      <label>CSV data (filled from the file above, or paste/edit directly)
        <textarea id="csvtext" name="csv" rows="10" required placeholder="${escapeText(example)}"></textarea>
      </label>
      <div class="form-actions"><button type="submit" class="btn primary">Import</button></div>
    </form>
    <details class="import-help">
      <summary>CSV format &amp; example</summary>
      <p>A header row, then one row <em>per person per committee</em> (repeat a person to place them on several). Columns:</p>
      <ul>
        <li><code>name</code> — full name</li>
        <li><code>email</code> — email (used for the SSO login match and contact)</li>
        <li><code>login_role</code> — blank for no login, or <code>member</code> / <code>staff</code> / <code>clerk</code> (staff can approve membership changes; clerk = full admin)</li>
        <li><code>committee</code> — committee/body to place them on (created if it doesn't exist)</li>
        <li><code>committee_role</code> — Chair / Vice Chair / Member (default Member)</li>
      </ul>
      <pre class="import-example">${escapeText(example)}</pre>
    </details>`;

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Import roster</p>
    <h1>Import roster (CSV)</h1>
    <p class="muted">Importing legislative files instead? <a href="/admin/import/matters">Import legislative files</a>.</p>
    ${result ? raw(summary) : ''}
    ${raw(card('Bulk import', form))}
    <script src="/assets/csv-fill.js" defer></script>`;
  return layout({ title: 'Import roster', active: '/admin', body });
}

function mattersImportPage({ result = null } = {}) {
  const example = `file_number,type,title,status,body,intro_date,final_date,summary,sponsors,topics
,Ordinance,Trash collection schedule update,Enacted,Board of Governors,2026-03-04,2026-04-01,Updates residential pickup days.,Jane Smith;John Doe,Public Works;Sanitation
,Resolution,FY27 budget adoption,Passed,Board of Governors,2026-05-12,,Adopts the FY27 operating budget.,Jane Smith,Budget
260601,Motion,Adopt meeting calendar,Draft,,,,,,`;

  let summary = '';
  if (result) {
    const errs = result.errors.length
      ? `<div class="form-error"><strong>${result.errors.length} row(s) skipped:</strong>
         <ul>${result.errors.map((e) => `<li>${escapeText(e)}</li>`).join('')}</ul></div>`
      : '';
    const warns = (result.warnings || []).length
      ? `<div class="form-warn"><strong>${result.warnings.length} warning(s):</strong>
         <ul>${result.warnings.map((e) => `<li>${escapeText(e)}</li>`).join('')}</ul></div>`
      : '';
    summary = `<div class="import-result">
      ${result.errors.length ? '' : '<p class="form-ok">Import complete.</p>'}
      <ul class="import-stats">
        <li>Rows processed: <strong>${result.rows}</strong></li>
        <li>Files created: <strong>${result.created}</strong></li>
        <li>Sponsors linked: <strong>${result.sponsorsLinked}</strong></li>
        <li>History entries added: <strong>${result.historyAdded}</strong></li>
      </ul>${errs}${warns}
    </div>`;
  }

  const form = html`
    <form class="form" method="post" action="/admin/import/matters">
      <p class="muted">Bulk-create legislative files (matters) from a spreadsheet export —
        for migrating historical records into the system.</p>
      <label>Choose a CSV file
        <input type="file" id="csvfile" accept=".csv,text/csv">
      </label>
      <label>CSV data (filled from the file above, or paste/edit directly)
        <textarea id="csvtext" name="csv" rows="10" required placeholder="${escapeText(example)}"></textarea>
      </label>
      <div class="form-actions"><button type="submit" class="btn primary">Import files</button></div>
    </form>
    <details class="import-help">
      <summary>CSV format &amp; example</summary>
      <p>A header row, then one row per legislative file. Columns:</p>
      <ul>
        <li><code>file_number</code> — blank to auto-assign the next YYMMXX number; if given, must be unused</li>
        <li><code>type</code> — Ordinance, Resolution, Motion, Appointment, Public Hearing, Proclamation, Contract, Report, or Communication</li>
        <li><code>status</code> — e.g. Draft, Introduced, Passed, Enacted (defaults to Draft)</li>
        <li><code>body</code> — the body in control, matched by name (must already exist)</li>
        <li><code>intro_date</code> / <code>final_date</code> — YYYY-MM-DD; an intro date also creates an "Introduced" history entry</li>
        <li><code>summary</code> — short description</li>
        <li><code>sponsors</code> — semicolon-separated member names (first is Primary); unmatched names are skipped with a warning</li>
        <li><code>topics</code> — semicolon-separated index terms (created as needed)</li>
      </ul>
      <pre class="import-example">${escapeText(example)}</pre>
    </details>`;

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / <a href="/admin/import">Import</a> / Legislative files</p>
    <h1>Import legislative files (CSV)</h1>
    ${result ? raw(summary) : ''}
    ${raw(card('Bulk import', form))}
    <script src="/assets/csv-fill.js" defer></script>`;
  return layout({ title: 'Import legislative files', active: '/admin', body });
}

function announcementPage({ saved = false } = {}) {
  const announcement = require('../announcement');
  const a = announcement.get();
  const levelOpts = announcement.LEVELS.map((lv) =>
    `<option value="${lv}"${a.level === lv ? ' selected' : ''}>${escapeText(lv[0].toUpperCase() + lv.slice(1))}</option>`).join('');
  const preview = a.text
    ? `<div class="announce announce-${escapeText(a.level)}"><span class="announce-ic">📢</span><span class="announce-text">${escapeText(a.text)}</span></div>`
    : emptyState('No announcement is currently showing.');

  const form = html`
    <form class="form" method="post" action="/admin/announcement">
      <label>Message<textarea name="text" rows="3" maxlength="500" placeholder="e.g. The Board meeting has been moved to 11:30 a.m.">${escapeText(a.text)}</textarea></label>
      <div class="form-row">
        <label>Level<select name="level">${raw(levelOpts)}</select></label>
        <label class="check-label"><input type="checkbox" name="active" value="1"${a.active ? ' checked' : ''}> Show the banner site-wide</label>
      </div>
      <button type="submit" class="btn primary">Save announcement</button>
    </form>
    <p class="muted">Clear the message or uncheck the box to take the banner down. It shows on every page, above the content.</p>`;

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Announcement</p>
    <h1>Site announcement banner</h1>
    ${saved ? raw('<p class="saved-banner">Announcement saved.</p>') : ''}
    ${raw(card('Current banner', preview))}
    ${raw(card('Edit', form))}`;
  return layout({ title: 'Announcement', active: '/admin', body });
}

function integrationsPage({ status: flash = '' } = {}) {
  const esign = require('../esign');
  const s = esign.status();
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const redirectUri = (base || '(your app URL)') + '/admin/integrations/adobe/callback';
  const REGIONS = ['na1', 'na2', 'na3', 'eu1', 'eu2', 'au1', 'jp1', 'in1', 'sg1'];
  const regionOpts = REGIONS.map((r) => `<option value="${r}"${s.region === r ? ' selected' : ''}>${r}</option>`).join('');

  const flashMsg = flash === 'connected' ? '<p class="saved-banner">Connected to Adobe Acrobat Sign.</p>'
    : (flash === 'saved' ? '<p class="saved-banner">Credentials saved.</p>'
      : (flash === 'disconnected' ? '<p class="saved-banner">Disconnected.</p>'
        : (flash === 'error' ? '<p class="form-error">Could not connect — check the credentials, redirect URI, and scopes, then try again.</p>' : '')));

  const statusLine = s.connected
    ? `<p class="form-ok">✓ Connected to Adobe Acrobat Sign (region ${escapeText(s.region || 'na1')}). Circulating a written consent now sends it for e-signature.</p>`
    : (s.hasCredentials
      ? '<p class="muted">Credentials saved. Click <strong>Connect</strong> below to authorize with Adobe.</p>'
      : '<p class="muted">Not configured. Enter your Adobe API application credentials, save, then connect.</p>');

  const connectBtn = s.hasCredentials
    ? `<a class="btn primary" href="/admin/integrations/adobe/connect">${s.connected ? 'Reconnect' : 'Connect to Adobe'}</a>`
    : '<button class="btn primary" disabled title="Save credentials first">Connect to Adobe</button>';
  const disconnectBtn = s.connected
    ? `<form method="post" action="/admin/integrations/adobe/disconnect" class="inline" onsubmit="return confirm('Disconnect Adobe Acrobat Sign?')"><button class="btn ghost" type="submit">Disconnect</button></form>`
    : '';

  const form = html`
    <form class="form" method="post" action="/admin/integrations/adobe">
      <div class="form-row">
        <label>Client ID<input type="text" name="client_id" value="${escapeText(s.clientId || '')}" autocomplete="off"></label>
        <label>Client Secret<input type="password" name="client_secret" placeholder="${s.hasCredentials ? '•••••••• (leave blank to keep)' : ''}" autocomplete="off"></label>
      </div>
      <div class="form-row">
        <label>Region<select name="region">${raw(regionOpts)}</select></label>
        <label>Webhook client ID <span class="muted">(optional)</span><input type="text" name="webhook_client_id" value="${escapeText(s.webhookClientId === s.clientId ? '' : (s.webhookClientId || ''))}" autocomplete="off"></label>
      </div>
      <label>Scopes<input type="text" name="scopes" value="${escapeText(s.scopes || '')}"></label>
      <button type="submit" class="btn">Save credentials</button>
    </form>`;

  const setup = `<ol class="setup-list">
    <li>In Adobe Acrobat Sign: <em>Account → Adobe Sign API → API Applications</em> — create an application for your own account.</li>
    <li>Configure OAuth and add this <strong>Redirect URI</strong>: <code>${escapeText(redirectUri)}</code></li>
    <li>Copy the Client ID and Client Secret into the form below, pick your region, and Save.</li>
    <li>Click <strong>Connect</strong>, approve in Adobe — the refresh token is captured automatically.</li>
    <li>Register a webhook in Adobe pointing to <code>${escapeText((base || '(your app URL)') + '/webhooks/adobe-sign')}</code> for agreement events.</li>
  </ol>`;

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Integrations</p>
    <h1>Integrations — Adobe Acrobat Sign</h1>
    ${raw(flashMsg)}
    ${raw(card('Status', statusLine + `<div class="head-actions" style="margin-top:10px">${connectBtn} ${disconnectBtn}</div>`))}
    ${raw(card('Setup', setup))}
    ${raw(card('API application credentials', form))}`;
  return layout({ title: 'Integrations', active: '/admin', body });
}

module.exports = { bodiesAdmin, bodyForm, membersPage, brandingPage, importPage, mattersImportPage, announcementPage, integrationsPage };
