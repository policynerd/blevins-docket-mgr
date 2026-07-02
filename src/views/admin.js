'use strict';

const { html, raw, formatDate, todayISO } = require('../util');
const { layout, card, workflowStepper, statusBadge, typeBadge, emptyState, escapeText } = require('./layout');
const { ORG } = require('../org');
const auth = require('../auth');
const repo = require('../repo');
const docTemplates = require('../doc-templates');
const { editorField } = require('./reports');

function adminHome(user) {
  const s = repo.stats();
  const isAdmin = auth.hasRole(user, 'admin');
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
      <a class="btn" href="/admin/bodies">Bodies &amp; committees</a>
      <a class="btn" href="/admin/agenda-template">Agenda template</a>
      <a class="btn" href="/admin/doc-templates">Document templates</a>
      <a class="btn" href="/admin/comments">Public comments${repo.comments.pendingCount()
        ? raw(` <span class="badge pending-badge">${repo.comments.pendingCount()}</span>`) : ''}</a>
      <a class="btn" href="/admin/policies">Policies</a>
      <a class="btn" href="/budget">Budget</a>
      <a class="btn" href="/admin/org">Manage organization</a>
      ${isAdmin ? raw(`
      <a class="btn" href="/admin/users">Users &amp; roles</a>
      <a class="btn" href="/admin/import">Import roster (CSV)</a>
      <a class="btn" href="/admin/branding">Branding</a>
      <a class="btn" href="/admin/footer">Footer</a>
      <a class="btn" href="/admin/legal">Terms &amp; Privacy</a>`) : ''}
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
    ${isAdmin ? raw(card('Danger zone', `
      <p class="muted">Permanently delete <strong>all</strong> people, bodies, legislation, meetings, votes, and org units. Your user logins and branding settings are kept. Use this once to clear the demo/sample data.</p>
      <form method="post" action="/admin/purge" onsubmit="return confirm('Permanently delete ALL legislative data (people, bodies, files, meetings, votes)? This cannot be undone.');">
        <button type="submit" class="btn danger-btn">Clear all data</button>
      </form>`)) : ''}
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
  const budgetLines = repo.budget.lineOptions();
  const sponsors = isEdit ? repo.matters.sponsors(matter.id).map((s) => s.id) : [];
  const action = isEdit ? `/admin/matters/${matter.id}` : '/admin/matters';

  const sponsorChecks = allPeople.map((p) => html`
    <label class="chk"><input type="checkbox" name="sponsor_id" value="${p.id}"
      ${sponsors.includes(p.id) ? raw('checked') : ''}> ${p.full_name}</label>`).join('');

  const fileNumPreview = !isEdit ? raw(`
    <p class="muted file-num-preview">File # will be auto-assigned: <strong id="fn-preview">…</strong></p>
    <script>
      (function(){
        var out = document.getElementById('fn-preview');
        if(!out) return;
        fetch('/admin/matters/next-number').then(function(r){return r.ok?r.json():Promise.reject(r.status);}).then(function(d){out.textContent=d.number;}).catch(function(){out.textContent='—';});
      })();
    </script>`) : '';

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
      ${fileNumPreview}
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
        <legend>Fiscal impact</legend>
        <div class="form-row">
          <label>Amount ($)
            <input type="number" step="0.01" name="fiscal_impact" value="${matter && matter.fiscal_impact != null ? matter.fiscal_impact : ''}" placeholder="0.00">
          </label>
          <label>Budget line
            <select name="budget_line_id">${raw(selectOptions(budgetLines, matter && matter.budget_line_id, { includeBlank: '— none —' }))}</select>
          </label>
        </div>
      </fieldset>
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
    const activeUsers = repo.users.all().filter((u) => u.active);
    const userOptions = (selected) => `<option value="">— any clerk —</option>`
      + activeUsers.map((u) => `<option value="${u.id}">${escapeText(u.name)} (${escapeText(u.role)})</option>`).join('');
    const stepRows = repo.workflowTemplate().map((s) => `
      <label>${escapeText(s.name)} <span class="muted">(${escapeText(s.role || '')})</span>
        <select name="assignee_id">${userOptions()}</select>
      </label>`).join('');
    const inner = `<p class="muted">Route this file through departmental review and approval.
        Each step goes to the person you pick — it appears in their Approvals inbox, and only they
        (or an admin) can act on it. Leave a step unassigned to let any clerk handle it.</p>
      <form class="form" method="post" action="/admin/matters/${matter.id}/route">
        <div class="form-row">${stepRows}</div>
        <button type="submit" class="btn">▶ Start approval route</button>
      </form>`;
    return card('Approval routing', inner);
  }
  const current = repo.workflow.current(matter.id);
  const currentFull = current ? repo.workflow.get(current.id) : null;
  const actionForm = current ? `
    <form class="form inline-form" method="post" action="/admin/workflow-steps/${current.id}/act">
      <p><strong>Current step:</strong> ${escapeText(current.seq + '. ' + current.name)}
        <span class="muted">(${escapeText(current.role || '')})</span>
        — routed to <strong>${escapeText((currentFull && currentFull.assignee_name) || 'any clerk')}</strong></p>
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
  const inner = `<p>
      <a class="btn" href="/admin/matters/${matter.id}/text">✎ Edit legislation text</a>
      <a class="btn" href="/admin/matters/${matter.id}/reports/new">✎ New document (word processor)</a>
    </p>${list}`;
  return card('Documents & reports', inner);
}

// --- Legislation text editor (per-type form template + versioning) -----------
function matterTextForm(matter) {
  const usingTemplate = !matter.body_html;
  const content = matter.body_html || docTemplates.applyTemplate(matter.type, matter) || '';
  const form = html`
    <form class="form" method="post" action="/admin/matters/${matter.id}/text" data-wp-form>
      ${usingTemplate ? raw(`<p class="muted">Pre-filled from the <strong>${escapeText(matter.type)}</strong> form template
        (<a href="/admin/doc-templates?type=${encodeURIComponent(matter.type)}">edit templates</a>). Nothing is saved until you save here.</p>`) : ''}
      ${raw(editorField('body_html', content, { label: 'Legislation text', rows: 18 }))}
      <div class="form-actions">
        <button type="submit" class="btn primary">Save text</button>
        <a class="btn-link" href="/admin/matters/${matter.id}/edit">Cancel</a>
      </div>
      <p class="muted">Saving over existing text archives the previous text as a numbered version.</p>
    </form>
    <script src="/assets/editor.js" defer></script>`;
  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> /
      <a href="/admin/matters/${matter.id}/edit">${matter.file_number}</a> / Text</p>
    <h1>${matter.file_number} — legislation text</h1>
    ${raw(card('Word processor', form))}`;
  return layout({ title: `${matter.file_number} text`, active: '/admin', body });
}

