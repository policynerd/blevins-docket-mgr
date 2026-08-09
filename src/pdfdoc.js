'use strict';

// A small layout engine over pdf-lib.
//
// The documents this produces are legal instruments — an ordinance, a notice
// published under statute, an approval log — so they need things the previous
// draw-a-line-at-a-time approach could not do: word wrapping, page breaks that
// carry a running subject header, indented statutory subsections that hang
// correctly, and struck/underlined runs for a redline. Everything here exists
// to serve those five documents; it is not a general typesetting library.
//
// Times rather than Helvetica because that is what board letters and ordinances
// are set in, and because the standard-14 Times faces need no embedding.

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const LETTER = { w: 612, h: 792 };

const INK = rgb(0.06, 0.07, 0.09);
const MUTED = rgb(0.42, 0.46, 0.52);
const RULE = rgb(0.78, 0.76, 0.73);

// A footnote reference is written as a `^n` suffix on the word that carries
// it — "Government Code Section 25124^1" — rather than as a separate token,
// so it survives line-wrapping attached to its word the way a citation mark
// does in print, and needs no change to how paragraphs are split into words.
// Sentence punctuation may follow the digits ("clause^1.", "matter^2,") the
// way a citation mark sits before the period in print — that trailing
// punctuation is captured separately so it draws at the baseline, after the
// raised marker, rather than being swallowed by the digit-only match.
function splitMarker(word) {
  const m = /^(.*\S)\^(\d+)([.,;:)\]]*)$/.exec(word);
  return m ? { base: m[1], marker: m[2], tail: m[3] } : { base: word, marker: null, tail: '' };
}

// A word's drawn width, including its superscript marker if it carries one.
function wordWidth(word, font, size) {
  const { base, marker, tail } = splitMarker(word);
  let w = font.widthOfTextAtSize(base, size);
  if (marker) w += font.widthOfTextAtSize(marker, size * 0.62) + size * 0.04 + font.widthOfTextAtSize(tail, size);
  return w;
}

// A line's natural (unjustified) width: its words at their own widths, plus
// one ordinary space between each.
function lineWidth(words, font, size) {
  const spaceW = font.widthOfTextAtSize(' ', size);
  return words.reduce((s, w) => s + wordWidth(w, font, size), 0) + spaceW * Math.max(0, words.length - 1);
}

class Doc {
  constructor(pdf, fonts, opts = {}) {
    this.pdf = pdf;
    this.f = fonts;
    this.margin = Object.assign({ top: 72, right: 72, bottom: 72, left: 72 }, opts.margin);
    this.size = opts.size || LETTER;
    this.contentW = this.size.w - this.margin.left - this.margin.right;
    // Drawn at the top of every page after the first. Receives (doc, pageNo).
    this.runningHeader = opts.runningHeader || null;
    // Drawn at the bottom of every page. Receives (doc, pageNo, pageCount);
    // deferred to the end so it can print "2 of 5".
    this.footer = opts.footer || null;
    this.pages = [];
    this.page = null;
    this.y = 0;
    // Footnotes, keyed by the physical page they were registered on — a
    // reference on page 3 prints at the bottom of page 3, not wherever save()
    // happens to be looking. footnoteReserve is the vertical space already
    // spoken for by notes on the *current* page, so need() stops body text
    // from running into a footnote registered earlier on the same page.
    this.pageNotes = new Map();
    this.footnoteReserve = 0;
    this.newPage();
  }

  static async create(opts) {
    const pdf = await PDFDocument.create();
    const fonts = {
      r: await pdf.embedFont(StandardFonts.TimesRoman),
      b: await pdf.embedFont(StandardFonts.TimesRomanBold),
      i: await pdf.embedFont(StandardFonts.TimesRomanItalic),
      bi: await pdf.embedFont(StandardFonts.TimesRomanBoldItalic),
      sans: await pdf.embedFont(StandardFonts.Helvetica),
      sansB: await pdf.embedFont(StandardFonts.HelveticaBold),
    };
    return new Doc(pdf, fonts, opts);
  }

  newPage() {
    this.page = this.pdf.addPage([this.size.w, this.size.h]);
    this.pages.push(this.page);
    this.y = this.size.h - this.margin.top;
    this.footnoteReserve = 0;
    if (this.pages.length > 1 && this.runningHeader) this.runningHeader(this, this.pages.length);
    return this.page;
  }

