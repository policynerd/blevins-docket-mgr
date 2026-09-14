'use strict';

const pages = require('./pages');
const { escapeHtml: escapeText, formatDate } = require('../util');

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

function install() {
  if (pages.__legislationInstalled) return;
  pages.__legislationInstalled = true;
  const origDetail = pages.matterDetail;
  pages.matterDetail = function matterDetailWired(matter, query, user) {
    let html = origDetail(matter, query, user);
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
