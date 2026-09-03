'use strict';

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { ORG } = require('./org');
const repo = require('./repo');
const { formatDate, formatDateTime } = require('./util');
const { MUTED: MUTED2 } = require('./pdfdoc');
const { flow } = require('./flow');
const documents = require('./documents');
const render = require('./render');
const packetprint = require('./packetprint');
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
// Packet furniture is deliberately separate from the legal instruments it
// contains. Cover, contents, tab dividers and separator sheets come from
// packetprint.js; board letters, ordinances, reports and attachments retain
// their own native document formatting.
async function generatePacket(meeting) {
  const rows = repo.meetings.packet(meeting.id);
  const body = await PDFDocument.create();
  const problems = [];
  let documentCount = 0;

  // Merge one generated or fetched PDF into any destination document.
  const mergeInto = async (target, bytes) => {
    if (!bytes) return 0;
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await target.copyPages(src, src.getPageIndices());
    for (const pg of pages) target.addPage(pg);
    return pages.length;
  };
  const mergeBody = (bytes) => mergeInto(body, bytes);

  const when = formatDateTime(meeting.meeting_date, meeting.meeting_time);
  const packetIdentity = [ORG.name, meeting.body_name, 'Agenda packet'].filter(Boolean).join(' · ');
  const packetFooter = packetprint.footerPlain(packetIdentity);
  const packetFooterDrawn = (d) => {
    d.at(d.margin.left, d.margin.bottom - 26, packetIdentity,
      { size: 8, style: 'sans', color: MUTED2 });
  };

  /** One sheet of packet furniture, rendered by Chromium where available. */
  const sheet = async (html) => {
    if (render.available()) {
      try { return await render.render(html, { footerTemplate: packetFooter }); } catch (e) {
        render.noteFailure(`packet sheet: ${e.message}`);
      }
    }
    return flow(html, { footer: packetFooterDrawn });
  };

  // A single bad supporting document must not take down the entire packet.
  const safely = async (label, fn) => {
    try { return await fn(); } catch (e) {
      problems.push(`${label}: ${e.message}`);
      return null;
    }
  };

  // Count only documents that actually make it into the bound packet. Divider
  // and separator sheets are packet furniture and do not inflate this number.
  const bindGenerated = async (label, fn) => {
    const bytes = await safely(label, fn);
    if (!bytes) return 0;
    const n = await mergeBody(bytes);
    if (n) documentCount += 1;
    return n;
  };

  // Contents entries are created before binding, then filled with the packet
  // page where each tab begins after front matter is paginated.
  const entries = rows.filter((r) => r.included).map((r) => {
    const it = r.item;
    return {
      tab: r.tab || null,
      agendaNumber: it.agenda_number || '',
      fileNumber: it.matter_id ? (it.file_number || '') : '',
      title: it.matter_id ? (it.matter_title || '') : (it.title || '(item)'),
      section: it.section || '',
      bodyPage: null,
      page: null,
    };
  });
  const entryByTab = new Map(entries.filter((e) => e.tab != null)
    .map((e) => [String(e.tab), e]));

  // --- Each item's material, behind its tab --------------------------------
  for (const r of rows) {
    if (!r.tab) continue;
    const it = r.item;
    const matter = it.matter_id ? repo.matters.get(it.matter_id) : null;
    const entry = entryByTab.get(String(r.tab));
    if (entry) entry.bodyPage = body.getPageCount() + 1;

    const dividerTitle = matter ? `${it.file_number} — ${it.matter_title}` : (it.title || '');
    await mergeBody(await sheet(packetprint.divider({
      tab: r.tab,
      agendaNumber: it.agenda_number,
      title: dividerTitle,
      section: it.section,
    })));

    if (matter) {
      await bindGenerated(`${it.file_number} board letter`,
        () => documents.boardLetter(matter, { date: meeting.meeting_date }));

      if (matter.type === 'Ordinance') {
        await bindGenerated(`${it.file_number} ordinance`,
          () => documents.ordinance(matter));
        await bindGenerated(`${it.file_number} redline`,
          () => documents.ordinance(matter, { redline: true }));
        await bindGenerated(`${it.file_number} summary`,
          () => documents.summaryForPublication(matter, meeting));
      }

      for (const rep of r.reports) {
        const full = repo.reports.get(rep.id);
        if (full) {
          await bindGenerated(`${it.file_number} ${rep.title}`,
            () => documents.reportDoc(matter, full));
        }
      }
    }

    const files = [
      ...r.attachments.map((a) => ({
        name: a.name, url: a.url, file_path: a.file_path, kind: 'Attachment',
      })),
      ...r.docs.map((d) => ({ name: d.name, url: d.url, kind: 'Item document' })),
    ];

    for (const f of files) {
      const bytes = localPdfBytes(f) || (f.url ? await fetchPdfBytes(f.url) : null);
      let sepNote = null;
      if (!bytes) {
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
      await mergeBody(await sheet(packetprint.separator({
        kind: f.kind,
        name: f.name,
        note: sepNote,
        url: sepUrl,
      })));
      if (bytes) {
        const n = await safely(`${f.name}`, () => mergeBody(bytes));
        if (n) documentCount += 1;
      }
    }
  }

  // Build the quality-control page now so its page count can be included when
  // calculating the tab start pages printed in the contents.
  let problemBytes = null;
  let problemPages = 0;
  if (problems.length) {
    problemBytes = await sheet(packetprint.problems(problems));
    const pdoc = await PDFDocument.load(problemBytes, { ignoreEncryption: true });
    problemPages = pdoc.getPageCount();
  }

  // Contents pagination is a two-pass operation. The number of contents pages
  // is independent of the page-number values themselves because that column is
  // fixed width. Render once to know the front-matter length, calculate each
  // tab's true packet page, then render the final contents.
  const provisionalContents = await sheet(packetprint.contents(meeting, entries));
  const provisionalContentsDoc = await PDFDocument.load(provisionalContents, { ignoreEncryption: true });
  let contentsPages = provisionalContentsDoc.getPageCount();

  const coverBytes = await sheet(packetprint.cover(meeting, when, {
    itemCount: entries.length,
    tabCount: entries.filter((e) => e.tab != null).length,
    documentCount,
  }));
  const coverDoc = await PDFDocument.load(coverBytes, { ignoreEncryption: true });
  const coverPages = coverDoc.getPageCount();

  const applyPacketPages = () => {
    for (const e of entries) {
      e.page = e.bodyPage == null
        ? null
        : coverPages + contentsPages + problemPages + e.bodyPage;
    }
  };
  applyPacketPages();
  let contentsBytes = await sheet(packetprint.contents(meeting, entries));
  let contentsDoc = await PDFDocument.load(contentsBytes, { ignoreEncryption: true });

  // Extremely long agenda titles can, in theory, push the numbered contents
  // onto one extra page. Recalculate once if that happens so page references
  // remain true instead of being off by one for the rest of the book.
  if (contentsDoc.getPageCount() !== contentsPages) {
    contentsPages = contentsDoc.getPageCount();
    applyPacketPages();
    contentsBytes = await sheet(packetprint.contents(meeting, entries));
    contentsDoc = await PDFDocument.load(contentsBytes, { ignoreEncryption: true });
  }

  // Final binding order: cover, contents, quality-control notice (if any), then
  // the agenda material in tab order.
  const out = await PDFDocument.create();
  await mergeInto(out, coverBytes);
  await mergeInto(out, contentsBytes);
  if (problemBytes) await mergeInto(out, problemBytes);
  if (body.getPageCount()) await mergeInto(out, await body.save());

  // Useful metadata for Finder/Explorer, PDF readers and document-management
  // systems. A packet should identify itself even when its filename is lost.
  const packetTitle = `${meeting.body_name || ORG.name} Agenda Packet — ${formatDate(meeting.meeting_date)}`;
  out.setTitle(packetTitle);
  out.setSubject(`Agenda packet for ${when}`);
  out.setAuthor(ORG.name);
  out.setCreator(`${ORG.name} Legislative Information Center`);
  out.setProducer(`${ORG.name} Legislative Information Center`);
  out.setCreationDate(new Date());
  out.setModificationDate(new Date());
  if (typeof out.setKeywords === 'function') {
    out.setKeywords(['agenda packet', 'board meeting', meeting.body_name || ORG.name]);
  }

  // Continuous packet numbering. Embedded documents may carry their own page
  // numbers; this label is explicitly named "Packet page" so there is no
  // ambiguity about which numbering system a chair or clerk is citing.
  const stamp = await out.embedFont(StandardFonts.TimesRoman);
  const pages = out.getPages();
  pages.forEach((pg, i) => {
    const label = `Packet page ${i + 1} of ${pages.length}`;
    const size = 7.5;
    const w = stamp.widthOfTextAtSize(label, size);
    const { width } = pg.getSize();
    pg.drawText(label, {
      x: (width - w) / 2,
      y: 18,
      size,
      font: stamp,
      color: rgb(0.40, 0.44, 0.49),
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