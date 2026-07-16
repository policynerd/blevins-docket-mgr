'use strict';

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { ORG } = require('./org');
const repo = require('./repo');
const { formatDate, formatDateTime } = require('./util');

const HTTPS_URL = /^https:\/\/[^"'<>\s]+$/;

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

async function generatePacket(meeting) {
  const pdfDoc = await PDFDocument.create();
  const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  function addPage() {
    return { page: pdfDoc.addPage([W, H]), y: H - MARGIN };
  }

  function drawLine(page, text, { x = MARGIN, y, size = 10, font = fontR, color = INK } = {}) {
    const str = String(text == null ? '' : text);
    if (!str) return;
    page.drawText(str, { x, y, size, font, color, maxWidth: CONTENT_W });
  }

  // ---- Cover page ----
  let { page, y } = addPage();

  drawLine(page, ORG.name, { y, size: 20, font: fontB, color: ACCENT });
  y -= 28;
  drawLine(page, meeting.body_name, { y, size: 16, font: fontB });
  y -= 24;
  drawLine(page, 'Agenda Packet', { y, size: 14, color: MUTED });
  y -= 22;
  drawLine(page, formatDateTime(meeting.meeting_date, meeting.meeting_time), { y, size: 12 });
  y -= 16;
  if (meeting.location) {
    drawLine(page, meeting.location, { y, size: 12, color: MUTED });
    y -= 16;
  }
  drawLine(page, 'Status: ' + (meeting.status || ''), { y, size: 11, color: MUTED });

  // ---- Agenda items ----
  const items = repo.meetings.items(meeting.id);
  let current = addPage();
  page = current.page;
  y = current.y;

  function ensure(needed) {
    if (y - needed < MARGIN) {
      current = addPage();
      page = current.page;
      y = current.y;
    }
  }

  let lastSection = null;
  for (const it of items) {
    if (it.section && it.section !== lastSection) {
      lastSection = it.section;
      ensure(28);
      drawLine(page, it.section.toUpperCase(), { y, size: 11, font: fontB, color: ACCENT });
      y -= 18;
    }

    ensure(48);
    const numPart = it.agenda_number ? it.agenda_number + '. ' : '';
    const filePart = it.file_number ? '[' + it.file_number + '] ' : '';
    const titleLine = numPart + filePart + (it.matter_title || it.title || '');
    drawLine(page, titleLine, { y, size: 10, font: fontB });
    y -= 14;

    if (it.matter_type) {
      drawLine(page, it.matter_type, { y, size: 9, color: MUTED });
      y -= 12;
    }

    if (it.action) {
      const actionText = 'Action: ' + it.action + (it.result ? ' — ' + it.result : '');
      drawLine(page, actionText, { y, size: 9 });
      y -= 12;
    }

    if (it.matter_id) {
      const tally = repo.votes.tally(it.id);
      const total = (tally.Yea || 0) + (tally.Nay || 0) + (tally.Abstain || 0) +
        (tally.Recused || 0) + (tally.Absent || 0);
      if (total > 0) {
        const t = `Vote: Yea ${tally.Yea}, Nay ${tally.Nay}` +
          (tally.Abstain ? `, Abstain ${tally.Abstain}` : '') +
          (tally.Absent ? `, Absent ${tally.Absent}` : '');
        ensure(14);
        drawLine(page, t, { y, size: 9 });
        y -= 12;
      }

      const attachments = repo.matters.attachments(it.matter_id);
      if (attachments.length) {
        ensure(14);
        drawLine(page, 'Attachments:', { y, size: 9, font: fontB });
        y -= 12;
        for (const a of attachments) {
          ensure(13);
          drawLine(page, '  • ' + a.name, { y, size: 9, color: MUTED });
          y -= 12;
        }
      }
    }

    y -= 8;
  }

  // ---- Append external PDF attachments ----
  const seen = new Set();
  for (const it of items) {
    if (!it.matter_id) continue;
    const attachments = repo.matters.attachments(it.matter_id);
    for (const a of attachments) {
      if (!a.url || seen.has(a.url)) continue;
      seen.add(a.url);
      const bytes = await fetchPdfBytes(a.url);
      if (!bytes) continue;
      try {
        const extDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        // Separator page
        const { page: sep } = addPage();
        drawLine(sep, a.name, { y: H / 2 + 20, size: 14, font: fontB });
        const context = it.file_number || (it.matter_title ? it.matter_title.slice(0, 80) : '');
        if (context) drawLine(sep, context, { y: H / 2, size: 11, color: MUTED });
        // Copy pages
        const indices = extDoc.getPageIndices();
        const copied = await pdfDoc.copyPages(extDoc, indices);
        for (const cp of copied) pdfDoc.addPage(cp);
      } catch {
        // Skip unreadable or encrypted PDFs silently
      }
    }
  }

  return pdfDoc.save();
}

// Strip HTML to plain paragraphs for the consent body.
function htmlToParagraphs(html) {
  const text = String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
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
