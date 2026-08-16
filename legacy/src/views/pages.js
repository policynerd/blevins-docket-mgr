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
  const inSession = repo.meetings.inSession();
  const nextMeeting = repo.meetings.nextScheduled(today);

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

  const sessionBanner = inSession.length
    ? raw(`<div class="session-banner">
        ${inSession.map((m) => `<span class="session-live">● IN SESSION</span>
          <a class="session-link" href="/live/${m.id}">${escapeText(m.body_name)} is meeting now</a>
          <a class="btn session-btn" href="/live/${m.id}">Watch live →</a>`).join('')}
      </div>`)
    : '';

  const nextCard = nextMeeting
    ? raw(`<div class="next-meeting-strip">
        <span class="nm-label">Next meeting</span>
        <span class="nm-body"><a href="/meetings/${nextMeeting.id}">${escapeText(nextMeeting.body_name)}</a></span>
        <span class="nm-when">${escapeText(formatDate(nextMeeting.meeting_date))}${nextMeeting.meeting_time ? ' · ' + escapeText(nextMeeting.meeting_time) : ''}${nextMeeting.location ? ' · ' + escapeText(nextMeeting.location) : ''}</span>
        <a class="btn-link" href="/docket">Today's docket →</a>
      </div>`)
    : raw(`<div class="next-meeting-strip"><span class="nm-label">No upcoming meetings scheduled</span> <a class="btn-link" href="/docket">Today's docket →</a></div>`);

  const body = html`
    ${sessionBanner}
    ${nextCard}
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

function legislationList(query, user = null) {
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
          <input type="search" name="q" value="${q}" placeholder="e.g. zoning, 260603">
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
    ${user ? raw(`
    <form class="form inline-form save-search" method="post" action="/legislation/save-search">
      ${['q', 'type', 'status', 'body_id', 'sponsor_id', 'topic', 'from', 'to']
    .map((k) => `<input type="hidden" name="${k}" value="${escapeText(String((baseParams[k] ?? '')))}">`).join('')}
      <input type="text" name="name" required maxlength="80" placeholder="Name this search…">
      <button type="submit" class="btn">🔔 Save search &amp; alert me on new matches</button>
    </form>`) : ''}
    ${raw(table)}
    ${raw(pager)}`;
  return layout({ title: 'Legislation', active: '/legislation', body });
}

