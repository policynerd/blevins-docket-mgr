'use strict';
const { db } = require('./db');

function getFooterHtml() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'footer.body'").get();
    return row && row.value ? row.value : null;
  } catch (_) { return null; }
}

function setFooterHtml(html) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('footer.body', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(html || '');
}

module.exports = { getFooterHtml, setFooterHtml };
