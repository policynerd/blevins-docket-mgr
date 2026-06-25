'use strict';

const { html, raw, formatDate, todayISO } = require('../util');
const { layout, card, workflowStepper, statusBadge, typeBadge, emptyState, escapeText } = require('./layout');
const { ORG } = require('../org');
const repo = require('../repo');

function adminHome() {
  const s = repo.stats();
  const recent = repo.matters.search({ limit: 10 });
  const recentRows = recent.map((m) => html`
    <tr>
      <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${m.file_number}</a></td>
      <td>${typeBadge(m.type)}</td>
      <td class="title-cell">${m.title}</td>
      <td>${statusBadge(m.status)}</td>
      <td><a class="btn-link" href="/admin/matters/${m.id}/edit">Edit</a></td>
    </tr>`);

  const body = html`
    <div class="admin-actions">
      <a class="btn" href="/admin/matters/new">+ New legislative file</a>
      <a class="btn" href="/admin/meetings/new">+ Schedule meeting</a>
      <a class="btn" href="/govern/members">Board membership</a>
      <a class="btn" href="/admin/import">Import roster (CSV)</a>
      <a class="btn" href="/admin/bodies">Bodies &amp; committees</a>
      <a class="btn" href="/admin/org">Manage organization</a>
      <a class="btn" href="/admin/branding">Branding</a>
    </div>
    <div class="stat-grid small">
      <div class="stat"><span class="stat-n">${s.matters}</span><span class="stat-l">Files</span></div>
      <div class="stat"><span class="stat-n">${s.pending}</span><span class="stat-l">In progress</span></div>
      <div class="stat"><span class="stat-n">${s.meetings}</span><span class="stat-l">Meetings</span></div>
      <div class="stat"><span class="stat-n">${s.people}</span><span class="stat-l">Officials</span></div>
    </div>
    ${raw(card('Run a meeting live', require('./live').liveLauncher()))}
    ${raw(card('Manage legislation',
      `<table class="data"><thead><tr><th>File #</th><th>Type</th><th>Title</th><th>Status</th><th></th></tr></thead><tbody>${recentRows.join('')}</tbody></table>`))}
    ${raw(card('Danger zone', `
      <p class="muted">Permanently delete <strong>all</strong> people, bodies, legislation, meetings, votes, and org units. Your user logins and branding settings are kept. Use this once to clear the demo/sample data.</p>
      <form method="post" action="/admin/purge" onsubmit="return confirm('Permanently delete ALL legislative data (people, bodies, files, meetings, votes)? This cannot be undone.');">
        <button type="submit" class="btn danger-btn">Clear all data</button>
      </form>`))}
  `;
  return layout({ title: 'Clerk Workspace', active: '/admin',
    subtitle: 'Create files, draft documents, build agendas, run live voting, and capture results.', body });
}

function selectOptions(values, current, { includeBlank } = {}) {
  let html = includeBlank ? `<option value="">${escapeText(includeBlank)}</option>` : '';
  for (const v of values) {
    const value = typeof v === 'object' ? v.value : v;
    const label = typeof v === 'object' ? v.label : v;
    html += `<option value="${escapeText(value)}"${String(value) === String(current) ? ' selected' : ''}>${escapeText(label)}</option>`;
  }
  return html;
}

// --- Matter form (new + edit) -----------------------------------------------
function matterForm(matter, opts = {}) {
  const isEdit = !!matter;
  const allBodies = repo.bodies.all().map((b) => ({ value: b.id, label: b.name }));
  const allPeople = repo.people.all();
  const sponsors = isEdit ? repo.matters.sponsors(matter.id).map((s) => s.id) : [];
  const action = isEdit ? `/admin/matters/${matter.id}` : '/admin/matters';

  const sponsorChecks = allPeople.map((p) => html`
    <label class="chk"><input type="checkbox" name="sponsor_id" value="${p.id}"
      ${sponsors.includes(p.id) ? raw('checked') : ''}> ${p.full_name}</label>`).join('');

  const form = html`
    <form class="form" method="post" action="${action}">
      <div class="form-row">
        <label>Type
          <select name="type" required>${raw(selectOptions(repo.MATTER_TYPES, matter && matter.type))}</select>
        </label>
        <label>Status
          <select name="status">${raw(selectOptions(repo.MATTER_STATUSES, matter ? matter.status : 'Draft'))}</select>
        </label>
      </div>
      <label>Title
        <input type="text" name="title" required value="${matter ? matter.title : ''}" placeholder="An ordinance amending…">
      </label>
      <div class="form-row">
        <label>In control (body)
          <select name="body_id">${raw(selectOptions(allBodies, matter && matter.body_id, { includeBlank: '—' }))}</select>
        </label>
        <label>Introduced
          <input type="date" name="intro_date" value="${matter && matter.intro_date ? matter.intro_date : ''}">
        </label>
      </div>
      <label>Summary
        <textarea name="summary" rows="3" placeholder="Plain-language summary for the public record…">${matter ? (matter.summary || '') : ''}</textarea>
      </label>
      <label>Full text
        <textarea name="full_text" rows="8" placeholder="BE IT ORDAINED…">${matter ? (matter.full_text || '') : ''}</textarea>
      </label>
      <label>Index terms (comma-separated)
        <input type="text" name="topics" value="${isEdit ? repo.topics.forMatter(matter.id).map((t) => t.name).join(', ') : ''}" placeholder="Zoning, Budget, Public Safety">
      </label>
      <fieldset>
        <legend>Sponsors</legend>
        <div class="chk-grid">${raw(sponsorChecks)}</div>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn primary">${isEdit ? 'Save changes' : 'Create file'}</button>
        ${isEdit ? raw(`<a class="btn-link" href="/legislation/${encodeURIComponent(matter.file_number)}">View file</a>`) : ''}
      </div>
    </form>`;

  let extras = '';
  if (isEdit) {
    extras = workflowPanel(matter) + actionRecorder(matter) + documentsPanel(matter) + attachmentForm(matter);
  }

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / ${isEdit ? matter.file_number : 'New file'}</p>
    <h1>${isEdit ? 'Edit ' + matter.file_number : 'New legislative file'}</h1>
    ${raw(card(isEdit ? 'File details' : 'Create file', form))}
    ${raw(extras)}`;
  return layout({ title: isEdit ? 'Edit ' + matter.file_number : 'New file', active: '/admin', body });
}

