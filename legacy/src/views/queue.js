'use strict';

// My Work Queue.
//
// The application could tell you what a file was, and could not tell you what
// was waiting. Approvals routed to you existed only as a number on a nav
// badge; files stuck with a reviewer for three weeks looked exactly like files
// routed yesterday; files nobody had ever routed were invisible entirely,
// because nothing starts a route automatically and creating a file redirects
// to the public page. A clerk carried all of that in their head.
//
// So this screen answers the four questions the week is actually made of:
// what is on me, what is late, what is ready to be scheduled, and what has
// been forgotten. Nothing here is new information — every row comes from a
// query the data already supported. It had simply never been asked.

const { html, raw, formatDate } = require('../util');
const { layout, card, statusBadge, typeBadge, emptyState, escapeText } = require('./layout');
const repo = require('../repo');
const auth = require('../auth');

// How long a step may sit before it is worth naming. Not a deadline — the
// system has no notion of one — but the point past which "still waiting" stops
// being ordinary and starts being a question.
const STALE_DAYS = 7;

function ageCell(days) {
  if (days == null) return '<span class="muted">—</span>';
  if (days === 0) return 'today';
  const label = `${days} day${days === 1 ? '' : 's'}`;
  return days >= STALE_DAYS ? `<strong class="age-stale">${label}</strong>` : label;
}

function fileLink(row) {
  const fn = escapeText(row.file_number);
  return `<a href="/legislation/${encodeURIComponent(row.file_number)}">${fn}</a>`;
}