// --- Document form templates (per matter type) --------------------------------
function docTemplatesAdmin(type, { saved = false } = {}) {
  const active = repo.MATTER_TYPES.includes(type) ? type : 'Ordinance';
  const pills = repo.MATTER_TYPES.map((t) => `
    <a class="btn${t === active ? ' primary' : ''}" href="/admin/doc-templates?type=${encodeURIComponent(t)}">${escapeText(t)}${docTemplates.isCustomized(t) ? ' ●' : ''}</a>`).join(' ');
  const form = html`
    <form class="form" method="post" action="/admin/doc-templates" data-wp-form>
      <input type="hidden" name="type" value="${active}">
      ${raw(editorField('template_html', docTemplates.getTemplate(active) || '', { label: `${active} form`, rows: 16 }))}
      <div class="form-actions">
        <button type="submit" class="btn primary">Save ${active} template</button>
        <button type="submit" name="reset" value="1" class="btn">Reset to built-in default</button>
      </div>
      <p class="muted">Placeholders are filled in when the form is applied to a file:
        <code>{{file_number}}</code>, <code>{{title}}</code>, <code>{{date}}</code>, <code>{{org}}</code>.
        Types marked ● have a customized template.</p>
    </form>
    <script src="/assets/editor.js" defer></script>`;
  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Document templates</p>
    <h1>Document form templates</h1>
    <p class="muted">The boilerplate a drafter starts from for each file type — applied when drafting
      a new file or opening a file's text for the first time.</p>
    ${saved ? raw('<p class="form-ok">Template saved.</p>') : ''}
    <div class="admin-actions">${raw(pills)}</div>
    ${raw(card(`Edit the ${active} form`, form))}`;
  return layout({ title: 'Document templates', active: '/admin', body });
}

function attachmentForm(matter) {
  const attachments = repo.matters.attachments(matter.id);
  const sizeLabel = (n) => (n > 1024 * 1024 ? (n / (1024 * 1024)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const list = attachments.length
    ? `<ul class="attach-list">${attachments.map((a) => html`<li>
        ${a.file_path
    ? raw(`<a href="/files/${a.id}">${escapeText(a.name)}</a> <span class="muted">(${escapeText(sizeLabel(a.size || 0))})</span>`)
    : (a.url ? raw(`<a href="${escapeText(a.url)}">${escapeText(a.name)}</a> <span class="muted">(link)</span>`) : a.name)}
        <form method="post" action="/admin/attachments/${a.id}/delete" class="inline">
          <button type="submit" class="btn-link danger" title="Remove attachment">remove</button>
        </form></li>`).join('')}</ul>`
    : emptyState('No attachments yet.');
  const form = html`
    <form class="form inline-form" method="post" action="/admin/matters/${matter.id}/attachments"
      enctype="multipart/form-data">
      <label>Upload a file<input type="file" name="file"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.txt,.csv,.rtf"></label>
      <div class="form-row">
        <label>Name<input type="text" name="name" placeholder="Defaults to the file name"></label>
        <label>…or link a URL<input type="url" name="url" placeholder="https://…"></label>
      </div>
      <label>Note<input type="text" name="note" placeholder="Optional"></label>
      <button type="submit" class="btn">Add attachment</button>
      <p class="muted">Upload a file (stored with the record, max 20 MB) or provide an external link with a name.</p>
    </form>
    ${raw(list)}`;
  return card('Attachments', form);
}

// --- Meeting form (new + edit) ----------------------------------------------
function meetingForm(meeting) {
  const isEdit = !!meeting;
  const allBodies = repo.bodies.all().map((b) => ({ value: b.id, label: b.name }));
  const action = isEdit ? `/admin/meetings/${meeting.id}` : '/admin/meetings';
  const statuses = ['Scheduled', 'In Progress', 'Adjourned', 'Final', 'Cancelled'];
  const form = html`
    <form class="form" method="post" action="${action}">
      <div class="form-row">
        <label>Body<select name="body_id" required>${raw(selectOptions(allBodies, meeting && meeting.body_id, { includeBlank: 'Select…' }))}</select></label>
        <label>Status<select name="status">${raw(selectOptions(statuses, meeting ? meeting.status : 'Scheduled'))}</select></label>
      </div>
      <div class="form-row">
        <label>Date<input type="date" name="meeting_date" value="${meeting ? meeting.meeting_date : todayISO()}" required></label>
        <label>Time<input type="text" name="meeting_time" value="${meeting && meeting.meeting_time ? meeting.meeting_time : ''}" placeholder="6:00 PM"></label>
      </div>
      <label>Location<input type="text" name="location" value="${meeting && meeting.location ? meeting.location : ''}" placeholder="${escapeText(ORG.meetingLocation)}"></label>
      <div class="form-row">
        <label>Agenda URL<input type="url" name="agenda_url" value="${meeting && meeting.agenda_url ? meeting.agenda_url : ''}" placeholder="https://…"></label>
        <label>Video URL<input type="url" name="video_url" value="${meeting && meeting.video_url ? meeting.video_url : ''}" placeholder="https://…"></label>
      </div>
      <label>Notes<input type="text" name="notes" value="${meeting && meeting.notes ? meeting.notes : ''}"></label>
      <div class="form-actions">
        <button type="submit" class="btn primary">${isEdit ? 'Save meeting' : 'Schedule meeting'}</button>
        ${isEdit ? raw(`<a class="btn-link" href="/admin/meetings/${meeting.id}/agenda">Manage agenda</a>`) : ''}
      </div>
    </form>`;
  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / ${isEdit ? 'Edit meeting' : 'Schedule meeting'}</p>
    <h1>${isEdit ? 'Edit meeting' : 'Schedule meeting'}</h1>
    ${raw(card('Meeting details', form))}`;
  return layout({ title: isEdit ? 'Edit meeting' : 'Schedule meeting', active: '/admin', body });
}

