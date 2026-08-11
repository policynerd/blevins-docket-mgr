'use strict';

// Periodic alert jobs: saved-search matches and the daily digest. Runs on an
// interval only when SMTP is configured; each pass is cheap against SQLite.
const { db } = require('./db');
const repo = require('./repo');
const notify = require('./notify');
const smtp = require('./smtp');

// Saved searches: email the owner when new files match their query.
function checkSavedSearches() {
  for (const s of repo.savedSearches.all()) {
    try {
      const matches = repo.savedSearches.newMatches(s);
      if (!matches.length) continue;
      const lines = matches.map((m) => `  ${m.file_number} — ${m.title} (${m.type}, ${m.status})`);
      notify.queue(s.email, `${matches.length} new file(s) match "${s.name}"`,
        `New legislative files matching your saved search "${s.name}":\n\n${lines.join('\n')}\n\n`
        + `Run the search: ${notify.baseUrl()}/legislation`);
      repo.savedSearches.bump(s.id, Math.max(...matches.map((m) => m.id)));
    } catch (e) { console.error('saved-search check failed:', e.message); }
  }
}

// Daily digest: yesterday's recorded actions + today's meetings, once per
// UTC day, to every opted-in account.
function sendDailyDigest() {
  const today = new Date().toISOString().slice(0, 10);
  const last = db.prepare("SELECT value FROM settings WHERE key = 'digest.last_date'").get();
  if (last && last.value === today) return;
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('digest.last_date', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(today);

  const subscribers = db.prepare(`SELECT email, name FROM users
    WHERE digest = 1 AND active = 1 AND email IS NOT NULL`).all();
  if (!subscribers.length) return;

  const actions = db.prepare(`
    SELECT h.action, h.result, m.file_number, m.title
    FROM matter_history h JOIN matters m ON m.id = h.matter_id
    WHERE h.action_date >= date('now', '-1 day')
    ORDER BY h.id DESC LIMIT 40`).all();
  const meetings = db.prepare(`
    SELECT mt.meeting_date, mt.meeting_time, mt.location, b.name AS body_name, mt.id
    FROM meetings mt JOIN bodies b ON b.id = mt.body_id
    WHERE mt.meeting_date = date('now') AND mt.status != 'Cancelled'
    ORDER BY mt.meeting_time`).all();
  if (!actions.length && !meetings.length) return;

  const parts = [];
  if (meetings.length) {
    parts.push('MEETINGS TODAY\n' + meetings.map((m) =>
      `  ${m.body_name}${m.meeting_time ? ' · ' + m.meeting_time : ''}${m.location ? ' · ' + m.location : ''}`
      + `\n    ${notify.baseUrl()}/meetings/${m.id}`).join('\n'));
  }
  if (actions.length) {
    parts.push('RECENT ACTIONS\n' + actions.map((a) =>
      `  ${a.file_number}: ${a.action}${a.result ? ' — ' + a.result : ''} (${a.title.slice(0, 60)})`).join('\n'));
  }
  const body = `Daily digest for ${today}\n\n${parts.join('\n\n')}`;
  for (const s of subscribers) notify.queue(s.email, `Daily digest — ${today}`, body);
}

function schedule() {
  if (!smtp.isConfigured()) return;
  const tick = () => {
    try { checkSavedSearches(); } catch (e) { console.error('alerts:', e.message); }
    try { sendDailyDigest(); } catch (e) { console.error('digest:', e.message); }
  };
  setTimeout(tick, 15 * 1000).unref();            // shortly after boot
  setInterval(tick, 15 * 60 * 1000).unref();      // then every 15 minutes
}

module.exports = { checkSavedSearches, sendDailyDigest, schedule };
