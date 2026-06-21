'use strict';

const { html, raw, formatDate, formatDateTime, todayISO } = require('../util');
const { layout, card, statusBadge, typeBadge, emptyState, escapeText } = require('./layout');
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
function legislationList(query) {
  const { q = '', type = '', status = '', body_id = '', sponsor_id = '' } = query;
  const rows = repo.matters.search({
    q, type, status,
    bodyId: body_id ? Number(body_id) : undefined,
    sponsorId: sponsor_id ? Number(sponsor_id) : undefined,
  });
  const allBodies = repo.bodies.all();
  const allPeople = repo.people.all();

  const opt = (value, current, label) =>
    `<option value="${escapeText(value)}"${String(value) === String(current) ? ' selected' : ''}>${escapeText(label)}</option>`;

  const filters = html`
    <form class="filters" method="get" action="/legislation">
      <input type="search" name="q" value="${q}" placeholder="Search title, file #, summary…">
      <select name="type">${raw('<option value="">All types</option>' + repo.MATTER_TYPES.map((t) => opt(t, type, t)).join(''))}</select>
      <select name="status">${raw('<option value="">All statuses</option>' + repo.MATTER_STATUSES.map((s) => opt(s, status, s)).join(''))}</select>
      <select name="body_id">${raw('<option value="">All bodies</option>' + allBodies.map((b) => opt(b.id, body_id, b.name)).join(''))}</select>
      <select name="sponsor_id">${raw('<option value="">Any sponsor</option>' + allPeople.map((p) => opt(p.id, sponsor_id, p.full_name)).join(''))}</select>
      <button type="submit">Filter</button>
      <a class="btn-link" href="/legislation">Reset</a>
    </form>`;

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
    ? `<table class="data"><thead><tr><th>File #</th><th>Type</th><th>Title / Sponsors</th><th>In control</th><th>Introduced</th><th>Status</th></tr></thead><tbody>${tableRows}</tbody></table>`
    : emptyState('No legislative files match your search.');

  const body = html`
    ${raw(filters)}
    <p class="muted result-count">${rows.length} legislative file${rows.length === 1 ? '' : 's'}</p>
    ${raw(table)}`;
  return layout({ title: 'Legislation', active: '/legislation', body });
}

// --- Matter detail -----------------------------------------------------------
function matterDetail(matter) {
  const sponsors = repo.matters.sponsors(matter.id);
  const history = repo.matters.history(matter.id);
  const attachments = repo.matters.attachments(matter.id);
  const appearances = repo.matters.appearsOn(matter.id);

  const sponsorHtml = sponsors.length
    ? sponsors.map((p) => html`<a class="chip" href="/people/${p.id}">${p.full_name}${p.sponsor_type === 'Primary' ? raw(' <em>(primary)</em>') : ''}</a>`)
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

  const meta = html`
    <dl class="meta">
      <dt>File #</dt><dd>${matter.file_number}</dd>
      <dt>Type</dt><dd>${typeBadge(matter.type)}</dd>
      <dt>Status</dt><dd>${statusBadge(matter.status)}</dd>
      <dt>In control</dt><dd>${matter.body_name || '—'}</dd>
      <dt>Introduced</dt><dd>${raw(formatDate(matter.intro_date)) || '—'}</dd>
      ${matter.final_date ? html`<dt>Final action</dt><dd>${raw(formatDate(matter.final_date))}</dd>` : ''}
      <dt>Sponsors</dt><dd class="chips">${sponsorHtml}</dd>
    </dl>`;

  const body = html`
    <p class="crumbs"><a href="/legislation">Legislation</a> / ${matter.file_number}</p>
    <div class="detail-head">
      <h1>${matter.title}</h1>
      <a class="btn" href="/admin/matters/${matter.id}/edit">Manage</a>
    </div>
    ${raw(card('Overview', meta))}
    ${matter.summary ? raw(card('Summary', `<p>${escapeText(matter.summary)}</p>`)) : ''}
    ${matter.full_text ? raw(card('Full text', `<pre class="fulltext">${escapeText(matter.full_text)}</pre>`)) : ''}
    ${raw(card('Legislative history',
      historyRows
        ? `<table class="data"><thead><tr><th>Date</th><th>Body</th><th>Action</th><th>Result</th><th></th></tr></thead><tbody>${historyRows}</tbody></table>`
        : emptyState('No recorded actions yet.')))}
    ${raw(card('Attachments', attachmentList))}
    ${appearanceRows ? raw(card('Agenda appearances',
      `<table class="data"><thead><tr><th>Meeting date</th><th>Body</th><th>Action</th><th>Result</th></tr></thead><tbody>${appearanceRows}</tbody></table>`)) : ''}
  `;
  return layout({ title: matter.file_number, active: '/legislation', body });
}

