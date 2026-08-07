'use strict';

// The five official outputs, structured after the artifacts a Legistar-backed
// board produces for a single docket: the board letter that carries an item to
// the body, the clean ordinance, the redline showing what it changes, the
// summary published as legal notice, and the approval log that records who
// cleared it.
//
// The structure is taken from those documents; the content is this board's.
// Where the source form carries a jurisdiction-specific section (an equity or
// sustainability statement mandated by that county's board policy) the section
// is emitted only when the matter actually carries that content, rather than
// printing an empty heading to imitate the shape.

const { Doc, INK, MUTED } = require('./pdfdoc');
const { ORG } = require('./org');
const repo = require('./repo');
const legisdoc = require('./legisdoc');
const amend = require('./amend');
const { formatDate } = require('./util');

const RAIL_W = 128;   // left rail carrying the member roster on page 1

// The governing body and the organisation are often configured to the same
// name ("Board of Governors" of "Board of Governors"), which reads as a
// stutter in an enacting clause and a doubled masthead. Say it once when they
// agree, and name both when they genuinely differ.
function bodyOf() {
  const org = String(ORG.name || '').trim();
  const body = String(ORG.primaryBody || '').trim() || org;
  return { org, body, same: body.toLowerCase() === org.toLowerCase() };
}
function enactingClause() {
  const { org, body, same } = bodyOf();
  return same ? `The ${body} ordains as follows:` : `The ${body} of ${org} ordains as follows:`;
}

function upper(s) { return String(s == null ? '' : s).toUpperCase(); }

