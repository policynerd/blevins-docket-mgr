'use strict';

const base = require('./layout-base');

let currentUser = null;
const origSetUser = base.setUser;
function setUser(u) {
  currentUser = u;
  return origSetUser(u);
}

function deskStrip() {
  const user = currentUser;
  if (!user) return '';
  let desk;
  try { desk = require('../awareness').desk(user); }
  catch (_) { return ''; }
  const bits = [];
  if (desk.inbox) bits.push(`<a href="/approvals">${desk.inbox} awaiting approval</a>`);
  if (desk.moved && desk.moved.length) {
    bits.push(`${desk.moved.length} watched file${desk.moved.length === 1 ? '' : 's'} moved`);
  }
  try {
    if (require('../auth').hasRole(user, 'staff')) bits.push('<a href="/spend">Spend</a>');
  } catch (_) { /* */ }
  bits.push(`<a href="/watching">Watching (${(desk.watches || []).length})</a>`);
  if (!bits.length) return '';
  return `<p class="desk-strip">${bits.join(' · ')}</p>`;
}

function withInstitutionalCss(markup) {
  let html = String(markup || '');
  const legacy = '<link rel="stylesheet" href="/styles.css">';
  const institutional = legacy
    + '\n  <link rel="stylesheet" href="/assets/institutional.css">'
    + '\n  <link rel="stylesheet" href="/assets/mod-tabs.css">';
  if (!html.includes('/assets/institutional.css')) {
    html = html.replace(legacy, institutional);
  } else if (!html.includes('/assets/mod-tabs.css')) {
    html = html.replace(
      '<link rel="stylesheet" href="/assets/institutional.css">',
      '<link rel="stylesheet" href="/assets/institutional.css">\n  <link rel="stylesheet" href="/assets/mod-tabs.css">',
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
  return html;
}

function layout(opts) { return withInstitutionalCss(base.layout(opts)); }
function authLayout(title, body) { return withInstitutionalCss(base.authLayout(title, body)); }
function forbidden() { return withInstitutionalCss(base.forbidden()); }

module.exports = { ...base, setUser, layout, authLayout, forbidden };
