'use strict';

const { html, raw, formatDate, formatDateTime, todayISO } = require('../util');
const { layout, card, tabs, workflowStepper, statusBadge, typeBadge, emptyState, escapeText } = require('./layout');
const { ORG } = require('../org');
const { money } = require('./budget');
const auth = require('../auth');
const repo = require('../repo');

// --- Dashboard ---------------------------------------------------------------
function dashboard() {
  const s = repo.stats();
  const today = todayISO();
  const upcoming = repo.meetings.upcoming(today, 6);
  const recent = repo.matters.search({ limit: 8 });
  const buckets = repo.statusBuckets();

  const statCards = [
    ['Legislative files', s.matters, '/legislation'],
    ['In progress', s.pending, '/legislation?status=In+Committee'],
    ['Passed / enacted', s.enacted, '/legislation?status=Passed'],
    ['Meetings', s.meetings, '/calendar'],
    ['Bodies', s.bodies, '/bodies'],
    ['Officials', s.people, '/people'],
  ].map(([label, n, href]) => html`
    <a class="stat" href="${href}"><span class="stat-n">${n}</span><span class="stat-l">${label}</span></a>`);

  const upcomingRows = upcoming.length ? upcoming.map((m) => html`
    <tr>
      <td>${raw(formatDateTime(m.meeting_date, m.meeting_time))}</td>
      <td><a href="/meetings/${m.id}">${m.body_name}</a></td>
      <td>${m.location || ''}</td>
      <td>${statusBadge(m.status)}</td>
    </tr>`) : null;

  const recentRows = recent.map((m) => html`
    <tr>
      <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${m.file_number}</a></td>
      <td>${typeBadge(m.type)}</td>
      <td class="title-cell">${m.title}</td>
      <td>${statusBadge(m.status)}</td>
    </tr>`);

  const bucketBars = buckets.map((b) => html`
    <li><a href="/legislation?status=${encodeURIComponent(b.status)}">
      <span class="bucket-l">${b.status}</span><span class="bucket-n">${b.n}</span></a></li>`);

  const body = html`
    <div class="hero">
      <h1>Legislative Docket</h1>
      <p>Track ordinances, resolutions, and motions from introduction through final action.
         Browse the public record of meetings, agendas, votes, and council members.</p>
    </div>
    <div class="stat-grid">${raw(statCards.join(''))}</div>
    <div class="grid-2">
      ${raw(card('Upcoming meetings',
        upcomingRows
          ? `<table class="data"><thead><tr><th>When</th><th>Body</th><th>Location</th><th>Status</th></tr></thead><tbody>${upcomingRows.join('')}</tbody></table>`
          : emptyState('No upcoming meetings scheduled.'),
        { actions: '<a class="btn-link" href="/calendar">Full calendar →</a>' }))}
      ${raw(card('Legislation by status',
        `<ul class="bucket-list">${bucketBars.join('')}</ul>`))}
    </div>
    ${raw(card('Recently introduced',
      `<table class="data"><thead><tr><th>File #</th><th>Type</th><th>Title</th><th>Status</th></tr></thead><tbody>${recentRows.join('')}</tbody></table>`,
      { actions: '<a class="btn-link" href="/legislation">All legislation →</a>' }))}
  `;
  return layout({ title: 'Dashboard', active: '/', body });
}

// --- Legislation list --------------------------------------------------------
const PAGE_SIZE = 25;

function legislationList(query) {
  const { q = '', type = '', status = '', body_id = '', sponsor_id = '', topic = '',
    from = '', to = '' } = query;
  const sort = repo.SORT_COLUMNS[query.sort] ? query.sort : 'intro_date';
  const dir = String(query.dir).toLowerCase() === 'asc' ? 'asc' : 'desc';

  const filterArgs = {
    q, type, status,
    bodyId: body_id ? Number(body_id) : undefined,
    sponsorId: sponsor_id ? Number(sponsor_id) : undefined,
    topicId: topic ? Number(topic) : undefined,
    from: from || undefined, to: to || undefined,
  };
  const total = repo.matters.count(filterArgs);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, parseInt(query.page, 10) || 1), pages);
  const rows = repo.matters.search({
    ...filterArgs, sort, dir, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
  });

  const activeTopic = topic ? repo.topics.get(Number(topic)) : null;
  const allBodies = repo.bodies.all();
  const allPeople = repo.people.all();

  const opt = (value, current, label) =>
    `<option value="${escapeText(value)}"${String(value) === String(current) ? ' selected' : ''}>${escapeText(label)}</option>`;

  // Preserve current filters/sort when building links.
  const baseParams = { q, type, status, body_id, sponsor_id, topic, from, to, sort, dir };
  const urlWith = (overrides) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...baseParams, ...overrides })) {
      if (v !== '' && v != null) p.set(k, v);
    }
    const s = p.toString();
    return '/legislation' + (s ? '?' + s : '');
  };

  const filters = html`
    <form class="search-panel" method="get" action="/legislation" role="search">
      <div class="sp-head">Search Legislation</div>
      ${topic ? raw(`<input type="hidden" name="topic" value="${escapeText(topic)}">`) : ''}
      <div class="sp-grid">
        <label class="sp-field">Words or file number
          <input type="search" name="q" value="${q}" placeholder="e.g. zoning, ORD-2026-0003">
        </label>
        <label class="sp-field">Type
          <select name="type">${raw('<option value="">— All types —</option>' + repo.MATTER_TYPES.map((t) => opt(t, type, t)).join(''))}</select>
        </label>
        <label class="sp-field">Status
          <select name="status">${raw('<option value="">— All statuses —</option>' + repo.MATTER_STATUSES.map((s) => opt(s, status, s)).join(''))}</select>
        </label>
        <label class="sp-field">In control (body)
          <select name="body_id">${raw('<option value="">— All bodies —</option>' + allBodies.map((b) => opt(b.id, body_id, b.name)).join(''))}</select>
        </label>
        <label class="sp-field">Sponsor
          <select name="sponsor_id">${raw('<option value="">— Any sponsor —</option>' + allPeople.map((p) => opt(p.id, sponsor_id, p.full_name)).join(''))}</select>
        </label>
        <label class="sp-field">Introduced from
          <input type="date" name="from" value="${from}">
        </label>
        <label class="sp-field">Introduced to
          <input type="date" name="to" value="${to}">
        </label>
        <div class="sp-actions">
          <button type="submit">Search</button>
          <a class="btn-link" href="/legislation">Clear</a>
        </div>
      </div>
    </form>`;

  // Sortable column header.
  const th = (key, label) => {
    const active = sort === key;
    const nextDir = active && dir === 'asc' ? 'desc' : 'asc';
    const arrow = active ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th><a class="sort-link${active ? ' active' : ''}" href="${urlWith({ sort: key, dir: nextDir, page: '' })}">${escapeText(label)}${arrow}</a></th>`;
  };

  const tableRows = rows.length ? rows.map((m) => html`
    <tr>
      <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${m.file_number}</a></td>
      <td>${typeBadge(m.type)}</td>
      <td class="title-cell">${m.title}<div class="sub">${m.sponsors || ''}</div></td>
      <td>${m.body_name || ''}</td>
      <td>${raw(formatDate(m.intro_date))}</td>
      <td>${statusBadge(m.status)}</td>
    </tr>`).join('') : null;

  const table = tableRows
    ? `<table class="data sortable"><thead><tr>${th('file_number', 'File #')}${th('type', 'Type')}${th('title', 'Title / Sponsors')}${th('body', 'In control')}${th('intro_date', 'Introduced')}${th('status', 'Status')}</tr></thead><tbody>${tableRows}</tbody></table>`
    : emptyState('No legislative files match your search.');

  const exportQs = new URLSearchParams(
    Object.entries({ q, type, status, body_id, sponsor_id, topic, from, to }).filter(([, v]) => v)
  ).toString();
  const exportSuffix = exportQs ? '?' + exportQs : '';

  const topicNotice = activeTopic
    ? `<p class="topic-notice">Index: <strong>${escapeText(activeTopic.name)}</strong> · <a href="/legislation">clear</a></p>`
    : '';

  const firstRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = (page - 1) * PAGE_SIZE + rows.length;
  const pager = pages > 1 ? `<nav class="pager">
      ${page > 1 ? `<a class="btn-link" href="${urlWith({ page: page - 1 })}">‹ Prev</a>` : '<span class="pager-disabled">‹ Prev</span>'}
      <span class="pager-info">Page ${page} of ${pages}</span>
      ${page < pages ? `<a class="btn-link" href="${urlWith({ page: page + 1 })}">Next ›</a>` : '<span class="pager-disabled">Next ›</span>'}
    </nav>` : '';

  const body = html`
    ${raw(filters)}
    ${raw(topicNotice)}
    <div class="list-toolbar">
      <p class="muted result-count">${total ? `Showing ${firstRow}–${lastRow} of ${total}` : '0'} legislative file${total === 1 ? '' : 's'}</p>
      <span class="export-links">
        <a class="btn-link" href="/legislation.csv${exportSuffix}">⬇ Export CSV</a>
        <a class="btn-link" href="/legislation.rss">🔔 RSS</a>
      </span>
    </div>
    ${raw(table)}
    ${raw(pager)}`;
  return layout({ title: 'Legislation', active: '/legislation', body });
}

