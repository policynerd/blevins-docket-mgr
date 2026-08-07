'use strict';

// The board's seal and monogram, drawn rather than uploaded.
//
// A seal is not a logo. It is a device of office: a double ring with the name
// of the body set around it, a mark of authority at the centre, and ornament
// at the flanks separating the legend from the counter-legend. It appears on
// the instruments the body issues, which is why it is generated here from the
// organisation's own configured identity — the name on the seal is the name in
// the record, and the two cannot drift apart.
//
// Drawn as SVG so it is sharp at a 24px favicon and at a 92px document
// masthead, needs no asset pipeline, and re-letters itself when the board is
// renamed. An uploaded mark still wins wherever one is supplied.

const { ORG } = require('./org');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Initials for the cipher. Articles and conjunctions are skipped — a monogram
// is built from the words that carry the name, so "Board of Governors" gives
// BG rather than BOG, which reads as a word and not as a cipher.
const SKIP = new Set(['of', 'the', 'and', 'for', 'de', 'la', 'a', 'an']);
function initials(name, max = 3) {
  const words = String(name || '').split(/[\s—–-]+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ''))
    .filter((w) => w && !SKIP.has(w.toLowerCase()));
  if (!words.length) return 'BG';
  return words.slice(0, max).map((w) => w[0].toUpperCase()).join('');
}

// Fit a legend to its arc.
//
// Closing the tracking alone is not enough: past a certain length the glyphs
// themselves no longer fit the semicircle and SVG simply stops drawing at the
// end of the path, so a long board name loses its head and tail and reads as
// nonsense — "…OF GOVERNORS OF BLEVINS HOL". The type has to shrink as well.
//
// Georgia's uppercase advance averages about 0.62em. The available run is the
// semicircle less a margin at each end, where the flank ornaments sit.
function fitLegend(text, radius, maxSize, baseTrack) {
  let str = String(text || '');
  if (!str) return { size: maxSize, track: baseTrack, text: '' };
  const available = Math.PI * radius * 0.84;
  let track = baseTrack;
  let size = maxSize;
  const width = () => str.length * (0.62 * size + track);
  // Give up the tracking first — a seal wants letterspacing, so it is the
  // last thing to go and the first thing to shrink.
  while (width() > available && track > 0.15) track -= 0.1;
  // Then the type, to a floor below which the legend is not worth setting.
  while (width() > available && size > 3.6) size -= 0.15;
  // A name long enough to overrun even at the floor has to be cut. Cutting it
  // here, at a word boundary and with an ellipsis, is a visible and deliberate
  // loss; leaving it is a silent one, because SVG simply stops drawing at the
  // end of the path and the head and tail disappear without trace.
  if (width() > available) {
    const fits = Math.max(1, Math.floor(available / (0.62 * size + track)) - 1);
    str = str.slice(0, fits);
    const sp = str.lastIndexOf(' ');
    if (sp > fits * 0.5) str = str.slice(0, sp);
    str = str.replace(/[\s,;:.-]+$/, '') + '\u2026';
  }
  return { size: Math.round(size * 100) / 100, track: Math.round(track * 100) / 100, text: str };
}

