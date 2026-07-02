'use strict';

// SQLite backups via VACUUM INTO: a consistent, compacted copy of the live
// database written alongside it on the data volume. Runs on boot (if the
// newest copy is stale) and every 24h while the machine is up; Fly's volume
// snapshots remain the second line of defense.
const fs = require('node:fs');
const path = require('node:path');
const { db, DB_PATH } = require('./db');

const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const KEEP = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^docket-.*\.db$/.test(f))
    .sort()
    .map((f) => {
      const p = path.join(BACKUP_DIR, f);
      const st = fs.statSync(p);
      return { name: f, path: p, size: st.size, mtime: st.mtimeMs };
    });
}

function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
  const dest = path.join(BACKUP_DIR, `docket-${stamp}.db`);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  const all = listBackups();
  for (const b of all.slice(0, Math.max(0, all.length - KEEP))) fs.unlinkSync(b.path);
  return dest;
}

// Kick a backup if the newest one is older than a day, then keep a daily
// timer while the process lives (unref'd so it never blocks shutdown).
function schedule() {
  try {
    const newest = listBackups().pop();
    if (!newest || Date.now() - newest.mtime > DAY_MS) runBackup();
  } catch (e) { console.error('Backup failed:', e.message); }
  setInterval(() => {
    try { runBackup(); } catch (e) { console.error('Backup failed:', e.message); }
  }, DAY_MS).unref();
}

module.exports = { runBackup, listBackups, schedule, BACKUP_DIR };