// --- Matter detail -----------------------------------------------------------
function matterDetail(matter) {
  const sponsors = repo.matters.sponsors(matter.id);
  const history = repo.matters.history(matter.id);
  const attachments = repo.matters.attachments(matter.id);
  const appearances = repo.matters.appearsOn(matter.id);

  const sponsorHtml = sponsors.length
    ? raw(sponsors.map((p) => html`<a class="chip" href="/people/${p.id}">${p.full_name}${p.sponsor_type === 'Primary' ? raw(' <em>(primary)</em>') : ''}</a>`).join(''))
    : raw('<span class="muted">None</span>');

  const historyRows = history.length ? history.map((h) => html`
    <tr>
      <td>${raw(formatDate(h.action_date))}</td>
      <td>${h.body_name || ''}</td>
      <td>${h.action}${h.notes ? raw(`<div class="sub">${escapeText(h.notes)}</div>`) : ''}</td>
      <td>${h.result ? statusBadge(h.result) : ''}</td>
      <td>${h.meeting_id ? raw(`<a href="/meetings/${h.meeting_id}">meeting</a>`) : ''}</td>
    </tr>`).join('') : null;

  const attachmentList = attachments.length
    ? `<ul class="attach-list">${attachments.map((a) => html`
        <li>${a.url ? raw(`<a href="${escapeText(a.url)}">${escapeText(a.name)}</a>`) : a.name}
        ${a.note ? raw(`<span class="muted"> — ${escapeText(a.note)}</span>`) : ''}</li>`).join('')}</ul>`
    : emptyState('No attachments.');

  const appearanceRows = appearances.length ? appearances.map((a) => html`
    <tr>
      <td>${raw(formatDate(a.meeting_date))}</td>
      <td><a href="/meetings/${a.meeting_id}">${a.body_name}</a></td>
      <td>${a.action || ''}</td>
      <td>${a.result ? statusBadge(a.result) : ''}</td>
    </tr>`).join('') : null;

  const topics = repo.topics.forMatter(matter.id);
  const topicChips = topics.length
    ? raw(topics.map((t) => html`<a class="chip" href="/legislation?topic=${t.id}">${t.name}</a>`).join(''))
    : raw('<span class="muted">None</span>');

  const reports = repo.reports.forMatter(matter.id);
  const reportList = reports.length
    ? `<ul class="attach-list doc-list">${reports.map((r) => html`
        <li><a href="/reports/${r.id}">${r.title}</a> <span class="badge type">${r.kind}</span>
        ${r.author_name ? raw(`<span class="muted"> — ${escapeText(r.author_name)}</span>`) : ''}</li>`).join('')}</ul>`
    : emptyState('No staff reports or documents.');

  const onAgenda = appearances.length ? formatDate(appearances[0].meeting_date) : null;

  const fiscalLine = matter.budget_line_id ? repo.budget.getLine(matter.budget_line_id) : null;
  const fiscalRow = (matter.fiscal_impact != null && matter.fiscal_impact !== '')
    ? raw(`<dt>Fiscal impact</dt><dd>${money(matter.fiscal_impact)}${fiscalLine
        ? ` · <a href="/budget/${fiscalLine.budget_id}">${escapeText(fiscalLine.fiscal_year)} budget — ${escapeText((fiscalLine.category ? fiscalLine.category + ' / ' : '') + fiscalLine.name)}</a>` : ''}</dd>`)
    : '';

  const meta = html`
    <dl class="meta record-header">
      <dt>File #</dt><dd>${matter.file_number}</dd>
      <dt>Version</dt><dd>1</dd>
      <dt>Type</dt><dd>${typeBadge(matter.type)}</dd>
      <dt>Status</dt><dd>${statusBadge(matter.status)}</dd>
      <dt>File created</dt><dd>${raw(formatDate(matter.created_at)) || '—'}</dd>
      <dt>In control</dt><dd>${matter.body_name || '—'}</dd>
      <dt>Introduced</dt><dd>${raw(formatDate(matter.intro_date)) || '—'}</dd>
      <dt>On agenda</dt><dd>${onAgenda ? raw(onAgenda) : '—'}</dd>
      <dt>Final action</dt><dd>${matter.final_date ? raw(formatDate(matter.final_date)) : '—'}</dd>
      <dt>Title</dt><dd>${matter.title}</dd>
      <dt>Sponsors</dt><dd class="chips">${sponsorHtml}</dd>
      <dt>Indexes</dt><dd class="chips">${topicChips}</dd>
      ${fiscalRow}
    </dl>`;

  // Tab panels (History default, mirroring the conventional record layout).
  const historyPanel = historyRows
    ? `<table class="data"><thead><tr><th>Date</th><th>Ver.</th><th>Action By</th><th>Action</th><th>Result</th><th></th></tr></thead><tbody>${
        history.map((h) => html`
          <tr>
            <td>${raw(formatDate(h.action_date))}</td>
            <td>1</td>
            <td>${h.body_name || ''}</td>
            <td>${h.action}${h.notes ? raw(`<div class="sub">${escapeText(h.notes)}</div>`) : ''}</td>
            <td>${h.result ? statusBadge(h.result) : ''}</td>
            <td>${h.meeting_id ? raw(`<a href="/meetings/${h.meeting_id}">meeting</a>`) : ''}</td>
          </tr>`).join('')}</tbody></table>`
    : emptyState('No recorded actions yet.');

  const textPanel = ((matter.summary ? `<h3 class="tab-h">Summary</h3><p>${escapeText(matter.summary)}</p>` : '')
    + (matter.body_html
      ? `<h3 class="tab-h">Legislation text</h3><div class="doc-body">${matter.body_html}</div>`
      : (matter.full_text ? `<h3 class="tab-h">Full text</h3><pre class="fulltext">${escapeText(matter.full_text)}</pre>` : '')))
    || emptyState('No text on file.');

  const docsPanel = `<h3 class="tab-h">Documents &amp; reports</h3>${reportList}`
    + `<h3 class="tab-h">Attachments</h3>${attachmentList}`;

  const appearancesPanel = appearanceRows
    ? `<table class="data"><thead><tr><th>Meeting date</th><th>Body</th><th>Action</th><th>Result</th></tr></thead><tbody>${appearanceRows}</tbody></table>`
    : emptyState('This file has not appeared on an agenda.');

  const wfSteps = repo.workflow.forMatter(matter.id);

  const tabbed = tabs([
    { id: 'history', label: 'History', count: history.length, html: historyPanel },
    { id: 'text', label: 'Text', html: textPanel },
    { id: 'docs', label: 'Reports & Attachments', count: reports.length + attachments.length, html: docsPanel },
    { id: 'workflow', label: 'Workflow', count: wfSteps.length || null, html: workflowStepper(wfSteps) },
    { id: 'agenda', label: 'Agenda appearances', count: appearances.length, html: appearancesPanel },
  ]);

  const body = html`
    <p class="crumbs"><a href="/legislation">Legislation</a> / ${matter.file_number}</p>
    <div class="detail-head">
      <h1>${matter.title}</h1>
      <a class="btn" href="/admin/matters/${matter.id}/edit">Manage</a>
    </div>
    ${raw(card('Record', meta))}
    ${raw(tabbed)}
    <script src="/assets/tabs.js" defer></script>
  `;
  return layout({ title: matter.file_number, active: '/legislation', body });
}

