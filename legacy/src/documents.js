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
const { formatDate, escapeHtml } = require('./util');
const render = require('./render');
const docprint = require('./docprint');

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
    // A row ends a line; a cell only ends a column. Without the cell rule a
    // fiscal-note table arrives in the PDF as one run-on word.
    .replace(/<\s*\/\s*(td|th)\s*>/gi, ' | ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/caption|\/table)\s*>/gi, '\n')
    // Opening block tags break a line too.
    //
    // Only closing tags did, which is right for well-formed markup and wrong
    // for the markup people actually paste. A word processor writes
    // `<p>…required now to:<ul><li>Eliminate…` — the <p> is never closed
    // before the list, because a browser closes it implicitly and this is a
    // regex, not a parser. It printed in the board letter as
    // "required now to:• Eliminate ambiguity", the bullet glued to the end of
    // the sentence that introduces it.
    .replace(/<\s*(p|div|ul|ol|table|tr|h[1-6])(\s[^>]*)?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ');
  let prev;
  do { prev = text; text = text.replace(/<[^>]*>/g, ''); } while (text !== prev);
  text = text.replace(/[<>]/g, '');
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  return text.split(/\n+/)
    // The last cell of a row leaves a separator with nothing after it.
    .map((s) => s.trim().replace(/\s*\|\s*$/, '').trim())
    .filter(Boolean);
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

// Attachment labels: A…Z, then AA, AB… String.fromCharCode(65 + i) turns into
// "[" at the 27th attachment, which is not a citable label.
function attachmentLabel(i) {
  let n = i;
  let out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

// --- 1. Board letter ---------------------------------------------------------
// The instrument that carries a matter to the body: masthead, the roster of
// members down the left rail, then SUBJECT and the standing report sections.
// Continuation pages repeat the subject, which is what makes a page found on
// its own identifiable.
/**
 * The board letter.
 *
 * Set as HTML and printed by the browser, which is what makes its head matter
 * an actual column and lets a section keep the list markup a clerk wrote
 * instead of flattening it to "• item" strings. `boardLetterDrawn` below is
 * the same letter drawn with pdf-lib; it stays as the fallback, because a
 * board meeting cannot be held up by a container that came back without its
 * browser package.
 */
async function boardLetter(matter, opts = {}) {
  if (render.available()) {
    const html = boardLetterHtml(matter, opts);
    try {
      return await render.render(html, {
        footerTemplate: docprint.footer(`${ORG.name} \u00b7 ${matter.file_number}`),
      });
    } catch (_) {
      // Any failure of the browser falls through to the drawn letter. A fault
      // in the template itself throws above this, while building the HTML, so
      // a real bug still surfaces rather than being papered over by a fallback
      // that quietly produces a different-looking document for ever.
    }
  }
  return boardLetterDrawn(matter, opts);
}

/** The letter's markup. Pure: it reads the record and returns a string. */
function boardLetterHtml(matter, opts = {}) {
  const body = matter.body_id ? repo.bodies.get(matter.body_id) : null;
  const bodyName = (body && body.name) || ORG.primaryBody || ORG.name;
  const members = body ? repo.bodies.members(body.id) : [];
  const when = opts.date || matter.intro_date || null;

  let out = docprint.rail(members);
  out += docprint.masthead('Agenda item', bodyName);
  out += docprint.headMatter([
    ['DATE:', when ? formatDate(when) : '________________'],
    ['TO:', bodyName],
    ['FILE:', matter.file_number],
  ]);
  out += docprint.section('Subject',
    `<p class="subject">${escapeHtml(matter.title || '')}</p>`);

  // The letter's own sections, in their configured order. The stored markup
  // goes through as markup: a list a clerk wrote stays a list, and a table
  // stays a table, instead of being flattened to text and re-marked with
  // bullet characters. That flattening is why the two renderings of one
  // section could look different in the first place.
  const composed = repo.letters.compose(matter.id);
  for (const sec of composed) {
    let html = '';
    if (sec.filled) html = sec.body_html;
    else if (sec.key === 'overview' && matter.summary) html = `<p>${escapeHtml(matter.summary)}</p>`;
    else if (sec.key === 'fiscal') html = fiscalHtml(matter);
    if (html) out += docprint.section(sec.label, html);
  }

  if (!composed.some((sec) => sec.filled) && !matter.summary) {
    out += `<p class="muted"><em>[No board letter has been written for this file.]</em></p>`;
  }

  const sponsors = repo.matters.sponsors(matter.id);
  if (sponsors.length) {
    out += docprint.section('Sponsor(s)',
      `<p>${escapeHtml(sponsors.map((sp) => sp.full_name).join(', '))}</p>`);
  }

  out += `<div class="sign"><p>Respectfully submitted,</p>`
    + `<div class="sign-line"></div>`
    + `<div class="sign-role">${escapeHtml(opts.submitterTitle || ORG.clerkTitle || 'Clerk of the Board')}</div>`
    + `</div>`;

  // Attachments are lettered here and cited that way in debate ("Attachment
  // B"), so the letter is where the lettering is fixed.
  const atts = repo.matters.attachments(matter.id);
  if (atts.length) {
    out += docprint.section('Attachment(s)',
      '<ul>' + atts.map((a, i) =>
        `<li>Attachment ${escapeHtml(attachmentLabel(i))}: ${escapeHtml(a.name || '')}</li>`)
        .join('') + '</ul>');
  }

  return docprint.page(`${matter.file_number} — ${matter.title || 'Board letter'}`, out,
    docprint.RAIL_PAGE_CSS);
}

// Silence on cost reads as "not considered", and a board acts on the number.
function fiscalHtml(matter) {
  const out = [];
  if (matter.fiscal_impact != null && matter.fiscal_impact !== '') {
    const amt = Number(matter.fiscal_impact);
    out.push(`Estimated impact: $${amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      + (matter.fiscal_recurring ? ' (ongoing annual cost)' : ' (one-time)'));
  }
  if (matter.fiscal_note) out.push(...paragraphs(matter.fiscal_note));
  if (!out.length) out.push('There is no fiscal impact associated with this action.');
  return out.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
}

async function boardLetterDrawn(matter, opts = {}) {
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
      //
      // The margin used to drop back to 72 here, so the text column jumped
      // 128pt left and grew a third wider between page 1 and page 2 — one
      // document set in two measures, which is the first thing the eye catches
      // and reads as a fault rather than a design. The rail stays for the
      // whole letter; below the roster it is letterhead, which is what a rail
      // is for.
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
  //
  // Labelled, because seven names alone in a margin say nothing about what
  // they are — a reader has no way to tell a membership roster from a
  // distribution list or a list of sponsors.
  //
  // And labelled with the office where there is one. members() orders by
  // Chair, then Vice Chair, then name; the sub-label showed the district, so
  // the rail read "Seat 1, Seat 2, At-Large, Seat 3, Seat 5, Seat 6, Seat 4"
  // — an order with no visible reason, which reads as a sorting bug. Printing
  // the office that put those two at the top explains the order on the page.
  let railY = doc.size.h - 60;
  doc.at(72, railY, 'MEMBERS', { size: 7, style: 'sansB', color: MUTED });
  railY -= 14;
  for (const m of members) {
    doc.at(72, railY, m.full_name.toUpperCase(), { size: 8, style: 'sansB' });
    railY -= 10;
    const office = m.role && m.role !== 'Member' ? m.role : '';
    const sub = office && m.district ? `${office} · ${m.district}`
      : (office || m.district || '');
    if (sub) { doc.at(72, railY, sub, { size: 7.5, style: 'sans', color: MUTED }); railY -= 10; }
    railY -= 5;
    if (railY < 140) break;
  }

  // --- Head matter ---
  // Three labelled values, in a column. These were padded with spaces —
  // `DATE:  `, `TO:    ` — which aligns nothing: the layout draws word by word
  // at computed positions, so the padding is gone before anything reaches the
  // page. The values landed at x=232.0, 219.4 and 227.7.
  const when = opts.date || matter.intro_date || null;
  doc.field('DATE:', when ? formatDate(when) : '________________', { size: 10.5, after: 4 });
  doc.field('TO:', bodyName, { size: 10.5, after: 4 });
  doc.field('FILE:', matter.file_number, { size: 10.5, after: 12 });

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
    // Not justified. The rail leaves this column about 340pt wide — roughly 55
    // characters at 10.5pt, below what justification needs — so every line came
    // out with its word spacing stretched ("Approve  and  Adopt  the  revised
    // Enterprise  Governance  Code") and rivers running down the page. The
    // wider documents below still justify; this one is a memo on a narrow
    // measure and reads better ragged right.
    for (const para of paras) {
      // A bullet hangs: its runover lines align under the text, not under the
      // mark. Without it the second line of a bullet starts at the same left
      // edge as the bullet itself, and a three-line item stops looking like
      // one item.
      const bullet = /^[•\u2013\u2014-]\s/.test(para);
      doc.text(para, bullet
        ? { size: 10.5, after: 6, indent: 12, hanging: 12 }
        : { size: 10.5, after: 6 });
    }
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
      doc.text(`Attachment ${attachmentLabel(i)}: ${a.name}`,
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

  for (const line of preamble) doc.text(line, { size: 11, after: 6, justify: true });
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
      style: isSection ? 'b' : 'r', after: isSection ? 6 : 4, justify: true,
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
       + 'against it.', { size: 11, after: 20, justify: true });
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
    + ` will consider for adoption: ${upper(matter.title)}.`, { size: 11, after: 10, justify: true });

  if (matter.summary) doc.text(matter.summary, { size: 11, after: 10, justify: true });

  if (when) {
    doc.text(`Said proposed ordinance will be presented to the ${bodyName} for first reading `
      + `on ${when}, at which time public testimony will be received.`, { size: 11, after: 10, justify: true });
  }

  const place = (meeting && meeting.location) || ORG.meetingLocation;
  if (place) doc.text(`The ${bodyName} meets at ${place}.`, { size: 11, after: 10, justify: true });

  doc.text('Interested persons are encouraged to review the text of the proposed ordinance in '
    + `detail. A certified copy of the full text is on file in the ${ORG.clerkOffice || 'Office of the Clerk'}`
    + (opts.publicUrl ? `, and is also available online at ${opts.publicUrl}.` : '.'),
  { size: 11, after: 10, justify: true });

  if (opts.authority) doc.text(`This summary is published pursuant to ${opts.authority}.`, { size: 11, after: 10, justify: true });

  doc.gap(24);
  doc.text('APPROVED AS TO FORM AND LEGALITY', { size: 10, style: 'b', after: 16 });
  doc.signature('General Counsel');

  return doc.save();
}

// --- Staff report -------------------------------------------------------------
// A report attached to a file, rendered so it can be bound into the packet.
// Reports are authored as rich text, so this is a plain rendering of that
// prose under a heading identifying what it is and what it belongs to.
async function reportDoc(matter, report) {
  const doc = await Doc.create({
    footer: officialFooter(`${ORG.name} \u00b7 ${matter.file_number} \u00b7 ${report.kind || 'Report'}`),
  });
  doc.text(upper(report.kind || 'Report'), { size: 10, style: 'sans', color: MUTED, after: 4 });
  doc.text(report.title || matter.title, { size: 13, style: 'b', after: 4 });
  doc.text(`${matter.file_number} \u2014 ${matter.title}`, { size: 10, color: MUTED, after: 6 });
  if (report.author_name) doc.text(`Prepared by ${report.author_name}`, { size: 10, color: MUTED, after: 4 });
  doc.rule({ after: 14 });
  const paras = paragraphs(report.body_html);
  if (!paras.length) {
    doc.text('[This report has no text.]', { size: 10.5, style: 'i', color: MUTED });
  }
  for (const para of paras) doc.text(para, { size: 10.5, after: 7, justify: true });
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
    ? attachments.map((a, i) => `${attachmentLabel(i)}. ${a.name}`).join('\n')
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

/**
 * The legislation details sheet.
 *
 * The cover a file gets asked for by number: what it is, where it stands, who
 * sponsored it, what is attached to it, and every action taken on it. It is
 * the sheet a records request means when it names a file rather than a
 * document, and the one a member wants in front of them when an item is called.
 *
 * It carries any matter type, and that is safe in a way the ordinance template
 * is not: this describes the file, it does not speak for the body. Nothing here
 * ordains, resolves or enacts, so there is no instrument to misstate.
 *
 * No `Ver.` column on the history table, though Legistar prints one. This
 * schema records the action, not the version of the text it was taken against
 * (`matter_history` has no version column), so filling it with the file's
 * current version would attach today's number to a vote taken on an earlier
 * draft. An absent column says less than a wrong one.
 */
async function legislationDetails(matter) {
  const body = matter.body_id ? repo.bodies.get(matter.body_id) : null;
  const sponsors = repo.matters.sponsors(matter.id);
  const topics = repo.topics.forMatter(matter.id);
  const attachments = repo.matters.attachments(matter.id);
  const history = repo.matters.history(matter.id);
  const appearances = repo.matters.appearsOn(matter.id);
  const versions = repo.matters.versions(matter.id);
  const version = versions.length ? versions[0].version : 1;

  const doc = await Doc.create({
    footer: officialFooter(`${ORG.name} \u00b7 Legislation details \u00b7 ${matter.file_number}`),
  });

  doc.text(ORG.clerkOffice || ORG.name, { size: 9, style: 'sans', color: MUTED, after: 2 });
  doc.text('LEGISLATION DETAILS', { size: 13, style: 'b', after: 12 });
  doc.rule({ after: 12 });

  const W = doc.contentW;
  const lab = 88;
  const half = (W - lab * 2) / 2;
  const date = (d) => (d ? formatDate(String(d).slice(0, 10)) : '');

  // The scheduled appearance and the disposition. appearsOn() is ordered by
  // meeting date descending, so the earliest row is the last element.
  const scheduled = appearances.length ? appearances[appearances.length - 1] : null;
  const inControl = (body && body.name)
    || (scheduled && scheduled.body_name)
    || ORG.primaryBody;

  doc.table([lab, half, lab, half], [
    ['File #', matter.file_number || '', 'Version', String(version)],
    ['Type', matter.type || '', 'Status', matter.status || ''],
    // `intro_date`, not `created_at`. Legistar heads this column "File
    // created", but created_at is the row's insert time — for anything
    // imported or migrated that is the day of the import, which says something
    // true about the database and nothing about the file. Introduction is the
    // event the record actually turns on.
    ['Introduced', date(matter.intro_date), 'Final action', date(matter.final_date)],
  ], { after: 0 });

  doc.table([lab, W - lab], [
    ['In control', inControl || ''],
    ['On agenda', appearances.length
      ? appearances.map((a) => `${date(a.meeting_date)} \u2014 ${a.body_name}`).join('\n')
      : 'Not yet scheduled'],
    ['Title', matter.title || ''],
    ['Subject', matter.summary || ''],
    ['Sponsors', sponsors.length
      ? sponsors.map((sp) => (sp.sponsor_type === 'Primary' ? `${sp.full_name} (Primary)` : sp.full_name)).join(', ')
      : 'None'],
    ['Indexes', topics.length ? topics.map((t) => t.name).join(', ') : 'None'],
    ['Attachments', attachments.length
      ? attachments.map((a, i) => `${attachmentLabel(i)}. ${a.name}`).join('\n')
      : 'None'],
  ], { after: 16 });

  // Voided entries are shown, struck through in words rather than removed. The
  // board that carried a motion and then voided it did both, and a sheet that
  // prints only the survivors cannot answer "was this ever carried?".
  const rows = history.map((h) => [
    h.body_name || inControl || '',
    date(h.action_date),
    h.voided_at ? `${h.action || ''} (voided)` : (h.action || ''),
    h.voided_at ? '\u2014' : (h.result || ''),
  ]);
  if (!rows.length) rows.push(['No action recorded', '', '', '']);

  doc.table([W - 96 - 68 - 74, 74, 96, 68], rows, {
    head: ['Action by', 'Date', 'Action', 'Result'],
    after: 12,
  });

  const voided = history.filter((h) => h.voided_at).length;
  if (voided) {
    doc.text(`${voided} entr${voided === 1 ? 'y' : 'ies'} shown above ${voided === 1 ? 'has' : 'have'} been voided. `
      + 'A voided action is struck from effect, not from the record.',
    { size: 9, style: 'i', color: MUTED });
  }

  return doc.save();
}

module.exports = { legislationDetails, boardLetter, boardLetterHtml, ordinance, summaryForPublication, approvalLog, reportDoc, attachmentLabel, paragraphs };