// --- Calendar ----------------------------------------------------------------
function calendar() {
  const today = todayISO();
  const upcoming = repo.meetings.upcoming(today, 50);
  const past = repo.meetings.past(today, 50);

  const row = (m) => html`
    <tr>
      <td>${raw(formatDateTime(m.meeting_date, m.meeting_time))}</td>
      <td><a href="/meetings/${m.id}">${m.body_name}</a></td>
      <td>${m.location || ''}</td>
      <td>${statusBadge(m.status)}</td>
    </tr>`;

  const tbl = (list, empty) => list.length
    ? `<table class="data"><thead><tr><th>When</th><th>Body</th><th>Location</th><th>Status</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table>`
    : emptyState(empty);

  const body = html`
    ${raw(card('Upcoming meetings', tbl(upcoming, 'No upcoming meetings.'),
      { actions: '<a class="btn-link" href="/admin/meetings/new">+ Schedule meeting</a>' }))}
    ${raw(card('Past meetings', tbl(past, 'No past meetings on record.')))}
  `;
  return layout({ title: 'Calendar', active: '/calendar', body });
}

// --- Meeting detail ----------------------------------------------------------
function meetingDetail(meeting) {
  const items = repo.meetings.items(meeting.id);

  const itemBlocks = items.length ? items.map((it) => {
    const tally = it.id ? repo.votes.tally(it.id) : null;
    const itemVotes = it.matter_id ? repo.votes.forItem(it.id) : [];
    const voteSummary = (itemVotes.length)
      ? `<div class="vote-summary">
          <span class="v yea">Yea ${tally.Yea}</span>
          <span class="v nay">Nay ${tally.Nay}</span>
          ${tally.Abstain ? `<span class="v">Abstain ${tally.Abstain}</span>` : ''}
          ${tally.Recused ? `<span class="v">Recused ${tally.Recused}</span>` : ''}
          ${tally.Absent ? `<span class="v">Absent ${tally.Absent}</span>` : ''}
        </div>
        <ul class="vote-list">${itemVotes.map((v) => html`<li><span class="vt vt-${v.vote.toLowerCase()}">${v.vote}</span> ${v.full_name}</li>`).join('')}</ul>`
      : '';
    const titleLine = it.matter_id
      ? html`<a href="/legislation/${encodeURIComponent(it.file_number)}">${it.file_number}</a> — ${it.matter_title}`
      : html`${it.title || '(item)'}`;
    return html`
      <li class="agenda-item">
        <div class="ai-head">
          <span class="ai-num">${it.agenda_number || ''}</span>
          <div class="ai-body">
            <div class="ai-title">${titleLine}</div>
            ${it.section ? raw(`<div class="sub">${escapeText(it.section)}</div>`) : ''}
            ${it.action ? raw(`<div class="ai-action">${escapeText(it.action)} ${it.result ? `— <strong>${escapeText(it.result)}</strong>` : ''}</div>`) : ''}
          </div>
        </div>
        ${raw(voteSummary)}
      </li>`;
  }).join('') : emptyState('No agenda items posted.');

  const links = [
    meeting.agenda_url ? `<a href="${escapeText(meeting.agenda_url)}">Agenda packet</a>` : '',
    meeting.minutes_url ? `<a href="${escapeText(meeting.minutes_url)}">Minutes</a>` : '',
    meeting.video_url ? `<a href="${escapeText(meeting.video_url)}">Video</a>` : '',
  ].filter(Boolean).join(' · ');

  const body = html`
    <p class="crumbs"><a href="/calendar">Calendar</a> / Meeting</p>
    <div class="detail-head">
      <h1>${meeting.body_name}</h1>
      <a class="btn" href="/admin/meetings/${meeting.id}/agenda">Manage agenda</a>
    </div>
    ${raw(card('Meeting details', html`
      <dl class="meta">
        <dt>Date</dt><dd>${raw(formatDateTime(meeting.meeting_date, meeting.meeting_time))}</dd>
        <dt>Location</dt><dd>${meeting.location || '—'}</dd>
        <dt>Status</dt><dd>${statusBadge(meeting.status)}</dd>
        ${links ? html`<dt>Documents</dt><dd class="chips">${raw(links)}</dd>` : ''}
      </dl>`))}
    ${raw(card('Agenda', `<ol class="agenda">${itemBlocks}</ol>`))}
  `;
  return layout({ title: meeting.body_name + ' Meeting', active: '/calendar', body });
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
  return layout({ title: 'Council Members', active: '/people',
    subtitle: 'Elected officials and appointees of record.', body });
}

function personDetail(person) {
  const memberships = repo.people.memberships(person.id);
  const sponsored = repo.people.sponsored(person.id);

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
    <p class="crumbs"><a href="/people">Council Members</a> / ${person.full_name}</p>
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
    ${raw(card('Sponsored legislation',
      sponsoredRows
        ? `<table class="data"><thead><tr><th>File #</th><th>Type</th><th>Title</th><th>Status</th></tr></thead><tbody>${sponsoredRows}</tbody></table>`
        : emptyState('No sponsored legislation.')))}
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

// --- helpers -----------------------------------------------------------------
function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0].toUpperCase()).join('');
}

function notFound() {
  return layout({
    title: 'Not found', active: '',
    body: '<div class="hero"><h1>404</h1><p>The page you requested could not be found.</p><p><a class="btn" href="/">Back to dashboard</a></p></div>',
  });
}

module.exports = {
  dashboard, legislationList, matterDetail, calendar, meetingDetail,
  peopleList, personDetail, bodiesList, bodyDetail, notFound,
};
