'use strict';

const pages = require('./pages');
const { escapeHtml: escapeText, formatDate } = require('../util');

const MAST = `<div class="actions-mast" role="img" aria-label="Actions as Introduced inside the Board Chamber">
  <div class="actions-mast-art">
    <div class="actions-mast-copy">
      <p class="actions-mast-kicker">Actions as Introduced</p>
      <p class="actions-mast-sub">inside the Board Chamber</p>
    </div>
    <svg class="actions-mast-building" viewBox="0 0 320 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g fill="none" stroke="#2b2b2b" stroke-width="1.4" stroke-linejoin="miter">
        <path d="M12 108h296"/>
        <path d="M28 108 V78 h46 V108"/>
        <path d="M40 88h8M52 88h8M40 96h8M52 96h8"/>
        <path d="M74 108 V62 h72 V108"/>
        <path d="M86 74h10M102 74h10M118 74h10M86 86h10M102 86h10M118 86h10M86 98h10M102 98h10"/>
        <path d="M146 108 V48 h28 V28 h36 V48 h22 V108"/>
        <path d="M158 60h12M176 60h12M194 60h12M212 60h12"/>
        <path d="M158 72h12M176 72h12M194 72h12"/>
        <path d="M158 84h12M176 84h12M194 84h12"/>
        <path d="M232 108 V38 h56 V18 h20 V108"/>
        <path d="M244 50h12M262 50h12M280 50h12"/>
        <path d="M244 62h12M262 62h12M280 62h12"/>
        <path d="M244 74h12M262 74h12"/>
        <path d="M250 18 v-10 h16 v10"/>
        <path d="M20 108c8-14 18-22 28-22s16 10 22 22"/>
        <path d="M210 108c6-10 12-16 20-16 8 0 12 8 16 16"/>
      </g>
    </svg>
  </div>
</div>`;

function glanceHtml(matter) {
  let last = '';
  let next = '';
  try {
    const aw = require('../awareness');
    const la = aw.lastAction(matter.id);
    const nh = aw.nextHearing(matter.id, require('../util').todayISO());
    if (la) last = `${la.action}${la.result ? ' · ' + la.result : ''} (${formatDate(la.action_date)})`;
    if (nh) next = `${nh.body_name} · ${formatDate(nh.meeting_date)}`;
  } catch (_) { /* */ }
  if (!last && !next && !matter.assented_at) return '';
  const bits = [];
  if (last) bits.push(`<span>Last action: ${escapeText(last)}</span>`);
  if (next) bits.push(`<span>Next: ${escapeText(next)}</span>`);
  if (matter.assented_at) {
    bits.push(`<span>Assented ${escapeText(formatDate(matter.assented_at) || matter.assented_at)}${matter.assented_by_name ? ' · ' + escapeText(matter.assented_by_name) : ''}</span>`);
  }
  return `<p class="file-glance">${bits.join('')}</p>`;
}

function paintMast(html) {
  if (!html || html.includes('actions-mast')) return html;
  html = html.replace('<body>', '<body class="actions-intro">');
  html = html.replace('<main class="main-area">', '<main class="main-area">\n        ' + MAST);
  return html;
}

function install() {
  if (pages.__legislationInstalled) return;
  pages.__legislationInstalled = true;
  const origList = pages.legislationList;
  if (typeof origList === 'function') {
    pages.legislationList = function legislationListWired(query, user) {
      return paintMast(origList(query, user));
    };
  }
  const origDetail = pages.matterDetail;
  pages.matterDetail = function matterDetailWired(matter, query, user) {
    let html = origDetail(matter, query, user);
    html = paintMast(html);
    const g = glanceHtml(matter);
    if (g) html = html.replace('<ol class="track"', g + '<ol class="track"');
    const fn = encodeURIComponent(matter.file_number);
    if (html.includes('Draft text') && !html.includes('/instrument"')) {
      html = html.replace('>Draft text</a>', `>Draft text</a>\n    <a class="btn" href="/admin/legislation/${fn}/instrument">Instrument</a>`);
    }
    if (matter.status === 'Passed' && !matter.assented_at) {
      html = html.replace(
        `href="/admin/matters/${matter.id}/edit">Manage</a>`,
        `href="/admin/matters/${matter.id}/edit">Manage</a>\n    <form method="post" action="/admin/matters/${matter.id}/assent" class="inline"><button type="submit" class="btn">Assent</button></form>`,
      );
    }
    return html;
  };
}

module.exports = { install };
