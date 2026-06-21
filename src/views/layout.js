'use strict';

const { html, raw } = require('../util');

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/legislation', label: 'Legislation' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/people', label: 'Council Members' },
  { href: '/bodies', label: 'Bodies & Committees' },
  { href: '/admin', label: 'Admin' },
];

function statusBadge(status) {
  const cls = 'st-' + String(status || '').toLowerCase().replace(/[^a-z]+/g, '-');
  return raw(`<span class="badge ${cls}">${escapeText(status)}</span>`);
}

function typeBadge(type) {
  const cls = 'ty-' + String(type || '').toLowerCase().replace(/[^a-z]+/g, '-');
  return raw(`<span class="badge type ${cls}">${escapeText(type)}</span>`);
}

function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function layout({ title, active, body, subtitle }) {
  const nav = NAV.map((n) => {
    const isActive = n.href === active;
    return html`<a class="${isActive ? 'active' : ''}" href="${n.href}">${n.label}</a>`;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeText(title ? title + ' · ' : '')}Docket Manager</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <div class="wrap header-inner">
      <a class="brand" href="/">
        <span class="brand-seal">DM</span>
        <span class="brand-text">
          <strong>Legislative Docket Manager</strong>
          <small>Office of the City Clerk</small>
        </span>
      </a>
      <form class="header-search" action="/legislation" method="get">
        <input type="search" name="q" placeholder="Search legislation, file #, sponsor…" aria-label="Search">
        <button type="submit">Search</button>
      </form>
    </div>
    <nav class="site-nav"><div class="wrap nav-inner">${nav.join('')}</div></nav>
  </header>
  <main class="wrap">
    ${subtitle ? `<div class="page-head"><h1>${escapeText(title)}</h1><p class="muted">${escapeText(subtitle)}</p></div>` : ''}
    ${body}
  </main>
  <footer class="site-footer">
    <div class="wrap">
      <p>Legislative Docket Manager · an open, Legistar-style legislative management system.
         Public records portal &amp; <a href="/api/v1">Web API</a>.</p>
    </div>
  </footer>
</body>
</html>`;
}

function card(title, inner, opts = {}) {
  const actions = opts.actions ? `<div class="card-actions">${opts.actions}</div>` : '';
  return `<section class="card">
    <div class="card-head"><h2>${escapeText(title)}</h2>${actions}</div>
    <div class="card-body">${inner}</div>
  </section>`;
}

function emptyState(msg) {
  return `<p class="empty">${escapeText(msg)}</p>`;
}

module.exports = { layout, card, statusBadge, typeBadge, emptyState, escapeText, NAV };
