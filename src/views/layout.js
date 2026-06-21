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
  <title>${escapeText(title ? title + ' · ' : '')}Legislative Information Center</title>
  <link rel="stylesheet" href="/styles.css">
  <link rel="alternate" type="application/rss+xml" title="Recently Introduced Legislation" href="/legislation.rss">
  <link rel="alternate" type="text/calendar" title="Legislative Meetings" href="/calendar.ics">
</head>
<body>
  <div class="gov-utility">
    <div class="wrap util-inner">
      <span class="util-left">City of Westbrook</span>
      <span class="util-right">
        <a href="/api/v1">Developers / API</a>
        <a href="/legislation.rss">RSS</a>
        <a href="/admin">Staff Sign-In</a>
      </span>
    </div>
  </div>
  <header class="gov-banner">
    <div class="wrap banner-inner">
      <a class="brand" href="/">
        <span class="brand-seal" aria-hidden="true">★</span>
        <span class="brand-text">
          <strong>City of Westbrook</strong>
          <small>Legislative Information Center</small>
        </span>
      </a>
      <form class="banner-search" action="/legislation" method="get" role="search">
        <input type="search" name="q" placeholder="Search legislation, file #, or sponsor" aria-label="Search legislation">
        <button type="submit">Search</button>
      </form>
    </div>
  </header>
  <nav class="gov-tabs" aria-label="Primary">
    <div class="wrap tabs-inner">${nav.join('')}</div>
  </nav>
  <main class="wrap main-area">
    ${subtitle ? `<div class="page-head"><h1>${escapeText(title)}</h1><p class="muted">${escapeText(subtitle)}</p></div>` : ''}
    ${body}
  </main>
  <footer class="site-footer">
    <div class="wrap footer-inner">
      <div>
        <strong>City of Westbrook — Legislative Information Center</strong>
        <p>Public records of ordinances, resolutions, meetings, and votes.</p>
      </div>
      <div class="footer-links">
        <a href="/legislation">Legislation</a>
        <a href="/calendar">Calendar</a>
        <a href="/api/v1">Web API</a>
        <a href="/legislation.rss">RSS</a>
        <a href="/calendar.ics">iCalendar</a>
      </div>
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