// --- Calendar ----------------------------------------------------------------
function calendar(query = {}) {
  const today = todayISO();
  const view = ['upcoming', 'past', 'all'].includes(query.view) ? query.view : 'upcoming';
  const { body_id = '', from = '', to = '' } = query;
  const allBodies = repo.bodies.all();

  const filterArgs = {
    bodyId: body_id ? Number(body_id) : undefined,
    from: from || undefined, to: to || undefined, view, today,
  };
  const total = repo.meetings.countCalendar(filterArgs);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, parseInt(query.page, 10) || 1), pages);
  const list = repo.meetings.searchCalendar({
    ...filterArgs, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
  });

  const baseParams = { body_id, from, to, view };
  const urlWith = (overrides) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...baseParams, ...overrides })) {
      if (v !== '' && v != null) p.set(k, v);
    }
    const s = p.toString();
    return '/calendar' + (s ? '?' + s : '');
  };

  const docCell = (url, label) => url
    ? `<a class="doc-link" href="${escapeText(url)}">${label}</a>`
    : '<span class="doc-na">—</span>';

  const row = (m) => html`
    <tr>
      <td><a href="/meetings/${m.id}">${m.body_name}</a></td>
      <td>${raw(formatDate(m.meeting_date))}</td>
      <td>${m.meeting_time || ''}</td>
      <td>${m.location || ''}</td>
      <td>${statusBadge(m.status)}</td>
      <td class="icon-col"><a href="/meetings/${m.id}">Details</a></td>
      <td class="icon-col">${raw(docCell(m.agenda_url, 'Agenda'))}</td>
      <td class="icon-col">${raw(`<a class="doc-link" href="/meetings/${m.id}/packet">Packet</a>`)}</td>
      <td class="icon-col">${raw(m.minutes_status === 'published'
        ? `<a class="doc-link" href="/meetings/${m.id}/minutes">Minutes</a>`
        : docCell(m.minutes_url, 'Minutes'))}</td>
      <td class="icon-col">${raw(docCell(m.video_url, 'Video'))}</td>
    </tr>`;

  const table = list.length
    ? `<table class="data"><thead><tr><th>Name</th><th>Meeting Date</th><th>Time</th><th>Location</th><th>Status</th><th>Details</th><th>Agenda</th><th>Packet</th><th>Minutes</th><th>Video</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table>`
    : emptyState('No meetings match these filters.');

  const opt = (value, current, label) =>
    `<option value="${escapeText(value)}"${String(value) === String(current) ? ' selected' : ''}>${escapeText(label)}</option>`;

  const filterForm = `
    <form class="search-panel" method="get" action="/calendar" role="search">
      <div class="sp-head">Calendar</div>
      <div class="sp-grid">
        <label class="sp-field">View
          <select name="view">${['upcoming', 'past', 'all'].map((v) => opt(v, view, v[0].toUpperCase() + v.slice(1))).join('')}</select>
        </label>
        <label class="sp-field">Body
          <select name="body_id">${'<option value="">— All bodies —</option>' + allBodies.map((b) => opt(b.id, body_id, b.name)).join('')}</select>
        </label>
        <label class="sp-field">From<input type="date" name="from" value="${escapeText(from)}"></label>
        <label class="sp-field">To<input type="date" name="to" value="${escapeText(to)}"></label>
        <div class="sp-actions">
          <button type="submit">Apply</button>
          <a class="btn-link" href="/calendar">Clear</a>
        </div>
      </div>
    </form>`;

  const firstRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = (page - 1) * PAGE_SIZE + list.length;
  const pager = pages > 1 ? `<nav class="pager">
      ${page > 1 ? `<a class="btn-link" href="${urlWith({ page: page - 1 })}">‹ Prev</a>` : '<span class="pager-disabled">‹ Prev</span>'}
      <span class="pager-info">Page ${page} of ${pages}</span>
      ${page < pages ? `<a class="btn-link" href="${urlWith({ page: page + 1 })}">Next ›</a>` : '<span class="pager-disabled">Next ›</span>'}
    </nav>` : '';

  const body = html`
    ${raw(filterForm)}
    <div class="list-toolbar">
      <p class="muted result-count">${total ? `Showing ${firstRow}–${lastRow} of ${total}` : '0'} meeting${total === 1 ? '' : 's'}</p>
      <span class="export-links">
        <a class="btn-link" href="/calendar.ics">📅 Subscribe (iCal)</a>
        <a class="btn-link" href="/admin/meetings/new">+ Schedule meeting</a>
      </span>
    </div>
    ${raw(table)}
    ${raw(pager)}`;
  return layout({ title: 'Calendar', active: '/calendar', body });
}

