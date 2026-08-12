'use strict';

// The body lockup: the Board's name over the name of one of its bodies.
//
// A seal is the mark of the whole Board. A lockup answers a narrower question,
// and the one the room actually asks: which body is sitting? The Board of
// Governors, the Planning Commission and the Committee on Appropriations all
// meet in the same chamber, on the same screen, and the person who walks in
// late needs to know within a second which one of them is in session.
//
// Drawn rather than uploaded, for the same reasons as the seal: it is set from
// the body's own row, so it re-letters itself when a committee is renamed and
// a new committee needs no artwork commissioned before it can meet. Twelve
// bodies would otherwise be twelve files to keep in step with twelve names.
//
// The accent is the only thing that varies between them. The Board's name is
// always slate — it is the same Board — and the accent carries the body: its
// rule, its name, and the small "of" that ties the two lines together.

const { ORG } = require('./org');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const SLATE = '#353D4F';
const PAPER = '#F7F6F2';

// A body with no accent of its own is set in the Board's slate rather than
// given a colour at random. An arbitrary hue would read as meaning something.
const DEFAULT_ACCENT = SLATE;

// Only a hex colour. This is interpolated into SVG attributes, and the value
// comes from an admin form; anything else falls back rather than being escaped
// and hoped for.
const HEX = /^#[0-9A-Fa-f]{6}$/;
function accentOf(body) {
  const v = body && body.accent_color;
  return HEX.test(String(v || '')) ? String(v) : DEFAULT_ACCENT;
}

// --- Carrying an accent onto the wall ----------------------------------------
//
// The accents are chosen against cream paper, where a deep crimson or forest
// green reads as authority. On the chamber display — white on black, read from
// the back of a room — the dark end of that palette simply disappears: the
// crimson of the Planning Commission came out near-black on black.
//
// So the accent is lifted for a dark ground rather than a second palette being
// kept. One colour per body stays the fact; how far it has to be raised to
// survive the surface it is printed on is a rendering concern, and belongs
// here rather than in the hands of whoever picks the colour.

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance, per WCAG. 0 is black, 1 is white. */
function luminance({ r, g, b }) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function parseHex(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function toHex({ r, g, b }) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Contrast against black is (L + 0.05) / 0.05, so a target ratio fixes a
// minimum luminance. 7:1 — AAA for body text — is the floor here rather than
// the 4.5:1 that would do for a screen at arm's length. This one is read at
// the far end of a room, sometimes by people who are standing.
const WALL_MIN_LUMINANCE = 0.30;

/**
 * Raise a colour until it carries on black, keeping its hue.
 *
 * Blends toward white in small steps rather than converting through HSL: on
 * these accents the two are visually indistinguishable, and mixing keeps the
 * relationship between the channels — a lifted crimson still reads as crimson
 * rather than sliding toward pink.
 */
function forDarkGround(hex) {
  if (!HEX.test(hex)) return '#FFFFFF';
  let c = parseHex(hex);
  for (let i = 0; i < 24 && luminance(c) < WALL_MIN_LUMINANCE; i++) {
    c = { r: c.r + (255 - c.r) * 0.12, g: c.g + (255 - c.g) * 0.12, b: c.b + (255 - c.b) * 0.12 };
  }
  return toHex(c);
}

/** The accent as it should be drawn on a given ground. */
function accentFor(body, ground) {
  const accent = accentOf(body);
  return ground === 'dark' ? forDarkGround(accent) : accent;
}

/**
 * Split the Board's name across lines the way the lockup sets it.
 *
 * "BOARD OF GOVERNORS" reads as BOARD / GOVERNORS with a small "of" riding at
 * the end of the first line. Wherever the name has no "of" it simply breaks in
 * the middle, so a board named something else still stacks rather than running
 * off the edge.
 */
function splitName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { head: '', tie: '', tail: '' };
  const at = words.findIndex((w) => /^of$/i.test(w));
  if (at > 0 && at < words.length - 1) {
    return {
      head: words.slice(0, at).join(' '),
      tie: words[at],
      tail: words.slice(at + 1).join(' '),
    };
  }
  if (words.length === 1) return { head: words[0], tie: '', tail: '' };
  const mid = Math.ceil(words.length / 2);
  return { head: words.slice(0, mid).join(' '), tie: '', tail: words.slice(mid).join(' ') };
}

