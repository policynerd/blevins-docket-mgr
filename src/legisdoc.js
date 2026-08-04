'use strict';

// Structured legislative document model.
//
// The premise borrowed from XML-native drafting systems (USLM, Akoma Ntoso,
// LegisPro): a bill is not a blob of prose, it is a *tree of provisions*, each
// separately addressable. Once the text carries structure, everything else
// becomes possible — section-level citation, amending instructions that target
// a provision, and comparison of a bill against current law.
//
// We keep the hierarchy of U.S. legislative drafting:
//
//   SECTION 1.   → section        identifier  s1
//     (a)        → subsection                 s1/a
//       (1)      → paragraph                  s1/a/1
//         (A)    → subparagraph               s1/a/1/A
//           (i)  → clause                     s1/a/1/A/i
//
// Text in, tree out; tree renders back to text or to anchored HTML. The
// identifiers are stable so a citation keeps resolving as the draft is edited.

const LEVELS = ['section', 'subsection', 'paragraph', 'subparagraph', 'clause'];

const ROMAN = /^(x{0,3})(ix|iv|v?i{0,3})$/;

function isRoman(s) { return !!s && ROMAN.test(s.toLowerCase()) && s.toLowerCase() !== ''; }
function isLowerAlpha(s) { return /^[a-z]{1,2}$/.test(s); }
function isUpperAlpha(s) { return /^[A-Z]{1,2}$/.test(s); }
function isDigits(s) { return /^\d+$/.test(s); }

// A heading line: "SECTION 1. Short title." / "SEC. 12. ..." / "Section 3 -- ..."
const SECTION_RE = /^\s*(?:SECTION|SEC\.?|Section)\s+(\d+[A-Za-z]?)\s*[.\-—:]?\s*(.*)$/;
// A marked provision line: "(a) text", "(1) text", "(A) text", "(i) text"
const MARKER_RE = /^\s*\(([0-9A-Za-z]{1,4})\)\s*(.*)$/;

// Which level does a marker belong to? Ambiguity is real: "(i)" is a roman
// clause, but it is also the letter after "(h)". Resolve using the open
// context — if a subsection sequence is already at (h), then (i) continues it.
function levelForMarker(mark, open) {
  if (isDigits(mark)) return 'paragraph';
  if (isUpperAlpha(mark)) return 'subparagraph';
  if (isLowerAlpha(mark)) {
    // Roman-vs-letter: prefer continuing an open lettered sequence.
    const sub = open.subsection;
    if (isRoman(mark) && !(sub && nextAlpha(sub.marker) === mark)) {
      // Only treat as a clause when a subparagraph is actually open above it.
      if (open.subparagraph) return 'clause';
    }
    return 'subsection';
  }
  return 'paragraph';
}

function nextAlpha(mark) {
  if (!isLowerAlpha(mark) || mark.length !== 1) return null;
  return mark === 'z' ? null : String.fromCharCode(mark.charCodeAt(0) + 1);
}

function node(level, marker, heading, text) {
  return { level, marker, heading: heading || '', text: text || '', children: [], id: '' };
}

// Assign stable identifiers by walking the tree: s1, s1/a, s1/a/2 …
function assignIds(nodes, prefix) {
  for (const n of nodes) {
    n.id = prefix ? `${prefix}/${n.marker}` : `s${n.marker}`;
    assignIds(n.children, n.id);
  }
}

// Parse drafting text into a provision tree.
function parse(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const doc = { preamble: [], sections: [] };
  // Currently open node at each level.
  const open = { section: null, subsection: null, paragraph: null, subparagraph: null, clause: null };

  function clearBelow(level) {
    const i = LEVELS.indexOf(level);
    for (let j = i + 1; j < LEVELS.length; j++) open[LEVELS[j]] = null;
  }
  function deepestOpen() {
    for (let j = LEVELS.length - 1; j >= 0; j--) if (open[LEVELS[j]]) return open[LEVELS[j]];
    return null;
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const sec = SECTION_RE.exec(line);
    if (sec) {
      const n = node('section', sec[1], sec[2].trim(), '');
      doc.sections.push(n);
      open.section = n;
      clearBelow('section');
      continue;
    }

    const mk = MARKER_RE.exec(line);
    if (mk && open.section) {
      const marker = mk[1];
      const level = levelForMarker(marker, open);
      const n = node(level, marker, '', mk[2].trim());
      // Attach to the nearest open ancestor above this level.
      const idx = LEVELS.indexOf(level);
      let parent = null;
      for (let j = idx - 1; j >= 0; j--) { if (open[LEVELS[j]]) { parent = open[LEVELS[j]]; break; } }
      (parent ? parent.children : doc.sections).push(n);
      open[level] = n;
      clearBelow(level);
      continue;
    }

    // Continuation prose: append to the deepest open provision, else preamble.
    const target = deepestOpen();
    if (target) target.text = target.text ? target.text + ' ' + line : line;
    else doc.preamble.push(line);
  }

  assignIds(doc.sections, '');
  return doc;
}