// --- Matter detail -----------------------------------------------------------
function matterDetail(matter, query = {}, user = null) {
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
        <li>${a.file_path
    ? raw(`<a href="/files/${a.id}">${escapeText(a.name)}</a>`)
    : (a.url ? raw(`<a href="${escapeText(a.url)}">${escapeText(a.name)}</a>`) : a.name)}
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
    ? raw(`<dt>Fiscal impact</dt><dd>${money(matter.fiscal_impact)}
        <span class="muted">(${matter.fiscal_recurring ? 'recurring annual' : 'one-time'})</span>${fiscalLine
        ? ` · <a href="/budget/lines/${fiscalLine.id}">${escapeText(fiscalLine.fiscal_year)} budget — ${escapeText((fiscalLine.category ? fiscalLine.category + ' / ' : '') + fiscalLine.name)}</a>` : ''}${
        matter.fiscal_note ? `<div class="sub">${escapeText(matter.fiscal_note)}</div>` : ''}</dd>`)
    : (matter.fiscal_note ? raw(`<dt>Fiscal note</dt><dd>${escapeText(matter.fiscal_note)}</dd>`) : '');

  const versions = repo.matters.versions(matter.id);
  const currentVersion = versions.length + 1;

  // Congress.gov-style progress tracker. Terminal negative statuses render
  // the pipeline inert with a red terminal chip instead of a current stage.
  const TRACK_STAGES = ['Draft', 'Introduced', 'In Committee', 'On Agenda', 'Passed', 'Enacted'];
  const FAILED_STATUSES = ['Failed', 'Vetoed', 'Withdrawn', 'Tabled'];
  const stageIdx = TRACK_STAGES.indexOf(matter.status);
  const failed = FAILED_STATUSES.includes(matter.status);
  const tracker = `<ol class="track${failed ? ' track-dead' : ''}">${TRACK_STAGES.map((s, i) => {
    const cls = failed ? 'todo' : (i < stageIdx ? 'done' : (i === stageIdx ? 'current' : 'todo'));
    return `<li class="tk-${cls}"><span class="tk-dot"></span><span class="tk-label">${escapeText(s)}</span></li>`;
  }).join('')}${failed ? `<li class="tk-failed"><span class="tk-dot"></span><span class="tk-label">${escapeText(matter.status)}</span></li>` : ''}</ol>`;

  const relations = repo.matters.relationsFor(matter.id);
  const relatedRow = relations.length
    ? raw(`<dt>Related files</dt><dd class="chips">${relations.map((r) => `
        <a href="/legislation/${encodeURIComponent(r.file_number)}">${escapeText(r.file_number)}</a>
        <span class="muted">(${escapeText(r.outgoing ? r.relation : reverseRelation(r.relation))})</span>`).join(' · ')}</dd>`)
    : '';

  const meta = html`
    <dl class="meta record-header">
      <dt>File #</dt><dd>${matter.file_number}</dd>
      <dt>Version</dt><dd>${currentVersion}</dd>
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
      ${relatedRow}
    </dl>`;

  // Version in effect on a given date: one more than the number of texts
  // already archived by then (versions are archived when the text changes).
  const versionAt = (date) => (date
    ? 1 + versions.filter((v) => v.created_at && v.created_at.slice(0, 10) <= date).length
    : currentVersion);

  // Tab panels (History default, mirroring the conventional record layout).
  const historyPanel = historyRows
    ? `<table class="data"><thead><tr><th>Date</th><th>Ver.</th><th>Action By</th><th>Action</th><th>Result</th><th></th></tr></thead><tbody>${
        history.map((h) => html`
          <tr>
            <td>${raw(formatDate(h.action_date))}</td>
            <td>${versionAt(h.action_date)}</td>
            <td>${h.body_name || ''}</td>
            <td>${h.action}${h.notes ? raw(`<div class="sub">${escapeText(h.notes)}</div>`) : ''}</td>
            <td>${h.result ? statusBadge(h.result) : ''}</td>
            <td>${h.meeting_id ? raw(`<a href="/meetings/${h.meeting_id}">meeting</a>`) : ''}</td>
          </tr>`).join('')}</tbody></table>`
    : emptyState('No recorded actions yet.');

  const amendsPolicy = matter.amends_policy_id ? repo.policies.get(matter.amends_policy_id) : null;
  const changesLink = amendsPolicy
    ? `<p><a class="btn" href="/legislation/${encodeURIComponent(matter.file_number)}/changes">📑 View as changes to
        ${escapeText(amendsPolicy.policy_number ? amendsPolicy.policy_number + ' — ' : '')}${escapeText(amendsPolicy.title)}</a></p>`
    : '';

  const versionList = versions.length
    ? `<h3 class="tab-h">Text versions</h3><ul class="version-list">
        <li><strong>Version ${currentVersion}</strong> <span class="badge st-active">current</span></li>
        ${versions.map((v) => html`<li>Version ${v.version} — archived ${raw(formatDate(v.created_at))}
          · <a href="/legislation/${encodeURIComponent(matter.file_number)}/v/${v.version}">view</a>
          · <a href="/legislation/${encodeURIComponent(matter.file_number)}/compare?from=${v.version}&amp;to=${currentVersion}">compare with current</a></li>`).join('')}
      </ul>`
    : '';

  const textPanel = (changesLink
    + (matter.summary ? `<h3 class="tab-h">Summary</h3><p>${escapeText(matter.summary)}</p>` : '')
    + (matter.body_html
      ? `<h3 class="tab-h">Legislation text</h3><div class="doc-body">${matter.body_html}</div>`
      : (matter.full_text ? `<h3 class="tab-h">Full text</h3><pre class="fulltext">${escapeText(matter.full_text)}</pre>` : ''))
    + versionList)
    || emptyState('No text on file.');

  // Official outputs. These generate on request from the file's own record, so
  // they are listed rather than stored — there is nothing to find until one is
  // asked for. Ordinance-only instruments are offered only for an Ordinance,
  // matching the routes, so the page never links to a 404.
  const isOrdinance = matter.type === 'Ordinance';
  // The meeting this file is actually set to be heard at — not whatever meets
  // next. The notice names it as the hearing, so it has to be one this file is
  // on; the global next meeting may belong to another body.
  const nextMeeting = repo.meetings.nextAppearance(matter.id, require('../util').todayISO());
  const docLink = (slug, label, note) => `<li class="off-doc">
      <a href="/legislation/${encodeURIComponent(matter.file_number)}/doc/${slug}">${escapeText(label)}</a>
      ${note ? `<span class="muted">${escapeText(note)}</span>` : ''}
    </li>`;
  const officialDocs = [
    docLink('details.pdf', 'Legislation details', 'The file at a glance, with every action taken on it'),
    docLink('board-letter.pdf', 'Board letter', 'The item as carried to the body'),
    isOrdinance ? docLink('ordinance.pdf', 'Ordinance (clean)', 'The instrument as it would read') : '',
    isOrdinance ? docLink('ordinance-redline.pdf', 'Ordinance (redline)', 'Changes to the Code, struck and underlined') : '',
    // The notice is only lawful against a meeting, so it is offered only when
    // there is one to name.
    isOrdinance && nextMeeting
      ? docLink(`summary.pdf?meeting=${nextMeeting.id}`, 'Summary for publication',
        `Legal notice for ${require('../util').formatDate(nextMeeting.meeting_date)}`) : '',
    docLink('approval-log.pdf', 'Approval log', 'Who cleared this file, and when'),
  ].filter(Boolean).join('');

  const docsPanel = `<h3 class="tab-h">Official documents</h3>`
    + `<ul class="official-docs">${officialDocs}</ul>`
    + `<h3 class="tab-h">Documents &amp; reports</h3>${reportList}`
    + `<h3 class="tab-h">Attachments</h3>${attachmentList}`;

  const appearancesPanel = appearanceRows
    ? `<table class="data"><thead><tr><th>Meeting date</th><th>Body</th><th>Action</th><th>Result</th></tr></thead><tbody>${appearanceRows}</tbody></table>`
    : emptyState('This file has not appeared on an agenda.');

  const wfSteps = repo.workflow.forMatter(matter.id);

  // Public comment (eComment): approved comments + submission form.
  const approvedComments = repo.comments.approvedForMatter(matter.id);
  const ctally = repo.comments.tally(matter.id);
  const positionBadge = (p) => (p ? `<span class="badge pos-${p.toLowerCase()}">${escapeText(p)}</span>` : '');
  const commentItems = approvedComments.length
    ? `<p class="muted">Positions: ${ctally.Support} support · ${ctally.Oppose} oppose · ${ctally.Neutral} neutral</p>
       <ul class="comment-list">${approvedComments.map((c) => html`
        <li><div class="comment-head"><strong>${c.name}</strong> ${raw(positionBadge(c.position))}
          <span class="muted">${raw(formatDate(c.created_at))}</span></div>
          <p class="comment-body">${c.body}</p></li>`).join('')}</ul>`
    : emptyState('No public comments yet.');
  const commentForm = html`
    <h3 class="tab-h">Submit a comment</h3>
    <form class="form" method="post" action="/legislation/${encodeURIComponent(matter.file_number)}/comments">
      <div class="form-row">
        <label>Name<input type="text" name="name" required maxlength="100"></label>
        <label>Email (not published)<input type="email" name="email" maxlength="200"></label>
        <label>Position
          <select name="position"><option value="">—</option>
            ${raw(repo.COMMENT_POSITIONS.map((p) => `<option>${p}</option>`).join(''))}
          </select>
        </label>
      </div>
      <input type="text" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
      <label>Comment<textarea name="body" rows="4" required maxlength="4000"></textarea></label>
      <button type="submit" class="btn primary">Submit comment</button>
      <p class="muted">Comments are reviewed by the ${ORG.clerkOffice} before publication and become part of the public record.</p>
    </form>`;
  const commentsPanel = commentItems + commentForm;

  const implUpdates = repo.implementation.forMatter(matter.id);
  const implPanel = implUpdates.length
    ? `${progressBar(implUpdates[0].progress)}<p class="muted">${implUpdates[0].progress}% complete</p>
       <ul class="version-list">${implUpdates.map((u) => html`
        <li><strong>${u.progress}%</strong> — ${u.note || 'progress update'}
          <span class="muted">· ${raw(formatDate(u.created_at))}</span></li>`).join('')}</ul>`
    : null;

  const tabbed = tabs([
    { id: 'history', label: 'History', count: history.length, html: historyPanel },
    { id: 'text', label: 'Text', html: textPanel },
    { id: 'docs', label: 'Reports & Attachments', count: reports.length + attachments.length, html: docsPanel },
    { id: 'workflow', label: 'Workflow', count: wfSteps.length || null, html: workflowStepper(wfSteps) },
    { id: 'agenda', label: 'Agenda appearances', count: appearances.length, html: appearancesPanel },
    { id: 'comments', label: 'Public comment', count: approvedComments.length || null, html: commentsPanel },
    ...(implPanel ? [{ id: 'impl', label: 'Implementation', count: implUpdates.length, html: implPanel }] : []),
  ]);

  // Codification refused some instructions while enacting this measure. The
  // status is already saved, so the Code is out of step until this is resolved.
  const codifyNotice = query.codify_failed
    ? raw(`<p class="form-error"><strong>Not fully codified.</strong> This measure is enacted, but
        ${escapeText(String(query.codify_failed))}. The Board Code does not yet reflect it —
        correct the instruction under <a href="/admin/legislation/${escapeText(matter.file_number)}/code">Amend the Code</a>,
        then re-save the status to apply it.</p>`)
    : '';

  const commentedNotice = query.commented === '1'
    ? raw('<p class="form-ok">Thank you — your comment has been received and will appear once reviewed by the Clerk’s office.</p>')
    : '';

  const body = html`
    <p class="crumbs"><a href="/legislation">Legislation</a> / ${matter.file_number}</p>
    ${codifyNotice}
    ${commentedNotice}
    ${raw(tracker)}
    <div class="detail-head">
      <h1>${matter.title}</h1>
      <span class="head-actions">
        ${user ? raw(`
        <form method="post" action="/legislation/${encodeURIComponent(matter.file_number)}/watch" class="inline">
          <button type="submit" class="btn">${repo.watches.isWatching(user.id, matter.id) ? '★ Watching' : '☆ Watch'}</button>
        </form>`) : ''}
        <a class="btn" href="/legislation/${encodeURIComponent(matter.file_number)}.rss" title="Activity feed">RSS</a>
        ${auth.hasRole(user, 'clerk') ? raw(`
        <a class="btn" href="/admin/matters/${matter.id}/edit">Manage</a>
        <a class="btn" href="/admin/legislation/${encodeURIComponent(matter.file_number)}/draft" title="Structured drafting, validation and the provision outline">Draft text</a>
        <a class="btn" href="/admin/legislation/${encodeURIComponent(matter.file_number)}/letter" title="Write the board letter as its standard sections">Board letter</a>
        <a class="btn" href="/admin/legislation/${encodeURIComponent(matter.file_number)}/compare" title="Compare versions, or this measure against current law">Comparative print</a>
        <form method="post" action="/admin/matters/${matter.id}/reports/draft" class="inline">
          <button type="submit" class="btn">+ Draft staff report</button>
        </form>`) : ''}
      </span>
    </div>
    ${raw(card('Record', meta))}
    ${raw(tabbed)}
    <script src="/assets/tabs.js" defer></script>
  `;
  return layout({ title: matter.file_number, active: '/legislation', body });
}

