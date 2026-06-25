'use strict';

// Central organization identity / branding.
//
// Resolution order for every field: in-app setting (DB `settings` table, edited
// from the Branding admin screen) > ORG_* environment variable > built-in
// default. The exported `ORG` object is mutated in place by refresh(), so every
// module that did `const { ORG } = require('./org')` and reads `ORG.x` at
// render time picks up live changes without re-importing.

// Field -> { env, def }. `key` (the settings/DB + form name) is the field name.
const FIELDS = {
  name: { env: 'ORG_NAME', def: 'Board of Governors' },
  tagline: { env: 'ORG_TAGLINE', def: 'Legislative Information Center' },
  seal: { env: 'ORG_SEAL', def: '★' },
  logoUrl: { env: 'ORG_LOGO_URL', def: '' },
  primaryColor: { env: 'ORG_PRIMARY_COLOR', def: '#15569e' },
  primaryBody: { env: 'ORG_PRIMARY_BODY', def: 'Board of Governors' },
  primaryBodyType: { env: 'ORG_PRIMARY_BODY_TYPE', def: 'Governing Board' },
  membersLabel: { env: 'ORG_MEMBERS_LABEL', def: 'Board Members' },
  chairTitle: { env: 'ORG_CHAIR_TITLE', def: 'Chair' },
  viceChairTitle: { env: 'ORG_VICE_CHAIR_TITLE', def: 'Vice Chair' },
  memberTitle: { env: 'ORG_MEMBER_TITLE', def: 'Governor' },
  clerkTitle: { env: 'ORG_CLERK_TITLE', def: 'Clerk of the Board' },
  clerkOffice: { env: 'ORG_CLERK_OFFICE', def: 'Office of the Clerk of the Board' },
  meetingLocation: { env: 'ORG_MEETING_LOCATION', def: 'Boardroom' },
  emailDomain: { env: 'ORG_EMAIL_DOMAIN', def: 'board.gov' },
};

// Fields surfaced in the Branding admin form (others stay env/default only).
const EDITABLE = ['name', 'tagline', 'logoUrl', 'primaryColor', 'primaryBody',
  'primaryBodyType', 'membersLabel', 'chairTitle', 'viceChairTitle', 'memberTitle',
  'clerkTitle', 'clerkOffice', 'meetingLocation', 'emailDomain'];

function envOrDefault(field) {
  const f = FIELDS[field];
  const v = process.env[f.env];
  return (v == null || v === '') ? f.def : v;
}

// Base (env/default) layer, applied immediately so the app renders before the
// DB is available. refresh() overlays saved settings on top once init() has run.
const ORG = {};
for (const field of Object.keys(FIELDS)) ORG[field] = envOrDefault(field);

// Lazily required to avoid any load-order coupling with db.js.
function settingsRepo() {
  return require('./db').db;
}

// Overlay saved branding settings (keys like "org.name") onto ORG. Safe to call
// before the settings table exists — it just no-ops on error.
function refresh() {
  let rows = [];
  try {
    rows = settingsRepo().prepare("SELECT key, value FROM settings WHERE key LIKE 'org.%'").all();
  } catch (_) { return ORG; }
  const saved = {};
  for (const r of rows) saved[r.key.slice(4)] = r.value;
  for (const field of Object.keys(FIELDS)) {
    ORG[field] = (saved[field] != null && saved[field] !== '') ? saved[field] : envOrDefault(field);
  }
  return ORG;
}

// Persist edited branding values, then refresh the live ORG object. Only known
// editable fields are written; blank values clear the override (revert to
// env/default).
function update(values = {}) {
  const db = settingsRepo();
  const upsert = db.prepare(`INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  db.exec('SAVEPOINT sp_branding');
  try {
    for (const field of EDITABLE) {
      if (!(field in values)) continue;
      const v = values[field] == null ? '' : String(values[field]).trim();
      if (v === '') del.run('org.' + field);
      else upsert.run('org.' + field, v);
    }
    db.exec('RELEASE sp_branding');
  } catch (e) { db.exec('ROLLBACK TO sp_branding'); db.exec('RELEASE sp_branding'); throw e; }
  return refresh();
}

// Build an official email address from a local-part (e.g. 'clerk' -> clerk@domain).
function orgEmail(localPart) {
  return `${localPart}@${ORG.emailDomain}`;
}

module.exports = { ORG, orgEmail, refresh, update, FIELDS, EDITABLE };
