'use strict';

const { db } = require('./db');

let applied = false;

function tryExec(sql) {
  try { db.exec(sql); } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message)) throw e;
  }
}

function apply() {
  if (applied) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS publications (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      actor_id INTEGER REFERENCES users(id),
      actor_name TEXT,
      reason TEXT,
      supersedes_id INTEGER REFERENCES publications(id),
      manifest_json TEXT,
      manifest_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agenda_versions (
      id INTEGER PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      publication_id INTEGER REFERENCES publications(id),
      version INTEGER NOT NULL,
      snapshot_json TEXT,
      snapshot_hash TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS record_changes (
      id INTEGER PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      actor_id INTEGER REFERENCES users(id),
      actor_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS spend_requests (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'expense',
      status TEXT NOT NULL DEFAULT 'Draft',
      budget_line_id INTEGER REFERENCES budget_lines(id) ON DELETE SET NULL,
      org_unit_id INTEGER REFERENCES org_units(id) ON DELETE SET NULL,
      matter_id INTEGER REFERENCES matters(id) ON DELETE SET NULL,
      vendor_name TEXT,
      title TEXT NOT NULL,
      purpose TEXT,
      amount REAL NOT NULL,
      requested_by INTEGER REFERENCES users(id),
      requested_by_name TEXT,
      submitted_at TEXT,
      decided_by INTEGER REFERENCES users(id),
      decided_by_name TEXT,
      decided_at TEXT,
      decision_note TEXT,
      posted_tx_id INTEGER REFERENCES budget_transactions(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  tryExec("ALTER TABLE budget_transactions ADD COLUMN spend_request_id INTEGER REFERENCES spend_requests(id)");
  tryExec("ALTER TABLE matters ADD COLUMN citations TEXT");
  tryExec("ALTER TABLE matters ADD COLUMN recitals TEXT");
  tryExec("ALTER TABLE matters ADD COLUMN enacting_formula TEXT");
  tryExec("ALTER TABLE matters ADD COLUMN assented_at TEXT");
  tryExec("ALTER TABLE matters ADD COLUMN assented_by INTEGER REFERENCES users(id)");
  tryExec("ALTER TABLE matters ADD COLUMN assented_by_name TEXT");
  tryExec("ALTER TABLE attachments ADD COLUMN content_hash TEXT");
  tryExec("ALTER TABLE agenda_item_docs ADD COLUMN content_hash TEXT");
  applied = true;
}

module.exports = { apply };
