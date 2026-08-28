'use strict';

const { html, raw, formatDate, todayISO } = require('../util');
const { layout, card, workflowStepper, stepStrip, statusBadge, typeBadge, emptyState, escapeText } = require('./layout');
const { ORG } = require('../org');
const auth = require('../auth');
const repo = require('../repo');
const docTemplates = require('../doc-templates');
const { editorField } = require('./reports');

// Running a meeting, as one path rather than four unrelated screens.
//
// The work has a fixed order — schedule it, build the agenda, assemble the
// packet, run the roll, write the minutes — but each step lived on its own
// page reached from its own link, so the clerk had to already know the order
// and navigate it from memory. Nothing on the agenda screen said a packet came
// next, and nothing on the packet screen said you were three steps into
// something.
//
// So the sequence is stated on every screen in it: where you are, what is
// behind you, what is next, and which steps are already done. `done` is read
// from the meeting itself rather than tracked separately — a packet either has
// material or it does not.
function meetingSteps(meeting, current) {
  const items = repo.meetings.items(meeting.id).length;
  const packet = repo.meetings.packet(meeting.id).filter((r) => r.included).length;
  const voted = repo.meetings.items(meeting.id).some((i) => i.result);
  const steps = [
    { id: 'details', label: 'Schedule', href: `/admin/meetings/${meeting.id}/edit`, done: true },
    { id: 'agenda', label: 'Agenda', href: `/admin/meetings/${meeting.id}/agenda`, done: items > 0 },
    { id: 'packet', label: 'Packet', href: `/admin/meetings/${meeting.id}/packet`, done: packet > 0 },
    { id: 'live', label: 'Run live', href: `/admin/meetings/${meeting.id}/live`, done: voted },
    { id: 'minutes', label: 'Minutes', href: `/admin/meetings/${meeting.id}/minutes`,
      done: meeting.minutes_status === 'published' },
  ];
  return stepStrip(steps, current, 'Meeting workflow');
}

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

  // What is waiting on someone, first and by itself. This was buried among
  // twenty-two buttons of equal weight, so a queue with items in it looked
  // exactly like a settings link nobody had opened in a year.
  const queues = [
    { n: repo.comments.pendingCount(), label: 'Public comments', href: '/admin/comments' },
    { n: repo.applications.pendingCount(), label: 'Applications', href: '/admin/applications' },
    { n: repo.procurement.openCount(), label: 'Procurement', href: '/admin/procurement' },
  ];
  const waiting = queues.filter((q) => q.n > 0);
  const inbox = waiting.length
    ? `<div class="stat-grid small">${waiting.map((q) => `
        <a class="stat stat-flag" href="${q.href}">
          <span class="stat-n">${q.n}</span><span class="stat-l">${escapeText(q.label)}</span>
        </a>`).join('')}</div>`
    : '<p class="muted">Nothing is waiting on you.</p>';

  // Grouped by the job, and ordered by how often the job comes up: the daily
  // work first, the occasional setup after it, the once-a-year settings last.
  // "Schedule meeting" and "Terms & Privacy" were previously the same size,
  // in the same row, three buttons apart.
  const group = (title, links) => card(title,
    `<div class="admin-actions">${links.filter(Boolean).join('')}</div>`);
  const link = (href, label, opts = {}) => `<a class="btn${opts.primary ? ' primary' : ''}" `
    + `href="${href}">${label}</a>`;

  const body = html`
    ${raw(card('Waiting on you', inbox))}
    ${raw(group('Do the work', [
    link('/admin/matters/new', 'New legislative file', { primary: true }),
    link('/admin/meetings/new', 'Schedule meeting', { primary: true }),
    link('/meetings', 'Meetings'),
    link('/legislation', 'Legislation'),
    link('/budget', 'Budget'),
    link('/admin/procurement', 'Procurement'),
  ]))}
    ${raw(group('The board and its people', [
    link('/govern/members', 'Board membership'),
    link('/admin/bodies', 'Bodies &amp; committees'),
    link('/admin/org', 'Organization'),
    link('/people', escapeText(ORG.membersLabel)),
    isAdmin ? link('/admin/users', 'Users &amp; roles') : '',
  ]))}
    ${raw(group('Set up how things are drafted', [
    link('/admin/agenda-template', 'Agenda template'),
    link('/admin/doc-templates', 'Document templates'),
    link('/admin/policies', 'Policies'),
    isAdmin ? link('/admin/import', 'Import roster (CSV)') : '',
  ]))}
    ${isAdmin ? raw(group('Settings', [
    link('/admin/branding', 'Branding'),
    link('/admin/integrations', 'Integrations'),
    link('/admin/mail', 'Email'),
    link('/admin/footer', 'Footer'),
    link('/admin/legal', 'Terms &amp; Privacy'),
    link('/admin/audit', 'Audit log'),
  ])) : ''}
    <div class="stat-grid small">
      <div class="stat"><span class="stat-n">${s.matters}</span><span class="stat-l">Files</span></div>
      <div class="stat"><span class="stat-n">${s.pending}</span><span class="stat-l">In progress</span></div>
      <div class="stat"><span class="stat-n">${s.meetings}</span><span class="stat-l">Meetings</span></div>
      <div class="stat"><span class="stat-n">${s.people}</span><span class="stat-l">Officials</span></div>
    </div>
    ${raw(card('Run a meeting live', require('./live').liveLauncher()))}
    ${raw(card('Recent legislation',
    `<table class="data"><thead><tr><th>File #</th><th>Type</th><th>Title</th><th>Status</th><th></th></tr></thead><tbody>${recentRows.join('')}</tbody></table>`,
    { actions: '<a class="btn-link" href="/legislation">All legislation →</a>' }))}
    ${isAdmin ? raw(`<details class="danger-zone">
      <summary>Danger zone</summary>
      <div class="dz-body">
        <p class="muted">Permanently delete <strong>all</strong> people, bodies, legislation,
          meetings, votes, and org units. Your user logins and branding settings are kept.
          Use this once to clear the demo/sample data.</p>
        <form method="post" action="/admin/purge" onsubmit="return confirm('Permanently delete ALL legislative data (people, bodies, files, meetings, votes)? This cannot be undone.');">
          <button type="submit" class="btn danger-btn">Clear all data</button>
        </form>
      </div>
    </details>`) : ''}
  `;
  return layout({
    title: 'Clerk Workspace',
    subtitle: 'Create files, draft documents, build agendas, run live voting, and capture results.',
    active: '/admin',
    body,
  });
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

// The two live types, plus this file's own type when it predates them. Without
// that, opening an old Ordinance and pressing Save would quietly refile it as
// an Action, because the browser posts whatever the select happens to show.
function typeChoices(matter) {
  const t = matter && matter.type;
  return (t && !repo.MATTER_TYPES.includes(t)) ? repo.MATTER_TYPES.concat([t]) : repo.MATTER_TYPES;
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
      <p class="form-instructions">
        <strong>Before opening a file</strong>
        Complete every field marked with an asterisk. The file number is assigned on save and
        cannot be changed afterwards; the measure's text may be drafted later.
      </p>
      <fieldset>
        <legend>Identification</legend>
        <div class="form-row">
          <label>Type
            <select name="type" required>${raw(selectOptions(typeChoices(matter), matter && matter.type))}</select>
          </label>
          <label>Status
            <select name="status">${raw(selectOptions(repo.MATTER_STATUSES, matter ? matter.status : 'Draft'))}</select>
          </label>
        </div>
        ${fileNumPreview}
        <label>Title
          <input type="text" name="title" required value="${matter ? matter.title : ''}" placeholder="An ordinance amending…">
        </label>
      </fieldset>
      <fieldset>
        <legend>Referral</legend>
        <div class="form-row">
          <label>In control (body)
            <select name="body_id">${raw(selectOptions(allBodies, matter && matter.body_id, { includeBlank: '—' }))}</select>
          </label>
          <label>Introduced
            <input type="date" name="intro_date" value="${matter && matter.intro_date ? matter.intro_date : ''}">
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Text of the measure</legend>
        <label>Summary
          <textarea name="summary" rows="3" placeholder="Plain-language summary for the public record…">${matter ? (matter.summary || '') : ''}</textarea>
        </label>
        <label>Full text
          <textarea name="full_text" rows="8" placeholder="BE IT ORDAINED…">${matter ? (matter.full_text || '') : ''}</textarea>
        </label>
        <label>Index terms (comma-separated)
          <input type="text" name="topics" value="${isEdit ? repo.topics.forMatter(matter.id).map((t) => t.name).join(', ') : ''}" placeholder="Zoning, Budget, Public Safety">
        </label>
      </fieldset>
      <fieldset>
        <legend>Fiscal note</legend>
        <div class="form-row">
          <label>Amount ($)
            <input type="number" step="0.01" name="fiscal_impact" value="${matter && matter.fiscal_impact != null ? matter.fiscal_impact : ''}" placeholder="0.00">
          </label>
          <label>Budget line
            <select name="budget_line_id">${raw(selectOptions(budgetLines, matter && matter.budget_line_id, { includeBlank: '— none —' }))}</select>
          </label>
        </div>
        <label class="check-label"><input type="checkbox" name="fiscal_recurring" value="1"
          ${matter && matter.fiscal_recurring ? raw('checked') : ''}> Recurring (ongoing annual cost/revenue, not one-time)</label>
        <label>Fiscal note (narrative)
          <textarea name="fiscal_note" rows="2" placeholder="e.g. $45,000/yr ongoing from the General Fund beginning FY2027…">${matter ? (matter.fiscal_note || '') : ''}</textarea>
        </label>
      </fieldset>
      <label>Amends existing policy (enables the "changes to existing law" view)
        <select name="amends_policy_id">
          <option value="">— none —</option>
          ${raw(repo.policies.all().map((p) => `<option value="${p.id}"${matter && matter.amends_policy_id === p.id ? ' selected' : ''}>${escapeText((p.policy_number ? p.policy_number + ' — ' : '') + p.title)}</option>`).join(''))}
        </select>
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
    extras = workflowPanel(matter) + actionRecorder(matter) + documentsPanel(matter)
      + relationsPanel(matter) + implementationPanel(matter) + attachmentForm(matter);
  }

  const body = html`
    ${raw(card(isEdit ? 'File details' : 'Create file', form))}
    ${raw(extras)}`;
  return layout({
    title: isEdit ? `Edit ${matter.file_number}` : 'New legislative file',
    subtitle: isEdit ? matter.title : 'Open a file for a measure before it is drafted.',
    crumbs: [
      { href: '/admin', label: 'Clerk Workspace' },
      { label: isEdit ? matter.file_number : 'New file' },
    ],
    actions: isEdit
      ? `<a class="btn" href="/legislation/${encodeURIComponent(matter.file_number)}">View public record</a>`
        + ` <a class="btn primary" href="/admin/legislation/${encodeURIComponent(matter.file_number)}/draft">Draft the text</a>`
      : '',
    active: '/admin',
    body,
  });
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
        <input type="text" name="action" required list="action-verbs"
          placeholder="Referred to Finance Committee / Passed / Adopted…">
      </label>
      <datalist id="action-verbs">
        ${raw(['Introduced', 'Referred to committee', 'Reported out of committee',
    'Placed on the agenda', 'Adopted', 'Passed', 'Failed', 'Tabled',
    'Withdrawn', 'Enacted', 'Vetoed']
    .map((v) => `<option value="${escapeText(v)}">`).join(''))}
      </datalist>
      <div class="form-row">
        <label>Result<select name="result">${raw(selectOptions(['', 'Pass', 'Fail', 'Approved', 'Adopted', 'Held'], ''))}</select></label>
        <label>Status
          <select name="new_status">
            <option value="">Follow the action</option>
            ${raw(selectOptions(repo.MATTER_STATUSES, ''))}
          </select>
          <small class="muted">The status follows from what you recorded. Set it here only to
            override.</small>
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
    // `selected` used to be declared here and never used, and the helper was
    // called with no argument, so all six selects read "— any clerk —" on
    // every file for ever. Combined with the notifier dropping unassigned
    // steps, the route a clerk got by doing nothing was a route where nobody
    // was told anything.
    const userOptions = (selected) => `<option value=""${selected ? '' : ' selected'}>— any clerk —</option>`
      + activeUsers.map((u) => `<option value="${u.id}"${String(u.id) === String(selected) ? ' selected' : ''}>`
        + `${escapeText(u.name)} (${escapeText(u.role)})</option>`).join('');
    // The same few people review everything, so the last route is a far better
    // guess than nothing. Offered, not imposed: every select is still free.
    const remembered = repo.workflow.lastAssignees();
    const stepRows = repo.workflowTemplate().map((s) => `
      <label>${escapeText(s.name)} <span class="muted">(${escapeText(s.role || '')})</span>
        <select name="assignee_id">${userOptions(remembered.get(s.name))}</select>
      </label>`).join('');
    const inner = `<p class="muted">Route this file through departmental review and approval.
        Each step goes to the person you pick — it appears in their Approvals inbox, and only they
        (or an admin) can act on it. Leave a step unassigned to let any clerk handle it — they are all notified when you do.</p>
        <p class="muted">Each step is pre-filled with whoever took it on the last file routed.</p>
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
  const body = html`${raw(card('Word processor', form))}`;
  return layout({
    title: matter.title,
    subtitle: `Legislation text — ${matter.file_number}`,
    crumbs: [
      { href: '/admin', label: 'Clerk Workspace' },
      { href: `/admin/matters/${matter.id}/edit`, label: matter.file_number },
      { label: 'Text' },
    ],
    actions: `<a class="btn" href="/admin/legislation/${encodeURIComponent(matter.file_number)}/draft">`
      + 'Structured drafting</a>',
    active: '/admin',
    body,
  });
}

