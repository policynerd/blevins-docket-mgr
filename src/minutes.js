'use strict';

// Generates a draft minutes document (HTML) from a meeting's recorded data:
// roll-call attendance, and each agenda item's action, motion, result, and the
// individual roll-call votes. Output is our own markup using the same tag
// subset the word-processor sanitizer allows, so the clerk can refine it.
const repo = require('./repo');
const { formatDate, formatDateTime, escapeHtml } = require('./util');

function generate(meetingId) {
  const m = repo.meetings.get(meetingId);
  if (!m) return '';
  const items = repo.meetings.items(meetingId);
  const attendance = repo.meetings.attendance(meetingId);

  const out = [];
  out.push(`<h2>Minutes — ${escapeHtml(m.body_name)}</h2>`);
  out.push(`<p><strong>${escapeHtml(formatDateTime(m.meeting_date, m.meeting_time))}</strong>`
    + (m.location ? ` · ${escapeHtml(m.location)}` : '') + '</p>');

  // Roll call
  if (attendance.length) {
    const group = (status) => attendance.filter((a) => a.status === status).map((a) => a.full_name);
    out.push('<h3>Roll Call</h3><ul>');
    for (const status of ['Present', 'Remote', 'Excused', 'Absent']) {
      const names = group(status);
      if (names.length) out.push(`<li><strong>${status}:</strong> ${escapeHtml(names.join(', '))}</li>`);
    }
    out.push('</ul>');
  }

  // Agenda items
  let lastSection = null;
  for (const it of items) {
    if (it.section && it.section !== lastSection) {
      lastSection = it.section;
      out.push(`<h3>${escapeHtml(it.section)}</h3>`);
    }
    const heading = it.matter_id
      ? `${escapeHtml(it.agenda_number || '')} ${escapeHtml(it.file_number)} — ${escapeHtml(it.matter_title)}`
      : `${escapeHtml(it.agenda_number || '')} ${escapeHtml(it.title || '')}`;
    out.push(`<p><strong>${heading.trim()}</strong></p>`);

    if (it.motion_text || it.mover_id || it.seconder_id) {
      const mover = it.mover_id ? nameOf(it.mover_id) : null;
      const seconder = it.seconder_id ? nameOf(it.seconder_id) : null;
      let line = '';
      if (it.motion_text) line += `Motion: ${escapeHtml(it.motion_text)}. `;
      if (mover) line += `Moved by ${escapeHtml(mover)}`;
      if (seconder) line += `, seconded by ${escapeHtml(seconder)}`;
      out.push(`<p>${line.trim()}</p>`);
    }

    if (it.matter_id) {
      const votes = repo.votes.forItem(it.id);
      if (votes.length) {
        const t = repo.votes.tally(it.id);
        const byVote = (v) => votes.filter((x) => x.vote === v).map((x) => x.full_name);
        out.push(`<p>Vote: Yea ${t.Yea}, Nay ${t.Nay}`
          + (t.Abstain ? `, Abstain ${t.Abstain}` : '')
          + (t.Recused ? `, Recused ${t.Recused}` : '')
          + (t.Absent ? `, Absent ${t.Absent}` : '') + '.');
        const yeas = byVote('Yea'); const nays = byVote('Nay');
        if (yeas.length) out.push(` Yeas: ${escapeHtml(yeas.join(', '))}.`);
        if (nays.length) out.push(` Nays: ${escapeHtml(nays.join(', '))}.`);
        out.push('</p>');
      }
    }
    if (it.action || it.result) {
      out.push(`<p><em>${escapeHtml(it.action || 'Action')}${it.result ? ' — ' + escapeHtml(it.result) : ''}</em></p>`);
    }
  }

  out.push('<hr><p>Respectfully submitted by the Office of the City Clerk.</p>');
  return out.join('\n');
}

function nameOf(id) {
  const p = repo.people.get(id);
  return p ? p.full_name : '';
}

module.exports = { generate };
