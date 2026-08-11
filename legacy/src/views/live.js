'use strict';

const { html, raw, formatDateTime } = require('../util');
const { layout, statusBadge } = require('./layout');
const repo = require('../repo');

// One live page template, parameterized by capability. The client (live.js)
// hydrates and updates everything over SSE.
function livePage(meeting, { role, personId, control }) {
  const personAttr = personId ? ` data-person="${personId}"` : '';
  const body = html`
    <p class="crumbs"><a href="/calendar">Calendar</a> / <a href="/meetings/${meeting.id}">Meeting</a> / Live</p>
    <div class="detail-head">
      <h1>Live — ${meeting.body_name}</h1>
      <span class="live-pill" data-live-pill>● LIVE</span>
    </div>
    <p class="muted">${raw(formatDateTime(meeting.meeting_date, meeting.meeting_time))} · ${meeting.location || ''}</p>

    <div class="live" data-meeting="${meeting.id}" data-role="${role}" data-control="${control ? '1' : '0'}"${raw(personAttr)}>
      <section class="card live-active-card">
        <div class="card-head"><h2>Now before the body</h2><span class="muted" data-live-watchers></span></div>
        <div class="card-body" data-live-active><p class="empty">Waiting for the clerk to open an item…</p></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Agenda</h2></div>
        <div class="card-body"><ol class="live-agenda" data-live-agenda></ol></div>
      </section>
    </div>
    <script src="/assets/live.js" defer></script>`;
  return layout({ title: 'Live — ' + meeting.body_name, active: '/calendar', body });
}

function clerkConsole(meeting, user) {
  return livePage(meeting, { role: 'clerk', personId: user && user.person_id, control: true });
}

function publicLive(meeting, user) {
  const role = user && user.role === 'member' ? 'member' : 'public';
  return livePage(meeting, { role, personId: user && user.person_id, control: false });
}

// List of meetings a clerk can run live (used as a small launcher).
function liveLauncher() {
  const today = require('../util').todayISO();
  const list = repo.meetings.all().filter((m) => m.meeting_date >= today || m.status === 'In Progress');
  const rows = list.length ? list.map((m) => html`
    <tr><td>${raw(formatDateTime(m.meeting_date, m.meeting_time))}</td>
    <td>${m.body_name}</td><td>${statusBadge(m.status)}</td>
    <td><a class="btn" href="/admin/meetings/${m.id}/live">Run live</a></td></tr>`).join('') : null;
  return rows
    ? `<table class="data"><thead><tr><th>When</th><th>Body</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">No upcoming meetings to run.</p>';
}

module.exports = { clerkConsole, publicLive, liveLauncher };