/**
 * Wrap the body's name to a line length, in words.
 *
 * Measured in characters rather than drawn width because the face is not
 * loaded here. The limit is deliberately generous: overflowing by a little is
 * better than breaking "Committee on Health, Safety & Environment" into three
 * ragged lines when two will carry it.
 */
function wrapWords(text, max) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && next.length > max) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/**
 * The body's name, unless it is the Board's own.
 *
 * The lockup pairs the Board with one of its bodies, so the Board's own
 * meeting has no second name to set: rendering it produced "BOARD OF
 * GOVERNORS" over a rule over "BOARD OF GOVERNORS". A plenary sitting is not a
 * committee of itself, and the lockup should simply be the Board's name.
 */
function subordinateName(body) {
  const name = String((body && body.name) || '').trim();
  const board = String(ORG.name || '').trim();
  if (!name) return '';
  return name.toLowerCase() === board.toLowerCase() ? '' : name;
}

/**
 * The stacked lockup — the title card.
 *
 * Board's name over a rule over the body's name, centred. This is the form for
 * a screen with room to breathe: the chamber display before an item is called,
 * and the head of a body's own page.
 */
function stackedSvg(body, { width = 1000, ground = 'light' } = {}) {
  const boardName = String(ORG.name || 'Board of Governors');
  const bodyName = subordinateName(body);
  const accent = accentFor(body, ground);
  const { head, tie, tail } = splitName(boardName);
  // The body's own name is the one that varies most in length, from "Grants
  // Commission" to "Committee on Health, Safety & Environment".
  const lines = wrapWords(bodyName.toUpperCase(), 34);
  const ink = ground === 'dark' ? '#FFFFFF' : SLATE;
  const field = ground === 'dark' ? 'none' : PAPER;

  // Geometry on a 1000-unit width; the viewBox scales it. Heights are stated
  // rather than measured because the face is not available to measure with.
  const cx = 500;
  const headSize = tail ? 128 : 112;
  const tieSize = 46;
  const bodySize = 34;
  const lineGap = 46;
  const y1 = tail ? 200 : 250;
  const y2 = y1 + 132;
  const ruleY = y2 + 82;
  const firstBody = ruleY + 78;
  const height = firstBody + (lines.length - 1) * lineGap + 90;

  const family = "'Helvetica Neue',Helvetica,Arial,sans-serif";
  const label = bodyName ? `${boardName} — ${bodyName}` : boardName;

  let out = `<svg class="lockup-svg" viewBox="0 0 1000 ${height}" width="${width}" `
    + `role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">`
    + (field === 'none' ? '' : `<rect width="1000" height="${height}" fill="${field}"/>`)
    + `<text x="${cx}" y="${y1}" text-anchor="middle" font-family="${family}" `
    + `font-size="${headSize}" font-weight="700" letter-spacing="1" fill="${ink}">${esc(head.toUpperCase())}`
    + (tie
      ? `<tspan font-size="${tieSize}" font-weight="600" fill="${accent}" dx="18">${esc(tie.toUpperCase())}</tspan>`
      : '')
    + `</text>`;

  if (tail) {
    out += `<text x="${cx}" y="${y2}" text-anchor="middle" font-family="${family}" `
      + `font-size="${headSize}" font-weight="700" letter-spacing="1" fill="${ink}">${esc(tail.toUpperCase())}</text>`;
  }

  if (bodyName) {
    out += `<line x1="${cx - 55}" y1="${ruleY}" x2="${cx + 55}" y2="${ruleY}" `
      + `stroke="${accent}" stroke-width="5"/>`;
    lines.forEach((ln, i) => {
      out += `<text x="${cx}" y="${firstBody + i * lineGap}" text-anchor="middle" `
        + `font-family="${family}" font-size="${bodySize}" font-weight="600" `
        + `letter-spacing="4" fill="${accent}">${esc(ln)}</text>`;
    });
  }

  return out + '</svg>';
}