// --- Meeting detail ----------------------------------------------------------
function meetingDetail(meeting) {
  const items = repo.meetings.items(meeting.id);

  // Columnar "meeting items" grid grouped by agenda section.
  let lastSection = null;
  const itemRows = items.map((it) => {
    let sectionRow = '';
    if (it.section && it.section !== lastSection) {
      lastSection = it.section;
      sectionRow = `<tr class="section-row"><td colspan="7">${escapeText(it.section)}</td></tr>`;
    }
    const mover = it.mover_id ? repo.people.get(it.mover_id) : null;
    const seconder = it.seconder_id ? repo.people.get(it.seconder_id) : null;
    const motionLine = (it.motion_text || mover || seconder)
      ? `<div class="sub">${it.motion_text ? escapeText(it.motion_text) + ' · ' : ''}${mover ? 'Moved by ' + escapeText(mover.full_name) : ''}${seconder ? ', seconded by ' + escapeText(seconder.full_name) : ''}</div>`
      : '';
    const fileCell = it.matter_id
      ? `<a href="/legislation/${encodeURIComponent(it.file_number)}">${escapeText(it.file_number)}</a>` : '';
    const typeCell = it.matter_id ? `<span class="badge type">${escapeText(it.matter_type)}</span>` : '';
    const titleCell = (it.matter_id ? escapeText(it.matter_title) : escapeText(it.title || '(item)')) + motionLine;
    const resultCell = it.result
      ? `<span class="badge st-${String(it.result).toLowerCase().replace(/[^a-z]+/g, '-')}">${escapeText(it.result)}</span>` : '';

    let voteCell = '<span class="doc-na">—</span>';
    const itemVotes = it.matter_id ? repo.votes.forItem(it.id) : [];
    if (itemVotes.length) {
      const t = repo.votes.tally(it.id);
      const list = itemVotes.map((v) => `<li><span class="vt vt-${String(v.vote).toLowerCase()}">${escapeText(v.vote)}</span> ${escapeText(v.full_name)}</li>`).join('');
      voteCell = `<details class="vote-details"><summary>${t.Yea}–${t.Nay}${t.Abstain ? ' · ' + t.Abstain + ' abs' : ''}</summary><ul class="vote-list">${list}</ul></details>`;
    }

    return sectionRow + `<tr>
      <td>${escapeText(it.agenda_number || '')}</td>
      <td>${fileCell}</td>
      <td>${typeCell}</td>
      <td class="title-cell">${titleCell}</td>
      <td>${it.action ? escapeText(it.action) : ''}</td>
      <td>${resultCell}</td>
      <td>${voteCell}</td>
    </tr>`;
  }).join('');

  const itemsGrid = items.length
    ? `<table class="data meeting-items"><thead><tr><th>Agenda #</th><th>File #</th><th>Type</th><th>Title</th><th>Action</th><th>Result</th><th>Vote</th></tr></thead><tbody>${itemRows}</tbody></table>`
    : emptyState('No agenda items posted.');

  const attendance = repo.meetings.attendance(meeting.id);
  const attendanceCard = attendance.length
    ? card('Roll call / attendance', `<ul class="plain att-list">${attendance.map((a) => html`
        <li><a href="/people/${a.person_id}">${a.full_name}</a> ${raw(`<span class="badge st-${String(a.status).toLowerCase() === 'present' ? 'passed' : (String(a.status).toLowerCase() === 'absent' ? 'failed' : 'on-agenda')}">${escapeText(a.status)}</span>`)}</li>`).join('')}</ul>`)
    : '';

  const docLinks = [
    `<a href="/meetings/${meeting.id}/packet">Agenda packet</a>`,
    meeting.agenda_url ? `<a href="${escapeText(meeting.agenda_url)}">Agenda</a>` : '',
    meeting.minutes_status === 'published' ? `<a href="/meetings/${meeting.id}/minutes">Minutes</a>` : '',
    meeting.video_url ? `<a href="${escapeText(meeting.video_url)}">Video</a>` : '',
  ].filter(Boolean).join(' · ');

  const body = html`
    <p class="crumbs"><a href="/calendar">Calendar</a> / Meeting</p>
    <div class="detail-head">
      <h1>${meeting.body_name}</h1>
      <span class="head-actions">
        <a class="btn" href="/live/${meeting.id}">● Live</a>
        <a class="btn" href="/meetings/${meeting.id}/packet">📄 Agenda packet</a>
        <a class="btn" href="/meetings/${meeting.id}/minutes">🧾 Minutes</a>
        <a class="btn" href="/admin/meetings/${meeting.id}/agenda">Manage agenda</a>
      </span>
    </div>
    ${raw(card('Meeting details', html`
      <dl class="meta record-header">
        <dt>Name</dt><dd>${meeting.body_name}</dd>
        <dt>Date</dt><dd>${raw(formatDate(meeting.meeting_date))}</dd>
        <dt>Time</dt><dd>${meeting.meeting_time || '—'}</dd>
        <dt>Location</dt><dd>${meeting.location || '—'}</dd>
        <dt>Status</dt><dd>${statusBadge(meeting.status)}</dd>
        <dt>Published minutes</dt><dd>${raw(meeting.minutes_status === 'published'
          ? `<a href="/meetings/${meeting.id}/minutes">View minutes</a>`
          : '<span class="muted">Not yet published</span>')}</dd>
        <dt>Documents</dt><dd class="chips">${raw(docLinks)}</dd>
      </dl>`))}
    ${raw(attendanceCard)}
    ${raw(card('Meeting items', itemsGrid))}
  `;
  return layout({ title: meeting.body_name + ' Meeting', active: '/calendar', body });
}

