'use strict';

/**
 * The printed documents when there is no browser to print them.
 *
 * Every document in this application is now written once, as HTML, and set by
 * Chromium. That leaves the question of what happens on a machine that has no
 * Chromium — a developer's laptop, a container that came back without the
 * package, a browser killed for memory on the morning of a meeting. A board
 * meeting cannot be held up by that, so there has to be a second way to get
 * bytes.
 *
 * The way that was tried first, and abandoned here, was to write each document
 * twice: once as markup and once as a sequence of drawing calls. Four
 * documents had reached that state — the letter, the packet cover, the tab
 * divider, the separator sheet — and every one of the pairs had already begun
 * to drift, because a fix made in the markup is not a fix made in the drawing.
 * The cover said "Status:" in one and not the other. Six more documents were
 * still waiting to be ported, which would have meant ten twins.
 *
 * So this is the second way, once, for all of them: it reads the markup the
 * document already produced and draws it. Nothing here knows what a board
 * letter is. It knows paragraphs, headings, lists, tables, rules and a rail,
 * which is the whole vocabulary `docprint.js` writes in and the whole
 * vocabulary `sanitize.js` allows a clerk to write in.
 *
 * It is deliberately plainer than the browser's version, and that is a
 * property worth keeping rather than a shortfall to close. A fallback that
 * looks identical is one nobody notices — which is exactly how a container
 * with Chromium installed printed drawn documents for weeks with nothing to
 * read but the Producer string inside a PDF. This one is legible, complete,
 * and visibly not the letterpress version.
 */

const { Doc, INK, MUTED } = require('./pdfdoc');

const RAIL_W = 128;

// ------------------------------------------------------------- the parser ---
//
// The markup being read here is not the web's. It is what `docprint.js`
// writes plus what `sanitize.js` lets through — twenty-odd tags, balanced,
// with no scripts and no attributes but `class` and a validated `href`. That
// is why a few hundred bytes of regex is honest here and would not be against
// arbitrary HTML: the dialect is closed, and both ends of it are in this
// repository.

const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col']);
const SKIP = new Set(['style', 'script', 'title', 'head']);
const INLINE = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'a', 'code', 'sup', 'sub', 'span', 'br',
]);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function decode(s) {
  return String(s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const n = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : whole;
  });
}

function attr(raw, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(raw || '');
  return m ? decode(m[2] || m[3] || m[4] || '') : '';
}

function parse(html) {
  const src = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/gi, '');
  const root = { name: '#root', cls: '', children: [] };
  const stack = [root];
  const push = (node) => stack[stack.length - 1].children.push(node);
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  let last = 0;
  let skipping = null;
  let m;
  while ((m = TAG.exec(src))) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (skipping) {
      if (closing && name === skipping) { skipping = null; last = TAG.lastIndex; }
      continue;
    }
    const before = src.slice(last, m.index);
    last = TAG.lastIndex;
    if (before) push({ name: '#text', text: decode(before) });
    if (SKIP.has(name)) { if (!closing) skipping = name; continue; }
    if (name === 'html' || name === 'body') continue;
    if (closing) {
      // Pop to the matching open element. A stray closer with nothing to match
      // is dropped rather than unwinding the whole document.
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
      continue;
    }
    const node = {
      name, cls: attr(m[3], 'class'), href: attr(m[3], 'href'), children: [],
    };
    push(node);
    if (!VOID.has(name)) stack.push(node);
  }
  const tail = src.slice(last);
  if (tail) push({ name: '#text', text: decode(tail) });
  return root;
}

// ------------------------------------------------------------- the styles ---
//
// Keyed by the class where `docprint.js` gave the element one, and by the tag
// where it did not. Classes win, because a class in that stylesheet is a
// statement about what the thing *is* — a masthead, a signpost, a caption —
// while a tag is only how it happens to be marked up.