// Flatten to a list of { id, level, marker, heading, text, depth }.
function flatten(doc) {
  const out = [];
  (function walk(nodes, depth) {
    for (const n of nodes) {
      out.push({ id: n.id, level: n.level, marker: n.marker, heading: n.heading, text: n.text, depth });
      walk(n.children, depth + 1);
    }
  })(doc.sections, 0);
  return out;
}

// Find one provision by identifier (e.g. "s1/a/2").
function find(doc, id) {
  let hit = null;
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.id === id) { hit = n; return; }
      walk(n.children);
      if (hit) return;
    }
  })(doc.sections);
  return hit;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Render to anchored HTML. Every provision carries its identifier so the UI can
// deep-link and highlight a single subsection.
function toHtml(doc, { highlight = null } = {}) {
  let html = '';
  for (const p of doc.preamble) html += `<p class="ld-preamble">${escapeHtml(p)}</p>`;
  (function walk(nodes) {
    for (const n of nodes) {
      const hot = highlight && n.id === highlight ? ' ld-hit' : '';
      const label = n.level === 'section' ? `SECTION ${escapeHtml(n.marker)}.` : `(${escapeHtml(n.marker)})`;
      html += `<div class="ld-node ld-${n.level}${hot}" id="${escapeHtml(n.id)}" data-ld="${escapeHtml(n.id)}">`
        + `<span class="ld-mark">${label}</span>`
        + (n.heading ? `<span class="ld-heading">${escapeHtml(n.heading)}</span>` : '')
        + (n.text ? `<span class="ld-text">${escapeHtml(n.text)}</span>` : '')
        + '</div>';
      walk(n.children);
    }
  })(doc.sections);
  return html;
}

// Render back to canonical drafting text (round-trips through parse()).
function toText(doc) {
  const out = [];
  for (const p of doc.preamble) out.push(p);
  (function walk(nodes, indent) {
    for (const n of nodes) {
      const pad = '  '.repeat(indent);
      if (n.level === 'section') {
        out.push(`SECTION ${n.marker}. ${n.heading}`.trimEnd());
        if (n.text) out.push(`${pad}  ${n.text}`);
      } else {
        out.push(`${pad}(${n.marker}) ${n.text}`.trimEnd());
      }
      walk(n.children, indent + 1);
    }
  })(doc.sections, 0);
  return out.join('\n');
}

// Outline for navigation: sections plus their immediate subsections.
function outline(doc) {
  return doc.sections.map((s) => ({
    id: s.id,
    label: `SECTION ${s.marker}.`,
    heading: s.heading,
    children: s.children.filter((c) => c.level === 'subsection')
      .map((c) => ({ id: c.id, label: `(${c.marker})`, heading: excerpt(c.text, 60) })),
  }));
}

function excerpt(text, n) {
  const t = String(text || '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Structural validation — the checks a drafting system owes its user.
function validate(doc) {
  const issues = [];
  if (!doc.sections.length) issues.push({ level: 'error', id: '', msg: 'No sections found. Begin a provision with "SECTION 1."' });

  // Sections numbered sequentially from 1.
  doc.sections.forEach((s, i) => {
    const expected = String(i + 1);
    if (s.marker !== expected) {
      issues.push({ level: 'warn', id: s.id, msg: `Section numbered ${s.marker} where ${expected} was expected — sections should run consecutively.` });
    }
    if (!s.heading) issues.push({ level: 'warn', id: s.id, msg: `SECTION ${s.marker} has no heading.` });
  });

  // Sibling markers in sequence, and no empty provisions.
  (function walk(nodes) {
    const bySeq = {};
    for (const n of nodes) {
      if (n.level !== 'section') {
        (bySeq[n.level] = bySeq[n.level] || []).push(n);
      }
      if (n.level !== 'section' && !n.text && !n.children.length) {
        issues.push({ level: 'error', id: n.id, msg: `(${n.marker}) is empty.` });
      }
      walk(n.children);
    }
    for (const level of Object.keys(bySeq)) {
      const seq = bySeq[level];
      seq.forEach((n, i) => {
        const want = expectedMarker(level, i);
        if (want && n.marker !== want) {
          issues.push({ level: 'warn', id: n.id, msg: `(${n.marker}) breaks the ${level} sequence — (${want}) expected.` });
        }
      });
    }
  })(doc.sections);

  return issues;
}

function expectedMarker(level, i) {
  if (level === 'paragraph') return String(i + 1);
  if (level === 'subsection') return i < 26 ? String.fromCharCode(97 + i) : null;
  if (level === 'subparagraph') return i < 26 ? String.fromCharCode(65 + i) : null;
  if (level === 'clause') return ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'][i] || null;
  return null;
}

// Human-readable citation for a provision id, e.g. "s1/a/2" → "Sec. 1(a)(2)".
function cite(id) {
  if (!id) return '';
  const parts = String(id).split('/');
  const sec = parts.shift().replace(/^s/, '');
  return `Sec. ${sec}` + parts.map((p) => `(${p})`).join('');
}

module.exports = {
  LEVELS, parse, flatten, find, toHtml, toText, outline, validate, cite, escapeHtml, excerpt,
};