function actionRecorder(matter) {
  const allBodies = repo.bodies.all().map((b) => ({ value: b.id, label: b.name }));
  const history = repo.matters.history(matter.id);
  const histRows = history.length ? history.map((h) => html`
    <tr><td>${raw(formatDate(h.action_date))}</td><td>${h.body_name || ''}</td>
    <td>${h.action}</td><td>${h.result || ''}</td></tr>`).join('') : null;

  const form = html`
    <form class="form inline-form" method="post" action="/admin/matters/${matter.id}/actions">
      <div class="form-row">
        <label>Date<input type="date" name="action_date" value="${todayISO()}" required></label>
        <label>Body<select name="body_id">${raw(selectOptions(allBodies, matter.body_id, { includeBlank: '—' }))}</select></label>
      </div>
      <label>Action
        <input type="text" name="action" required placeholder="Referred to Finance Committee / Passed / Adopted…">
      </label>
      <div class="form-row">
        <label>Result<select name="result">${raw(selectOptions(['', 'Pass', 'Fail', 'Approved', 'Adopted', 'Held'], ''))}</select></label>
        <label>Set status to
          <select name="new_status">${raw(selectOptions(['', ...repo.MATTER_STATUSES], ''))}</select>
        </label>
      </div>
      <label>Notes<input type="text" name="notes" placeholder="Optional"></label>
      <button type="submit" class="btn">Record action</button>
    </form>
    ${raw(histRows ? `<table class="data compact"><thead><tr><th>Date</th><th>Body</th><th>Action</th><th>Result</th></tr></thead><tbody>${histRows}</tbody></table>` : '')}`;
  return card('Record an action', form);
}