// Amendment comparison: inline redline between two text versions.
function matterComparePage(matter, query = {}) {
  const diff = require('../diff');
  const versions = repo.matters.versions(matter.id);
  const currentVersion = versions.length + 1;
  const textOf = (sel) => {
    if (String(sel) === String(currentVersion) || sel === 'current' || !sel) {
      return { n: currentVersion, label: `Version ${currentVersion} (current)`,
        text: matter.body_html ? diff.stripHtml(matter.body_html) : (matter.full_text || '') };
    }
    const v = repo.matters.getVersion(matter.id, Number(sel));
    if (!v) return null;
    return { n: v.version, label: `Version ${v.version} (archived ${formatDate(v.created_at)})`,
      text: v.body_html ? diff.stripHtml(v.body_html) : (v.full_text || '') };
  };
  const from = textOf(query.from || (versions.length ? versions[0].version : currentVersion)) || textOf('current');
  const to = textOf(query.to || 'current') || textOf('current');

  const st = diff.stats(from.text, to.text);
  const opts = (sel) => Array.from({ length: currentVersion }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === sel.n ? ' selected' : ''}>Version ${n}${n === currentVersion ? ' (current)' : ''}</option>`).join('');
  const picker = `
    <form class="form inline-form" method="get" action="/legislation/${encodeURIComponent(matter.file_number)}/compare">
      <div class="form-row">
        <label>From<select name="from">${opts(from)}</select></label>
        <label>To<select name="to">${opts(to)}</select></label>
        <button type="submit" class="btn">Compare</button>
      </div>
    </form>
    <p class="muted"><ins class="df-ins">Added</ins> and <del class="df-del">removed</del> text,
      comparing ${escapeText(from.label)} → ${escapeText(to.label)} ·
      <strong>${st.ins}</strong> word(s) added, <strong>${st.del}</strong> removed.</p>`;

  const body = html`
    <p class="crumbs"><a href="/legislation">Legislation</a> /
      <a href="/legislation/${encodeURIComponent(matter.file_number)}">${matter.file_number}</a> / Compare</p>
    <h1>${matter.title}</h1>
    ${raw(card('Compare versions', picker + `<div class="doc-body redline">${diff.diffHtml(from.text, to.text) || emptyState('Neither version has text.')}</div>`))}`;
  return layout({ title: `${matter.file_number} — compare`, active: '/legislation', body });
}

// Comparative print: the proposed text as a redline against the current
// policy it amends ("changes to existing law").
function matterChangesPage(matter, policy) {
  const diff = require('../diff');
  const current = diff.stripHtml(policy.body_html);
  const proposed = matter.body_html ? diff.stripHtml(matter.body_html) : (matter.full_text || '');
  const st = diff.stats(current, proposed);
  const body = html`
    <p class="crumbs"><a href="/legislation">Legislation</a> /
      <a href="/legislation/${encodeURIComponent(matter.file_number)}">${matter.file_number}</a> / Changes to existing policy</p>
    <h1>${matter.title}</h1>
    <p class="muted">Showing ${matter.file_number} as changes to
      <a href="/policies/${policy.id}">${policy.policy_number ? policy.policy_number + ' — ' : ''}${policy.title}</a>:
      <ins class="df-ins">added</ins> and <del class="df-del">removed</del> text ·
      <strong>${st.ins}</strong> word(s) added, <strong>${st.del}</strong> removed.</p>
    ${raw(card('Comparative print', `<div class="doc-body redline">${diff.diffHtml(current, proposed) || emptyState('No text to compare.')}</div>`))}`;
  return layout({ title: `${matter.file_number} — changes`, active: '/legislation', body });
}

// Archived text version of a matter (public record, like the current text).
function matterVersionPage(matter, ver) {
  const currentVersion = repo.matters.versions(matter.id).length + 1;
  const text = ver.body_html
    ? `<div class="doc-body">${ver.body_html}</div>`
    : (ver.full_text ? `<pre class="fulltext">${escapeText(ver.full_text)}</pre>` : emptyState('This version had no text.'));
  const body = html`
    <p class="crumbs"><a href="/legislation">Legislation</a> /
      <a href="/legislation/${encodeURIComponent(matter.file_number)}">${matter.file_number}</a> / Version ${ver.version}</p>
    <h1>${matter.title}</h1>
    <div class="form-warn">You are viewing <strong>archived version ${ver.version}</strong> of ${matter.file_number}
      (archived ${raw(formatDate(ver.created_at))}). The current text is
      <a href="/legislation/${encodeURIComponent(matter.file_number)}">version ${currentVersion}</a>.</div>
    ${raw(card(`Text — version ${ver.version}`, text))}`;
  return layout({ title: `${matter.file_number} v${ver.version}`, active: '/legislation', body });
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
// Accountability: implementation progress on enacted/passed legislation.
function progressBar(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<div class="budget-bar impl-bar"><span style="width:${p}%"></span></div>`;
}

