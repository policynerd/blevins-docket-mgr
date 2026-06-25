'use strict';

const { html, raw, formatDate } = require('../util');
const { ORG } = require('../org');

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/legislation', label: 'Legislation' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/people', label: ORG.membersLabel },
  { href: '/bodies', label: 'Bodies & Committees' },
  { href: '/org', label: 'Organization' },
];

// Request-scoped current user. Handlers render synchronously after this is set
// (no awaits between setUser and rendering), so a module field is safe here.
let _user = null;
function setUser(u) { _user = u; }

const RANK = { public: 0, member: 1, staff: 2, clerk: 3 };
function navFor(user) {
  // Re-resolve the live members label (branding may have changed it).
  const items = NAV.map((n) => (n.href === '/people' ? { ...n, label: ORG.membersLabel } : n));
  const rank = user ? (RANK[user.role] || 0) : 0;
  if (rank >= RANK.member) items.push({ href: '/member', label: 'Member Portal' });
  if (rank >= RANK.staff) items.push({ href: '/govern/members', label: 'Membership' });
  if (rank >= RANK.clerk) items.push({ href: '/admin', label: 'Clerk Workspace' });
  return items;
}

// Brand color override (validated hex only) applied live via CSS variables.
function brandHead() {
  const c = String(ORG.primaryColor || '');
  if (!/^#[0-9a-fA-F]{3,8}$/.test(c)) return '';
  return `<style>:root{--accent:${c};--accent-dark:color-mix(in srgb, ${c}, #000 28%);}</style>`;
}

const HTTPS_URL = /^https:\/\/[^"'<>\s]+$/;

// Favicon: an explicit favicon URL, else the logo URL, else an auto-generated
// inline SVG (rounded square in the brand color with the seal glyph) so the tab
// icon always reflects the current branding without uploading a file.
function faviconLink() {
  const fav = String(ORG.faviconUrl || '');
  const logo = String(ORG.logoUrl || '');
  let href;
  if (HTTPS_URL.test(fav)) href = fav;
  else if (HTTPS_URL.test(logo)) href = logo;
  else {
    const color = /^#[0-9a-fA-F]{3,8}$/.test(ORG.primaryColor || '') ? ORG.primaryColor : '#15569e';
    const glyph = escapeText(String(ORG.seal || '★').slice(0, 2));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
      + `<rect width="64" height="64" rx="12" fill="${color}"/>`
      + `<text x="32" y="46" font-size="38" text-anchor="middle" fill="#ffffff" `
      + `font-family="Georgia,'Times New Roman',serif">${glyph}</text></svg>`;
    href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  return `<link rel="icon" href="${href}">`;
}

// Banner mark: a logo image when an https logo URL is configured, else the seal glyph.
function brandMark() {
  const url = String(ORG.logoUrl || '');
  if (HTTPS_URL.test(url)) {
    return `<img class="brand-logo" src="${url}" alt="${escapeText(ORG.name)} logo">`;
  }
  return `<span class="brand-seal" aria-hidden="true">${escapeText(ORG.seal)}</span>`;
}

function statusBadge(status) {
  const cls = 'st-' + String(status || '').toLowerCase().replace(/[^a-z]+/g, '-');
  return raw(`<span class="badge ${cls}">${escapeText(status)}</span>`);
}

function typeBadge(type) {
  const cls = 'ty-' + String(type || '').toLowerCase().replace(/[^a-z]+/g, '-');
  return raw(`<span class="badge type ${cls}">${escapeText(type)}</span>`);
}

// Escapes for both text content AND double/single-quoted attribute values
// (escaping quotes is harmless in text context but required in attributes).
function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  <title>${escapeText(title ? title + ' · ' : '')}${escapeText(ORG.tagline)}</title>
  <link rel="stylesheet" href="/styles.css">
  ${faviconLink()}
  <link rel="alternate" type="application/rss+xml" title="Recently Introduced Legislation" href="/legislation.rss">
  <link rel="alternate" type="text/calendar" title="Legislative Meetings" href="/calendar.ics">
  ${brandHead()}
  ${head || ''}
</head>
<body>
  <div class="gov-utility">
    <div class="wrap util-inner">
      <span class="util-left">${escapeText(ORG.name)}</span>
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
        ${brandMark()}
        <span class="brand-text">
          <strong>${escapeText(ORG.name)}</strong>
          <small>${escapeText(ORG.tagline)}</small>
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
        <strong>${escapeText(ORG.name)} — ${escapeText(ORG.tagline)}</strong>
        <p>Public records of ordinances, resolutions, meetings, and votes.</p>
      </div>
      <div class="footer-links">
        <a href="/legislation">Legislation</a>
        <a href="/calendar">Calendar</a>
        <a href="/org">Organization</a>
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
