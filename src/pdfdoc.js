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
    if (this.pages.length > 1 && this.runningHeader) this.runningHeader(this, this.pages.length);
    return this.page;
  }

  // Reserve vertical space, breaking to a new page when it will not fit.
  need(h) {
    if (this.y - h < this.margin.bottom) this.newPage();
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
        const oversized = font.widthOfTextAtSize(word, size) > width;
        if (oversized) {
          if (line) { out.push(line); line = ''; }
          line = hardSplit(word);
          continue;
        }
        const trial = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(trial, size) <= width) line = trial;
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
  //   underline / strike   redline decoration, drawn per line
  text(str, opts = {}) {
    const size = opts.size || 11;
    const font = this.font(opts.style);
    const lead = opts.lead || size * 1.32;
    const indent = opts.indent || 0;
    const hanging = opts.hanging || 0;
    const color = opts.color || INK;
    const width = this.contentW - indent - (opts.rightIndent || 0);
    const lines = this.wrap(str, { width: width - hanging, size, font });

    lines.forEach((line, i) => {
      this.need(lead);
      const extra = i === 0 ? 0 : hanging;
      let x = this.margin.left + indent + extra;
      if (opts.align === 'center') {
        x = this.margin.left + indent + (width - font.widthOfTextAtSize(line, size)) / 2;
      } else if (opts.align === 'right') {
        x = this.margin.left + indent + width - font.widthOfTextAtSize(line, size);
      }
      if (line) {
        this.page.drawText(line, { x, y: this.y - size, size, font, color });
        const w = font.widthOfTextAtSize(line, size);
        if (opts.underline) {
          this.page.drawLine({ start: { x, y: this.y - size - 1.5 }, end: { x: x + w, y: this.y - size - 1.5 }, thickness: 0.6, color });
        }
        if (opts.strike) {
          this.page.drawLine({ start: { x, y: this.y - size * 0.62 }, end: { x: x + w, y: this.y - size * 0.62 }, thickness: 0.6, color });
        }
      }
      this.y -= lead;
    });
    if (opts.after) this.y -= opts.after;
    return this;
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

  // Footers are drawn last so they can carry the final page count.
  async save() {
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