// --- Person form (edit a board member / official) ---------------------------
function personForm(person) {
  const parties = ['', 'Independent', 'Civic Party', 'Reform', 'Nonpartisan'];
  const form = html`
    <form class="form" method="post" action="/admin/people/${person.id}">
      <div class="form-row">
        <label>Full name<input type="text" name="full_name" required value="${person.full_name}"></label>
        <label>Title<input type="text" name="title" value="${person.title || ''}" placeholder="${escapeText(ORG.memberTitle)}"></label>
      </div>
      <div class="form-row">
        <label>District / seat<input type="text" name="district" value="${person.district || ''}" placeholder="Seat 1"></label>
        <label>Party / affiliation<input type="text" name="party" value="${person.party || ''}" list="party-list">
          <datalist id="party-list">${raw(parties.filter(Boolean).map((p) => `<option value="${escapeText(p)}">`).join(''))}</datalist>
        </label>
      </div>
      <div class="form-row">
        <label>Email<input type="email" name="email" value="${person.email || ''}"></label>
        <label>Phone<input type="text" name="phone" value="${person.phone || ''}"></label>
      </div>
      <label>Website<input type="url" name="website" value="${person.website || ''}" placeholder="https://…"></label>
      <label>Biography<textarea name="bio" rows="4">${person.bio || ''}</textarea></label>
      <label class="chk"><input type="checkbox" name="active" value="1" ${person.active ? raw('checked') : ''}> Active</label>
      <div class="form-actions">
        <button type="submit" class="btn primary">Save profile</button>
        <a class="btn-link" href="/people/${person.id}">Cancel</a>
      </div>
    </form>`;
  const body = html`
    <p class="crumbs"><a href="/people/${person.id}">${person.full_name}</a> / Edit</p>
    <h1>Edit ${person.full_name}</h1>
    ${raw(card('Profile', form))}`;
  return layout({ title: 'Edit ' + person.full_name, active: '/people', body });
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
        <label>Agenda # <span class="muted" style="font-weight:400">(auto)</span>
          <input type="text" name="agenda_number" placeholder="auto (e.g. 1A)">
        </label>
        <label>Section<select name="section">${raw(selectOptions(repo.AGENDA_SECTIONS, '', { includeBlank: '—' }))}</select></label>
      </div>
      <div class="form-row">
        <label>Legislative file (optional)
          <select name="matter_id">${raw(selectOptions(openMatters, '', { includeBlank: '— none (procedural item) —' }))}</select>
        </label>
        <label>Item type<select name="item_type">${raw(selectOptions(repo.ITEM_TYPES, '', { includeBlank: '— none —' }))}</select></label>
      </div>
      <label>Item title (for procedural items)
        <input type="text" name="title" placeholder="Call to Order / Approval of Minutes…">
      </label>
      <label class="check-label">
        <input type="checkbox" name="requires_vote" value="1"> Requires a vote
      </label>
      <button type="submit" class="btn">Add to agenda</button>
    </form>`;

  const { db: settingsDb } = require('../db');
  const templateRow = settingsDb.prepare("SELECT value FROM settings WHERE key = 'agenda.template'").get();
  const hasTemplate = !!(templateRow && templateRow.value);

  const loadTemplateBtn = hasTemplate && items.length === 0
    ? `<form class="inline" method="post" action="/admin/meetings/${meeting.id}/load-template">
        <button type="submit" class="btn">Load standard agenda template</button>
      </form>`
    : '';

  const reorderHint = items.length > 1
    ? '<p class="muted reorder-hint">Drag items by the ⠿ handle to reorder. <span class="reorder-status" data-reorder-status></span></p>'
    : '';

  const body = html`
    <p class="crumbs"><a href="/meetings/${meeting.id}">Meeting</a> / Manage agenda</p>
    <div class="detail-head">
      <h1>Agenda — ${meeting.body_name}</h1>
      <span class="head-actions">
        <a class="btn" href="/admin/meetings/${meeting.id}/edit">✎ Edit</a>
        <a class="btn" href="/admin/meetings/${meeting.id}/live">● Run live</a>
        <a class="btn" href="/admin/meetings/${meeting.id}/minutes">🧾 Minutes</a>
        <a class="btn" href="/meetings/${meeting.id}/packet">📄 Packet</a>
      </span>
    </div>
    <p class="muted">${raw(formatDate(meeting.meeting_date))} ${meeting.meeting_time || ''}</p>
    ${raw(card('Add agenda item', addItemForm))}
    ${raw(card('Agenda items & voting',
      loadTemplateBtn + reorderHint + `<div class="agenda-manage" data-meeting="${meeting.id}">${itemBlocks}</div>`))}
    ${raw(speakerQueue(meeting))}
    <script src="/assets/agenda-reorder.js" defer></script>
  `;
  return layout({ title: 'Manage agenda', active: '/calendar', body });
}

// Request-to-speak queue for a meeting (public sign-ups awaiting the clerk).
function speakerQueue(meeting) {
  const speakers = repo.speakers.forMeeting(meeting.id);
  if (!speakers.length) return card('Speakers', emptyState('No requests to speak.'));
  const btn = (s, status, label, cls = 'btn') => `
    <form method="post" action="/admin/speakers/${s.id}/status" class="inline">
      <input type="hidden" name="status" value="${status}">
      <button type="submit" class="${cls}">${label}</button>
    </form>`;
  const rows = speakers.map((s) => html`
    <li>
      <div class="comment-head">
        <strong>${s.name}</strong>
        ${s.position ? raw(`<span class="badge pos-${String(s.position).toLowerCase()}">${escapeText(s.position)}</span>`) : ''}
        ${statusBadge(s.status)}
        — ${s.agenda_item_id ? `${s.agenda_number ? s.agenda_number + '. ' : ''}${s.item_title || ''}` : 'General public comment'}
        ${s.email ? raw(`<span class="muted">· ${escapeText(s.email)}</span>`) : ''}
      </div>
      <div class="form-actions">
        ${s.status === 'Pending' ? raw(btn(s, 'Approved', 'Approve', 'btn primary') + btn(s, 'Rejected', 'Reject')) : ''}
        ${s.status === 'Approved' ? raw(btn(s, 'Spoke', 'Mark as spoke')) : ''}
      </div>
    </li>`).join('');
  return card(`Speakers (${speakers.length})`, `<ul class="comment-list">${rows}</ul>`);
}

function voteBlock(meeting, it) {
  const titleLine = it.matter_id
    ? `${escapeText(it.file_number)} — ${escapeText(it.matter_title)}`
    : escapeText(it.title || '(item)');

  // Voting roster = members of the meeting body
  const members = repo.bodies.members(meeting.body_id);
  const needsVote = !!it.requires_vote;
  const existing = needsVote ? repo.votes.forItem(it.id) : [];
  const byPerson = {};
  for (const v of existing) byPerson[v.person_id] = v.vote;

  const voteRows = (needsVote && members.length) ? members.map((m) => html`
    <div class="vote-row">
      <span>${m.full_name}</span>
      <span class="vote-opts">
        ${raw(repo.VOTE_VALUES.map((val) => `
          <label class="radio"><input type="radio" name="vote_${m.person_id}" value="${val}"
            ${byPerson[m.person_id] === val ? 'checked' : ''}> ${val}</label>`).join(''))}
      </span>
    </div>`).join('') : '';

  const memberSel = (name, currentId) => {
    const opts = '<option value="">—</option>' + members.map((m) =>
      `<option value="${m.person_id}"${String(m.person_id) === String(currentId) ? ' selected' : ''}>${escapeText(m.full_name)}</option>`
    ).join('');
    return `<select name="${name}">${opts}</select>`;
  };
  const thresholdSel = [
    ['majority', 'Majority of votes cast'],
    ['two_thirds', 'Two-thirds (⅔)'],
    ['majority_full', 'Majority of full body'],
  ].map(([v, l]) => `<option value="${v}"${(it.vote_threshold || 'majority') === v ? ' selected' : ''}>${l}</option>`).join('');

  const voteForm = needsVote ? html`
    <form class="form vote-form" method="post" action="/admin/agenda-items/${it.id}/votes">
      <div class="form-row">
        <label>Action<input type="text" name="action" value="${it.action || ''}" placeholder="Motion to adopt"></label>
        <label>Result<select name="result">${raw(selectOptions(['', 'Pass', 'Fail'], it.result || ''))}</select></label>
        <label>Threshold<select name="vote_threshold">${raw(thresholdSel)}</select></label>
      </div>
      <div class="form-row">
        <label>Mover${raw(memberSel('mover_id', it.mover_id))}</label>
        <label>Seconder${raw(memberSel('seconder_id', it.seconder_id))}</label>
        <label>Motion text<input type="text" name="motion_text" value="${it.motion_text || ''}" placeholder="I move to…"></label>
      </div>
      <div class="vote-grid">${raw(voteRows)}</div>
      <button type="submit" class="btn">Save votes</button>
    </form>` : '';

  const itemTypeBadge = it.item_type
    ? `<span class="badge type it-${escapeText(String(it.item_type).toLowerCase())}">${escapeText(it.item_type)}</span>`
    : '';
  const toggleLabel = needsVote ? 'Voted' : 'No vote';
  const toggleTitle = needsVote ? 'Click to mark as procedural (no vote)' : 'Click to enable voting for this item';

  return `<div class="agenda-manage-item" draggable="true" data-id="${it.id}">
    <div class="ami-head">
      <span class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>
      <span class="ai-num">${escapeText(it.agenda_number || '')}</span>
      <strong>${titleLine}</strong>
      ${itemTypeBadge}
      ${it.section ? `<span class="sub">${escapeText(it.section)}</span>` : ''}
      <form class="inline" method="post" action="/admin/agenda-items/${it.id}/toggle-vote">
        <button type="submit" class="btn-link${needsVote ? ' vote-on' : ' vote-off'}" title="${toggleTitle}">${toggleLabel}</button>
      </form>
      <form class="inline ami-del" method="post" action="/admin/agenda-items/${it.id}/delete"
        onsubmit="return confirm('Remove this item from the agenda? Recorded votes for it are also deleted.')">
        <button type="submit" class="btn-link danger" title="Remove from agenda">✕ Delete</button>
      </form></div>
    ${voteForm}
  </div>`;
}

// --- Agenda template admin --------------------------------------------------
function agendaTemplateAdmin(saved) {
  const { db: settingsDb } = require('../db');
  const row = settingsDb.prepare("SELECT value FROM settings WHERE key = 'agenda.template'").get();
  let current = '';
  if (row && row.value) {
    try {
      const parsed = JSON.parse(row.value);
      current = parsed.map((i) => {
        const base = i.section ? `${i.section} | ${i.title}` : i.title;
        return i.item_type ? `${base} | ${i.item_type}` : base;
      }).join('\n');
    } catch (_) { current = row.value; }
  }

  const DEFAULT_TEMPLATE = [
    'Call to Order | Call to Order | Information',
    'Call to Order | Pledge of Allegiance | Information',
    'Call to Order | Land Acknowledgement | Information',
    'Roll Call | Quorum Call | Action',
    'Public Comment | Public Comment | Information',
    'Approval of Minutes | Approval of Minutes | Action',
    'Approval of Minutes | Approval of the Agenda | Action',
    'Consent Agenda | Development of the Consent Calendar | Discussion',
    'Consent Agenda | Approval of the Consent Calendar | Action',
  ].join('\n');

  const savedBanner = saved ? '<p class="saved-banner">Template saved.</p>' : '';
  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Agenda template</p>
    <h1>Standard agenda template</h1>
    ${raw(savedBanner)}
    ${raw(card('Edit template', html`
      <p class="muted">One item per line. Format: <code>Section | Title | Type</code> where Type is <em>Action</em>, <em>Discussion</em>, or <em>Information</em> (optional).<br>
      Omit the section to create an unsectioned item. The template is stamped onto a new meeting when you click "Load standard agenda template".</p>
      <form class="form" method="post" action="/admin/agenda-template">
        <label>Template items
          <textarea name="template" rows="14" style="font-family:monospace">${current || DEFAULT_TEMPLATE}</textarea>
        </label>
        <div class="form-actions"><button type="submit" class="btn primary">Save template</button></div>
      </form>`))}`;
  return layout({ title: 'Agenda template', active: '/admin', body });
}