// --- Agenda packet (print / save-as-PDF) ------------------------------------
function agendaPacket(meeting) {
  const items = repo.meetings.items(meeting.id);

  let lastSection = null;
  const blocks = items.map((it) => {
    let sectionHeader = '';
    if (it.section && it.section !== lastSection) {
      lastSection = it.section;
      sectionHeader = `<h2 class="pk-section">${escapeText(it.section)}</h2>`;
    }

    let detail = '';
    if (it.matter_id) {
      const matter = repo.matters.get(it.matter_id);
      const sponsors = repo.matters.sponsors(it.matter_id);
      const attachments = repo.matters.attachments(it.matter_id);
      const itemVotes = repo.votes.forItem(it.id);
      const tally = repo.votes.tally(it.id);

      const sponsorLine = sponsors.length
        ? `<p class="pk-meta"><strong>Sponsors:</strong> ${escapeText(sponsors.map((s) => s.full_name).join(', '))}</p>`
        : '';
      const summary = matter && matter.summary
        ? `<p class="pk-summary">${escapeText(matter.summary)}</p>` : '';
      const actionLine = it.action
        ? `<p class="pk-meta"><strong>Action:</strong> ${escapeText(it.action)}${it.result ? ` — <strong>${escapeText(it.result)}</strong>` : ''}</p>`
        : '';
      const voteLine = itemVotes.length
        ? `<p class="pk-meta"><strong>Vote:</strong> Yea ${tally.Yea}, Nay ${tally.Nay}` +
          `${tally.Abstain ? `, Abstain ${tally.Abstain}` : ''}${tally.Absent ? `, Absent ${tally.Absent}` : ''}` +
          ` — ${itemVotes.map((v) => `${escapeText(v.full_name)} (${v.vote})`).join('; ')}</p>`
        : '';
      const attachLine = attachments.length
        ? `<p class="pk-meta"><strong>Attachments:</strong> ${attachments.map((a) => escapeText(a.name)).join(', ')}</p>`
        : '';
      detail = `<div class="pk-title"><span class="pk-file">${escapeText(it.file_number)}</span> ${escapeText(it.matter_title)}</div>`
        + summary + sponsorLine + actionLine + voteLine + attachLine;
    } else {
      detail = `<div class="pk-title">${escapeText(it.title || '')}</div>`;
    }

    return `${sectionHeader}
      <div class="pk-item">
        <span class="pk-num">${escapeText(it.agenda_number || '')}</span>
        <div class="pk-content">${detail}</div>
      </div>`;
  }).join('');

  const body = html`
    <div class="no-print packet-toolbar">
      <a class="btn-link" href="/meetings/${meeting.id}">← Back to meeting</a>
      <button class="btn primary" onclick="window.print()">🖨 Print / Save as PDF</button>
    </div>
    <article class="packet">
      <header class="pk-head">
        <h1>${meeting.body_name}</h1>
        <p class="pk-sub">Agenda Packet</p>
        <p class="pk-when">${raw(formatDateTime(meeting.meeting_date, meeting.meeting_time))}${meeting.location ? ' · ' + meeting.location : ''}</p>
      </header>
      ${raw(blocks || emptyState('No agenda items posted.'))}
      <footer class="pk-foot">Generated by Legislative Docket Manager</footer>
    </article>`;
  return layout({ title: 'Agenda Packet', active: '/calendar', body });
}