function workflowPanel(matter) {
  const steps = repo.workflow.forMatter(matter.id);
  if (!steps.length) {
    const inner = `<p class="muted">Route this file through departmental review and approval.</p>
      <form method="post" action="/admin/matters/${matter.id}/route">
        <button type="submit" class="btn">▶ Start approval route</button>
      </form>`;
    return card('Approval routing', inner);
  }
  const current = repo.workflow.current(matter.id);
  const actionForm = current ? `
    <form class="form inline-form" method="post" action="/admin/workflow-steps/${current.id}/act">
      <p><strong>Current step:</strong> ${escapeText(current.seq + '. ' + current.name)} <span class="muted">(${escapeText(current.role || '')})</span></p>
      <label>Notes<input type="text" name="notes" placeholder="Optional decision note"></label>
      <div class="form-actions">
        <button type="submit" name="status" value="Approved" class="btn primary">Approve &amp; advance</button>
        <button type="submit" name="status" value="Returned" class="btn">Return for revision</button>
        <button type="submit" name="status" value="Skipped" class="btn">Skip step</button>
      </div>
    </form>`
    : '<p class="muted">✓ All steps complete — this file has cleared the approval route.</p>';
  return card('Approval routing', workflowStepper(steps) + actionForm);
}

function documentsPanel(matter) {
  const reports = repo.reports.forMatter(matter.id);
  const list = reports.length
    ? `<ul class="attach-list doc-list">${reports.map((r) => html`
        <li><a href="/reports/${r.id}">${r.title}</a> <span class="badge type">${r.kind}</span>
        — <a class="btn-link" href="/admin/reports/${r.id}/edit">Edit</a></li>`).join('')}</ul>`
    : emptyState('No documents yet.');
  const inner = `<p><a class="btn" href="/admin/matters/${matter.id}/reports/new">✎ New document (word processor)</a></p>${list}`;
  return card('Documents & reports', inner);
}

function attachmentForm(matter) {
  const attachments = repo.matters.attachments(matter.id);
  const list = attachments.length
    ? `<ul class="attach-list">${attachments.map((a) => html`<li>${a.name}${a.url ? raw(` — <a href="${escapeText(a.url)}">link</a>`) : ''}</li>`).join('')}</ul>`
    : emptyState('No attachments yet.');
  const form = html`
    <form class="form inline-form" method="post" action="/admin/matters/${matter.id}/attachments">
      <div class="form-row">
        <label>Name<input type="text" name="name" required placeholder="Staff report.pdf"></label>
        <label>URL<input type="url" name="url" placeholder="https://…"></label>
      </div>
      <label>Note<input type="text" name="note" placeholder="Optional"></label>
      <button type="submit" class="btn">Add attachment</button>
    </form>
    ${raw(list)}`;
  return card('Attachments', form);
}