  // Reserve vertical space, breaking to a new page when it will not fit.
  // The footnote band reserved on this page (if any) counts as part of the
  // bottom margin, so body text stops above it rather than running through it.
  // `extra` is space a caller is about to reserve but has not queued yet —
  // text() uses it for a line's own footnote, so the page is chosen with that
  // note's height already accounted for, not after the line is already drawn.
  need(h, extra = 0) {
    if (this.y - h < this.margin.bottom + this.footnoteReserve + extra) this.newPage();
  }

  font(style) {
    if (style === 'b') return this.f.b;
    if (style === 'i') return this.f.i;
    if (style === 'bi') return this.f.bi;
    if (style === 'sans') return this.f.sans;
    if (style === 'sansB') return this.f.sansB;
    return this.f.r;
  }

  // Break a string into lines that fit `width` at `size` in `font`. Words
  // longer than the measure (a URL, a long citation) are hard-split rather
  // than allowed to run off the page.
  //
  // No hyphenation: at the measure these documents are set to (roughly
  // 460pt at 10-11pt type), word-spacing-only justification reads cleanly
  // without it — hyphenation earns its keep in narrow newspaper columns, not
  // a single-column US Letter page. Left as a deliberate choice, not an
  // oversight.
  wrap(str, { width, size, font }) {
    const out = [];
    for (const para of String(str == null ? '' : str).split('\n')) {
      if (!para.trim()) { out.push(''); continue; }
      // Split a word that cannot fit the measure on its own, returning the
      // trailing chunk to carry on the current line. Applied wherever an
      // oversized word lands, not only when it opens a line — a long URL
      // arriving mid-paragraph would otherwise be pushed whole and run off
      // the page.
      const hardSplit = (word) => {
        let chunk = '';
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > width && chunk) { out.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        return chunk;
      };

      let line = '';
      for (const word of para.trim().split(/\s+/)) {
        const oversized = wordWidth(word, font, size) > width;
        if (oversized) {
          if (line) { out.push(line); line = ''; }
          line = hardSplit(word);
          continue;
        }
        const trial = line ? line + ' ' + word : word;
        if (lineWidth(trial.split(' '), font, size) <= width) line = trial;
        else { out.push(line); line = word; }
      }
      if (line) out.push(line);
    }
    return out;
  }