// --- Public comment moderation ------------------------------------------------
function commentsAdmin() {
  const pending = repo.comments.pending();
  const decided = repo.comments.recentDecided();
  const positionBadge = (p) => (p ? `<span class="badge pos-${p.toLowerCase()}">${escapeText(p)}</span>` : '');
  const row = (c, actions) => html`
    <li class="comment-mod">
      <div class="comment-head">
        <strong>${c.name}</strong> ${raw(positionBadge(c.position))}
        on <a href="/legislation/${encodeURIComponent(c.file_number)}">${c.file_number}</a>
        <span class="muted">— ${c.matter_title}</span>
        <span class="muted">· ${raw(formatDate(c.created_at))}${c.email ? ' · ' + c.email : ''}</span>
      </div>
      <p class="comment-body">${c.body}</p>
      ${raw(actions)}
    </li>`;

  const pendingList = pending.length
    ? `<ul class="comment-list">${pending.map((c) => row(c, `
        <div class="form-actions">
          <form method="post" action="/admin/comments/${c.id}/status" class="inline">
            <input type="hidden" name="status" value="Approved">
            <button type="submit" class="btn primary">Approve &amp; publish</button>
          </form>
          <form method="post" action="/admin/comments/${c.id}/status" class="inline">
            <input type="hidden" name="status" value="Rejected">
            <button type="submit" class="btn">Reject</button>
          </form>
        </div>`)).join('')}</ul>`
    : emptyState('No comments waiting for review.');

  const decidedList = decided.length
    ? `<ul class="comment-list">${decided.map((c) => row(c, `
        <div class="form-actions">
          ${statusBadge(c.status)}
          <form method="post" action="/admin/comments/${c.id}/status" class="inline">
            <input type="hidden" name="status" value="${c.status === 'Approved' ? 'Rejected' : 'Approved'}">
            <button type="submit" class="btn-link">${c.status === 'Approved' ? 'Unpublish' : 'Publish'}</button>
          </form>
        </div>`)).join('')}</ul>`
    : emptyState('No decided comments yet.');

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Public comments</p>
    <h1>Public comment review</h1>
    <p class="muted">Comments submitted on legislative files are held here until approved. Approved comments
      are published on the file's public page; email addresses are never shown publicly.</p>
    ${raw(card(`Awaiting review (${pending.length})`, pendingList))}
    ${raw(card('Recently decided', decidedList))}`;
  return layout({ title: 'Public comments', active: '/admin', body });
}

module.exports = {
  adminHome, matterForm, meetingForm, personForm, agendaManager, agendaTemplateAdmin, commentsAdmin,
  matterTextForm, docTemplatesAdmin,
};