// --- Meeting form ------------------------------------------------------------
function meetingForm() {
  const allBodies = repo.bodies.all().map((b) => ({ value: b.id, label: b.name }));
  const form = html`
    <form class="form" method="post" action="/admin/meetings">
      <div class="form-row">
        <label>Body<select name="body_id" required>${raw(selectOptions(allBodies, '', { includeBlank: 'Select…' }))}</select></label>
        <label>Status<select name="status">${raw(selectOptions(['Scheduled', 'In Progress', 'Adjourned', 'Final', 'Cancelled'], 'Scheduled'))}</select></label>
      </div>
      <div class="form-row">
        <label>Date<input type="date" name="meeting_date" value="${todayISO()}" required></label>
        <label>Time<input type="text" name="meeting_time" placeholder="6:00 PM"></label>
      </div>
      <label>Location<input type="text" name="location" placeholder="${escapeText(ORG.meetingLocation)}"></label>
      <div class="form-row">
        <label>Agenda URL<input type="url" name="agenda_url" placeholder="https://…"></label>
        <label>Video URL<input type="url" name="video_url" placeholder="https://…"></label>
      </div>
      <button type="submit" class="btn primary">Schedule meeting</button>
    </form>`;
  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Schedule meeting</p>
    <h1>Schedule meeting</h1>
    ${raw(card('Meeting details', form))}`;
  return layout({ title: 'Schedule meeting', active: '/admin', body });
}

// --- Agenda manager (add items + record votes) ------------------------------
function agendaManager(meeting) {
  const items = repo.meetings.items(meeting.id);
  const openMatters = repo.matters.search({ limit: 300 })
    .map((m) => ({ value: m.id, label: `${m.file_number} — ${m.title}` }));

  const itemBlocks = items.length ? items.map((it) => voteBlock(meeting, it)).join('') :
    emptyState('No agenda items yet.');

  const addItemForm = html`
    <form class="form inline-form" method="post" action="/admin/meetings/${meeting.id}/agenda">
      <div class="form-row">
        <label>Agenda #<input type="text" name="agenda_number" placeholder="5.A"></label>
        <label>Section<select name="section">${raw(selectOptions(repo.AGENDA_SECTIONS, '', { includeBlank: '—' }))}</select></label>
      </div>
      <label>Legislative file (optional)
        <select name="matter_id">${raw(selectOptions(openMatters, '', { includeBlank: '— none (procedural item) —' }))}</select>
      </label>
      <label>Item title (for procedural items)
        <input type="text" name="title" placeholder="Call to Order / Approval of Minutes…">
      </label>
      <button type="submit" class="btn">Add to agenda</button>
    </form>`;

  const reorderHint = items.length > 1
    ? '<p class="muted reorder-hint">Drag items by the ⠿ handle to reorder. <span class="reorder-status" data-reorder-status></span></p>'
    : '';

  const body = html`
    <p class="crumbs"><a href="/meetings/${meeting.id}">Meeting</a> / Manage agenda</p>
    <div class="detail-head">
      <h1>Agenda — ${meeting.body_name}</h1>
      <span class="head-actions">
        <a class="btn" href="/admin/meetings/${meeting.id}/live">● Run live</a>
        <a class="btn" href="/admin/meetings/${meeting.id}/minutes">🧾 Minutes</a>
        <a class="btn" href="/meetings/${meeting.id}/packet">📄 Packet</a>
      </span>
    </div>
    <p class="muted">${raw(formatDate(meeting.meeting_date))} ${meeting.meeting_time || ''}</p>
    ${raw(card('Add agenda item', addItemForm))}
    ${raw(card('Agenda items & voting',
      reorderHint + `<div class="agenda-manage" data-meeting="${meeting.id}">${itemBlocks}</div>`))}
    <script src="/assets/agenda-reorder.js" defer></script>
  `;
  return layout({ title: 'Manage agenda', active: '/calendar', body });
}

function voteBlock(meeting, it) {
  const titleLine = it.matter_id
    ? `${escapeText(it.file_number)} — ${escapeText(it.matter_title)}`
    : escapeText(it.title || '(item)');

  // Voting roster = members of the meeting body
  const members = repo.bodies.members(meeting.body_id);
  const existing = it.matter_id ? repo.votes.forItem(it.id) : [];
  const byPerson = {};
  for (const v of existing) byPerson[v.person_id] = v.vote;

  const voteRows = (it.matter_id && members.length) ? members.map((m) => html`
    <div class="vote-row">
      <span>${m.full_name}</span>
      <span class="vote-opts">
        ${raw(repo.VOTE_VALUES.map((val) => `
          <label class="radio"><input type="radio" name="vote_${m.person_id}" value="${val}"
            ${byPerson[m.person_id] === val ? 'checked' : ''}> ${val}</label>`).join(''))}
      </span>
    </div>`).join('') : '';

  const voteForm = it.matter_id ? html`
    <form class="form vote-form" method="post" action="/admin/agenda-items/${it.id}/votes">
      <div class="form-row">
        <label>Action<input type="text" name="action" value="${it.action || ''}" placeholder="Motion to adopt"></label>
        <label>Result<select name="result">${raw(selectOptions(['', 'Pass', 'Fail'], it.result || ''))}</select></label>
      </div>
      <div class="vote-grid">${raw(voteRows)}</div>
      <button type="submit" class="btn">Save votes</button>
    </form>` : '';

  return `<div class="agenda-manage-item" draggable="true" data-id="${it.id}">
    <div class="ami-head">
      <span class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>
      <span class="ai-num">${escapeText(it.agenda_number || '')}</span>
      <strong>${titleLine}</strong>
      ${it.section ? `<span class="sub">${escapeText(it.section)}</span>` : ''}</div>
    ${voteForm}
  </div>`;
}

module.exports = {
  adminHome, matterForm, meetingForm, agendaManager,
};
