'use strict';

// Plain-text feed generators (no dependencies): iCalendar, CSV, RSS 2.0.
const repo = require('./repo');
const { formatDate } = require('./util');

// --- iCalendar (RFC 5545) ----------------------------------------------------
function icalEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Best-effort parse of a free-text time like "6:00 PM" → { h, m }.
function parseTime(t) {
  if (!t) return null;
  const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return { h, m: min };
}

function pad(n) { return String(n).padStart(2, '0'); }

function icalCalendar(meetings, baseUrl) {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'PRODID:-//Legislative Docket Manager//Calendar//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Legislative Meetings',
  ];

  for (const mt of meetings) {
    const date = mt.meeting_date.replace(/-/g, '');
    const time = parseTime(mt.meeting_time);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:meeting-${mt.id}@docket-manager`);
    lines.push(`DTSTAMP:${stamp}`);
    if (time) {
      const start = `${date}T${pad(time.h)}${pad(time.m)}00`;
      const endH = (time.h + 1) % 24;
      lines.push(`DTSTART:${start}`);
      lines.push(`DTEND:${date}T${pad(endH)}${pad(time.m)}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${date}`);
    }
    lines.push(`SUMMARY:${icalEscape(mt.body_name + ' Meeting')}`);
    if (mt.location) lines.push(`LOCATION:${icalEscape(mt.location)}`);
    const desc = [
      mt.meeting_time ? 'Time: ' + mt.meeting_time : '',
      'Status: ' + mt.status,
      baseUrl ? baseUrl + '/meetings/' + mt.id : '',
    ].filter(Boolean).join('\\n');
    lines.push(`DESCRIPTION:${icalEscape(desc)}`);
    if (baseUrl) lines.push(`URL:${baseUrl}/meetings/${mt.id}`);
    lines.push(`STATUS:${mt.status === 'Cancelled' ? 'CANCELLED' : 'CONFIRMED'}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  // RFC 5545 uses CRLF line endings.
  return lines.join('\r\n') + '\r\n';
}

// --- CSV (RFC 4180) ----------------------------------------------------------
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function mattersCsv(rows) {
  const header = ['File Number', 'Type', 'Title', 'Status', 'In Control', 'Introduced', 'Sponsors'];
  const lines = [header.map(csvCell).join(',')];
  for (const m of rows) {
    lines.push([
      m.file_number, m.type, m.title, m.status,
      m.body_name || '', m.intro_date || '', m.sponsors || '',
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// --- RSS 2.0 -----------------------------------------------------------------
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rfc822(dateStr) {
  if (!dateStr) return new Date().toUTCString();
  const d = new Date(dateStr.length <= 10 ? dateStr + 'T00:00:00Z' : dateStr);
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

function legislationRss(rows, baseUrl) {
  const items = rows.map((m) => {
    const link = `${baseUrl}/legislation/${encodeURIComponent(m.file_number)}`;
    const desc = `${m.type} · ${m.status}` + (m.summary ? ` — ${m.summary}` : '');
    return [
      '    <item>',
      `      <title>${xmlEscape(m.file_number + ': ' + m.title)}</title>`,
      `      <link>${xmlEscape(link)}</link>`,
      `      <guid isPermaLink="true">${xmlEscape(link)}</guid>`,
      `      <pubDate>${rfc822(m.intro_date)}</pubDate>`,
      `      <description>${xmlEscape(desc)}</description>`,
      '    </item>',
    ].join('\n');
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Legislative Docket — Recently Introduced</title>
    <link>${xmlEscape(baseUrl + '/legislation')}</link>
    <description>Newly introduced legislative files.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

module.exports = { icalCalendar, mattersCsv, legislationRss };