  // A block of body copy.
  //   indent      left inset for every line
  //   hanging     extra inset for lines after the first (statutory subsections
  //               read "(a)  text..." with the runover aligned under the text)
  //   align       'left' | 'center' | 'right'
  //   justify     stretch word-spacing so every line but the last fills the
  //               measure — off by default, since a short line (a heading, a
  //               label) justified to full width would space its few words
  //               out absurdly
  //   underline / strike   redline decoration, drawn per line
  //   notes       { '1': 'footnote text', ... } — text carrying a `word^1`
  //               marker prints a raised "1" there and the note is queued
  //               for the bottom of whichever physical page the marker
  //               actually lands on, which may not be the page text() was
  //               called on if the block spans a break
  text(str, opts = {}) {
    const size = opts.size || 11;
    const font = this.font(opts.style);
    const lead = opts.lead || size * 1.32;
    const indent = opts.indent || 0;
    const hanging = opts.hanging || 0;
    const color = opts.color || INK;
    const width = this.contentW - indent - (opts.rightIndent || 0);
    // wrap() treats each `\n`-delimited segment as its own paragraph, but it
    // returns one flat array of lines with the breaks discarded. Wrapping
    // each paragraph separately here, instead of the whole string at once,
    // costs nothing (same lines come back) but lets every paragraph's own
    // final line — not only the block's last line overall — go unjustified.
    const lines = [];
    const paraEnds = new Set();
    for (const para of String(str == null ? '' : str).split('\n')) {
      const wrapped = this.wrap(para, { width: width - hanging, size, font });
      for (const l of wrapped) lines.push(l);
      if (wrapped.length) paraEnds.add(lines.length - 1);
    }
    const spaceW = font.widthOfTextAtSize(' ', size);

    lines.forEach((line, i) => {
      const lineWords = line ? line.split(' ') : [];
      // A note registered by this line has to be counted before need()
      // decides whether the line itself fits — otherwise a marker landing
      // near the bottom margin can leave its line on a page with no room
      // left for the note, and the band save() draws later overlaps it.
      let noteExtra = 0;
      if (opts.notes) {
        for (const word of lineWords) {
          const { marker } = splitMarker(word);
          if (marker && opts.notes[marker] != null) {
            noteExtra += this._footnoteLines(marker, opts.notes[marker]).length * 10.5;
          }
        }
      }
      this.need(lead, noteExtra);
      const isLastLine = i === lines.length - 1 || paraEnds.has(i);
      const extra = i === 0 ? 0 : hanging;
      // The line was wrapped against `width - hanging` regardless of which
      // line it is (wrap() has no way to know a line's own indent), but a
      // first line rendered at `indent` alone reaches `width` before its
      // right edge meets a continuation line's. Justifying against that
      // wider target, rather than the narrower one it was broken against,
      // is what makes every line's right edge land on the same rule.
      const lineTargetW = i === 0 ? width : width - hanging;
      const words = lineWords;
      const startX = this.margin.left + indent + extra;
      let x = startX;

      if (opts.align === 'center' || opts.align === 'right') {
        const natural = lineWidth(words, font, size);
        x = opts.align === 'center'
          ? startX + (lineTargetW - natural) / 2
          : startX + lineTargetW - natural;
      }

      let gapW = spaceW;
      if (opts.justify && words.length > 1 && !isLastLine && opts.align !== 'center' && opts.align !== 'right') {
        const natural = lineWidth(words, font, size);
        gapW = spaceW + (lineTargetW - natural) / (words.length - 1);
      }

      const lineStartX = x;
      for (const word of words) {
        const { base, marker, tail } = splitMarker(word);
        if (base) {
          this.page.drawText(base, { x, y: this.y - size, size, font, color });
          x += font.widthOfTextAtSize(base, size);
        }
        if (marker) {
          this.page.drawText(marker, {
            x, y: this.y - size + size * 0.32, size: size * 0.62, font, color,
          });
          x += font.widthOfTextAtSize(marker, size * 0.62) + size * 0.04;
          if (opts.notes && opts.notes[marker]) this._queueFootnote(marker, opts.notes[marker]);
          if (tail) {
            this.page.drawText(tail, { x, y: this.y - size, size, font, color });
            x += font.widthOfTextAtSize(tail, size);
          }
        }
        x += gapW;
      }
      const lineEndX = words.length ? x - gapW : lineStartX;

      if (words.length) {
        if (opts.underline) {
          this.page.drawLine({
            start: { x: lineStartX, y: this.y - size - 1.5 }, end: { x: lineEndX, y: this.y - size - 1.5 },
            thickness: 0.6, color,
          });
        }
        if (opts.strike) {
          this.page.drawLine({
            start: { x: lineStartX, y: this.y - size * 0.62 }, end: { x: lineEndX, y: this.y - size * 0.62 },
            thickness: 0.6, color,
          });
        }
      }
      this.y -= lead;
    });
    if (opts.after) this.y -= opts.after;
    return this;
  }

  // The lines a footnote will actually draw as, at the band's own size and
  // width — used both to size the reserve before the note is queued and to
  // draw the band in save(), so the two never disagree about how tall a note
  // is. A citation long enough to wrap gets the extra lines it needs rather
  // than the reserve silently understating it.
  _footnoteLines(num, note) {
    return this.wrap(`${num}. ${note}`, { width: this.contentW, size: 7.5, font: this.f.sans });
  }

  // Register a footnote against the page currently being drawn on. Called
  // mid-line from text(), so `this.page` is already whichever physical page
  // the marker landed on.
  _queueFootnote(num, note) {
    const list = this.pageNotes.get(this.page) || [];
    list.push({ num, note });
    this.pageNotes.set(this.page, list);
    this.footnoteReserve += this._footnoteLines(num, note).length * 10.5;
  }

  heading(str, opts = {}) {
    this.need((opts.size || 11) * 2.4);
    return this.text(str, Object.assign({ style: 'b', after: 4 }, opts));
  }

  gap(h) { this.y -= h; return this; }

