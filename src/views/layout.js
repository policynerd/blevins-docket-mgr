'use strict';

const { html, raw, formatDate } = require('../util');

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/legislation', label: 'Legislation' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/people', label: 'Council Members' },
  { href: '/bodies', label: 'Bodies & Committees' },
];

// Request-scoped current user. Handlers render synchronously after this is set
// (no awaits between setUser and rendering), so a module field is safe here.
let _user = null;
function setUser(u) { _user = u; }

const RANK = { public: 0, member: 1, staff: 2, clerk: 3 };
function navFor(user) {
  const items = NAV.slice();
  if (user && (RANK[user.role] || 0) >= RANK.member) {
    items.push({ href: '/member', label: 'Member Portal' });
  }
  if (user && (RANK[user.role] || 0) >= RANK.clerk) {
    items.push({ href: '/admin', label: 'Clerk Workspace' });
  }
  return items;
}

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

function layout({ title, active, body, subtitle, head }) {
  const user = _user;
  const nav = navFor(user).map((n) => {
    const isActive = n.href === active;
    return html`<a class="${isActive ? 'active' : ''}" href="${n.href}">${n.label}</a>`;
  });

  const authArea = user
    ? `<span class="util-user">${escapeText(user.name)} · <span class="util-role">${escapeText(user.role)}</span></span>
       <form method="post" action="/logout" class="util-logout"><button type="submit">Sign out</button></form>`
    : '<a href="/login">Staff &amp; Member Sign-In</a>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeText(title ? title + ' · ' : '')}Legislative Information Center</title>
  <link rel="stylesheet" href="/styles.css">
  <link rel="alternate" type="application/rss+xml" title="Recently Introduced Legislation" href="/legislation.rss">
  <link rel="alternate" type="text/calendar" title="Legislative Meetings" href="/calendar.ics">
  ${head || ''}
</head>
<body>
  <div class="gov-utility">
    <div class="wrap util-inner">
      <span class="util-left">City of Westbrook</span>
      <span class="util-right">
        <a href="/api/v1">Developers / API</a>
        <a href="/legislation.rss">RSS</a>
        ${authArea}
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
        <a href="/topics">Indexes</a>
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

// Tabbed panel container (progressive enhancement). `items` is
// [{ id, label, count?, html }]. Without JS every panel renders; assets/tabs.js
// marks the container `.js` and hides inactive panels.
function tabs(items) {
  const nav = items.map((t, i) => {
    const label = escapeText(t.label) + (t.count != null ? ` <span class="tab-count">${escapeText(t.count)}</span>` : '');
    return `<button type="button" class="tab-btn${i === 0 ? ' active' : ''}" data-tab="${escapeText(t.id)}">${label}</button>`;
  }).join('');
  const panels = items.map((t, i) => `
    <div class="tab-panel${i === 0 ? ' active' : ''}" id="tab-${escapeText(t.id)}" role="tabpanel">${t.html}</div>`).join('');
  return `<div class="tabs"><nav class="tab-nav" role="tablist">${nav}</nav>${panels}</div>`;
}

function emptyState(msg) {
  return `<p class="empty">${escapeText(msg)}</p>`;
}

// Vertical routing/approval tracker. `steps` come from repo.workflow.forMatter.
function workflowStepper(steps) {
  if (!steps || !steps.length) return emptyState('This file has not been routed yet.');
  const badge = (st) => `<span class="wf-badge wf-b-${escapeText(String(st).toLowerCase())}">${escapeText(st)}</span>`;
  return `<ol class="wf">${steps.map((s) => `
    <li class="wf-step wf-${escapeText(String(s.status).toLowerCase())}">
      <span class="wf-dot"></span>
      <div class="wf-body">
        <div class="wf-name">${s.seq}. ${escapeText(s.name)} ${badge(s.status)}</div>
        <div class="sub">${escapeText(s.role || '')}${s.acted_by_name ? ' · ' + escapeText(s.acted_by_name) : ''}${s.acted_at ? ' · ' + escapeText(formatDate(s.acted_at)) : ''}</div>
        ${s.notes ? `<div class="sub wf-notes">${escapeText(s.notes)}</div>` : ''}
      </div>
    </li>`).join('')}</ol>`;
}

function forbidden() {
  return layout({
    title: 'Access denied', active: '',
    body: '<div class="hero"><h1>403 — Access denied</h1><p>You don’t have permission to view this page. <a style="color:#fff;text-decoration:underline" href="/login">Sign in</a> with an authorized account.</p></div>',
  });
}

module.exports = { layout, card, tabs, workflowStepper, statusBadge, typeBadge, emptyState, escapeText, NAV, setUser, forbidden };