function accountabilityPage() {
  const rows = repo.implementation.overview();
  const table = rows.length
    ? `<table class="data"><thead><tr><th>File #</th><th>Title</th><th>Status</th><th>Final action</th>
        <th>Implementation</th><th>Latest update</th></tr></thead>
       <tbody>${rows.map((m) => html`
        <tr>
          <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${m.file_number}</a></td>
          <td class="title-cell">${m.title}</td>
          <td>${statusBadge(m.status)}</td>
          <td>${raw(formatDate(m.final_date))}</td>
          <td class="bar-col">${m.progress != null
    ? raw(`${progressBar(m.progress)} <span class="muted">${m.progress}%</span>`)
    : raw('<span class="muted">not started</span>')}</td>
          <td>${m.last_note ? raw(`${escapeText(m.last_note)} <span class="muted">· ${escapeText(formatDate(m.last_update))}</span>`) : ''}</td>
        </tr>`).join('')}</tbody></table>`
    : emptyState('No enacted legislation to track yet.');
  const body = html`
    <h1>Accountability</h1>
    <p class="muted">What happened after adoption: implementation progress for enacted and passed legislation,
      updated by the ${ORG.clerkOffice}.</p>
    ${raw(card('Implementation tracker', table))}`;
  return layout({ title: 'Accountability', active: '/accountability',
    subtitle: 'Following legislation through to delivery.', body });
}