// --- People ------------------------------------------------------------------
function peopleList() {
  const list = repo.people.all();
  const cards = list.map((p) => html`
    <a class="person-card" href="/people/${p.id}">
      <span class="avatar">${initials(p.full_name)}</span>
      <span class="pc-body">
        <strong>${p.full_name}</strong>
        <span class="muted">${[p.title, p.district].filter(Boolean).join(' · ')}</span>
      </span>
    </a>`);
  const body = html`<div class="person-grid">${raw(cards.join(''))}</div>`;
  return layout({ title: ORG.membersLabel, active: '/people',
    subtitle: 'Elected officials and appointees of record.', body });
}

// A board member's office + staff roster (read for all; manage for clerks).
function officeSection(person, isClerk) {
  const staff = repo.people.officeStaff(person.id);
  const officeName = person.office_name || `Office of ${person.full_name}`;
  const staffList = staff.length
    ? `<ul class="plain office-staff">${staff.map((s) => html`<li><strong>${s.name}</strong>${s.title ? ' — ' + s.title : ''}${s.email ? raw(` · <a href="mailto:${escapeText(s.email)}">${escapeText(s.email)}</a>`) : ''}${s.phone ? ' · ' + s.phone : ''}</li>`).join('')}</ul>`
    : emptyState('No staff listed.');

  let manage = '';
  if (isClerk) {
    const rename = `
      <form class="form inline-form" method="post" action="/admin/people/${person.id}/office">
        <label>Office name<input type="text" name="office_name" value="${escapeText(person.office_name || '')}" placeholder="${escapeText('Office of ' + person.full_name)}"></label>
        <button type="submit" class="btn-link">Rename office</button>
      </form>`;
    const editRows = staff.map((s) => `
      <form class="form line-edit" method="post" action="/admin/office-staff/${s.id}">
        <input type="text" name="name" value="${escapeText(s.name)}" required aria-label="Name">
        <input type="text" name="title" value="${escapeText(s.title || '')}" placeholder="Title" aria-label="Title">
        <input type="email" name="email" value="${escapeText(s.email || '')}" placeholder="Email" aria-label="Email">
        <input type="text" name="phone" value="${escapeText(s.phone || '')}" placeholder="Phone" aria-label="Phone">
        <button type="submit" class="btn-link">Save</button>
        <button type="submit" formaction="/admin/office-staff/${s.id}/delete" class="btn-link danger" onclick="return confirm('Remove this staff member?')">Remove</button>
      </form>`).join('');
    const add = `
      <form class="form inline-form" method="post" action="/admin/people/${person.id}/staff">
        <div class="form-row">
          <label>Name<input type="text" name="name" required></label>
          <label>Title<input type="text" name="title" placeholder="Chief of Staff"></label>
        </div>
        <div class="form-row">
          <label>Email<input type="email" name="email"></label>
          <label>Phone<input type="text" name="phone"></label>
        </div>
        <button type="submit" class="btn">Add staff</button>
      </form>`;
    manage = `<div class="office-manage"><h3 class="wp-label">Manage office</h3>${rename}${editRows}${add}</div>`;
  }
  return card(officeName, staffList + manage);
}