const BY_CLASS = {
  'mast-org': { size: 13, style: 'b', after: 2 },
  'mast-kind': { size: 10, style: 'sans', color: MUTED, after: 2, upper: true },
  'mast-body': { size: 11, style: 'b', after: 8 },
  'cover-when': { size: 12, after: 4 },
  'cover-meta': { size: 10, color: MUTED, after: 2 },
  subject: { size: 11, style: 'b', after: 12, upper: true },
  sheet: { gapBefore: 150 },
  // A section heading, uppercased here because the stylesheet uppercases it
  // there. `text-transform` is a rendering instruction the browser carries out
  // and nothing else does, so a fallback that ignores it prints "Subject"
  // under a document whose every other heading is "OVERVIEW".
  sec: { size: 11, style: 'b', after: 5, heading: true, upper: true },
  'sheet-tab': { size: 28, style: 'b', align: 'center', after: 14 },
  'sheet-kind': { size: 10, style: 'sans', color: MUTED, align: 'center', after: 8, upper: true },
  'sheet-title': { size: 13, align: 'center', after: 6 },
  'sheet-note': { size: 10.5, style: 'i', color: MUTED, align: 'center', after: 6 },
  'sheet-url': { size: 9, color: MUTED, align: 'center', after: 6 },
  'warn-title': { size: 14, style: 'b', after: 8, upper: true },
  sign: { gapBefore: 10 },
  'sign-line': { line: true },
  'sign-role': { size: 9.5, style: 'sans', color: MUTED, after: 2 },
  'sec-body': {},
  muted: { size: 10.5, color: MUTED, after: 7 },
};

const BY_TAG = {
  p: { size: 10.5, after: 7 },
  div: { size: 10.5, after: 4 },
  h2: { size: 11, style: 'b', after: 5, heading: true },
  h3: { size: 10.5, style: 'b', after: 4, heading: true },
  h4: { size: 10.5, style: 'b', after: 4, heading: true },
  blockquote: { size: 10.5, indent: 24, rightIndent: 24, after: 7 },
  pre: { size: 9.5, style: 'sans', after: 7 },
  caption: { size: 9.5, style: 'i', color: MUTED, after: 4 },
  li: { size: 10.5, after: 3 },
};

function styleFor(node) {
  for (const cls of String(node.cls || '').split(/\s+/)) {
    if (cls && Object.prototype.hasOwnProperty.call(BY_CLASS, cls)) return BY_CLASS[cls];
  }
  return BY_TAG[node.name] || null;
}

// ------------------------------------------------------------- the runs -----

const BREAK = { break: true };

/** The inline content of a node, as runs carrying their own face. */
function runsOf(nodes, base = {}) {
  const out = [];
  const walk = (n, st) => {
    if (n.name === '#text') { if (n.text) out.push(Object.assign({}, st, { text: n.text })); return; }
    if (n.name === 'br') { out.push(BREAK); return; }
    const next = Object.assign({}, st);
    if (n.name === 'b' || n.name === 'strong') next.style = next.style === 'i' ? 'bi' : 'b';
    else if (n.name === 'i' || n.name === 'em') next.style = next.style === 'b' ? 'bi' : 'i';
    else if (n.name === 'u') next.underline = true;
    else if (n.name === 's' || n.name === 'strike') next.strike = true;
    else if (n.name === 'sup') next.sup = true;
    else if (n.name === 'sub') next.sub = true;
    else if (n.name === 'code' || n.name === 'pre') next.style = 'sans';
    for (const c of n.children || []) walk(c, next);
  };
  for (const n of nodes || []) walk(n, base);
  return out;
}

function hasText(runs) {
  return runs.some((r) => r !== BREAK && String(r.text || '').trim());
}

/**
 * A node's text, with block boundaries kept as spaces.
 *
 * Concatenating the runs is not enough: `<div>Members</div><div>Ada Chair` has
 * no whitespace anywhere in it, and reading it as one string gives
 * "MembersAda Chair". A block boundary is a space wherever text is being read
 * out of markup — a table cell holding two paragraphs is the same problem.
 */
