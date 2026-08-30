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

function wrap(op, safe) {
  if (op === 'del') return `<del class="df-del">${safe}</del>`;
  if (op === 'ins') return `<ins class="df-ins">${safe}</ins>`;
  return safe;
}

/**
 * Render an inline redline of two plain texts as safe HTML.
 *
 * With `lineNumbers`, the result is a numbered comparative print: one row per
 * line of the resulting text, numbered down the left margin, which is how an
 * amendment is cited — "page 4, line 12" — and the thing this could not do.
 *
 * The rows are built from the runs rather than by splitting the finished HTML.
 * A single del or ins run can span a newline, so cutting the assembled markup
 * at line breaks would leave a `<del>` opened in one row and closed in
 * another; browsers would repair that, differently, and the redline would stop
 * meaning what it says. Each run is instead cut at its own newlines and every
 * fragment gets its own tag, so no element ever crosses a row.
 */
function diffHtml(oldText, newText, { lineNumbers = false } = {}) {
  const runs = diffTokens(tokenize(oldText), tokenize(newText));
  if (!lineNumbers) {
    return runs.map((r) => wrap(r.op, escapeHtml(r.text).replace(/\n/g, '<br>'))).join('');
  }

  const lines = [[]];
  for (const r of runs) {
    const pieces = r.text.split('\n');
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) lines.push([]);
      if (pieces[i]) lines[lines.length - 1].push({ op: r.op, text: pieces[i] });
    }
  }

  // Every line is numbered, blank ones included: a citation counts lines on the
  // page, and skipping the empty ones would make the printed numbers disagree
  // with anyone counting down the margin.
  return '<div class="redline-numbered">' + lines.map((parts, i) => {
    const inner = parts.map((p) => wrap(p.op, escapeHtml(p.text))).join('');
    return `<div class="rl-line"><span class="rl-n">${i + 1}</span>`
      + `<span class="rl-t">${inner || '&nbsp;'}</span></div>`;
  }).join('') + '</div>';
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