function personDetail(person, user) {
  const memberships = repo.people.memberships(person.id);
  const sponsored = repo.people.sponsored(person.id);
  const voteRecord = repo.votes.byPerson(person.id);
  const voteSummary = repo.votes.personSummary(person.id);
  const officeCardHtml = officeSection(person, auth.hasRole(user, 'clerk'));

  const memRows = memberships.length
    ? `<ul class="plain">${memberships.map((m) => html`<li><a href="/bodies/${m.body_id}">${m.body_name}</a> — ${m.role}${m.voting ? '' : ' (non-voting)'}</li>`).join('')}</ul>`
    : emptyState('No current memberships.');

  const sponsoredRows = sponsored.length ? sponsored.map((m) => html`
    <tr>
      <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${m.file_number}</a></td>
      <td>${typeBadge(m.type)}</td>
      <td class="title-cell">${m.title}</td>
      <td>${statusBadge(m.status)}</td>
    </tr>`).join('') : null;

  const body = html`
    <p class="crumbs"><a href="/people">${ORG.membersLabel}</a> / ${person.full_name}</p>
    <div class="person-head">
      <span class="avatar lg">${initials(person.full_name)}</span>
      <div>
        <h1>${person.full_name}</h1>
        <p class="muted">${[person.title, person.district, person.party].filter(Boolean).join(' · ')}</p>
        <p class="contact">
          ${person.email ? raw(`<a href="mailto:${escapeText(person.email)}">${escapeText(person.email)}</a>`) : ''}
          ${person.phone ? raw(` · ${escapeText(person.phone)}`) : ''}
          ${person.website ? raw(` · <a href="${escapeText(person.website)}">website</a>`) : ''}
        </p>
      </div>
    </div>
    ${person.bio ? raw(card('Biography', `<p>${escapeText(person.bio)}</p>`)) : ''}
    ${raw(card('Memberships', memRows))}
    ${raw(officeCardHtml)}
    ${raw(card('Sponsored legislation',
      sponsoredRows
        ? `<table class="data"><thead><tr><th>File #</th><th>Type</th><th>Title</th><th>Status</th></tr></thead><tbody>${sponsoredRows}</tbody></table>`
        : emptyState('No sponsored legislation.')))}
    ${raw(card('Voting record', votingRecordHtml(voteRecord, voteSummary)))}
  `;
  return layout({ title: person.full_name, active: '/people', body });
}

// --- Bodies ------------------------------------------------------------------
function bodiesList() {
  const list = repo.bodies.all();
  const cards = list.map((b) => {
    const members = repo.bodies.members(b.id);
    return html`
      <a class="body-card" href="/bodies/${b.id}">
        <strong>${b.name}</strong>
        <span class="muted">${b.type || ''}</span>
        <p>${b.description || ''}</p>
        <span class="meta-line">${members.length} member${members.length === 1 ? '' : 's'}${b.meets ? ' · ' + b.meets : ''}</span>
      </a>`;
  });
  const body = html`<div class="body-grid">${raw(cards.join(''))}</div>`;
  return layout({ title: 'Bodies & Committees', active: '/bodies',
    subtitle: 'Legislative bodies, committees, and commissions.', body });
}

function bodyDetail(b) {
  const members = repo.bodies.members(b.id);
  const meetings = repo.bodies.upcomingMeetings(b.id, 12);

  const memberRows = members.length ? members.map((m) => html`
    <tr>
      <td><a href="/people/${m.person_id}">${m.full_name}</a></td>
      <td>${m.role}</td>
      <td>${m.district || ''}</td>
      <td>${m.voting ? 'Voting' : 'Non-voting'}</td>
    </tr>`).join('') : null;

  const meetingRows = meetings.length ? meetings.map((mt) => html`
    <tr>
      <td>${raw(formatDate(mt.meeting_date))}</td>
      <td><a href="/meetings/${mt.id}">${raw(formatDateTime('', mt.meeting_time) || 'Meeting')}</a></td>
      <td>${statusBadge(mt.status)}</td>
    </tr>`).join('') : null;

  const body = html`
    <p class="crumbs"><a href="/bodies">Bodies & Committees</a> / ${b.name}</p>
    <h1>${b.name}</h1>
    <p class="muted">${[b.type, b.meets].filter(Boolean).join(' · ')}</p>
    ${b.description ? raw(`<p>${escapeText(b.description)}</p>`) : ''}
    ${raw(card('Members',
      memberRows
        ? `<table class="data"><thead><tr><th>Name</th><th>Role</th><th>District</th><th>Voting</th></tr></thead><tbody>${memberRows}</tbody></table>`
        : emptyState('No members assigned.')))}
    ${raw(card('Meetings',
      meetingRows
        ? `<table class="data"><thead><tr><th>Date</th><th></th><th>Status</th></tr></thead><tbody>${meetingRows}</tbody></table>`
        : emptyState('No meetings on record.')))}
  `;
  return layout({ title: b.name, active: '/bodies', body });
}

// --- Topics / indexes --------------------------------------------------------
function topicsList() {
  const list = repo.topics.all();
  const cloud = list.length
    ? `<div class="topic-cloud">${list.map((t) => html`
        <a class="topic-tag" href="/legislation?topic=${t.id}">${t.name} <span class="topic-n">${t.n}</span></a>`).join('')}</div>`
    : emptyState('No index terms yet.');
  const body = html`${raw(card('Legislative index terms', cloud))}`;
  return layout({ title: 'Indexes', active: '/legislation',
    subtitle: 'Browse legislation by subject index term.', body });
}

// --- helpers -----------------------------------------------------------------
function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0].toUpperCase()).join('');
}

function votingRecordHtml(record, summary) {
  if (!record.length) return emptyState('No recorded votes.');
  const chips = ['Yea', 'Nay', 'Abstain', 'Recused', 'Absent']
    .filter((k) => summary[k])
    .map((k) => `<span class="v ${k === 'Yea' ? 'yea' : k === 'Nay' ? 'nay' : ''}">${k} ${summary[k]}</span>`)
    .join(' ');
  const rows = record.map((r) => html`
    <tr>
      <td>${raw(formatDate(r.meeting_date))}</td>
      <td>${r.body_name}</td>
      <td class="title-cell">${r.file_number
        ? raw(html`<a href="/legislation/${encodeURIComponent(r.file_number)}">${r.file_number}</a> — ${r.matter_title}`)
        : (r.item_action || '')}</td>
      <td>${raw(`<span class="vt vt-${r.vote.toLowerCase()}">${escapeText(r.vote)}</span>`)}</td>
      <td>${r.item_result ? statusBadge(r.item_result) : ''}</td>
    </tr>`).join('');
  return `<div class="vote-summary" style="margin:0 0 12px">${chips}</div>
    <table class="data"><thead><tr><th>Meeting</th><th>Body</th><th>Item</th><th>Vote</th><th>Outcome</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function notFound() {
  return layout({
    title: 'Not found', active: '',
    body: '<div class="hero"><h1>404</h1><p>The page you requested could not be found.</p><p><a class="btn" href="/">Back to dashboard</a></p></div>',
  });
}

module.exports = {
  dashboard, legislationList, matterDetail, calendar, meetingDetail, agendaPacket,
  peopleList, personDetail, bodiesList, bodyDetail, topicsList, notFound,
};
