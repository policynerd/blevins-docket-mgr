'use strict';

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { ORG } = require('./org');
const repo = require('./repo');
const { formatDate, formatDateTime } = require('./util');
const { Doc, MUTED: MUTED2 } = require('./pdfdoc');
const documents = require('./documents');
const render = require('./render');
const docprint = require('./docprint');
const upload = require('./upload');
const fs = require('node:fs');

function upper(v) { return String(v == null ? '' : v).toUpperCase(); }

const HTTPS_URL = /^https:\/\/[^"'<>\s]+$/;

/**
 * A file uploaded through the application, read off disk.
 *
 * The packet only knew how to fetch remote https URLs, so an attachment a
 * clerk uploaded — which is stored on the volume and has a `file_path` and no
 * URL — was reported as "could not be bound" on the incomplete-packet page.
 * The ordinary case of attaching a document to a file therefore never reached
 * the packet at all.
 *
 * The header is checked rather than the stored content type or the file name:
 * a mislabelled upload should fall through to the placeholder page, not crash
 * the merge.
 */
function localPdfBytes(att) {
  if (!att || !att.file_path) return null;
  const abs = upload.uploadPath(att.file_path);
  if (!abs) return null;
  try {
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function fetchPdfBytes(url) {
  if (!HTTPS_URL.test(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('pdf')) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// US Letter in points
const W = 612;
const H = 792;
const MARGIN = 72;
const CONTENT_W = W - 2 * MARGIN;

const INK = rgb(0.08, 0.08, 0.08);
const MUTED = rgb(0.45, 0.45, 0.45);
const ACCENT = rgb(0.083, 0.337, 0.62);

// The meeting packet: the documents themselves, bound in agenda order.
//
// This used to be a listing — it printed the names of the attachments and
// stopped. A packet whose contents are a table of names is not a packet; a
// member sitting down with it has nothing to read. Each item's material is
// now generated and bound behind a tab divider, in the order the tab numbers
// were assigned by repo.meetings.packet(), so the divider, the table of
// contents and the item itself cannot disagree about which tab is which.
//
// Items the clerk held back are omitted entirely, and items carrying nothing
// keep their place in the contents without taking a tab.
async function generatePacket(meeting) {
  const rows = repo.meetings.packet(meeting.id);
  const out = await PDFDocument.create();
  const problems = [];

  // Merge one generated or fetched PDF into the packet.
  const merge = async (bytes) => {
    if (!bytes) return 0;
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const pg of pages) out.addPage(pg);
    return pages.length;
  };

  /**
   * One sheet of the packet's own furniture — a cover, a divider, a separator.
   *
   * HTML through the browser where there is one, and the drawn version where
   * there is not. Every caller gets bytes either way, so a container without
   * the browser package still assembles a complete packet; it just assembles
   * the one that was drawn.
   */
  const sheet = async (html, drawn) => {
    if (render.available()) {
      try { return await render.render(html, { footerTemplate: packetFooter }); } catch (e) {
        // Fall through, but on the record. A fault in the markup throws before
        // this, while the string is being built, so a real bug still surfaces.
        render.noteFailure(`packet sheet: ${e.message}`);
      }
    }
    return drawn();
  };

  // Generate a document, but never let one bad item take the whole packet
  // down. A packet that fails entirely on the morning of a meeting is worse
  // than one that names what is missing, and the name is what lets a clerk
  // fix it before distribution.
  const safely = async (label, fn) => {
    try { return await fn(); } catch (e) {
      problems.push(`${label}: ${e.message}`);
      return null;
    }
  };

  // --- Cover and contents ---
  // No page count in this footer: the front matter does not know how long the
  // packet is, and reporting its own length here read "1 of 1" on the cover of
  // a twelve-page packet. Packet-wide numbering is stamped after the merge.
  const packetFooter = docprint.footerPlain(`${ORG.name} \u00b7 Agenda packet`);
  const entries = rows.filter((r) => r.included).map((r) => {
    const it = r.item;
    return {
      tab: r.tab ? `Tab ${r.tab}` : '',
      label: (it.agenda_number ? `${it.agenda_number}. ` : '')
        + (it.matter_id ? `${it.file_number} \u2014 ${it.matter_title}` : (it.title || '(item)')),
    };
  });
  const front = await Doc.create({
    footer: (d) => {
      d.at(d.margin.left, d.margin.bottom - 26, `${ORG.name} \u00b7 Agenda packet`,
        { size: 8, style: 'sans', color: MUTED2 });
    },
  });
  // The organisation and the body are usually configured to the same name, and
  // the cover printed both — "BOARD OF GOVERNORS" over "Board of Governors",
  // which reads as a stutter rather than as two facts. Say it once when they
  // agree, as the board letter already does.
  front.text(upper(ORG.name), { size: 16, style: 'b', after: 6 });
  if (meeting.body_name && upper(meeting.body_name) !== upper(ORG.name)) {
    front.text(meeting.body_name, { size: 13, style: 'b', after: 4 });
  }
  front.text('AGENDA PACKET', { size: 11, style: 'sans', color: MUTED2, after: 10 });
  front.rule({ after: 14 });
  front.text(formatDateTime(meeting.meeting_date, meeting.meeting_time), { size: 12, after: 4 });
  if (meeting.location) front.text(meeting.location, { size: 11, color: MUTED2, after: 4 });
  front.text(`Status: ${meeting.status || ''}`, { size: 10, color: MUTED2, after: 18 });

  const withTabs = rows.filter((r) => r.tab);
  front.heading('CONTENTS', { size: 12 });
  if (!withTabs.length) {
    front.text('No item on this agenda carries supporting material.',
      { size: 10.5, style: 'i', color: MUTED2, after: 8 });
  }
  for (const r of rows) {
    if (!r.included) continue;
    const it = r.item;
    const num = it.agenda_number ? `${it.agenda_number}. ` : '';
    const title = it.matter_id ? `${it.file_number} \u2014 ${it.matter_title}` : (it.title || '(item)');
    // An item carrying nothing keeps its place in the contents and takes no
    // tab. It used to print an em-dash in the tab column, which reads as a
    // value that failed to load rather than as "there is nothing behind this
    // one" — blank says that without claiming anything.
    const tab = r.tab ? `Tab ${r.tab}` : '';
    // A tab column, not a prefix. This was `${tab}    ${num}${title}` — padded
    // with spaces that the layout discards — so a tabbed row read "Tab 1 5.A.
    // 260802 — …" with the tab run into the agenda number, while an untabbed
    // row started flush at its number. Two left edges in one list, and no
    // column to scan down. The label sits in its own column and an item
    // carrying nothing leaves that column blank, which says "nothing behind
    // this one" without claiming anything.
    front.field(tab, `${num}${title}`, { size: 10.5, labelW: 52, after: 3 });
  }
  await merge(await sheet(
    docprint.packetCover(meeting, formatDateTime(meeting.meeting_date, meeting.meeting_time), entries),
    () => front.save()));

  // --- Each item's material, behind its tab ---
  for (const r of rows) {
    // A tab is only assigned to an included item, so this covers both: an item
    // the clerk held back never reaches here.
    if (!r.tab) continue;
    const it = r.item;
    const matter = it.matter_id ? repo.matters.get(it.matter_id) : null;

    // Divider: what this tab is, so a packet opened at random is navigable.
    const dividerTitle = matter ? `${it.file_number} \u2014 ${it.matter_title}` : (it.title || '');
    await merge(await sheet(
      docprint.divider({ tab: r.tab, agendaNumber: it.agenda_number,
        title: dividerTitle, section: it.section }),
      async () => {
        const div = await Doc.create({});
        div.gap(150);
        div.text(`TAB ${r.tab}`, { size: 28, style: 'b', align: 'center', after: 14 });
        if (it.agenda_number) {
          div.text(`Agenda item ${it.agenda_number}`, { size: 12, style: 'sans', color: MUTED2, align: 'center', after: 8 });
        }
        div.text(dividerTitle, { size: 13, align: 'center', after: 6 });
        if (it.section) div.text(it.section, { size: 10, style: 'sans', color: MUTED2, align: 'center' });
        return div.save();
      }));

    if (matter) {
      await merge(await safely(`${it.file_number} board letter`,
        () => documents.boardLetter(matter, { date: meeting.meeting_date })));

      if (matter.type === 'Ordinance') {
        await merge(await safely(`${it.file_number} ordinance`,
          () => documents.ordinance(matter)));
        await merge(await safely(`${it.file_number} redline`,
          () => documents.ordinance(matter, { redline: true })));
        // The notice belongs in the packet only for the meeting it notices,
        // which is this one.
        await merge(await safely(`${it.file_number} summary`,
          () => documents.summaryForPublication(matter, meeting)));
      }

      for (const rep of r.reports) {
        const full = repo.reports.get(rep.id);
        if (full) {
          await merge(await safely(`${it.file_number} ${rep.title}`,
            () => documents.reportDoc(matter, full)));
        }
      }
    }

    // Attachments and item documents: bind the PDF where it can be fetched,
    // and where it cannot, say so on its own page rather than leaving a gap
    // the reader has to notice.
    const files = [
      ...r.attachments.map((a) => ({
        name: a.name, url: a.url, file_path: a.file_path, kind: 'Attachment',
      })),
      ...r.docs.map((d) => ({ name: d.name, url: d.url, kind: 'Item document' })),
    ];
    for (const f of files) {
      // Uploaded first: a file held on the volume is the copy this board
      // controls, and it needs no network to bind.
      const bytes = localPdfBytes(f) || (f.url ? await fetchPdfBytes(f.url) : null);
      let sepNote = null;
      if (!bytes) {
        // Three different reasons, which want three different answers. A Word
        // document is not a retrieval failure and never will be: telling a
        // clerk to go and fix it wastes their morning, when what they need to
        // know is that it has to be converted or handed round separately.
        const notPdf = /\.(docx?|xlsx?|pptx?|txt|rtf|csv|png|jpe?g)$/i.test(f.name || '')
          || (f.file_path && !/\.pdf$/i.test(f.file_path));
        sepNote = notPdf
          ? 'This document is not a PDF and cannot be bound into the packet. '
            + 'Convert it to PDF to include it, or distribute it separately.'
          : (f.url
            ? 'This document is stored outside the packet and could not be retrieved when the packet was built.'
            : 'This document has no file or link attached to it.');
        problems.push(`${it.file_number || it.title}: ${f.name} `
          + (notPdf ? 'is not a PDF and was not bound' : 'could not be bound'));
      }
      const sepUrl = (!bytes && f.url && !/\.(docx?|xlsx?|pptx?|txt|rtf|csv|png|jpe?g)$/i.test(f.name || ''))
        ? f.url : null;
      await merge(await sheet(
        docprint.separator({ kind: f.kind, name: f.name, note: sepNote, url: sepUrl }),
        async () => {
          const sep = await Doc.create({});
          sep.gap(120);
          sep.text(f.kind.toUpperCase(), { size: 10, style: 'sans', color: MUTED2, align: 'center', after: 8 });
          sep.text(f.name, { size: 14, style: 'b', align: 'center', after: 8 });
          if (sepNote) sep.text(sepNote, { size: 10.5, style: 'i', color: MUTED2, align: 'center' });
          if (sepUrl) sep.text(sepUrl, { size: 9, color: MUTED2, align: 'center' });
          return sep.save();
        }));
      if (bytes) await safely(`${f.name}`, () => merge(bytes));
    }
  }

  // --- What could not be bound ---
  // Printed at the front of the reader's attention rather than buried: this
  // is the page that tells a clerk the packet is short before it goes out.
  if (problems.length) {
    const warn = await Doc.create({});
    warn.text('INCOMPLETE PACKET', { size: 14, style: 'b', after: 8 });
    warn.text(`${problems.length} document${problems.length === 1 ? '' : 's'} could not be included:`,
      { size: 11, after: 10 });
    for (const p of problems) warn.text(`\u2022 ${p}`, { size: 10.5, indent: 12, hanging: 12, after: 4 });
    warn.gap(10);
    warn.text('Resolve these before distributing the packet.', { size: 10.5, style: 'i' });
    const bytes = await warn.save();
    const src = await PDFDocument.load(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    // Insert after the cover so it is seen, not appended where it is not.
    pages.reverse().forEach((pg) => out.insertPage(1, pg));
  }

  // Packet-wide page numbers, stamped bottom-centre after everything is bound.
  // Each embedded document already carries its own "Page 1 of 3" at the edges,
  // which is the right number for that document and the wrong one for the
  // packet; this is the number a chair means by "turn to page 40". Centre
  // keeps the two from colliding.
  const stamp = await out.embedFont(StandardFonts.Helvetica);
  const pages = out.getPages();
  pages.forEach((pg, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const w = stamp.widthOfTextAtSize(label, 8);
    const { width } = pg.getSize();
    pg.drawText(label, {
      x: (width - w) / 2, y: 26, size: 8, font: stamp,
      color: rgb(0.42, 0.46, 0.52),
    });
  });

  return out.save();
}

// Strip HTML to plain paragraphs for the consent body (the result is drawn as
// PDF text, never re-rendered as HTML).
function htmlToParagraphs(html) {
  let text = String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ');
  // Remove remaining tags; loop until stable so nested or split tags
  // (e.g. "<scr<b>ipt>") can't survive a single pass, then drop stray brackets.
  let prev;
  do { prev = text; text = text.replace(/<[^>]*>/g, ''); } while (text !== prev);
  text = text.replace(/[<>]/g, '');
  // Decode entities, with &amp; LAST so "&amp;lt;" stays the literal "&lt;".
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  return text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

// Unanimous-written-consent cover sheet: the resolution text plus a signature
// line for each director. Signatures are captured by the e-sign provider or
// in person; this is the document of record.
async function generateConsent(consent, signers) {
  const pdfDoc = await PDFDocument.create();
  const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let page = pdfDoc.addPage([W, H]);
  let y = H - MARGIN;

  const ensure = (need) => { if (y - need < MARGIN) { page = pdfDoc.addPage([W, H]); y = H - MARGIN; } };
  const wrap = (str, size, font) => {
    const words = String(str).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const trial = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(trial, size) > CONTENT_W && line) { lines.push(line); line = w; }
      else line = trial;
    }
    if (line) lines.push(line);
    return lines;
  };
  const para = (str, { size = 10.5, font = fontR, color = INK, gap = 6, lead = 14 } = {}) => {
    for (const ln of wrap(str, size, font)) {
      ensure(lead);
      page.drawText(ln, { x: MARGIN, y, size, font, color });
      y -= lead;
    }
    y -= gap;
  };

  para(ORG.name, { size: 18, font: fontB, color: ACCENT, gap: 4, lead: 22 });
  if (consent.body_name) para(consent.body_name, { size: 13, font: fontB, gap: 4, lead: 17 });
  para('ACTION BY UNANIMOUS WRITTEN CONSENT', { size: 11, font: fontB, color: MUTED, gap: 2, lead: 15 });
  para(consent.number + '  ·  ' + formatDate(consent.created_at || new Date().toISOString()), { size: 10, color: MUTED, gap: 12, lead: 13 });

  para(consent.title, { size: 13, font: fontB, gap: 10, lead: 17 });
  para('The undersigned, constituting all of the members of the ' + (consent.body_name || 'body')
    + ', hereby adopt the following resolution by unanimous written consent, without a meeting:',
  { size: 10.5, gap: 12 });

  for (const p of htmlToParagraphs(consent.body_html)) para(p, { size: 10.5, gap: 8 });

  y -= 8;
  ensure(30);
  para('SIGNATURES', { size: 11, font: fontB, color: ACCENT, gap: 10, lead: 15 });
  for (const s of signers) {
    ensure(46);
    page.drawLine({ start: { x: MARGIN, y: y }, end: { x: MARGIN + 260, y: y }, thickness: 0.75, color: MUTED });
    y -= 13;
    page.drawText(s.name + (s.status === 'Signed' ? '   (signed' + (s.signed_at ? ' ' + formatDate(s.signed_at) : '') + ')' : ''),
      { x: MARGIN, y, size: 10, font: fontB, color: INK });
    y -= 30;
  }
  return pdfDoc.save();
}

module.exports = { generatePacket, generateConsent };
