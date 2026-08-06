'use strict';

const { html, raw, formatDate } = require('../util');
const { ORG } = require('../org');
const { getFooterHtml } = require('../footer-content');

// Primary navigation, grouped into sidebar sections. Labels are resolved live
// at render time (branding can rename the members label).
const NAV_GROUPS = [
  { label: null, items: [{ href: '/', label: 'Dashboard' }] },
  { label: 'Legislation', items: [
    { href: '/legislation', label: 'Legislation' },
    { href: '/calendar', label: 'Calendar' },
    { href: '/docket', label: "Today's Docket" },
    { href: '/policies', label: 'Policies' },
  ] },
  { label: 'Finance', items: [
    { href: '/budget', label: 'Budget' },
    { href: '/procurement', label: 'Procurement' },
  ] },
  { label: 'People & Bodies', items: [
    { href: '/people', label: ORG.membersLabel },
    { href: '/bodies', label: 'Bodies & Committees' },
    { href: '/org', label: 'Organization' },
  ] },
  { label: 'Participate', items: [
    { href: '/proposals', label: 'Proposals' },
    { href: '/accountability', label: 'Accountability' },
  ] },
];
// Flat list kept for any consumer that iterates the whole nav.
const NAV = NAV_GROUPS.flatMap((g) => g.items);

// Request-scoped current user. Handlers render synchronously after this is set
// (no awaits between setUser and rendering), so a module field is safe here.
let _user = null;
function setUser(u) { _user = u; }

const RANK = { public: 0, member: 1, staff: 2, clerk: 3 };
// Returns nav as groups [{ label, items:[{ href, label, badge? }] }], with the
// members label re-resolved live and role-gated sections appended.
function navFor(user) {
  const groups = NAV_GROUPS.map((g) => ({
    label: g.label,
    items: g.items.map((n) => (n.href === '/people' ? { ...n, label: ORG.membersLabel } : { ...n })),
  }));
  const rank = user ? (RANK[user.role] || 0) : 0;
  const workspace = [];
  if (rank >= RANK.member) {
    workspace.push({ href: '/member', label: 'Member Portal' });
    // Approvals routed to this user (lazy require avoids a load-order cycle).
    let count = 0;
    try { count = require('../repo').workflow.inboxCount(user.id, rank >= RANK.clerk); } catch (_) { /* ignore */ }
    workspace.push({ href: '/approvals', label: 'Approvals', badge: count || null });
  }
  if (rank >= RANK.staff) workspace.push({ href: '/govern/members', label: 'Membership' });
  if (rank >= RANK.clerk) {
    workspace.push({ href: '/admin/consents', label: 'Written Consents' });
    workspace.push({ href: '/admin/announcement', label: 'Announcement' });
    workspace.push({ href: '/admin', label: 'Clerk Workspace' });
  }
  if (workspace.length) groups.push({ label: 'Workspace', items: workspace });
  return groups;
}

