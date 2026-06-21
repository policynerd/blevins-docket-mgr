'use strict';

// Allowlist HTML sanitizer for rich text produced by the in-app word processor.
// Keeps a small, safe subset of tags; drops everything else (including all
// attributes except a validated href on <a>). No external dependencies.
const ALLOWED = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a', 'hr', 'code', 'pre',
]);

function escTextSegment(t) {
  return t
    .replace(/&(?!#?[a-zA-Z0-9]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeHref(raw) {
  const m = raw.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!m) return null;
  let href = (m[2] || m[3] || m[4] || '').trim();
  if (!href) return null;
  // Allow relative, anchors, http(s) and mailto only.
  const lower = href.toLowerCase();
  const ok = href.startsWith('/') || href.startsWith('#')
    || lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:');
  if (!ok) return null;
  return href.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
}

function sanitizeHtml(input, { maxLen = 200000 } = {}) {
  if (!input) return '';
  let s = String(input).slice(0, maxLen);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '');

  let out = '';
  let last = 0;
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(s))) {
    out += escTextSegment(s.slice(last, m.index));
    last = tagRe.lastIndex;
    const tag = m[0];
    const name = m[1].toLowerCase();
    const closing = tag[1] === '/';
    if (!ALLOWED.has(name)) continue; // drop tag, keep text around it
    if (closing) { out += `</${name}>`; continue; }
    if (name === 'a') {
      const href = safeHref(tag);
      out += href ? `<a href="${href}" rel="noopener noreferrer">` : '<a>';
    } else {
      out += `<${name}>`;
    }
  }
  out += escTextSegment(s.slice(last));
  return out.trim();
}

// Plain-text excerpt of sanitized HTML (for lists / search / summaries).
function htmlToText(htmlStr, maxLen = 280) {
  const t = String(htmlStr || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t;
}

module.exports = { sanitizeHtml, htmlToText, ALLOWED };