// --- Document form templates (per matter type) --------------------------------
function docTemplatesAdmin(type, { saved = false } = {}) {
  const active = repo.ALL_MATTER_TYPES.includes(type) ? type : 'Action';
  const pills = repo.ALL_MATTER_TYPES.map((t) => `
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
    ${saved ? raw('<p class="form-ok">Template saved.</p>') : ''}
    <div class="admin-actions">${raw(pills)}</div>
    ${raw(card(`Edit the ${active} form`, form))}`;
  return layout({
    title: 'Document form templates',
    subtitle: 'The boilerplate a drafter starts from for each file type — applied when drafting '
      + "a new file or opening a file's text for the first time.",
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Document templates' }],
    active: '/admin',
    body,
  });
}

// Link related files (companion / amends / supersedes) — Congress.gov-style.
function relationsPanel(matter) {
  const relations = repo.matters.relationsFor(matter.id);
  const list = relations.length
    ? `<ul class="attach-list">${relations.map((r) => html`
        <li><a href="/legislation/${encodeURIComponent(r.file_number)}">${r.file_number}</a>
          — ${r.title} <span class="muted">(${r.outgoing ? r.relation : 'linked from'})</span>
          <form method="post" action="/admin/relations/${r.id}/delete" class="inline">
            <button type="submit" class="btn-link danger">unlink</button>
          </form></li>`).join('')}</ul>`
    : emptyState('No related files linked.');
  const options = repo.matters.search({ limit: 300 })
    .filter((m) => m.id !== matter.id)
    .map((m) => `<option value="${m.id}">${escapeText(m.file_number + ' — ' + m.title.slice(0, 70))}</option>`).join('');
  const form = `
    <form class="form inline-form" method="post" action="/admin/matters/${matter.id}/relations">
      <div class="form-row">
        <label>File<select name="related_id" required><option value="">Select…</option>${options}</select></label>
        <label>Relation<select name="relation">${repo.RELATION_TYPES.map((t) => `<option>${t}</option>`).join('')}</select></label>
      </div>
      <button type="submit" class="btn">Link file</button>
    </form>`;
  return card('Related files', form + list);
}

// Accountability: record implementation progress on enacted/passed legislation.
function implementationPanel(matter) {
  const updates = repo.implementation.forMatter(matter.id);
  const eligible = ['Enacted', 'Passed'].includes(matter.status);
  const list = updates.length
    ? `<ul class="version-list">${updates.map((u) => html`
        <li><strong>${u.progress}%</strong> — ${u.note || 'progress update'}
          <span class="muted">· ${raw(formatDate(u.created_at))}</span></li>`).join('')}</ul>`
    : emptyState('No implementation updates yet.');
  const form = eligible ? `
    <form class="form inline-form" method="post" action="/admin/matters/${matter.id}/implementation">
      <div class="form-row">
        <label>Progress %<input type="number" name="progress" min="0" max="100" required
          value="${updates.length ? updates[0].progress : 0}"></label>
        <label>Note<input type="text" name="note" placeholder="Contract awarded / rules drafted…"></label>
      </div>
      <button type="submit" class="btn">Record update</button>
    </form>`
    : '<p class="muted">Implementation tracking becomes available once this file is Enacted or Passed.</p>';
  return card('Implementation (accountability)', form + list);
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
  const body = html`${raw(card('Meeting details', form))}`;
  return layout({
    title: isEdit ? 'Edit meeting' : 'Schedule meeting',
    subtitle: isEdit ? '' : 'Set the body, date and place. The agenda is built after.',
    crumbs: [{ href: '/meetings', label: 'Meetings' },
      { label: isEdit ? 'Edit' : 'Schedule' }],
    active: '/meetings',
    body,
  });
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
  const body = html`${raw(card('Profile', form))}`;
  return layout({
    title: `Edit ${person.full_name}`,
    crumbs: [
      { href: '/people', label: ORG.membersLabel },
      { href: `/people/${person.id}`, label: person.full_name },
      { label: 'Edit' },
    ],
    active: '/people',
    body,
  });
}

// --- Agenda manager (add items + record votes) ------------------------------
// What the last bulk placement did. Reporting the refusals is the point: the
// route drops ids the meeting is not allowed to hear, and a clerk who is not
// told will find out at the meeting.
function placementBanner(q) {
  const added = parseInt((q && q.added) || '', 10);
  const skipped = parseInt((q && q.skipped) || '', 10);
  if (!Number.isInteger(added)) return '';
  const noun = (n) => `${n} item${n === 1 ? '' : 's'}`;
  if (skipped > 0) {
    return `<p class="form-warn">Placed ${noun(added)} on the agenda. `
      + `${noun(skipped)} could not be placed — no longer eligible for this meeting `
      + `(already scheduled, in another body, or closed out). Reload to see the current list.</p>`;
  }
  return `<p class="saved-banner">Placed ${noun(added)} on the agenda.</p>`;
}

// One form for putting an item on the agenda and for correcting one already
// there. Adding was possible before; amending was not, so a wrong section or a
// mistyped title could only be fixed by deleting the item and adding it back —
// which discarded its votes, its packet documents and its place in the order.
//
// Grouped the way a clerk decides an item: where it sits, what it is about,
// and how it will be put.
function agendaItemForm(meeting, item, matterOpts) {
  const isEdit = !!(item && item.id);
  const action = isEdit ? `/admin/agenda-items/${item.id}` : `/admin/meetings/${meeting.id}/agenda`;
  const v = (k) => (item && item[k] != null ? item[k] : '');
  const thresholds = [
    { value: 'majority', label: 'Majority of those voting' },
    { value: 'two_thirds', label: 'Two-thirds of those voting' },
    { value: 'majority_full', label: 'Majority of the full seated body' },
  ];
  return html`
    <form class="form" method="post" action="${action}">
      <fieldset>
        <legend>Placement</legend>
        <div class="form-row">
          <label>Section
            <select name="section">${raw(selectOptions(repo.AGENDA_SECTIONS, v('section'), { includeBlank: '\u2014' }))}</select>
          </label>
          <label>Agenda number <span class="muted" style="font-weight:400">(blank to assign automatically)</span>
            <input type="text" name="agenda_number" value="${v('agenda_number')}" placeholder="e.g. 1A">
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Subject</legend>
        <div class="form-row">
          <label>Legislative file
            <select name="matter_id">${raw(selectOptions(matterOpts, v('matter_id'), { includeBlank: '\u2014 none (procedural item) \u2014' }))}</select>
          </label>
          <label>Item type
            <select name="item_type">${raw(selectOptions(repo.ITEM_TYPES, v('item_type'), { includeBlank: '\u2014 none \u2014' }))}</select>
          </label>
        </div>
        <label>Title <span class="muted" style="font-weight:400">(procedural items; a file supplies its own)</span>
          <input type="text" name="title" value="${v('title')}" placeholder="Call to Order / Approval of Minutes\u2026">
        </label>
        <label>Note for the record <span class="muted" style="font-weight:400">(optional)</span>
          <textarea name="notes" rows="2" placeholder="Context the minutes should carry\u2026">${v('notes')}</textarea>
        </label>
      </fieldset>
      <fieldset>
        <legend>How it will be put</legend>
        <label class="check-label">
          <input type="checkbox" name="requires_vote" value="1"${item && item.requires_vote ? ' checked' : ''}> Requires a vote
        </label>
        <label>Threshold to carry
          <select name="vote_threshold">${raw(selectOptions(thresholds, v('vote_threshold') || 'majority'))}</select>
        </label>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn primary">${isEdit ? 'Save item' : 'Add to agenda'}</button>
        ${isEdit ? raw(`<a class="btn-link" href="/admin/meetings/${meeting.id}/agenda">Cancel</a>`) : ''}
      </div>
    </form>`;
}

// The amend screen for a single agenda item.
function agendaItemPage(meeting, item) {
  const matterOpts = repo.matters.search({ limit: 300 })
    .map((m) => ({ value: m.id, label: `${m.file_number} \u2014 ${m.title}` }));
  const label = item.agenda_number ? `Item ${item.agenda_number}` : 'Agenda item';
  return layout({
    title: `${label} \u2014 ${meeting.body_name}`,
    h1: `Amend ${label.toLowerCase()}`,
    active: '/admin',
    crumbs: [
      { label: 'Clerk Workspace', href: '/admin' },
      { label: 'Agenda', href: `/admin/meetings/${meeting.id}/agenda` },
      { label },
    ],
    subtitle: item.matter_title || item.title || '',
    body: html`${raw(card('Agenda item', agendaItemForm(meeting, item, matterOpts)))}`,
  });
}

function agendaManager(meeting, query) {
  const items = repo.meetings.items(meeting.id);
  const openMatters = repo.matters.search({ limit: 300 })
    .map((m) => ({ value: m.id, label: `${m.file_number} — ${m.title}` }));

  // Grouped under section headings, in the order the meeting is run.
  //
  // This was a flat list with the section printed as small grey text on each
  // row, so the clerk arranged the agenda by dragging while unable to see the
  // thing being arranged, and first saw the grouping on the public page or in
  // the printed packet. Items keep their running order inside a section, and a
  // section that appears twice in the order is shown twice — that is a real
  // state the agenda can be in, and hiding it would be the bug.
  const grouped = () => {
    const out = [];
    let last = null;
    for (const it of items) {
      const sec = it.section || null;
      if (sec !== last) {
        out.push(`<h3 class="agenda-section-head">${escapeText(sec || 'Unsectioned')}</h3>`);
        last = sec;
      }
      out.push(voteBlock(meeting, it));
    }
    return out.join('');
  };
  const itemBlocks = items.length ? grouped() :
    emptyState('No agenda items yet.');

  const addItemForm = agendaItemForm(meeting, null, openMatters);

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
    ${raw(meetingSteps(meeting, 'agenda'))}
    ${raw(placementBanner(query))}
    ${raw(readyQueue(meeting))}
    ${raw(card('Add an item by hand', addItemForm))}
    ${raw(card('Agenda items & voting',
      loadTemplateBtn + reorderHint + `<div class="agenda-manage" data-meeting="${meeting.id}">${itemBlocks}</div>`))}
    ${raw(speakerQueue(meeting))}
    <script src="/assets/agenda-reorder.js" defer></script>
    <script src="/assets/check-all.js" defer></script>
  `;
  return layout({
    title: `Agenda — ${meeting.body_name}`,
    subtitle: [formatDate(meeting.meeting_date), meeting.meeting_time].filter(Boolean).join(' · '),
    crumbs: [
      { href: '/meetings', label: 'Meetings' },
      { href: `/meetings/${meeting.id}`, label: formatDate(meeting.meeting_date) || 'Meeting' },
      { label: 'Agenda' },
    ],
    actions: `<a class="btn" href="/admin/meetings/${meeting.id}/edit">Edit meeting</a>`
      + ` <a class="btn primary" href="/admin/meetings/${meeting.id}/live">Run live</a>`,
    active: '/meetings',
    body,
  });
}

// The docket waiting to be heard: files this body can take up that are not
// already scheduled. Placing business on an agenda is a bulk act — a clerk
// works down a list deciding what makes this meeting — so this is a checklist
// with one placement action, not the one-at-a-time dropdown beneath it.
// Whether the file is actually written, said on the row where it is about to
// be placed. The judgement is repo.matters.readiness — the same one the
// drafting screen states in a sentence. Before this the queue asked only
// whether a file had the right status and was not already booked, so a file
// with no text and every board-letter section blank sat here looking exactly
// like a finished one: the two screens disagreed about the same file.
//
// It flags rather than blocks. A clerk may have reason to agendise something
// unfinished; the point is that they should know they are doing it.
function readyFlag(matter) {
  const { ready, reasons } = repo.matters.readiness(matter);
  if (ready) return '<span class="badge st-passed">Ready</span>';
  const why = reasons.map((r) => r.label).join('; ');
  return `<span class="badge st-draft" title="${escapeText(why)}">Not ready</span>`;
}

function readyQueue(meeting) {
  const ready = repo.meetings.readyForAgenda(meeting.id);
  if (!ready.length) {
    return card('Ready for agenda', emptyState(
      'Nothing is waiting for this body. Files appear here once introduced and until they are scheduled.'));
  }
  const rows = ready.map((m) => html`
    <tr>
      <td class="rq-pick"><input type="checkbox" name="matter_id" value="${m.id}"
        id="rq${m.id}" form="ready-queue"></td>
      <td><label for="rq${m.id}">${m.file_number}</label></td>
      <td>${typeBadge(m.type)}</td>
      <td class="title-cell"><label for="rq${m.id}">${m.title}</label></td>
      <td>${statusBadge(m.status)}</td>
      <td>${raw(readyFlag(m))}</td>
      <td class="rq-material muted">${raw(materialNote(m))}</td>
    </tr>`).join('');

  const body = `
    <form class="form" id="ready-queue" method="post"
      action="/admin/meetings/${meeting.id}/agenda/add-matters"></form>
    <table class="data ready-queue">
      <thead><tr>
        <th class="rq-pick"><input type="checkbox" data-check-all="ready-queue" aria-label="Select all"></th>
        <th>File #</th><th>Type</th><th>Title</th><th>Status</th><th>Ready</th><th>Material</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="rq-actions">
      <label>Place under section
        <select name="section" form="ready-queue">${selectOptions(repo.AGENDA_SECTIONS, 'New Business', { includeBlank: '— none —' })}</select>
      </label>
      <label>Item type
        <select name="item_type" form="ready-queue">${selectOptions(repo.ITEM_TYPES, 'Action')}</select>
      </label>
      <button type="submit" class="btn primary" form="ready-queue">Place selected on agenda</button>
    </div>`;
  return card(`Ready for agenda (${ready.length})`, body);
}

// What supporting material a file already carries, so a clerk can see before
// scheduling whether the packet for it will be empty.
function materialNote(m) {
  const bits = [];
  if (m.report_count) bits.push(`${m.report_count} report${m.report_count > 1 ? 's' : ''}`);
  if (m.attachment_count) bits.push(`${m.attachment_count} attachment${m.attachment_count > 1 ? 's' : ''}`);
  return bits.length ? escapeText(bits.join(' · ')) : '<em>none</em>';
}

// --- Packet builder ----------------------------------------------------------
// The assembled meeting packet, shown in the order it will be bound: every
// agenda item in agenda order with its supporting material gathered behind it.
// The point of the screen is to make an empty tab obvious before the packet
// goes out, which is the failure that actually costs a meeting — a member
// turning to tab 4 and finding nothing there.
function packetBuilder(meeting) {
  const rows = repo.meetings.packet(meeting.id);
  const included = rows.filter((r) => r.included);
  const withTabs = rows.filter((r) => r.tab);
  const bare = included.filter((r) => r.material === 0 && r.item.matter_id);

  const summary = `
    <div class="stat-grid small">
      <div class="stat"><span class="stat-n">${rows.length}</span><span class="stat-l">Agenda items</span></div>
      <div class="stat"><span class="stat-n">${withTabs.length}</span><span class="stat-l">Tabs</span></div>
      <div class="stat"><span class="stat-n">${included.reduce((n, r) => n + r.material, 0)}</span><span class="stat-l">Documents</span></div>
      <div class="stat${bare.length ? ' stat-flag' : ''}"><span class="stat-n">${bare.length}</span><span class="stat-l">Files with no material</span></div>
    </div>`;

  const warning = bare.length ? `
    <p class="form-warn">${bare.length} legislative file${bare.length > 1 ? 's are' : ' is'} on the agenda
    with no staff report or attachment. Members will have nothing to read on
    ${bare.length > 1 ? 'those items' : 'that item'}:
    ${escapeText(bare.map((r) => r.item.file_number || r.item.title).join(', '))}.</p>` : '';

  const blocks = rows.map((r) => packetRow(meeting, r)).join('');

  const body = html`
    ${raw(meetingSteps(meeting, 'packet'))}
    ${raw(summary)}
    ${raw(warning)}
    ${raw(card('Contents, in binding order', rows.length
      ? `<div class="packet-list">${blocks}</div>`
      : emptyState('No agenda items yet — build the agenda first.')))}`;
  return layout({
    title: `Packet — ${meeting.body_name}`,
    subtitle: [formatDate(meeting.meeting_date), meeting.meeting_time, meeting.location]
      .filter(Boolean).join(' · '),
    crumbs: [
      { href: '/meetings', label: 'Meetings' },
      { href: `/meetings/${meeting.id}`, label: formatDate(meeting.meeting_date) || 'Meeting' },
      { label: 'Packet' },
    ],
    actions: `<a class="btn primary" href="/meetings/${meeting.id}/packet">Download packet</a>`,
    active: '/meetings',
    body,
  });
}

function packetRow(meeting, r) {
  const it = r.item;
  const title = it.matter_id
    ? `${escapeText(it.file_number)} — ${escapeText(it.matter_title)}`
    : escapeText(it.title || '(item)');
  const num = it.agenda_number ? `<span class="pb-num">${escapeText(it.agenda_number)}</span>` : '';
  const tab = r.tab ? `<span class="pb-tab">Tab ${r.tab}</span>` : '<span class="pb-tab pb-tab-none">no tab</span>';

  const docLine = (name, kind, href, del) => `
    <li class="pb-doc">
      <span class="pb-kind">${escapeText(kind)}</span>
      ${href ? `<a href="${escapeText(href)}">${escapeText(name)}</a>` : `<span class="pb-file">${escapeText(name)}</span>`}
      ${del || ''}
    </li>`;

  const docs = [
    ...r.reports.map((rep) => docLine(rep.title, rep.kind || 'Report', `/admin/reports/${rep.id}/edit`)),
    ...r.attachments.map((a) => docLine(a.name, 'Attachment', a.url || (a.file_path ? `/files/${a.id}` : null))),
    ...r.docs.map((d) => docLine(d.name, 'Item document', d.url || null,
      `<form method="post" action="/admin/agenda-item-docs/${d.id}/delete" class="inline-del"
         onsubmit="return confirm('Remove this document from the packet?')"><button type="submit" class="link-danger">Remove</button></form>`)),
  ].join('');

  const addDoc = `
    <form class="form inline-form pb-add" method="post" action="/admin/agenda-items/${it.id}/docs">
      <input type="text" name="name" placeholder="Document name" required>
      <input type="url" name="url" placeholder="https://… (link)">
      <button type="submit" class="btn">Attach</button>
    </form>`;

  const toggle = `
    <form method="post" action="/admin/agenda-items/${it.id}/in-packet" class="inline">
      <input type="hidden" name="value" value="${r.included ? '0' : '1'}">
      <button type="submit" class="btn-link">${r.included ? 'Hold back' : 'Include'}</button>
    </form>`;

  return `
    <section class="pb-item${r.included ? '' : ' pb-held'}${r.included && r.material === 0 && it.matter_id ? ' pb-bare' : ''}">
      <header class="pb-head">
        ${num}${tab}
        <span class="pb-title">${title}</span>
        ${it.section ? `<span class="pb-section muted">${escapeText(it.section)}</span>` : ''}
        ${toggle}
      </header>
      ${r.included
        ? (docs ? `<ul class="pb-docs">${docs}</ul>`
                : `<p class="pb-empty">${it.matter_id ? 'No staff report or attachment on this file.' : 'Procedural item — nothing to bind.'}</p>`)
        : '<p class="pb-empty">Held back — not in this packet.</p>'}
      ${r.included ? addDoc : ''}
    </section>`;
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
      <form class="inline video-ts-form" method="post" action="/admin/agenda-items/${it.id}/video"
        title="Timestamp of this item in the meeting video (h:mm:ss)">
        <input type="text" name="video_ts" value="${escapeText(it.video_ts || '')}" placeholder="▶ 0:14:32" size="8">
        <button type="submit" class="btn-link">set</button>
      </form>
      <a class="btn-link" href="/admin/agenda-items/${it.id}/edit" title="Amend this item">\u270e Edit</a>
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
  return layout({
    title: 'Standard agenda template',
    subtitle: 'The running order a new meeting starts from.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Agenda template' }],
    active: '/admin',
    body,
  });
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
    ${raw(card(`Awaiting review (${pending.length})`, pendingList))}
    ${raw(card('Recently decided', decidedList))}`;
  return layout({
    title: 'Public comment review',
    subtitle: "Comments on legislative files are held here until approved. Approved comments are "
      + "published on the file's public page; email addresses are never shown publicly.",
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Public comments' }],
    active: '/admin',
    body,
  });
}

// --- Board/commission application review --------------------------------------
function applicationsAdmin() {
  const pending = repo.applications.pending();
  const decided = repo.applications.recentDecided();
  const row = (a, actions) => html`
    <li>
      <div class="comment-head">
        <strong>${a.name}</strong> — applying to <strong>${a.body_name}</strong>
        <span class="muted">· ${raw(formatDate(a.created_at))}${a.email ? ' · ' + a.email : ''}${a.phone ? ' · ' + a.phone : ''}</span>
      </div>
      ${a.statement ? raw(`<p class="comment-body">${escapeText(a.statement)}</p>`) : ''}
      ${raw(actions)}
    </li>`;
  const pendingList = pending.length
    ? `<ul class="comment-list">${pending.map((a) => row(a, `
        <div class="form-actions">
          <form method="post" action="/admin/applications/${a.id}/decide" class="inline">
            <input type="hidden" name="decision" value="nominate">
            <button type="submit" class="btn primary">Nominate for seat</button>
          </form>
          <form method="post" action="/admin/applications/${a.id}/decide" class="inline">
            <input type="hidden" name="decision" value="decline">
            <button type="submit" class="btn">Decline</button>
          </form>
        </div>`)).join('')}</ul>`
    : emptyState('No applications waiting for review.');
  const decidedList = decided.length
    ? `<ul class="comment-list">${decided.map((a) => row(a,
      `<div class="form-actions">${statusBadge(a.status)}${a.motion_id
        ? ` <a class="btn-link" href="/govern/members">view nomination</a>` : ''}</div>`)).join('')}</ul>`
    : emptyState('No decided applications yet.');
  const body = html`
    ${raw(card(`Awaiting review (${pending.length})`, pendingList))}
    ${raw(card('Recently decided', decidedList))}`;
  return layout({
    title: 'Board & commission applications',
    subtitle: 'Citizen applications submitted from body pages. Nominating an applicant creates a '
      + 'seat nomination in the membership workflow (Nominate \u2192 Approve \u2192 Seat).',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Applications' }],
    active: '/admin',
    body,
  });
}

// --- Audit log ------------------------------------------------------------------
function auditAdmin() {
  const rows = repo.audit.recent(200);
  const table = rows.length
    ? `<table class="data compact"><thead><tr><th>When</th><th>User</th><th>Action</th><th>IP</th></tr></thead><tbody>${
      rows.map((r) => html`
        <tr>
          <td>${r.created_at}</td>
          <td>${r.user_name || raw('<span class="muted">—</span>')}</td>
          <td><code>${r.method} ${r.path}</code></td>
          <td>${r.ip || ''}</td>
        </tr>`).join('')}</tbody></table>`
    : emptyState('No recorded actions yet.');
  const body = html`
    ${raw(card('Recent actions', table))}`;
  return layout({
    title: 'Audit log',
    subtitle: 'Every state-changing request by a signed-in user (most recent 200 shown; the log '
      + 'keeps the last 20,000 entries). Timestamps are UTC.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Audit log' }],
    active: '/admin',
    body,
  });
}