function textOf(node) {
  if (!node) return '';
  let out = '';
  const walk = (n) => {
    if (n.name === '#text') { out += n.text; return; }
    const block = !isInline(n.name);
    if (block && out && !/\s$/.test(out)) out += ' ';
    for (const c of n.children || []) walk(c);
    if (block) out += ' ';
  };
  walk(node);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Draw a block of runs.
 *
 * A `<br>` is a line the author asked for, and `rich()` breaks on the measure
 * rather than on characters, so the runs are cut at each break and set as
 * consecutive blocks with no space between them.
 */
function drawRuns(doc, runs, style) {
  const parts = [[]];
  for (const r of runs) {
    if (r === BREAK) parts.push([]);
    else parts[parts.length - 1].push(r);
  }
  const live = parts.filter((p) => hasText(p))
    .map((p) => (style.upper ? p.map((r) => Object.assign({}, r, { text: String(r.text).toUpperCase() })) : p));
  live.forEach((part, i) => {
    if (style.heading && i === 0) doc.need((style.size || 11) * 2.4);
    doc.rich(part, Object.assign({}, style, {
      after: i === live.length - 1 ? style.after : 0,
    }));
  });
}

// ------------------------------------------------------------- the blocks ---

function isInline(name) { return name === '#text' || INLINE.has(name); }

function renderChildren(doc, node, style) {
  let pending = [];
  const flush = () => {
    if (hasText(runsOf(pending))) drawRuns(doc, runsOf(pending), style || BY_TAG.p);
    pending = [];
  };
  for (const child of node.children || []) {
    if (isInline(child.name)) { pending.push(child); continue; }
    flush();
    renderBlock(doc, child);
  }
  flush();
}

function renderList(doc, node, depth = 0) {
  const ordered = node.name === 'ol';
  let n = 0;
  for (const li of node.children || []) {
    if (li.name !== 'li') continue;
    n += 1;
    const inline = (li.children || []).filter((c) => isInline(c.name));
    const blocks = (li.children || []).filter((c) => !isInline(c.name));
    const runs = runsOf(inline);
    if (hasText(runs)) {
      const marker = ordered ? `${n}.` : '•';
      drawRuns(doc, [{ text: `${marker} ` }].concat(runs),
        { size: 10.5, indent: 14 + depth * 14, hanging: 12, after: 3 });
    }
    for (const b of blocks) {
      if (b.name === 'ul' || b.name === 'ol') renderList(doc, b, depth + 1);
      else renderBlock(doc, b);
    }
  }
  doc.gap(4);
}

function renderTable(doc, node) {
  const rows = [];
  const collect = (n) => {
    for (const c of n.children || []) {
      if (c.name === 'tr') rows.push(c);
      else if (c.name === 'thead' || c.name === 'tbody' || c.name === 'tfoot') collect(c);
      else if (c.name === 'caption') renderBlock(doc, c);
    }
  };
  collect(node);
  if (!rows.length) return;
  const cellsOf = (tr) => (tr.children || []).filter((c) => c.name === 'td' || c.name === 'th');

  // Head matter and a packet's contents are label/value pairs rather than
  // tabular data, and they are the two layouts space-padding used to imitate.
  // `field()` is the column they were reaching for.
  const cls = String(node.cls || '');
  if (/\b(headmatter|contents)\b/.test(cls)) {
    for (const tr of rows) {
      const cells = cellsOf(tr);
      doc.field(textOf(cells[0]), textOf(cells[1]), { size: 10.5, labelW: 52, after: 4 });
    }
    doc.gap(8);
    return;
  }

  const grid = rows.map((tr) => cellsOf(tr).map(textOf));
  const ncol = Math.max(1, ...grid.map((r) => r.length));
  const pad = (r) => r.concat(new Array(Math.max(0, ncol - r.length)).fill(''));
  const headed = cellsOf(rows[0]).every((c) => c.name === 'th');
  const cols = new Array(ncol).fill(doc.contentW / ncol);
  doc.table(cols, (headed ? grid.slice(1) : grid).map(pad),
    { head: headed ? pad(grid[0]) : null, after: 8 });
}

function renderBlock(doc, node) {
  // The rail is positioned, not flowed. It is drawn once, before anything
  // else, by drawRail().
  if (node.name === 'aside' && /\brail\b/.test(node.cls || '')) return;
  if (node.name === 'hr') {
    doc.rule({ after: /mast-rule/.test(node.cls || '') ? 14 : 10 });
    return;
  }
  if (node.name === 'table') return renderTable(doc, node);
  if (node.name === 'ul' || node.name === 'ol') return renderList(doc, node);

  const style = styleFor(node) || BY_TAG.div;
  if (style.line) { doc.signature(null, { width: 209 }); return; }
  if (style.gapBefore) doc.gap(style.gapBefore);
  renderChildren(doc, node, style);
  return undefined;
}

/**
 * The roster down the left rail.
 *
 * Positioned rather than flowed, on the first page only. The browser's version
 * repeats it on every page, which is what letterhead does and what paged CSS
 * can express; this cannot, and a roster on page one is what the drawn letter
 * always did. What matters is that the measure does not move between pages,
 * and it does not: the margin that clears the rail is set for the whole
 * document.
 */
function drawRail(doc, root, x) {
  let rail = null;
  const find = (n) => {
    if (rail) return;
    if (n.name === 'aside' && /\brail\b/.test(n.cls || '')) { rail = n; return; }
    for (const c of n.children || []) find(c);
  };
  find(root);
  if (!rail) return;
  let y = doc.size.h - 60;
  for (const child of rail.children || []) {
    if (child.name === '#text') continue;
    const cls = String(child.cls || '');
    if (/rail-label/.test(cls)) {
      doc.at(x, y, textOf(child).toUpperCase(), { size: 7, style: 'sansB', color: MUTED });
      y -= 14;
    } else if (/rail-member/.test(cls)) {
      for (const g of child.children || []) {
        const gc = String(g.cls || '');
        if (/rail-name/.test(gc)) {
          doc.at(x, y, textOf(g).toUpperCase(), { size: 8, style: 'sansB', color: INK });
          y -= 10;
        } else if (/rail-role/.test(gc)) {
          doc.at(x, y, textOf(g), { size: 7.5, style: 'sans', color: MUTED });
          y -= 10;
        }
      }
      y -= 5;
      // A rail longer than the page stops rather than running off it.
      if (y < 140) break;
    }
  }
}

/** Whether a document carries a rail, and so needs the wider left margin. */
function hasRail(html) {
  return /class="[^"]*\brail\b/.test(String(html || ''));
}

/**
 * A document, drawn from its own markup.
 *
 * `opts` are the Doc's: `footer`, `runningHeader`, `margin`, `size`. The
 * caller keeps those because they are the parts a browser expresses in its own
 * header/footer band, which has no equivalent here.
 */
async function flow(html, opts = {}) {
  const root = parse(html);
  const rail = hasRail(html);
  const doc = await Doc.create(Object.assign({}, opts, {
    margin: Object.assign(
      rail ? { top: 60, right: 72, bottom: 72, left: 72 + RAIL_W } : {},
      opts.margin,
    ),
  }));
  if (rail) drawRail(doc, root, 72);
  for (const child of root.children || []) {
    if (isInline(child.name)) {
      if (hasText(runsOf([child]))) drawRuns(doc, runsOf([child]), BY_TAG.p);
    } else renderBlock(doc, child);
  }
  return doc.save();
}

module.exports = { flow, parse, textOf, hasRail, RAIL_W };
