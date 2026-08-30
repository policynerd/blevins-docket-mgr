'use strict';

// The per-item report.
//
// One agenda item, on one page, in the form a board actually circulates it:
// what the item is, what the board is being asked to do about it, why, what
// came with it, and who touched it last. Modelled on the notice a governing
// board's agenda system prints for each numbered item — the thing a member
// reads on their own before the meeting, and the thing a member of the public
// asks for afterwards when they want one item rather than the whole packet.
//
// The packet already assembled all of this, and only all of it: a hundred-page
// document in which a single item is a paragraph somebody has to find. That is
// the right artifact for the meeting and the wrong one for the question "what
// is item 14c".
//
// Everything printed here is recorded. Where the record does not hold
// something the form would like — who created the item, as against when — this
// prints what is true and says nothing about the rest, rather than inventing
// an author or leaving a blank labelled as though it were missing data.

const { html, raw, formatDate, formatDateTime } = require('../util');
const { layout, escapeText, statusBadge, typeBadge } = require('./layout');
const { ORG } = require('../org');
const repo = require('../repo');

// A labelled block, printed only when it has something in it. A report of
// empty headings is worse than a shorter report: it reads as though the work
// were done and had come back blank.
function section(label, body) {
  if (!body) return '';
  return `<section class="ir-block">
    <h2 class="ir-label">${escapeText(label)}</h2>
    <div class="ir-body">${body}</div>
  </section>`;
}

/**
 * What the board is being asked to do.
 *
 * Three fields can carry it and they are filled at different moments:
 * `notes` is what the clerk wrote when the item was placed, `motion_text` is
 * what was moved on the floor, `action` is what was recorded afterwards. The
 * first that exists is the recommendation as it stood when this was printed.
 */
function recommendation(item) {
  const text = item.notes || item.motion_text || item.action;
  return text ? `<p>${escapeText(text)}</p>` : '';
}

function details(item, matter) {
  const parts = [];
  if (matter && matter.summary) parts.push(`<p>${escapeText(matter.summary)}</p>`);
  // The board letter, where one has been written and published to this
  // audience. Its sanitized HTML is stored, so it is printed as markup.
  const letters = matter ? repo.reports.forMatter(matter.id) : [];
  for (const r of letters) {
    if (!r.body_html) continue;
    parts.push(`<h3 class="ir-sub">${escapeText(r.title || r.kind)}</h3>`);
    parts.push(r.body_html);
  }
  if (!parts.length && matter && matter.full_text) {
    parts.push(`<pre class="ir-text">${escapeText(matter.full_text)}</pre>`);
  }
  return parts.join('\n');
}

function supporting(matter) {
  if (!matter) return '';
  const files = repo.matters.attachments(matter.id);
  if (!files.length) return '';
  return '<ul class="ir-files">' + files.map((a) => {
    const name = escapeText(a.name || 'Attachment');
    const href = a.file_path ? `/files/${a.id}` : (a.url || null);
    return `<li>${href ? `<a href="${escapeText(href)}">${name}</a>` : name}`
      + (a.note ? ` <span class="muted">— ${escapeText(a.note)}</span>` : '')
      + '</li>';
  }).join('') + '</ul>';
}

// How the item was disposed of, when it has been. Printed from the certified
// arithmetic rather than the mutable projection, for the same reason the
// minutes are: the two must not be able to disagree about one roll.
function disposition(item) {
  if (item.vote_status !== 'closed' || !item.result_computed_at) return '';
  const o = repo.eligibility.outcome(item.id);
  if (!o) return '';
  const carriedOn = item.consent_group_id ? repo.meetings.getItem(item.consent_group_id) : null;
  const where = carriedOn
    ? `<p>Taken on the consent calendar${carriedOn.agenda_number
      ? ` (${escapeText(carriedOn.agenda_number)})` : ''}, with other items.</p>`
    : '';
  return where + `<p><strong>${escapeText(item.result || 'Vote taken')}</strong>`
    + ` — Yea ${o.yea}, Nay ${o.nay}`
    + (o.recused ? `, Recused ${o.recused}` : '')
    + `. Required ${o.required} of ${o.eligible} eligible, ${escapeText(o.basis || '')}.</p>`
    + (item.result_certified_at
      ? `<p class="muted">Certified ${escapeText(String(item.result_certified_at).slice(0, 16))}.</p>`
      : '');
}

// When the record was made and last touched. Timestamps only: the schema
// records when a file changed and not who changed it, and a line naming an
// author this system never captured would be a fabrication on a document
// people are meant to rely on.
function provenance(matter) {
  if (!matter) return '';
  const bits = [];
  if (matter.created_at) bits.push(`Created ${formatDate(matter.created_at)}`);
  if (matter.updated_at) bits.push(`last modified ${formatDate(matter.updated_at)}`);
  if (!bits.length) return '';
  return `<p class="ir-provenance">${escapeText(bits.join(' · '))}</p>`;
}

function itemReport(meeting, item, user) {
  const matter = item.matter_id ? repo.matters.get(item.matter_id) : null;
  const title = item.matter_id ? item.matter_title : (item.title || 'Agenda item');
  const number = item.agenda_number ? `${item.agenda_number}. ` : '';

  const carried = item.is_consent_group ? repo.meetings.consentMembers(item.id) : [];
  const carriedBlock = carried.length
    ? section(`Items on this calendar (${carried.length})`,
      '<ol class="ir-carried">' + carried.map((c) => `<li>`
        + escapeText(c.agenda_number ? `${c.agenda_number} ` : '')
        + escapeText(c.matter_id ? `${c.file_number} — ${c.matter_title}` : (c.title || ''))
        + '</li>').join('') + '</ol>')
    : '';

  const body = html`
    <div class="no-print packet-toolbar">
      <a class="btn-link" href="/meetings/${meeting.id}">← Back to meeting</a>
      <button class="btn primary" onclick="window.print()">🖨 Print / Save as PDF</button>
    </div>
    <article class="packet item-report">
      <header class="pk-head">
        <h1>${ORG.name}</h1>
        <p class="pk-sub">Notice of ${meeting.body_name} Meeting</p>
        <p class="pk-when">${raw(formatDateTime(meeting.meeting_date, meeting.meeting_time))}${
  meeting.location ? ' · ' + meeting.location : ''}</p>
      </header>

      <h2 class="ir-title">${raw(escapeText(number))}${title}</h2>
      ${raw(matter ? `<p class="ir-file">${escapeText(matter.file_number)} `
    + `${typeBadge(matter.type).value} ${statusBadge(matter.status).value}</p>` : '')}

      ${raw(section('Item Type', item.item_type
    ? `<p>${escapeText(item.item_type)}</p>` : ''))}
      ${raw(section('Recommendation', recommendation(item)))}
      ${raw(section('Agenda Item Details', details(item, matter)))}
      ${raw(carriedBlock)}
      ${raw(section('Supporting Documents', supporting(matter)))}
      ${raw(section('Disposition', disposition(item)))}
      ${raw(provenance(matter))}
    </article>`;

  return layout({
    title: `${number}${title}`,
    active: '/calendar',
    heading: false,
    body,
    user,
  });
}

module.exports = { itemReport };
