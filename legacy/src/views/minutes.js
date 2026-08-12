'use strict';

const { html, raw, formatDateTime } = require('../util');
const { layout, card, statusBadge, emptyState, escapeText } = require('./layout');
const { editorField } = require('./reports');
const repo = require('../repo');

const ATTEND_STATUSES = ['Present', 'Remote', 'Excused', 'Absent'];

function attendanceForm(meeting) {
  const members = repo.bodies.members(meeting.body_id);
  const existing = {};
  for (const a of repo.meetings.attendance(meeting.id)) existing[a.person_id] = a.status;

  const rows = members.map((m) => `
    <div class="vote-row">
      <span>${escapeText(m.full_name)}</span>
      <span class="vote-opts">${ATTEND_STATUSES.map((s) => `
        <label class="radio"><input type="radio" name="att_${m.person_id}" value="${s}"
          ${(existing[m.person_id] || 'Present') === s ? 'checked' : ''}> ${s}</label>`).join('')}</span>
    </div>`).join('');

  return card('Roll call / attendance', `
    <form class="form" method="post" action="/admin/meetings/${meeting.id}/attendance">
      <div class="vote-grid">${rows}</div>
      <button type="submit" class="btn">Save attendance</button>
    </form>`);
}

function minutesEditor(meeting) {
  const status = meeting.minutes_status || 'none';
  const has = !!meeting.minutes_html;

  const generate = `
    <form method="post" action="/admin/meetings/${meeting.id}/minutes/generate" class="inline-form">
      <button type="submit" class="btn">${has ? '↻ Regenerate from agenda & votes' : '✨ Generate draft from agenda & votes'}</button>
      <span class="muted">Builds roll call, motions, and vote breakdowns automatically.</span>
    </form>`;

  const editor = has ? html`
    <form class="form" method="post" action="/admin/meetings/${meeting.id}/minutes" data-wp-form>
      ${raw(editorField('minutes_html', meeting.minutes_html, { label: 'Minutes document', rows: 20 }))}
      <div class="form-actions">
        <button type="submit" name="status" value="draft" class="btn">Save draft</button>
        <button type="submit" name="status" value="published" class="btn primary">Publish minutes</button>
        <a class="btn-link" href="/meetings/${meeting.id}/minutes">Preview</a>
      </div>
    </form>
    <script src="/assets/editor.js" defer></script>` : emptyState('No minutes yet — generate a draft to begin.');

  const body = html`
    <p class="crumbs"><a href="/meetings/${meeting.id}">Meeting</a> / Minutes</p>
    <div class="detail-head">
      <h1>Minutes — ${meeting.body_name}</h1>
      <span>${statusBadge(status === 'published' ? 'Passed' : (status === 'draft' ? 'In Committee' : 'Draft'))} ${raw(`<span class="muted">${escapeText(status)}</span>`)}</span>
    </div>
    <p class="muted">${raw(formatDateTime(meeting.meeting_date, meeting.meeting_time))}</p>
    ${raw(attendanceForm(meeting))}
    ${raw(card('Generate minutes', generate))}
    ${raw(card('Edit minutes', editor))}`;
  return layout({ title: 'Minutes', active: '/calendar', body });
}

function minutesView(meeting) {
  const published = meeting.minutes_status === 'published';
  const body = html`
    <div class="no-print packet-toolbar">
      <a class="btn-link" href="/meetings/${meeting.id}">← Back to meeting</a>
      <button class="btn primary" onclick="window.print()">🖨 Print / Save as PDF</button>
    </div>
    <article class="packet">
      <header class="pk-head">
        <h1>${meeting.body_name}</h1>
        <p class="pk-sub">${published ? 'Minutes' : 'Draft Minutes'}</p>
        <p class="pk-when">${raw(formatDateTime(meeting.meeting_date, meeting.meeting_time))}${meeting.location ? ' · ' + meeting.location : ''}</p>
      </header>
      <div class="doc-body">${meeting.minutes_html
        ? raw(meeting.minutes_html)
        : raw(emptyState('Minutes have not been published for this meeting.'))}</div>
    </article>`;
  return layout({ title: 'Minutes — ' + meeting.body_name, active: '/calendar', body });
}

module.exports = { minutesEditor, minutesView, attendanceForm, ATTEND_STATUSES };