// Strip HTML to plain paragraphs. The result is drawn as PDF text and is never
// re-rendered as markup, but tags are removed in a loop so a split or nested
// tag cannot survive a single pass.
function paragraphs(html) {
  let text = String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ');
  let prev;
  do { prev = text; text = text.replace(/<[^>]*>/g, ''); } while (text !== prev);
  text = text.replace(/[<>]/g, '');
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  return text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

// Footer carried by every official output: the issuing office, the document
// series, and "page N of M" so a member can tell at a glance whether a page is
// missing from a printed packet.
function officialFooter(series) {
  return (doc, page, total) => {
    const y = doc.margin.bottom - 26;
    doc.at(doc.margin.left, y, series, { size: 8, style: 'sans', color: MUTED });
    const label = `Page ${page} of ${total}`;
    const w = doc.f.sans.widthOfTextAtSize(label, 8);
    doc.at(doc.size.w - doc.margin.right - w, y, label, { size: 8, style: 'sans', color: MUTED });
  };
}

// --- 1. Board letter ---------------------------------------------------------
// The instrument that carries a matter to the body: masthead, the roster of
// members down the left rail, then SUBJECT and the standing report sections.
// Continuation pages repeat the subject, which is what makes a page found on
// its own identifiable.
async function boardLetter(matter, opts = {}) {
  const body = matter.body_id ? repo.bodies.get(matter.body_id) : null;
  const bodyName = (body && body.name) || ORG.primaryBody || ORG.name;
  const members = body ? repo.bodies.members(body.id) : [];
  const reports = repo.reports.forMatter(matter.id);
  const report = opts.report || reports[0] || null;
  const subject = upper(matter.title);

  const doc = await Doc.create({
    margin: { top: 60, right: 72, bottom: 72, left: 72 + RAIL_W },
    runningHeader: (d) => {
      // Repeat the subject on every continuation page, hanging under the label.
      d.margin.left = 72;
      d.contentW = d.size.w - d.margin.left - d.margin.right;
      d.text('SUBJECT:', { size: 10, style: 'b' });
      d.y += 10 * 1.32;
      d.text(subject, { size: 10, style: 'b', indent: 62, hanging: 0 });
      d.gap(14);
    },
    footer: officialFooter(`${ORG.name} · ${matter.file_number}`),
  });

  // --- Masthead (page 1 only) ---
  doc.text(upper(ORG.name), { size: 13, style: 'b', after: 2 });
  doc.text('AGENDA ITEM', { size: 11, style: 'sans', color: MUTED, after: 2 });
  if (upper(bodyName) !== upper(ORG.name)) {
    doc.text(upper(bodyName), { size: 11, style: 'b', after: 8 });
  } else doc.gap(6);
  doc.rule({ after: 14 });

  // --- Member roster down the left rail ---
  let railY = doc.size.h - 60;
  for (const m of members) {
    doc.at(72, railY, m.full_name.toUpperCase(), { size: 8, style: 'sansB' });
    railY -= 10;
    const sub = m.district || m.role || '';
    if (sub) { doc.at(72, railY, sub, { size: 7.5, style: 'sans', color: MUTED }); railY -= 10; }
    railY -= 5;
    if (railY < 140) break;
  }

  // --- Head matter ---
  const when = opts.date || matter.intro_date || null;
  doc.text(`DATE:  ${when ? formatDate(when) : '________________'}`, { size: 10.5, after: 4 });
  doc.text(`TO:    ${bodyName}`, { size: 10.5, after: 4 });
  doc.text(`FILE:  ${matter.file_number}`, { size: 10.5, after: 12 });

  doc.heading('SUBJECT', { size: 11 });
  doc.text(subject, { size: 11, style: 'b', after: 12 });

  // The standard sections, in the configured order, each carrying what was
  // written for it. A section with nothing written is omitted rather than
  // printed as an empty heading — the form is a set of questions, and a
  // heading with no answer under it asserts one was given.
  // Two sections have structured data behind them and can be answered from the
  // file when nobody has written them: the summary stands in for OVERVIEW, and
  // the fiscal fields for FISCAL IMPACT. Both are resolved inside the loop so
  // they print in their configured position — appending a fallback after the
  // loop puts it out of order, which for a form document is a defect.
  const fiscalFromFile = () => {
    const out = [];
    if (matter.fiscal_impact != null && matter.fiscal_impact !== '') {
      const amt = Number(matter.fiscal_impact);
      out.push(`Estimated impact: $${amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        + (matter.fiscal_recurring ? ' (ongoing annual cost)' : ' (one-time)'));
    }
    if (matter.fiscal_note) out.push(...paragraphs(matter.fiscal_note));
    // Silence on cost reads as "not considered", and a board acts on the number.
    if (!out.length) out.push('There is no fiscal impact associated with this action.');
    return out;
  };

  const composed = repo.letters.compose(matter.id);
  for (const sec of composed) {
    let paras;
    if (sec.filled) paras = paragraphs(sec.body_html);
    else if (sec.key === 'overview') paras = matter.summary ? paragraphs(matter.summary) : [];
    else if (sec.key === 'fiscal') paras = fiscalFromFile();
    else paras = [];
    if (!paras.length) continue;
    doc.heading(sec.label, { size: 11 });
    for (const para of paras) doc.text(para, { size: 10.5, after: 6 });
    doc.gap(4);
  }

  // Nothing written at all: say so rather than issuing a letter that looks
  // complete because its headings are missing.
  if (!composed.some((sec) => sec.filled) && !matter.summary) {
    doc.text('[No board letter has been written for this file.]',
      { size: 10.5, style: 'i', color: MUTED, after: 8 });
  }

  const sponsors = repo.matters.sponsors(matter.id);
  if (sponsors.length) {
    doc.heading('SPONSOR(S)', { size: 11 });
    doc.text(sponsors.map((sp) => sp.full_name).join(', '), { size: 10.5, after: 10 });
  }

  doc.gap(14);
  doc.text('Respectfully submitted,', { size: 10.5 });
  doc.signature(opts.submitterTitle || ORG.clerkTitle || 'Clerk of the Board');

  // Attachments are lettered here and cited that way in debate ("Attachment
  // B"), so the letter is where the lettering is fixed.
  const atts = repo.matters.attachments(matter.id);
  if (atts.length) {
    doc.gap(10);
    doc.heading('ATTACHMENT(S)', { size: 11 });
    atts.forEach((a, i) => {
      doc.text(`Attachment ${String.fromCharCode(65 + i)}: ${a.name}`,
        { size: 10.5, hanging: 18, after: 4 });
    });
  }

  return doc.save();
}

// --- 2 & 3. Ordinance, clean and redline -------------------------------------
// One template. The redline draws the comparative print from src/amend.js:
// struck text is what the section says today, underlined text is what the
// ordinance would make it say. Producing both from one function is what keeps
// them provably the same instrument.
async function ordinance(matter, opts = {}) {
  const redline = !!opts.redline;
  const doc = await Doc.create({
    footer: officialFooter(`${ORG.name} · ${matter.file_number}`
      + (redline ? ' · REDLINE' : '')),
  });

  // Body from the parsed provision tree, so numbering and indentation follow
  // the document's own structure rather than being re-typed here.
  // flatten() yields { id, level, marker, heading, text, depth }. Indentation
  // comes from `depth` rather than a level lookup so a document nested deeper
  // than the five named levels still steps in rather than collapsing flat.
  const parsed = matter.full_text ? legisdoc.parse(matter.full_text) : null;
  const nodes = parsed ? legisdoc.flatten(parsed) : [];
  // parse() keeps everything before the first section in `preamble`; flatten()
  // returns only sections. Recitals are substantive, so they are rendered in
  // their conventional place — after the title, before the enacting clause —
  // and they count towards whether the instrument has been drafted at all.
  const preamble = (parsed && parsed.preamble) ? parsed.preamble.filter((l) => String(l).trim()) : [];

  doc.text(`ORDINANCE NO. ${matter.ordinance_number || '__________'}`,
    { size: 12, style: 'b', align: 'center', after: 10 });
  doc.text(upper(matter.title), { size: 12, style: 'b', align: 'center', after: 6 });
  if (redline) {
    doc.text('(REDLINE — SHOWING CHANGES TO EXISTING CODE)',
      { size: 9.5, style: 'sans', align: 'center', color: MUTED, after: 4 });
    doc.text('Struck text is deleted. Underlined text is added.',
      { size: 9, style: 'i', align: 'center', color: MUTED, after: 4 });
  }
  doc.rule({ after: 16 });

  for (const line of preamble) doc.text(line, { size: 11, after: 6 });
  if (preamble.length) doc.gap(6);
  doc.text(enactingClause(), { size: 11, after: 14 });

  if (!nodes.length && !preamble.length) {
    doc.text('[The text of this ordinance has not been drafted. Nothing is printed here '
      + 'rather than an empty instrument being represented as complete.]',
    { size: 10.5, style: 'i', color: MUTED, after: 12 });
  }

  for (const n of nodes) {
    const isSection = n.level === 'section';
    const indent = n.depth * 22;
    const label = n.marker ? (isSection ? `SECTION ${n.marker}.` : `(${n.marker})`) : '';
    const head = n.heading ? String(n.heading).replace(/\.\s*$/, '') + '.' : '';
    const text = [label, head, n.text || ''].filter(Boolean).join('  ');
    if (!text.trim()) continue;
    doc.text(text, {
      size: 11, indent, hanging: isSection ? 0 : 18,
      style: isSection ? 'b' : 'r', after: isSection ? 6 : 4,
    });
  }

  // Amending instructions, shown as a comparative print when this is a redline.
  // Not wrapped in a try: a failure here means the code changes are unknown,
  // and an official instrument that silently omits them is worse than no
  // document. Let it reach the route's error handler.
  const prints = amend.comparativePrint(matter.id) || [];
  if (prints.length) {
    doc.gap(8);
    doc.heading(redline ? 'CHANGES TO THE CODE' : 'SECTIONS AMENDED', { size: 11 });
    for (const p of prints) {
      const a = p.amendment || {};
      doc.text(`${upper(a.op || 'amend')} — ${a.citation || ''}`,
        { size: 10.5, style: 'b', after: 4 });
      if (!redline) {
        doc.text(p.proposedText || '(no text)', { size: 10.5, indent: 22, after: 8 });
        continue;
      }
      if (p.currentText) {
        doc.text(p.currentText, { size: 10.5, indent: 22, strike: true, color: MUTED, after: 4 });
      }
      if (p.proposedText) {
        doc.text(p.proposedText, { size: 10.5, indent: 22, underline: true, after: 8 });
      }
    }
  }

  // A drafted ordinance normally carries its own effective-date section. Only
  // supply the standard clause when the text does not already say when it takes
  // effect — printing both produces an instrument with two, which is exactly the
  // ambiguity the clause exists to remove.
  const hasEffective = nodes.some((n) =>
    /effective\s+date/i.test(String(n.heading || '')) || /shall take effect/i.test(String(n.text || '')));
  if (!hasEffective) {
    doc.gap(10);
    doc.heading('EFFECTIVE DATE', { size: 11 });
    doc.text(opts.effectiveClause
      || 'This ordinance shall take effect and be in force thirty (30) days after its '
       + 'passage; and before the expiration of fifteen (15) days after its passage a '
       + 'summary shall be published once, with the names of the members voting for and '
       + 'against it.', { size: 11, after: 20 });
  } else {
    doc.gap(20);
  }

  doc.rule({ after: 12 });
  doc.text('APPROVED AS TO FORM AND LEGALITY', { size: 10, style: 'b', after: 16 });
  doc.signature('General Counsel');

  return doc.save();
}

// --- 4. Summary for publication ----------------------------------------------
// The legal notice. This is the artifact whose publication starts the statutory
// clock, so it carries where and when the body will consider the ordinance and
// where the full text can be inspected.
async function summaryForPublication(matter, meeting, opts = {}) {
  // Enforced here rather than only at the route: this notice states when and
  // where the body will consider the ordinance, and publishing one without a
  // hearing to point at is not a lesser notice, it is not a notice.
  if (!meeting || !meeting.meeting_date) {
    throw new Error('A summary for publication requires the meeting it gives notice of.');
  }
  const doc = await Doc.create({
    margin: { top: 90, right: 90, bottom: 90, left: 90 },
    footer: officialFooter(`${ORG.name} · Notice · ${matter.file_number}`),
  });

  doc.text('SUMMARY OF PROPOSED ORDINANCE', { size: 12, style: 'b', align: 'center', after: 22 });

  const bodyName = ORG.primaryBody || ORG.name;
  const when = meeting
    ? `${formatDate(meeting.meeting_date)}${meeting.meeting_time ? ' at ' + meeting.meeting_time : ''}`
    : null;

  const { org: orgName, same: sameName } = bodyOf();
  doc.text(`Notice is hereby given that the ${bodyName}`
    + (sameName ? '' : ` of ${orgName}`)
    + ` will consider for adoption: ${upper(matter.title)}.`, { size: 11, after: 10 });

  if (matter.summary) doc.text(matter.summary, { size: 11, after: 10 });

  if (when) {
    doc.text(`Said proposed ordinance will be presented to the ${bodyName} for first reading `
      + `on ${when}, at which time public testimony will be received.`, { size: 11, after: 10 });
  }

  const place = (meeting && meeting.location) || ORG.meetingLocation;
  if (place) doc.text(`The ${bodyName} meets at ${place}.`, { size: 11, after: 10 });

  doc.text('Interested persons are encouraged to review the text of the proposed ordinance in '
    + `detail. A certified copy of the full text is on file in the ${ORG.clerkOffice || 'Office of the Clerk'}`
    + (opts.publicUrl ? `, and is also available online at ${opts.publicUrl}.` : '.'),
  { size: 11, after: 10 });

  if (opts.authority) doc.text(`This summary is published pursuant to ${opts.authority}.`, { size: 11, after: 10 });

  doc.gap(24);
  doc.text('APPROVED AS TO FORM AND LEGALITY', { size: 10, style: 'b', after: 16 });
  doc.signature('General Counsel');

  return doc.save();
}

// --- 5. Approval log ---------------------------------------------------------
// Who cleared this item, in what order, and when. Rows come from the routing
// record, so the log cannot drift from the approvals the system actually holds.
async function approvalLog(matter) {
  const steps = repo.workflow.forMatter(matter.id);
  const attachments = repo.matters.attachments(matter.id);
  const body = matter.body_id ? repo.bodies.get(matter.body_id) : null;

  const doc = await Doc.create({
    footer: officialFooter(`${ORG.name} · Approval log · ${matter.file_number}`),
  });

  doc.text('BOARD LETTER APPROVAL LOG', { size: 12, style: 'b', after: 16 });
  doc.rule({ after: 14 });

  const field = (label, value) => {
    doc.text(label, { size: 9, style: 'sansB', color: MUTED, after: 2 });
    doc.text(value || '—', { size: 10.5, after: 10 });
  };
  field('BOARD LETTER TITLE', matter.title);
  field('FILE NUMBER', matter.file_number);
  field('ORIGINATING BODY', (body && body.name) || ORG.name);
  field('ATTACHMENTS', attachments.length
    ? attachments.map((a, i) => `${String.fromCharCode(65 + i)}. ${a.name}`).join('\n')
    : 'None');

  doc.gap(6);

  const rows = steps.map((s) => [
    s.name || '',
    s.assignee_name || s.role || 'Any clerk',
    s.status || 'Pending',
    s.acted_at ? formatDate(s.acted_at.slice(0, 10)) : '',
    s.acted_by_name || '',
  ]);
  if (!rows.length) rows.push(['No approval route started', '', '', '', '']);

  doc.table([132, 116, 74, 82, 64], rows, {
    head: ['Approval', 'Routed to', 'Decision', 'Date', 'Signature'],
    after: 16,
  });

  const acted = steps.filter((s) => s.acted_at).length;
  doc.text(`${acted} of ${steps.length} approval${steps.length === 1 ? '' : 's'} recorded.`,
    { size: 9.5, style: 'sans', color: MUTED, after: 4 });
  doc.text('Signature verification is held in the approval record and the audit log; '
    + 'this sheet reproduces it and is not itself the evidence.',
  { size: 9, style: 'i', color: MUTED });

  return doc.save();
}

module.exports = { boardLetter, ordinance, summaryForPublication, approvalLog, paragraphs };