/**
 * The horizontal lockup — a masthead.
 *
 * The same two names set side by side, divided by a rule, for a place with
 * width and no height: the head of a page, the top of a printed sheet.
 */
function horizontalSvg(body, { width = 1000, ground = 'light' } = {}) {
  const boardName = String(ORG.name || 'Board of Governors');
  const bodyName = subordinateName(body);
  const accent = accentFor(body, ground);
  const { head, tie, tail } = splitName(boardName);
  const ink = ground === 'dark' ? '#FFFFFF' : SLATE;
  const field = ground === 'dark' ? 'none' : PAPER;
  const family = "'Helvetica Neue',Helvetica,Arial,sans-serif";
  const height = 190;
  const divider = 470;
  const label = bodyName ? `${boardName} — ${bodyName}` : boardName;

  let out = `<svg class="lockup-svg" viewBox="0 0 1000 ${height}" width="${width}" `
    + `role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">`
    + (field === 'none' ? '' : `<rect width="1000" height="${height}" fill="${field}"/>`)
    + `<text x="30" y="${tail ? 82 : 112}" font-family="${family}" font-size="62" `
    + `font-weight="700" letter-spacing="0.5" fill="${ink}">${esc(head.toUpperCase())}`
    + (tie ? `<tspan font-size="26" font-weight="600" fill="${accent}" dx="12">${esc(tie.toUpperCase())}</tspan>` : '')
    + `</text>`;
  if (tail) {
    out += `<text x="30" y="152" font-family="${family}" font-size="62" font-weight="700" `
      + `letter-spacing="0.5" fill="${ink}">${esc(tail.toUpperCase())}</text>`;
  }
  if (bodyName) {
    out += `<line x1="${divider}" y1="40" x2="${divider}" y2="${height - 40}" stroke="${accent}" stroke-width="5"/>`;
    // The gutter the name has to live in, not the width of the whole card.
    const textX = divider + 40;
    const avail = 1000 - textX - 30;
    // Wrap first, then fit the longest line that comes back — fitting before
    // wrapping would shrink the type to hold a line that was going to break.
    const lines = wrapWords(bodyName.toUpperCase(), 26);
    const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), '');
    const { size, track } = fitLine(longest, avail, 30, 4, 15);
    const startY = height / 2 + size / 3 - (lines.length - 1) * (size * 0.7);
    lines.forEach((ln, i) => {
      out += `<text x="${textX}" y="${startY + i * size * 1.4}" font-family="${family}" `
        + `font-size="${size}" font-weight="600" letter-spacing="${track}" fill="${accent}">${esc(ln)}</text>`;
    });
  }
  return out + '</svg>';
}

/**
 * Fit a letterspaced line to a width.
 *
 * The horizontal lockup has a fixed gutter to the right of the divider, and
 * "COMMITTEE ON APPROPRIATIONS" set at the nominal size overran it and was
 * clipped by the viewBox — the name of the body simply missing its tail.
 *
 * Tracking goes first: a lockup wants letterspacing, so it is the last thing
 * to lose entirely and the first to give a little. Then the type. Sans caps
 * average about 0.62em of advance, which is close enough to choose a size by;
 * the check that matters is that nothing leaves the box.
 */
function fitLine(text, width, maxSize, baseTrack, minSize) {
  let size = maxSize;
  let track = baseTrack;
  const w = () => String(text).length * (0.62 * size + track);
  while (w() > width && track > 1) track -= 0.25;
  while (w() > width && size > minSize) size -= 0.5;
  return { size, track };
}

function dataUri(svg) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

module.exports = {
  stackedSvg, horizontalSvg, dataUri, accentOf, accentFor, forDarkGround, luminance, parseHex,
  splitName, wrapWords, subordinateName, WALL_MIN_LUMINANCE,
  DEFAULT_ACCENT, SLATE,
};
