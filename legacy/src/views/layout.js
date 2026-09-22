'use strict';

const util = require('../util');
if (!util.__rawPatched) {
  util.__rawPatched = true;
  const origRaw = util.raw;
  util.raw = function raw(value) {
    const s = value == null ? '' : String(value);
    const box = origRaw(s);
    box.toString = function () { return s; };
    box.valueOf = function () { return s; };
    return box;
  };
}

const base = require('./layout-base');

let currentUser = null;
const origSetUser = base.setUser;
function setUser(u) {
  currentUser = u;
  return origSetUser(u);
}

function labelOf(status) {
  if (status == null || status === '' || status === 'none') return '—';
  return status;
}
function statusBadge(status) { return base.statusBadge(labelOf(status)); }
function typeBadge(type) { return base.typeBadge(labelOf(type)); }

function deskStrip() {
  const user = currentUser;
  if (!user) return '';
  let desk;
  try { desk = require('../awareness').desk(user); }
  catch (_) { return ''; }
  const bits = ['<a href="/desk">Desk</a>'];
  if (desk.inbox) bits.push(`<a href="/approvals">${desk.inbox} awaiting approval</a>`);
  if (desk.moved && desk.moved.length) {
    bits.push(`${desk.moved.length} watched file${desk.moved.length === 1 ? '' : 's'} moved`);
  }
  try {
    if (require('../auth').hasRole(user, 'staff')) bits.push('<a href="/spend">Spend</a>');
  } catch (_) { /* */ }
  bits.push(`<a href="/watching">Watching (${(desk.watches || []).length})</a>`);
  return `<p class="desk-strip">${bits.join(' · ')}</p>`;
}

function withInstitutionalCss(markup) {
  let html = String(markup || '');
  html = html.replace(/\[object Object\]/g, '');
  html = html.replace(/(<span class="muted">)\s*none\s*(<\/span>)/gi, '$1—$2');
  const legacy = '<link rel="stylesheet" href="/styles.css">';
  const extra = '\n  <link rel="stylesheet" href="/assets/institutional.css">'
    + '\n  <link rel="stylesheet" href="/assets/mod-tabs.css">'
    + '\n  <link rel="stylesheet" href="/assets/chamber.css">'
    + '\n  <link rel="stylesheet" href="/assets/actions-mast.css">'
    + '\n  <link rel="stylesheet" href="/assets/a11y.css">';
  if (!html.includes('/assets/institutional.css')) {
    html = html.replace(legacy, legacy + extra);
  }
  if (!html.includes('/assets/actions-mast.css')) {
    html = html.replace(
      '<link rel="stylesheet" href="/assets/chamber.css">',
      '<link rel="stylesheet" href="/assets/chamber.css">\n  <link rel="stylesheet" href="/assets/actions-mast.css">',
    );
  }
  html = html.replace(
    /(<a class="mod-tab(?: active)?" href="\/legislation"[^>]*>)Docket(<\/a>)/g,
    '$1Legislation$2',
  );
  if (!html.includes('class="desk-strip"')) {
    html = html.replace(
      '<nav class="mod-bar" aria-label="Modules">',
      deskStrip() + '\n      <nav class="mod-bar" aria-label="Modules">',
    );
  }
  if (!html.includes('/assets/live-floor.js')) {
    html = html.replace('</body>', '  <script src="/assets/live-floor.js" defer></script>\n</body>');
  }
  if (!html.includes('/assets/a11y-prefs.js')) {
    html = html.replace('</body>', '  <script src="/assets/a11y-prefs.js" defer></script>\n</body>');
  }
  return html;
}

function layout(opts) {
  if (opts && opts.actions && typeof opts.actions === 'object') {
    opts = Object.assign({}, opts, {
      actions: opts.actions.__raw ? opts.actions.value : String(opts.actions),
    });
  }
  return withInstitutionalCss(base.layout(opts));
}
function authLayout(title, body) { return withInstitutionalCss(base.authLayout(title, body)); }
function forbidden() { return withInstitutionalCss(base.forbidden()); }

module.exports = { ...base, setUser, layout, authLayout, forbidden, statusBadge, typeBadge };
