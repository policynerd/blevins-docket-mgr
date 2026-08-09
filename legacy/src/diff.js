'use strict';

// Word-level text comparison for legislative amendment views — no dependencies.
// Classic LCS over word tokens; unchanged runs render as-is, removals as <del>,
// insertions as <ins>. Inputs are plain text (callers strip HTML first); the
// output is safe HTML (tokens are escaped before wrapping).
const { escapeHtml } = require('./util');

const MAX_TOKENS = 6000; // keep the O(n·m) table bounded (~36M cells worst case)

function tokenize(text) {
  // Words plus their trailing whitespace, so joins reproduce spacing.
  return String(text || '').match(/\S+\s*/g) || [];
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/blockquote|\/pre)>/gi, '$&\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&') // last, so "&amp;lt;" decodes to "&lt;", not "<"
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// Diff two token arrays into [{ op: 'same'|'del'|'ins', text }] runs.
function diffTokens(a, b) {
  const n = Math.min(a.length, MAX_TOKENS);
  const m = Math.min(b.length, MAX_TOKENS);
  // LCS length table (n+1 x m+1), row-major Uint32.
  const W = m + 1;
  const table = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * W + j] = a[i] === b[j]
        ? table[(i + 1) * W + j + 1] + 1
        : Math.max(table[(i + 1) * W + j], table[i * W + j + 1]);
    }
  }
  const runs = [];
  const push = (op, text) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.op === op) last.text += text;
    else runs.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (table[(i + 1) * W + j] >= table[i * W + j + 1]) { push('del', a[i]); i++; }
    else { push('ins', b[j]); j++; }
  }
  while (i < n) { push('del', a[i]); i++; }
  while (j < m) { push('ins', b[j]); j++; }
  // Anything beyond the token cap is appended un-diffed.
  if (a.length > n) push('del', a.slice(n).join(''));
  if (b.length > m) push('ins', b.slice(m).join(''));
  return runs;
}

// Render an inline redline of two plain texts as safe HTML.
function diffHtml(oldText, newText) {
  const runs = diffTokens(tokenize(oldText), tokenize(newText));
  return runs.map((r) => {
    const safe = escapeHtml(r.text).replace(/\n/g, '<br>');
    if (r.op === 'del') return `<del class="df-del">${safe}</del>`;
    if (r.op === 'ins') return `<ins class="df-ins">${safe}</ins>`;
    return safe;
  }).join('');
}

function stats(oldText, newText) {
  const runs = diffTokens(tokenize(oldText), tokenize(newText));
  let ins = 0;
  let del = 0;
  for (const r of runs) {
    const words = r.text.trim() ? r.text.trim().split(/\s+/).length : 0;
    if (r.op === 'ins') ins += words;
    else if (r.op === 'del') del += words;
  }
  return { ins, del };
}

module.exports = { diffHtml, stripHtml, stats };