// The seal. `ground` names the surface it sits on, not the colour of the
// artwork — layout.js uses `variant: 'light'` to mean light-coloured artwork
// FOR a dark ground, the exact opposite reading, and the two conventions
// meeting produced a white disc on the navy rail.
function sealSvg({ size = 96, ground = 'dark', legend, counter, center } = {}) {
  // A legend too small to read is ornament pretending to be information. Under
  // about 64px the ring text is illegible at any tracking, so the seal gives
  // way to the cipher, which is what it is for.
  if (size < 64) return monogramSvg({ size, ground, center });
  const name = String(legend == null ? ORG.name : legend);
  const sub = String(counter == null ? (ORG.primaryBodyType || ORG.tagline || '') : counter);
  const cipher = String(center == null ? initials(ORG.name) : center);
  const glyph = String(ORG.seal || '★').slice(0, 1);

  // On a dark ground the device is brass and the field is left open, so the
  // rail shows through; on paper it is navy on white.
  const ink = ground === 'dark' ? '#D9B450' : '#353D4F';
  const rule = ink;
  const field = ground === 'dark' ? 'none' : '#FFFFFF';
  const uid = 'sl' + Math.abs(hash(name + sub + cipher + ground)).toString(36);

  // Geometry on a 100-unit square, scaled by the viewBox.
  const c = 50;
  const rOuter = 47;
  const rInner = 37.5;
  const rLegend = 42.4;   // baseline circle for the legend
  const rCounter = 42.0;
  const legendFit = fitLegend(name, rLegend, 7.2, 1.7);
  const counterFit = fitLegend(sub, rCounter, 5.4, 1.4);

  return `<svg class="seal-svg" viewBox="0 0 100 100" width="${size}" height="${size}" `
    + `role="img" aria-label="${esc(name)} seal" xmlns="http://www.w3.org/2000/svg">`
    + `<defs>`
    // Top arc: left round over the top to the right, so the legend reads
    // left-to-right across the head of the seal.
    + `<path id="${uid}t" fill="none" d="M ${c - rLegend},${c} A ${rLegend},${rLegend} 0 0 1 ${c + rLegend},${c}"/>`
    // Bottom arc drawn the other way, so the counter-legend also reads
    // left-to-right and upright rather than inverted along the foot.
    + `<path id="${uid}b" fill="none" d="M ${c - rCounter},${c} A ${rCounter},${rCounter} 0 0 0 ${c + rCounter},${c}"/>`
    + `</defs>`
    + (field === 'none' ? '' : `<circle cx="${c}" cy="${c}" r="${rOuter}" fill="${field}"/>`)
    + `<circle cx="${c}" cy="${c}" r="${rOuter}" fill="none" stroke="${rule}" stroke-width="2"/>`
    + `<circle cx="${c}" cy="${c}" r="${rInner}" fill="none" stroke="${rule}" stroke-width="0.9"/>`
    + `<text fill="${ink}" font-family="Georgia,'Times New Roman',serif" font-size="${legendFit.size}" `
    + `letter-spacing="${legendFit.track}" font-weight="600">`
    + `<textPath href="#${uid}t" startOffset="50%" text-anchor="middle">${esc((legendFit.text || name).toUpperCase())}</textPath></text>`
    + (sub ? `<text fill="${ink}" font-family="Georgia,'Times New Roman',serif" font-size="${counterFit.size}" `
      + `letter-spacing="${counterFit.track}">`
      + `<textPath href="#${uid}b" startOffset="50%" text-anchor="middle">${esc((counterFit.text || sub).toUpperCase())}</textPath></text>` : '')
    // Ornament at the flanks, dividing legend from counter-legend.
    + `<text x="6.5" y="${c + 2.6}" fill="${ink}" font-size="6.5" text-anchor="middle" font-family="Georgia,serif">${esc(glyph)}</text>`
    + `<text x="93.5" y="${c + 2.6}" fill="${ink}" font-size="6.5" text-anchor="middle" font-family="Georgia,serif">${esc(glyph)}</text>`
    // The cipher at the centre.
    + `<text x="${c}" y="${c + 7.5}" fill="${ink}" text-anchor="middle" `
    + `font-family="Georgia,'Times New Roman',serif" font-size="22" font-weight="700" `
    + `letter-spacing="0.5">${esc(cipher)}</text>`
    + `</svg>`;
}

// The cipher alone, in a roundel — for small spaces where a legend would not
// be legible: the favicon, a list row, a watermark.
function monogramSvg({ size = 48, ground = 'dark', center } = {}) {
  const cipher = String(center == null ? initials(ORG.name) : center);
  const ink = ground === 'dark' ? '#D9B450' : '#353D4F';
  const field = ground === 'dark' ? '#353D4F' : '#FFFFFF';
  return `<svg class="monogram-svg" viewBox="0 0 100 100" width="${size}" height="${size}" `
    + `role="img" aria-label="${esc(ORG.name)}" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="50" cy="50" r="48" fill="${field}"/>`
    + `<circle cx="50" cy="50" r="48" fill="none" stroke="${ink}" stroke-width="2.5"/>`
    + `<circle cx="50" cy="50" r="41" fill="none" stroke="${ink}" stroke-width="1"/>`
    + `<text x="50" y="63" fill="${ink}" text-anchor="middle" `
    + `font-family="Georgia,'Times New Roman',serif" font-size="${cipher.length > 2 ? 34 : 42}" `
    + `font-weight="700" letter-spacing="1">${esc(cipher)}</text>`
    + `</svg>`;
}

// A data: URI, for the favicon and anywhere an <img src> is wanted.
function dataUri(svg) {
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h;
}

module.exports = { sealSvg, monogramSvg, initials, dataUri };