// Reading a relation from the other end: "A supersedes B" reads on B's page
// as "superseded by"; symmetric labels pass through.
function reverseRelation(rel) {
  return ({ Amends: 'Amended by', Supersedes: 'Superseded by' })[rel] || rel;
}

// Deep link into a meeting recording at a timestamp ("h:mm:ss" or seconds).
function videoHref(url, ts) {
  if (!url || !ts) return null;
  let secs = 0;
  for (const p of String(ts).split(':')) secs = secs * 60 + (Number(p) || 0);
  if (/youtube\.com|youtu\.be/.test(url)) {
    return url + (url.includes('?') ? '&' : '?') + 't=' + secs + 's';
  }
  return url + '#t=' + secs;
}

function meetingDetail(meeting, query = {}) {
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
      ? `<a href="/legislation/${encodeURIComponent(it.file_number)}">${escapeText(it.file_number)}</a><div class="sub">${escapeText(it.matter_type)}</div>`
      : '';
    const typeCell = it.item_type
      ? `<span class="item-type it-${String(it.item_type).toLowerCase()}">${escapeText(it.item_type)}</span>`
      : '';
    const vhref = videoHref(meeting.video_url, it.video_ts);
    const videoLine = vhref
      ? `<div class="sub"><a href="${escapeText(vhref)}" target="_blank" rel="noopener">▶ Watch this item (${escapeText(it.video_ts)})</a></div>`
      : '';
    const titleCell = (it.matter_id ? escapeText(it.matter_title) : escapeText(it.title || '(item)'))
      + motionLine + videoLine;
    const resultCell = it.result
      ? `<span class="badge st-${String(it.result).toLowerCase().replace(/[^a-z]+/g, '-')}">${escapeText(it.result)}</span>` : '';

    let voteCell = '';
    const itemVotes = it.requires_vote ? repo.votes.forItem(it.id) : [];
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
    ${raw(speakCard(meeting, items, query))}
  `;
  return layout({ title: meeting.body_name + ' Meeting', active: '/calendar', body });
}

// Public request-to-speak sign-up, shown while a meeting still accepts
// speakers (not concluded/cancelled; In Progress allowed for same-day
// sign-ups while the meeting is live). Keep in sync with acceptsSpeakers.
function speakCard(meeting, items, query = {}) {
  if (!acceptsSpeakers(meeting)) return '';
  if (query.speak === '1') {
    return card('Request to speak',
      '<p class="form-ok">Thank you — your request has been received. The Clerk’s office will confirm your spot before the meeting.</p>');
  }
  const itemOptions = ['<option value="">General public comment</option>']
    .concat(items.map((it) => {
      const label = `${it.agenda_number ? it.agenda_number + '. ' : ''}${it.matter_id ? it.matter_title : (it.title || '(item)')}`;
      return `<option value="${it.id}">${escapeText(label.slice(0, 90))}</option>`;
    })).join('');
  const form = `
    <p class="muted">Sign up to address the body at this meeting. Requests are reviewed by the Clerk's office;
      your name is called during the item you select.</p>
    <form class="form" method="post" action="/meetings/${meeting.id}/speak">
      <div class="form-row">
        <label>Name<input type="text" name="name" required maxlength="100"></label>
        <label>Email (for confirmation)<input type="email" name="email" maxlength="200"></label>
      </div>
      <div class="form-row">
        <label>Agenda item<select name="agenda_item_id">${itemOptions}</select></label>
        <label>Position<select name="position"><option value="">—</option>
          ${repo.COMMENT_POSITIONS.map((p) => `<option>${p}</option>`).join('')}</select></label>
      </div>
      <input type="text" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit" class="btn primary">Request to speak</button>
    </form>`;
  return card('Request to speak', form);
}

function acceptsSpeakers(meeting) {
  return meeting.meeting_date >= todayISO()
    && !['Cancelled', 'Final', 'Adjourned'].includes(meeting.status);
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
          `${tally.Present ? `, Present ${tally.Present}` : ''}${tally.Abstain ? `, Abstain ${tally.Abstain}` : ''}${tally.Absent ? `, Absent ${tally.Absent}` : ''}` +
          ` — ${itemVotes.map((v) => `${escapeText(v.full_name)} (${v.vote})`).join('; ')}</p>`
        : '';
      const attachLine = attachments.length
        ? `<p class="pk-meta"><strong>Attachments:</strong></p><ul class="pk-attachments">${attachments.map((a) => {
    const href = a.file_path ? `/files/${a.id}` : a.url;
    return `<li>${href
      ? `<a href="${escapeText(href)}" target="_blank" rel="noopener">${escapeText(a.name)}</a>`
      : escapeText(a.name)}${a.note ? ` <span class="muted">— ${escapeText(a.note)}</span>` : ''}</li>`;
  }).join('')}</ul>`
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
      <a class="btn" href="/meetings/${meeting.id}/packet.pdf">⬇ Download PDF with attachments</a>
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
  const isClerk = auth.hasRole(user, 'clerk');

  const sponsoredRows = sponsored.length ? sponsored.map((m) => html`
    <tr>
      <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${m.file_number}</a></td>
      <td>${typeBadge(m.type)}</td>
      <td class="title-cell">${m.title}</td>
      <td>${statusBadge(m.status)}</td>
      <td>${raw(formatDate(m.intro_date))}</td>
    </tr>`).join('') : null;

  const sponsoredPanel = sponsoredRows
    ? `<table class="data"><thead><tr><th>File #</th><th>Type</th><th>Title</th><th>Status</th><th>Introduced</th></tr></thead><tbody>${sponsoredRows}</tbody></table>`
    : emptyState('No sponsored legislation.');

  const memPanel = memberships.length
    ? `<table class="data"><thead><tr><th>Body</th><th>Role</th><th>Voting</th></tr></thead><tbody>${
        memberships.map((m) => html`
          <tr>
            <td><a href="/bodies/${m.body_id}">${m.body_name}</a></td>
            <td>${m.role}</td>
            <td>${m.voting ? 'Voting' : 'Non-voting'}</td>
          </tr>`).join('')}</tbody></table>`
    : emptyState('No current memberships.');

  const bioPanel = person.bio
    ? `<p>${escapeText(person.bio)}</p>`
    : emptyState('No biography on file.');

  const officePanel = officeSection(person, isClerk);

  const tabItems = [
    { id: 'sponsored', label: 'Sponsored', count: sponsored.length, html: sponsoredPanel },
    { id: 'voting', label: 'Voting record', count: voteRecord.length, html: votingRecordHtml(voteRecord, voteSummary) },
    { id: 'memberships', label: 'Memberships', count: memberships.length, html: memPanel },
    { id: 'bio', label: 'Biography', html: bioPanel },
    { id: 'office', label: 'Office & Staff', html: officePanel },
  ];

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
        ${isClerk ? raw(`<p><a class="btn-link" href="/admin/people/${person.id}/edit">✎ Edit profile</a></p>`) : ''}
      </div>
    </div>
    ${raw(tabs(tabItems))}
    <script src="/assets/tabs.js" defer></script>
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

function bodyDetail(b, query = {}) {
  const members = repo.bodies.members(b.id);
  const meetings = repo.bodies.upcomingMeetings(b.id, 24);
  const legislation = repo.bodies.legislation(b.id);

  const memberRows = members.length ? members.map((m) => html`
    <tr>
      <td><a href="/people/${m.person_id}">${m.full_name}</a></td>
      <td>${m.role}</td>
      <td>${m.district || ''}</td>
      <td>${m.voting ? 'Voting' : 'Non-voting'}</td>
    </tr>`).join('') : null;

  const membersPanel = memberRows
    ? `<table class="data"><thead><tr><th>Name</th><th>Role</th><th>District</th><th>Voting</th></tr></thead><tbody>${memberRows}</tbody></table>`
    : emptyState('No members assigned.');

  const docCell = (url, label) => url
    ? `<a class="doc-link" href="${escapeText(url)}">${label}</a>`
    : '<span class="doc-na">—</span>';

  const meetingRows = meetings.length ? meetings.map((mt) => html`
    <tr>
      <td>${raw(formatDate(mt.meeting_date))}</td>
      <td>${mt.meeting_time || ''}</td>
      <td>${statusBadge(mt.status)}</td>
      <td class="icon-col"><a href="/meetings/${mt.id}">Details</a></td>
      <td class="icon-col">${raw(docCell(mt.agenda_url, 'Agenda'))}</td>
      <td class="icon-col">${raw(`<a class="doc-link" href="/meetings/${mt.id}/packet">Packet</a>`)}</td>
      <td class="icon-col">${raw(mt.minutes_status === 'published'
        ? `<a class="doc-link" href="/meetings/${mt.id}/minutes">Minutes</a>`
        : docCell(mt.minutes_url, 'Minutes'))}</td>
    </tr>`).join('') : null;

  const meetingsPanel = meetingRows
    ? `<table class="data"><thead><tr><th>Date</th><th>Time</th><th>Status</th><th>Details</th><th>Agenda</th><th>Packet</th><th>Minutes</th></tr></thead><tbody>${meetingRows}</tbody></table>`
    : emptyState('No meetings on record.');

  const legRows = legislation.length ? legislation.map((m) => html`
    <tr>
      <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${m.file_number}</a></td>
      <td>${typeBadge(m.type)}</td>
      <td class="title-cell">${m.title}</td>
      <td>${statusBadge(m.status)}</td>
      <td>${raw(formatDate(m.intro_date))}</td>
    </tr>`).join('') : null;

  const legPanel = legRows
    ? `<table class="data"><thead><tr><th>File #</th><th>Type</th><th>Title</th><th>Status</th><th>Introduced</th></tr></thead><tbody>${legRows}</tbody></table>`
    : emptyState('No legislation in control of this body.');

  const applyPanel = query.applied === '1'
    ? '<p class="form-ok">Thank you — your application has been received. The Clerk’s office reviews applications and will contact you.</p>'
    : `
    <p class="muted">Interested in serving on the ${escapeText(b.name)}? Submit an application —
      the ${escapeText(ORG.clerkOffice)} reviews it, and approved applicants are nominated through
      the membership process.</p>
    <form class="form" method="post" action="/bodies/${b.id}/apply">
      <div class="form-row">
        <label>Name<input type="text" name="name" required maxlength="100"></label>
        <label>Email<input type="email" name="email" maxlength="200"></label>
        <label>Phone<input type="text" name="phone" maxlength="40"></label>
      </div>
      <input type="text" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
      <label>Why do you want to serve? (qualifications, interest)
        <textarea name="statement" rows="4" maxlength="4000"></textarea></label>
      <button type="submit" class="btn primary">Submit application</button>
    </form>`;

  const tabbed = tabs([
    { id: 'members', label: 'Members', count: members.length, html: membersPanel },
    { id: 'meetings', label: 'Meetings', count: meetings.length, html: meetingsPanel },
    { id: 'legislation', label: 'Legislation', count: legislation.length, html: legPanel },
    { id: 'apply', label: 'Apply to serve', html: applyPanel },
  ]);

  const meta = html`
    <dl class="meta record-header">
      <dt>Name</dt><dd>${b.name}</dd>
      <dt>Type</dt><dd>${b.type || '—'}</dd>
      <dt>Meeting schedule</dt><dd>${b.meets || '—'}</dd>
      <dt>Location</dt><dd>${b.meeting_location || '—'}</dd>
      <dt>Members</dt><dd>${members.length}${b.seats != null ? ` of ${b.seats} authorized seats` : ''} (${members.filter((m) => m.voting).length} voting)${b.seats != null && b.seats > members.length ? raw(` · <span class="badge st-failed">${b.seats - members.length} vacant</span>`) : ''}</dd>
      <dt>Status</dt><dd>${b.active ? 'Active' : 'Inactive'}</dd>
    </dl>`;

  const body = html`
    <p class="crumbs"><a href="/bodies">Bodies & Committees</a> / ${b.name}</p>
    <div class="detail-head">
      <h1>${b.name}</h1>
    </div>
    ${b.description ? raw(`<p class="body-desc">${escapeText(b.description)}</p>`) : ''}
    ${raw(card('Body details', meta))}
    ${raw(tabbed)}
    <script src="/assets/tabs.js" defer></script>
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

// --- Daily docket ------------------------------------------------------------
function docket() {
  const today = todayISO();
  const meetings = repo.meetings.todayDocket(today);
  const upcoming = repo.meetings.nextScheduled(today);

  const meetingBlocks = meetings.map((mt) => {
    const items = repo.meetings.items(mt.id);
    let lastSection = null;
    const rows = items.map((it) => {
      let sectionRow = '';
      if (it.section && it.section !== lastSection) {
        lastSection = it.section;
        sectionRow = `<tr class="section-row"><td colspan="5">${escapeText(it.section)}</td></tr>`;
      }
      const fileCell = it.matter_id
        ? `<a href="/legislation/${encodeURIComponent(it.file_number)}">${escapeText(it.file_number)}</a>` : '';
      const typeCell = it.matter_id ? `<span class="badge type">${escapeText(it.matter_type)}</span>` : '';
      const titleCell = it.matter_id ? escapeText(it.matter_title) : escapeText(it.title || '');
      const resultCell = it.result
        ? `<span class="badge st-${String(it.result).toLowerCase().replace(/[^a-z]+/g, '-')}">${escapeText(it.result)}</span>` : '';
      return sectionRow + `<tr>
        <td>${escapeText(it.agenda_number || '')}</td>
        <td>${fileCell}</td>
        <td>${typeCell}</td>
        <td class="title-cell">${titleCell}</td>
        <td>${resultCell}</td>
      </tr>`;
    }).join('');

    const grid = items.length
      ? `<table class="data meeting-items"><thead><tr><th>#</th><th>File #</th><th>Type</th><th>Title</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`
      : emptyState('No agenda items posted.');

    const stCls = 'st-' + String(mt.status || '').toLowerCase().replace(/[^a-z]+/g, '-');
    return card(
      `${escapeText(mt.body_name)} — ${formatDateTime(mt.meeting_date, mt.meeting_time)}${mt.location ? ' · ' + escapeText(mt.location) : ''}`,
      `<span class="badge ${stCls}">${escapeText(mt.status)}</span> <a class="btn-link" href="/meetings/${mt.id}/packet" style="margin-left:8px">Agenda packet</a>${grid}`
    );
  });

  const noMeetings = meetings.length === 0
    ? emptyState(`No meetings scheduled for today (${formatDate(today)}).`)
    : '';

  const upcomingNote = upcoming && meetings.length === 0
    ? raw(`<p class="muted">Next scheduled meeting: <a href="/meetings/${upcoming.id}">${escapeText(upcoming.body_name)}</a> on ${formatDate(upcoming.meeting_date)}${upcoming.meeting_time ? ' at ' + escapeText(upcoming.meeting_time) : ''}.</p>`)
    : '';

  const body = html`
    <div class="detail-head">
      <h1>Daily Docket</h1>
      <span class="head-actions"><a class="btn-link" href="/calendar">Full calendar →</a></span>
    </div>
    <p class="muted">${raw(formatDate(today))}</p>
    ${raw(noMeetings)}
    ${upcomingNote}
    ${raw(meetingBlocks.join(''))}
  `;
  return layout({ title: "Today's Docket", active: '/docket', body });
}

// --- helpers -----------------------------------------------------------------
function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0].toUpperCase()).join('');
}

function votingRecordHtml(record, summary) {
  if (!record.length) return emptyState('No recorded votes.');
  // Absent is still listed: it cannot be cast any more, but it was, and a
  // member's record has to show the votes as they were recorded.
  const chips = ['Yea', 'Nay', 'Present', 'Abstain', 'Recused', 'Absent']
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
  dashboard, legislationList, matterDetail, matterVersionPage, matterComparePage, matterChangesPage,
  calendar, meetingDetail, agendaPacket, accountabilityPage,
  peopleList, personDetail, bodiesList, bodyDetail, topicsList, docket, notFound, acceptsSpeakers,
};
