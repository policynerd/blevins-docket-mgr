'use strict';

// Site-wide announcement banner. Stored in the key-value `settings` table
// (keys "announcement.*") so a clerk can set, edit, or clear it live from the
// admin screen without a deploy. Rendered by the layout on every page.
const { db } = require('./db');

const LEVELS = ['info', 'warning', 'urgent'];
const PREFIX = 'announcement.';

function get() {
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'announcement.%'").all();
    const s = {};
    for (const r of rows) s[r.key.slice(PREFIX.length)] = r.value;
    const text = (s.text || '').trim();
    return {
      text,
      level: LEVELS.includes(s.level) ? s.level : 'warning',
      active: s.active === '1' && !!text,
    };
  } catch (_) {
    return { text: '', level: 'warning', active: false };
  }
}

function put(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(PREFIX + key, value);
}

// Save the banner. Blank text turns it off. Only known levels are accepted.
function set({ text, level, active }) {
  const t = String(text == null ? '' : text).trim().slice(0, 500);
  put('text', t);
  put('level', LEVELS.includes(level) ? level : 'warning');
  put('active', (active && t) ? '1' : '0');
  return get();
}

// One-time initial notice: sets the banner on first boot only (guarded by a
// "seeded" marker), so it never resurrects after a clerk edits or clears it.
function seedIfAbsent({ text, level } = {}) {
  try {
    const marked = db.prepare("SELECT value FROM settings WHERE key = 'announcement.seeded'").get();
    if (marked) return;
    set({ text, level, active: true });
    put('seeded', '1');
  } catch (_) { /* settings table not ready yet — skip */ }
}

module.exports = { get, set, seedIfAbsent, LEVELS };