// --- Email / notifications ------------------------------------------------------
function mailAdmin({ sent = false } = {}) {
  const smtp = require('../smtp');
  const notify = require('../notify');
  const configured = smtp.isConfigured();
  const c = smtp.config();
  const statusCard = configured
    ? `<p class="form-ok">SMTP is configured — notifications are active.</p>
       <dl class="meta"><dt>Relay</dt><dd>${escapeText(c.host)}:${escapeText(String(c.port))} (${escapeText(c.secure)})</dd>
       <dt>From</dt><dd>${escapeText(c.from)}</dd>
       <dt>Site link base</dt><dd>${escapeText(notify.baseUrl() || '(APP_BASE_URL not set — emails use relative links)')}</dd></dl>`
    : `<p class="muted">Not configured — notifications are silently disabled. Set these secrets on the app
       (e.g. <code>fly secrets set …</code>) to activate:</p>
       <ul>
         <li><code>SMTP_HOST</code>, <code>SMTP_PORT</code> (587 STARTTLS or 465 implicit TLS)</li>
         <li><code>SMTP_USER</code> / <code>SMTP_PASS</code> (relay credentials)</li>
         <li><code>SMTP_FROM</code> (sender address) and <code>APP_BASE_URL</code> (for links in emails)</li>
       </ul>
       <p class="muted">Notifications sent: approval routed to you · activity on watched files ·
       application decisions · speaker confirmations.</p>`;
  const testForm = configured ? `
    <form class="form inline-form" method="post" action="/admin/mail/test">
      <div class="form-row">
        <label>Send a test message to<input type="email" name="to" required placeholder="you@example.gov"></label>
      </div>
      <button type="submit" class="btn">Queue test email</button>
    </form>${sent ? '<p class="form-ok">Test message queued — it should arrive within a minute.</p>' : ''}` : '';
  const rows = notify.recent();
  const outbox = rows.length
    ? `<table class="data compact"><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th><th>Error</th></tr></thead>
       <tbody>${rows.map((m) => html`<tr>
         <td>${m.created_at}</td><td>${m.to_email}</td><td>${m.subject}</td>
         <td>${statusBadge(m.status)}${m.attempts > 1 ? raw(` <span class="muted">×${m.attempts}</span>`) : ''}</td>
         <td class="muted">${m.last_error || ''}</td></tr>`).join('')}</tbody></table>`
    : emptyState('No messages queued yet.');
  const body = html`
    ${raw(card('Status', statusCard + testForm))}
    ${raw(card('Outbox (most recent 50)', outbox))}`;
  return layout({
    title: 'Email notifications',
    subtitle: 'Delivery status and what has been sent.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Email' }],
    active: '/admin',
    body,
  });
}

module.exports = {
  adminHome, matterForm, meetingForm, personForm, agendaManager, agendaItemPage, meetingSteps, packetBuilder, agendaTemplateAdmin, commentsAdmin,
  matterTextForm, docTemplatesAdmin, applicationsAdmin, auditAdmin, mailAdmin,
};
