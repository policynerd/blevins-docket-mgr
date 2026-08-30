'use strict';

// Generates a draft minutes document (HTML) from a meeting's recorded data:
// roll-call attendance, and each agenda item's action, motion, result, and the
// individual roll-call votes. Output is our own markup using the same tag
// subset the word-processor sanitizer allows, so the clerk can refine it.
const repo = require('./repo');
const { formatDate, formatDateTime, escapeHtml } = require('./util');
const { ORG } = require('./org');

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

    // The consent calendar, in the minutes.
    //
    // One roll disposed of these, so the tally is printed once — on the
    // calendar, below — and each item it carried is named here. Printing the
    // items without saying they travelled together would read as twelve
    // separate votes that nobody took; printing the calendar without naming
    // the items would record a decision without saying what was decided.
    const carried = it.is_consent_group ? repo.meetings.consentMembers(it.id) : [];
    if (carried.length) {
      out.push(`<p>The following ${carried.length} item${carried.length === 1 ? '' : 's'} `
        + `${carried.length === 1 ? 'was' : 'were'} considered together on the consent calendar:</p>`);
      out.push('<ol>' + carried.map((c) => '<li>'
        + escapeHtml(c.agenda_number ? `${c.agenda_number} ` : '')
        + escapeHtml(c.matter_id ? `${c.file_number} — ${c.matter_title}` : (c.title || ''))
        + '</li>').join('') + '</ol>');
    }

    // An item carried on a calendar states where its vote was taken instead of
    // reprinting a roll it was not the subject of.
    if (it.consent_group_id) {
      const group = repo.meetings.getItem(it.consent_group_id);
      out.push('<p>Adopted on the consent calendar'
        + (group && group.agenda_number ? ` (${escapeHtml(group.agenda_number)})` : '')
        + '; see the roll recorded there.</p>');
    }

    if (it.motion_text || it.mover_id || it.seconder_id) {
      const mover = it.mover_id ? nameOf(it.mover_id) : null;
      const seconder = it.seconder_id ? nameOf(it.seconder_id) : null;
      let line = '';
      if (it.motion_text) line += `Motion: ${escapeHtml(it.motion_text)}. `;
      if (mover) line += `Moved by ${escapeHtml(mover)}`;
      if (seconder) line += `, seconded by ${escapeHtml(seconder)}`;
      out.push(`<p>${line.trim()}</p>`);
    }

    // Every item that went to a roll gets its vote printed, linked to a
    // legislative file or not. This was gated on `matter_id`, so approval of
    // the prior minutes, procedural motions and any resolution carried without
    // a file had their ballots recorded in the ledger and then left out of the
    // document entirely — the clerk retyped them from the console by hand.
    //
    // The gate is the item's own vote state, the same pair the chamber board
    // reads. Not `requires_vote`, which records what was meant to happen; not
    // an open roll, which has not happened yet. It also keeps a voided vote
    // out: voiding deliberately leaves the ballots in the ledger but returns
    // the item to 'pending', and outcome() would otherwise still tally them
    // into minutes for a vote the Board has said did not occur.
    if (it.vote_status === 'closed' && it.result_computed_at) {
      // The certified arithmetic, not `votes.tally`. That table is a mutable
      // projection with no notion of where the roll closed, so a late or
      // superseded ballot moved the printed count while the result the clerk
      // certified stood unchanged — the minutes and the certificate stating
      // different numbers for the same vote. outcome() reads the append-only
      // ledger bounded by the close, which is the arithmetic that produced the
      // result, so the two cannot drift apart.
      const o = repo.eligibility.outcome(it.id);
      if (o) {
        const named = (choice) => o.roll.filter((r) => r.choice === choice).map((r) => r.full_name);
        const yeas = named('Yea'); const nays = named('Nay');
        const present = named('Present').length; const abstain = named('Abstain').length;
        // Absent is attendance, never a ballot: it is not a choice a member can
        // record, so who was not in the room is the only thing the column can
        // mean. Derived the way the chamber board derives it, so the wall and
        // the minutes cannot report different figures for the same roll.
        const absent = o.seated - o.present;
        out.push(`<p>Vote: Yea ${o.yea}, Nay ${o.nay}`
          + (present ? `, Present ${present}` : '')
          + (abstain ? `, Abstain ${abstain}` : '')
          + (o.recused ? `, Recused ${o.recused}` : '')
          + (absent ? `, Absent ${absent}` : '') + '.');
        if (yeas.length) out.push(` Yeas: ${escapeHtml(yeas.join(', '))}.`);
        if (nays.length) out.push(` Nays: ${escapeHtml(nays.join(', '))}.`);
        // The rule the result was ruled under, in the same paragraph rather
        // than a section of its own. A reader given only "Yea 4, Nay 3" cannot
        // tell whether that carried, and the chair has to be able to state the
        // basis aloud from the minutes without recomputing it.
        out.push(` <em>Required to carry: ${o.required} of ${o.eligible} eligible`
          + ` — ${escapeHtml(o.basis)}.</em>`);
        out.push('</p>');
      }
    }
    if (it.action || it.result) {
      out.push(`<p><em>${escapeHtml(it.action || 'Action')}${it.result ? ' — ' + escapeHtml(it.result) : ''}</em></p>`);
    }
  }

  out.push(`<hr><p>Respectfully submitted by the ${escapeHtml(ORG.clerkOffice)}.</p>`);
  return out.join('\n');
}

function nameOf(id) {
  const p = repo.people.get(id);
  return p ? p.full_name : '';
}

module.exports = { generate };
