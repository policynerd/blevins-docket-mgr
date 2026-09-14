'use strict';

const { html, raw, formatDateTime } = require('../util');
const { layout } = require('./layout');
const { escapeText } = require('./layout-base');
const { hasRole } = require('../auth');

function paint(opts, skin) {
  return layout(opts).replace('<body>', `<body class="chamber-${skin}">`);
}

function memberLive(meeting, user) {
  const body = html`
    <div class="vc" data-meeting="${meeting.id}" data-person="${user.person_id || ''}">
      <header class="vc-top">
        <p class="vc-kicker">${escapeText(meeting.body_name)}</p>
        <h1>On the floor</h1>
        <p class="vc-meta">${escapeText(formatDateTime(meeting.meeting_date, meeting.meeting_time))}</p>
        <p class="vc-clock" data-vc-clock hidden></p>
      </header>
      <article class="vc-card" data-vc-card>
        <p class="empty">Waiting for the chair to put a question…</p>
      </article>
      <p class="vc-foot">
        <a href="/meetings/${meeting.id}/packet">Packet</a>
        · <a href="/member">Desk</a>
      </p>
    </div>
    <script src="/assets/chamber-member.js" defer></script>`;
  return paint({ title: 'On the floor — ' + meeting.body_name, heading: false, active: '/member', body }, 'member');
}

function publicLive(meeting) {
  const body = html`
    <div class="vc vc-public" data-meeting="${meeting.id}">
      <header class="vc-top">
        <p class="vc-kicker">${escapeText(meeting.body_name)}</p>
        <h1>Live meeting</h1>
        <p class="vc-meta">${escapeText(formatDateTime(meeting.meeting_date, meeting.meeting_time))}</p>
      </header>
      <article class="vc-card" data-vc-card>
        <p class="empty">The body has not opened an item.</p>
      </article>
      <p class="vc-foot"><a href="/meetings/${meeting.id}">Meeting record</a></p>
    </div>
    <script src="/assets/chamber-member.js" defer></script>`;
  return paint({ title: 'Live — ' + meeting.body_name, heading: false, active: '/calendar', body }, 'public');
}

function clerkLiveHint(meeting) {
  return html`<p class="run-strip">Run of show: Information is received. Discussion is heard. Consent is one roll. Action is a question. <a class="btn" href="/admin/meetings/${meeting.id}/minutes">Minutes &amp; certify</a></p>`;
}

function deskPage(user) {
  const desk = require('../awareness').desk(user);
  const moved = (desk.moved || []).map((m) =>
    `<li><a href="/legislation/${encodeURIComponent(m.file_number)}">${escapeText(m.file_number)}</a> — ${escapeText(m.title)} <span class="muted">${escapeText(m.last_action || '')}</span></li>`).join('');
  const recent = (desk.recent || []).map((h) =>
    `<li>${escapeText(h.file_number || '')} · ${escapeText(h.action)}${h.result ? ' · ' + escapeText(h.result) : ''}</li>`).join('');
  const body = html`
    <div class="desk-home">
      <p class="muted">${desk.inbox ? desk.inbox + ' awaiting approval.' : 'Nothing in the approval inbox.'}</p>
      <section class="card"><div class="card-head"><h2>Watched files that moved</h2></div>
        <div class="card-body">${moved ? raw('<ul class="plain">' + moved + '</ul>') : raw('<p class="empty">None since you watched them.</p>')}</div></section>
      <section class="card"><div class="card-head"><h2>Recent actions</h2></div>
        <div class="card-body">${recent ? raw('<ul class="plain">' + recent + '</ul>') : raw('<p class="empty">No recent history.</p>')}</div></section>
    </div>`;
  return layout({ title: 'Desk', subtitle: 'Waiting, moved, next.', active: '/legislation', body });
}

function pickPublicLive(meeting, user) {
  if (hasRole(user, 'member') && user && user.person_id) return memberLive(meeting, user);
  return publicLive(meeting);
}

module.exports = { memberLive, publicLive, pickPublicLive, clerkLiveHint, deskPage };