// --- What is routed to me -----------------------------------------------------
function minePanel(user) {
  const actsAsClerk = auth.hasRole(user, 'clerk');
  const items = user ? repo.workflow.inboxFor(user.id, actsAsClerk) : [];
  if (!items.length) return emptyState('Nothing is routed to you.');

  const rows = items.map((it) => html`
    <tr>
      <td>${raw(fileLink(it))}</td>
      <td class="title-cell">${it.matter_title}</td>
      <td>${it.seq}. ${it.name}${it.status === 'Returned' ? raw(' <span class="badge st-failed">Returned</span>') : ''}</td>
      <td>${raw(it.assignee_id ? '' : '<span class="muted">unassigned</span>')}</td>
      <td class="row-actions">
        <form class="inline" method="post" action="/approvals/steps/${it.id}/act">
          <button type="submit" name="status" value="Approved" class="btn-link">Approve</button>
        </form>
      </td>
    </tr>`).join('');

  return `<table class="data compact">
    <thead><tr><th>File #</th><th>Title</th><th>Step</th><th></th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// --- What has been sitting too long ------------------------------------------
function stalePanel() {
  const late = repo.workflow.waiting({ olderThanDays: STALE_DAYS });
  if (!late.length) {
    return emptyState(`Nothing has been waiting more than ${STALE_DAYS} days.`);
  }
  const rows = late.map((r) => html`
    <tr>
      <td>${raw(fileLink(r))}</td>
      <td class="title-cell">${r.title}</td>
      <td>${r.seq}. ${r.step_name}</td>
      <td>${r.assignee_name || raw('<span class="muted">any clerk</span>')}</td>
      <td>${raw(ageCell(r.days))}</td>
    </tr>`).join('');

  return `<table class="data compact">
    <thead><tr><th>File #</th><th>Title</th><th>Step</th><th>With</th><th>Waiting</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// --- What could go on the next agenda ----------------------------------------
//
// Ready in the sense the drafting screen means it — written, and every required
// board-letter section answered — not merely "has the right status", which is
// all the agenda's own queue has ever checked.
function readyPanel(meeting) {
  if (!meeting) return emptyState('No meeting is scheduled to place anything on.');
  const candidates = repo.meetings.readyForAgenda(meeting.id);
  if (!candidates.length) return emptyState('Nothing is waiting for this body.');

  const rows = candidates.map((m) => {
    const { ready, reasons } = repo.matters.readiness(m);
    const flag = ready
      ? '<span class="badge st-passed">Ready</span>'
      : `<span class="badge st-draft" title="${escapeText(reasons.map((r) => r.label).join('; '))}">Not ready</span>`;
    return html`
      <tr>
        <td>${raw(fileLink(m))}</td>
        <td>${typeBadge(m.type)}</td>
        <td class="title-cell">${m.title}</td>
        <td>${statusBadge(m.status)}</td>
        <td>${raw(flag)}</td>
      </tr>`;
  }).join('');

  return `<table class="data compact">
    <thead><tr><th>File #</th><th>Type</th><th>Title</th><th>Status</th><th>Ready</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// --- What was never routed ----------------------------------------------------
function unroutedPanel() {
  const rows = repo.workflow.unrouted();
  if (!rows.length) return emptyState('Every open file has been routed.');
  const body = rows.slice(0, 40).map((m) => html`
    <tr>
      <td>${raw(fileLink(m))}</td>
      <td>${typeBadge(m.type)}</td>
      <td class="title-cell">${m.title}</td>
      <td>${statusBadge(m.status)}</td>
      <td>${m.intro_date ? raw(formatDate(m.intro_date)) : raw('<span class="muted">—</span>')}</td>
      <td class="row-actions"><a class="btn-link" href="/admin/matters/${m.id}/edit">Route it →</a></td>
    </tr>`).join('');

  return `<table class="data compact">
    <thead><tr><th>File #</th><th>Type</th><th>Title</th><th>Status</th><th>Introduced</th><th></th></tr></thead>
    <tbody>${body}</tbody></table>`
    + (rows.length > 40 ? `<p class="muted">${rows.length - 40} more not shown.</p>` : '');
}

function workQueue(user) {
  const nextMeeting = repo.meetings.upcoming(new Date().toISOString().slice(0, 10), 1)[0] || null;
  const mine = user ? repo.workflow.inboxFor(user.id, auth.hasRole(user, 'clerk')).length : 0;
  const late = repo.workflow.waiting({ olderThanDays: STALE_DAYS }).length;
  const unrouted = repo.workflow.unrouted().length;

  // The counts first, as links, so the screen answers "is there anything?"
  // before it answers "what is it?".
  const stats = `<div class="stat-grid small">
    <a class="stat${mine ? ' stat-flag' : ''}" href="#mine"><span class="stat-n">${mine}</span><span class="stat-l">Routed to you</span></a>
    <a class="stat${late ? ' stat-flag' : ''}" href="#late"><span class="stat-n">${late}</span><span class="stat-l">Waiting over ${STALE_DAYS} days</span></a>
    <a class="stat" href="#ready"><span class="stat-n">${nextMeeting ? repo.meetings.readyForAgenda(nextMeeting.id).length : 0}</span><span class="stat-l">Could be scheduled</span></a>
    <a class="stat${unrouted ? ' stat-flag' : ''}" href="#unrouted"><span class="stat-n">${unrouted}</span><span class="stat-l">Never routed</span></a>
  </div>`;

  const nextLabel = nextMeeting
    ? `${escapeText(nextMeeting.body_name)} · ${formatDate(nextMeeting.meeting_date)}`
    : 'no meeting scheduled';

  const body = html`
    ${raw(stats)}
    ${raw(`<div id="mine">${card('Routed to you', minePanel(user))}</div>`)}
    ${raw(`<div id="late">${card(`Waiting more than ${STALE_DAYS} days`, stalePanel())}</div>`)}
    ${raw(`<div id="ready">${card(`Could go on the next agenda — ${nextLabel}`, readyPanel(nextMeeting), {
    actions: nextMeeting
      ? `<a class="btn-link" href="/admin/meetings/${nextMeeting.id}/agenda">Build that agenda →</a>` : '',
  })}</div>`)}
    ${raw(`<div id="unrouted">${card('Never routed for review', unroutedPanel())}</div>`)}`;

  return layout({
    title: 'My Work Queue',
    active: '/admin/queue',
    subtitle: 'What is on you, what is late, what could be scheduled, and what was forgotten.',
    body,
  });
}

module.exports = { workQueue, STALE_DAYS };