// Brand color override (validated hex only) applied live via CSS variables.
function brandHead() {
  const c = String(ORG.primaryColor || '');
  if (!/^#[0-9a-fA-F]{3,8}$/.test(c)) return '';
  return `<style>:root{--accent:${c};--accent-dark:color-mix(in srgb, ${c}, #000 28%);}</style>`;
}

const HTTPS_URL = /^https:\/\/[^"'<>\s]+$/;
// Brand art may be hosted (https) or shipped with the app under /brand/.
// A local path keeps the mark working offline and on first boot.
const LOCAL_ASSET = /^\/(brand|assets)\/[A-Za-z0-9._-]+$/;
function isBrandSrc(v) { return HTTPS_URL.test(v) || LOCAL_ASSET.test(v); }

// Favicon: an explicit favicon URL, else the logo URL, else an auto-generated
// inline SVG (rounded square in the brand color with the seal glyph) so the tab
// icon always reflects the current branding without uploading a file.
function faviconLink() {
  const fav = String(ORG.faviconUrl || '');
  const logo = String(ORG.logoUrl || '');
  let href;
  if (isBrandSrc(fav)) href = fav;
  else if (isBrandSrc(logo)) href = logo;
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
// The board's mark. `variant: 'light'` is for dark grounds (the navy rail),
// where the reversed artwork is used when one has been supplied.
function brandMark({ variant = 'light', cls = 'brand-logo' } = {}) {
  const light = String(ORG.logoLightUrl || '');
  const dark = String(ORG.logoUrl || '');
  // On a dark ground prefer the reversed mark, else fall back to the standard one.
  const src = variant === 'light'
    ? (isBrandSrc(light) ? light : (isBrandSrc(dark) ? dark : ''))
    : (isBrandSrc(dark) ? dark : (isBrandSrc(light) ? light : ''));
  if (src) {
    return `<img class="${escapeText(cls)}" src="${escapeText(src)}" alt="${escapeText(ORG.name)} seal">`;
  }
  return `<span class="brand-seal" aria-hidden="true">${escapeText(ORG.seal)}</span>`;
}

// The sidebar masthead. A horizontal lockup already contains the organization
// name, so it stands alone; otherwise the seal is set beside the name in type.
function brandBlock() {
  const lockup = String(ORG.logoLockupUrl || '');
  if (isBrandSrc(lockup)) {
    return `<a class="brand brand-lockup-wrap" href="/">`
      + `<img class="brand-lockup" src="${escapeText(lockup)}" alt="${escapeText(ORG.name)}">`
      + '</a>';
  }
  return `<a class="brand" href="/">
        ${brandMark()}
        <span class="brand-text">
          <strong>${escapeText(ORG.name)}</strong>
          <small>${escapeText(ORG.tagline)}</small>
        </span>
      </a>`;
}

// The mark for the sign-in page, which sits on a light ground.
//
// Prefer the light-ground seal. Failing that, a lockup is usually reversed
// artwork meant for the navy rail — invisible on white — so it is set on a
// navy plate rather than dropped onto the page, which is what made the
// sign-in page fall back to the placeholder glyph while the rail showed the
// real mark.
// True when the sign-in mark is a lockup that already sets the name in type,
// so the adjacent wordmark would repeat it. Kept for screen readers.
function authMarkCarriesName() {
  return !isBrandSrc(String(ORG.logoUrl || '')) && isBrandSrc(String(ORG.logoLockupUrl || ''));
}

function authMark() {
  // The artwork is decorative in every branch: the adjacent .auth-brand-text
  // supplies the name and tagline, visibly or to assistive tech, so alt text
  // here would announce the organization twice.
  const seal = String(ORG.logoUrl || '');
  if (isBrandSrc(seal)) {
    return `<img class="brand-logo" src="${escapeText(seal)}" alt="">`;
  }
  // Validate each candidate in turn. Branding values are stored unvalidated,
  // so a malformed lockup must not shadow a usable reversed seal.
  for (const cand of [String(ORG.logoLockupUrl || ''), String(ORG.logoLightUrl || '')]) {
    if (isBrandSrc(cand)) {
      return `<span class="auth-plate"><img class="auth-plate-img" src="${escapeText(cand)}" alt=""></span>`;
    }
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

// Grouped left-rail navigation. Groups render as labelled sections of links.
function sideNav(user, active) {
  return navFor(user).map((g) => {
    const links = g.items.map((n) => {
      const badge = n.badge ? `<span class="nav-badge">${escapeText(n.badge)}</span>` : '';
      return `<a class="${n.href === active ? 'active' : ''}" href="${escapeText(n.href)}">${escapeText(n.label)}${badge}</a>`;
    }).join('');
    const label = g.label ? `<div class="nav-group-label">${escapeText(g.label)}</div>` : '';
    return `<div class="nav-group">${label}${links}</div>`;
  }).join('');
}

function announcementBanner() {
  let a;
  try { a = require('../announcement').get(); } catch (_) { return ''; }
  if (!a.active || !a.text) return '';
  return `<div class="announce announce-${escapeText(a.level)}" role="alert">`
    + `<span class="announce-ic" aria-hidden="true">📢</span>`
    + `<span class="announce-text">${escapeText(a.text)}</span></div>`;
}

function layout({ title, active, body, subtitle, head }) {
  const user = _user;
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
  <input type="checkbox" id="nav-toggle-cb" class="nav-toggle-cb" hidden>
  <div class="app">
    <aside class="sidebar" aria-label="Primary navigation">
      ${brandBlock()}
      <nav class="sidenav">${sideNav(user, active)}</nav>
    </aside>
    <div class="content">
      <div class="topbar">
        <label for="nav-toggle-cb" class="nav-toggle" aria-label="Toggle navigation">☰</label>
        <form class="banner-search" action="/legislation" method="get" role="search">
          <input type="search" name="q" placeholder="Search legislation, file #, or sponsor" aria-label="Search legislation">
          <button type="submit">Search</button>
        </form>
        <span class="util-right">
          <a href="/api/v1">Developers / API</a>
          <a href="/legislation.rss">RSS</a>
          ${authArea}
        </span>
      </div>
      ${announcementBanner()}
      <main class="main-area">
        ${subtitle ? `<div class="page-head"><h1>${escapeText(title)}</h1><p class="muted">${escapeText(subtitle)}</p></div>` : ''}
        ${body}
      </main>
      <footer class="site-footer">
        <div class="footer-inner">
          <div>
            <strong>${escapeText(ORG.name)} — ${escapeText(ORG.tagline)}</strong>
            ${getFooterHtml() || '<p>Public records of ordinances, resolutions, meetings, and votes.</p>'}
          </div>
          <div class="footer-links">
            <a href="/legislation">Legislation</a>
            <a href="/calendar">Calendar</a>
            <a href="/policies">Policies</a>
            <a href="/org">Organization</a>
            <a href="/api/v1">Web API</a>
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
          </div>
        </div>
        <div class="footer-legal">
          © ${new Date().getFullYear()} ${escapeText(ORG.name)}. All rights reserved.
          · <a href="/terms">Terms &amp; Conditions</a> · <a href="/privacy">Privacy Notice</a>
        </div>
      </footer>
    </div>
  </div>
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
  const routedTo = (s) => ((s.status === 'Pending' || s.status === 'Returned')
    ? (s.assignee_name ? ' · routed to ' + escapeText(s.assignee_name) : ' · unassigned (any clerk)')
    : '');
  return `<ol class="wf">${steps.map((s) => `
    <li class="wf-step wf-${escapeText(String(s.status).toLowerCase())}">
      <span class="wf-dot"></span>
      <div class="wf-body">
        <div class="wf-name">${s.seq}. ${escapeText(s.name)} ${badge(s.status)}</div>
        <div class="sub">${escapeText(s.role || '')}${routedTo(s)}${s.acted_by_name ? ' · ' + escapeText(s.acted_by_name) : ''}${s.acted_at ? ' · ' + escapeText(formatDate(s.acted_at)) : ''}</div>
        ${s.notes ? `<div class="sub wf-notes">${escapeText(s.notes)}</div>` : ''}
      </div>
    </li>`).join('')}</ol>`;
}

// Standalone centered layout for auth pages — no nav, just brand + content + slim footer.
function authLayout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeText(title ? title + ' · ' : '')}${escapeText(ORG.tagline)}</title>
  <link rel="stylesheet" href="/styles.css">
  ${faviconLink()}
  ${brandHead()}
</head>
<body class="auth-page">
  <div class="auth-shell">
    <a class="auth-brand" href="/">
      ${authMark()}
      <span class="auth-brand-text${authMarkCarriesName() ? ' visually-hidden' : ''}">
        <strong>${escapeText(ORG.name)}</strong>
        <small>${escapeText(ORG.tagline)}</small>
      </span>
    </a>
    ${body}
    <footer class="auth-foot">
      © ${new Date().getFullYear()} ${escapeText(ORG.name)} ·
      <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> ·
      <a href="/">Public portal</a>
    </footer>
  </div>
</body>
</html>`;
}

function forbidden() {
  return layout({
    title: 'Access denied', active: '',
    body: '<div class="hero"><h1>403 — Access denied</h1><p>You don\'t have permission to view this page. <a style="color:#fff;text-decoration:underline" href="/login">Sign in</a> with an authorized account.</p></div>',
  });
}

module.exports = { layout, authLayout, card, tabs, workflowStepper, statusBadge, typeBadge, emptyState, escapeText, NAV, setUser, forbidden };