  rule(opts = {}) {
    const h = opts.thickness || 0.7;
    this.need(10);
    this.page.drawLine({
      start: { x: this.margin.left + (opts.indent || 0), y: this.y },
      end: { x: this.size.w - this.margin.right, y: this.y },
      thickness: h, color: opts.color || RULE,
    });
    this.y -= (opts.after == null ? 10 : opts.after);
    return this;
  }

  // A signature line with its role beneath — used by the ordinance approval
  // block and the approval log.
  signature(role, opts = {}) {
    const w = opts.width || 260;
    this.need(46);
    this.y -= 22;
    this.page.drawLine({
      start: { x: this.margin.left + (opts.indent || 0), y: this.y },
      end: { x: this.margin.left + (opts.indent || 0) + w, y: this.y },
      thickness: 0.8, color: INK,
    });
    this.y -= 12;
    if (role) this.text(role, { size: 9.5, style: 'sans', color: MUTED, indent: opts.indent || 0 });
    return this;
  }

  // Simple grid. `cols` is an array of widths in points; `rows` an array of
  // arrays of cell strings. Header row is set in bold on a tinted band.
  table(cols, rows, opts = {}) {
    const size = opts.size || 9.5;
    const pad = 6;
    const drawRow = (cells, isHead) => {
      const font = isHead ? this.f.sansB : this.f.sans;
      const wrapped = cells.map((c, i) => this.wrap(c, { width: cols[i] - pad * 2, size, font }));
      const lines = Math.max(1, ...wrapped.map((w) => w.length));
      const h = lines * (size * 1.35) + pad * 2;
      this.need(h);
      let x = this.margin.left;
      if (isHead) {
        this.page.drawRectangle({
          x, y: this.y - h, width: cols.reduce((a, b) => a + b, 0), height: h,
          color: rgb(0.93, 0.91, 0.88),
        });
      }
      cols.forEach((cw, i) => {
        this.page.drawRectangle({
          x, y: this.y - h, width: cw, height: h,
          borderColor: RULE, borderWidth: 0.6,
        });
        (wrapped[i] || []).forEach((line, li) => {
          this.page.drawText(line, {
            x: x + pad, y: this.y - pad - size - li * (size * 1.35),
            size, font, color: INK,
          });
        });
        x += cw;
      });
      this.y -= h;
    };
    if (opts.head) drawRow(opts.head, true);
    for (const r of rows) drawRow(r, false);
    this.y -= (opts.after == null ? 10 : opts.after);
    return this;
  }

  // Footnotes and footers are drawn last, footnotes first: the footer prints
  // at a fixed offset from the bottom edge regardless of page content, and
  // the footnote band sits just above it, so the footer has to already be
  // conceptually "there" — footnotes are drawn from margin.bottom upward,
  // which is where need()'s reservation assumed they would go.
  async save() {
    for (const [page, notes] of this.pageNotes) {
      const prev = this.page;
      this.page = page;
      const noteLines = notes.map((n) => this._footnoteLines(n.num, n.note));
      const totalLines = noteLines.reduce((sum, ls) => sum + ls.length, 0);
      const bandTop = this.margin.bottom + totalLines * 10.5;
      this.page.drawLine({
        start: { x: this.margin.left, y: bandTop },
        end: { x: this.margin.left + 130, y: bandTop },
        thickness: 0.5, color: RULE,
      });
      let row = 0;
      noteLines.forEach((ls) => {
        ls.forEach((lineText) => {
          this.at(this.margin.left, bandTop - 9 - row * 10.5, lineText, { size: 7.5, style: 'sans', color: MUTED });
          row += 1;
        });
      });
      this.page = prev;
    }
    if (this.footer) {
      this.pages.forEach((p, i) => {
        const prev = this.page;
        this.page = p;
        this.footer(this, i + 1, this.pages.length);
        this.page = prev;
      });
    }
    return this.pdf.save();
  }

  // Absolute placement, for mastheads and footers that sit outside the flow.
  at(x, y, str, opts = {}) {
    const size = opts.size || 9;
    this.page.drawText(String(str == null ? '' : str), {
      x, y, size, font: this.font(opts.style), color: opts.color || INK,
    });
    return this;
  }
}

module.exports = { Doc, LETTER, INK, MUTED, RULE };
