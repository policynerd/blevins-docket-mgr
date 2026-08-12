'use strict';

const { html, raw, formatDateTime } = require('../util');
const { layout, statusBadge } = require('./layout');
const { hasRole } = require('../auth');
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
    ${raw(control ? `<p class="live-tools"><a class="btn" href="/display/${meeting.id}" target="_blank" rel="noopener">Open chamber display →</a>
      <span class="muted">The board for the room. Open it on the wall screen; it needs no sign-in.</span></p>` : '')}

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

/**
 * The live board as anyone but the clerk sees it.
 *
 * `hasRole`, not `role === 'member'`. Roles rank — public, member, staff,
 * clerk, admin — and every other gate in the application compares rank. This
 * one compared the string, so everybody senior to a member fell through to
 * 'public' and the board showed them no way to vote.
 *
 * That is not an edge case: auth.js seeds the Chair as `staff`, so the chair
 * of the body could not cast a vote from the live board, and neither could any
 * governor who had been made an admin. The server never agreed — the cast
 * route asks whether you are seated, not what rank you hold — so this was the
 * page declining to offer what the route would have accepted.
 *
 * The person link is required here too. A user with no `person_id` is not any
 * particular member of the board — SSO provisions exactly that — and the
 * buttons would post a ballot the server rejects as having no identity.
 */
function publicLive(meeting, user) {
  const canVote = hasRole(user, 'member') && !!(user && user.person_id);
  return livePage(meeting, {
    role: canVote ? 'member' : 'public',
    personId: user && user.person_id,
    control: false,
  });
}

// List of meetings a clerk can run live (used as a small launcher).
function liveLauncher() {
  const today = require('../util').todayISO();
  const list = repo.meetings.all().filter((m) => m.meeting_date >= today || m.status === 'In Progress');
  const rows = list.length ? list.map((m) => html`
    <tr><td>${raw(formatDateTime(m.meeting_date, m.meeting_time))}</td>
    <td>${m.body_name}</td><td>${statusBadge(m.status)}</td>
    <td><a class="btn" href="/admin/meetings/${m.id}/live">Run live</a>
    <a class="btn" href="/display/${m.id}" target="_blank" rel="noopener">Display</a></td></tr>`).join('') : null;
  return rows
    ? `<table class="data"><thead><tr><th>When</th><th>Body</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">No upcoming meetings to run.</p>';
}

module.exports = { clerkConsole, publicLive, liveLauncher };
