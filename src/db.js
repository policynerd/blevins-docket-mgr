'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// DB_PATH may point anywhere (e.g. a mounted volume via DOCKET_DB); ensure its
// parent directory exists rather than assuming the in-repo ./data folder.
const DB_PATH = process.env.DOCKET_DB || path.join(__dirname, '..', 'data', 'docket.db');
const DB_DIR = path.dirname(DB_PATH);

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  title TEXT,
  district TEXT,
  party TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  photo_url TEXT,
  bio TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bodies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  description TEXT,
  meeting_location TEXT,
  meets TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS body_members (
  id INTEGER PRIMARY KEY,
  body_id INTEGER NOT NULL REFERENCES bodies(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'Member',
  voting INTEGER NOT NULL DEFAULT 1,
  start_date TEXT,
  end_date TEXT
);

CREATE TABLE IF NOT EXISTS matters (
  id INTEGER PRIMARY KEY,
  file_number TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',
  body_id INTEGER REFERENCES bodies(id),
  intro_date TEXT,
  final_date TEXT,
  summary TEXT,
  full_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matter_sponsors (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  sponsor_type TEXT NOT NULL DEFAULT 'Sponsor'
);

CREATE TABLE IF NOT EXISTS matter_history (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  action_date TEXT,
  body_id INTEGER REFERENCES bodies(id),
  action TEXT NOT NULL,
  result TEXT,
  notes TEXT,
  meeting_id INTEGER REFERENCES meetings(id)
);

-- Archived text versions of a matter. The matters row always holds the current
-- text; editing snapshots the previous text here first (Legistar-style
-- introduced/amended/adopted history). Current version = COUNT(versions) + 1.
CREATE TABLE IF NOT EXISTS matter_versions (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  full_text TEXT,
  body_html TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  body_id INTEGER NOT NULL REFERENCES bodies(id),
  meeting_date TEXT NOT NULL,
  meeting_time TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'Scheduled',
  agenda_url TEXT,
  minutes_url TEXT,
  video_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agenda_items (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  matter_id INTEGER REFERENCES matters(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  agenda_number TEXT,
  section TEXT,
  title TEXT,
  action TEXT,
  result TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY,
  agenda_item_id INTEGER NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id),
  vote TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  password_hash TEXT,
  password_salt TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER REFERENCES matters(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Staff Report',
  body_html TEXT,
  author_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id),
  status TEXT NOT NULL DEFAULT 'Present'
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS matter_topics (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS org_units (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES org_units(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  name TEXT NOT NULL,
  leader_name TEXT,
  leader_title TEXT,
  leader_email TEXT,
  leader_phone TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  acted_by INTEGER REFERENCES users(id),
  acted_at TEXT,
  notes TEXT
);

-- Login sessions (hashed cookie ids) persisted so deploys and machine
-- auto-stop/start cycles don't log everyone out.
CREATE TABLE IF NOT EXISTS sessions (
  sid_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- Audit trail of state-changing requests by signed-in users.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  user_name TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Citizen applications to serve on a board/commission. Approving one creates
-- a member_motions nomination (entering the Nominate -> Approve -> Seat flow).
CREATE TABLE IF NOT EXISTS board_applications (
  id INTEGER PRIMARY KEY,
  body_id INTEGER NOT NULL REFERENCES bodies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  statement TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Nominated | Declined
  motion_id INTEGER REFERENCES member_motions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Request-to-speak sign-ups for upcoming meetings; reviewed by the clerk.
CREATE TABLE IF NOT EXISTS speaker_requests (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agenda_item_id INTEGER REFERENCES agenda_items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  position TEXT,                            -- Support | Oppose | Neutral
  status TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Approved | Rejected | Spoke
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Watch list: signed-in users following a legislative file.
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, matter_id)
);

-- Public comments on legislative files (eComment). Held for clerk review;
-- only Approved comments are displayed publicly.
CREATE TABLE IF NOT EXISTS public_comments (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  position TEXT,                            -- Support | Oppose | Neutral
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Approved | Rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Key/value store for runtime-editable settings (e.g. in-app branding overrides).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Board-membership change requests routed through Nominate -> Approve -> Seat.
CREATE TABLE IF NOT EXISTS member_motions (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,                        -- 'seat' | 'remove'
  body_id INTEGER REFERENCES bodies(id),
  person_id INTEGER REFERENCES people(id),     -- existing person (seat-existing or remove)
  member_id INTEGER REFERENCES body_members(id) ON DELETE SET NULL, -- membership removed (remove)
  nominee_name TEXT,                           -- new person to seat (seat-new)
  nominee_title TEXT,
  nominee_email TEXT,
  nominee_district TEXT,
  seat_role TEXT DEFAULT 'Member',
  status TEXT NOT NULL DEFAULT 'Nominated',    -- Nominated|Approved|Completed|Rejected
  reason TEXT,
  nominated_by INTEGER REFERENCES users(id),
  nominated_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  result_person_id INTEGER REFERENCES people(id),
  decision_notes TEXT
);

-- Adopted governance policies / bylaws (reference documents, authored in the
-- word processor). Published (non-Draft) policies are shown publicly.
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY,
  policy_number TEXT,
  title TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'Draft',   -- Draft | Active | Under Review | Superseded
  effective_date TEXT,
  body_html TEXT,
  matter_id INTEGER REFERENCES matters(id) ON DELETE SET NULL,
  author_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Budget: a fiscal-year budget with categorized line items. Legislative items
-- (matters) carry a fiscal_impact that can be tied to a line and rolls up.
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY,
  fiscal_year TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',   -- Draft | Adopted | Closed
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budget_lines (
  id INTEGER PRIMARY KEY,
  budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Expense',   -- Expense | Revenue
  amount REAL NOT NULL DEFAULT 0,         -- budgeted amount
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Budget amendments: signed adjustments to a line's adopted amount, each
-- ideally linked to the authorizing legislative file. The line's amount column
-- stays the ADOPTED figure; current amount = adopted + SUM(amendments).
CREATE TABLE IF NOT EXISTS budget_amendments (
  id INTEGER PRIMARY KEY,
  budget_line_id INTEGER NOT NULL REFERENCES budget_lines(id) ON DELETE CASCADE,
  matter_id INTEGER REFERENCES matters(id) ON DELETE SET NULL,
  amount REAL NOT NULL,                     -- signed: + supplemental, - reduction/transfer out
  note TEXT,
  author_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Actuals ledger: expenditures (expense lines) / receipts (revenue lines),
-- entered by the clerk or imported from the accounting system.
CREATE TABLE IF NOT EXISTS budget_transactions (
  id INTEGER PRIMARY KEY,
  budget_line_id INTEGER NOT NULL REFERENCES budget_lines(id) ON DELETE CASCADE,
  tx_date TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A governor's office staff: aides/staff listed under a board member (person).
CREATE TABLE IF NOT EXISTS office_staff (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  phone TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_matters_status ON matters(status);
CREATE INDEX IF NOT EXISTS idx_mversions_matter ON matter_versions(matter_id);
CREATE INDEX IF NOT EXISTS idx_pcomments_matter ON public_comments(matter_id);
CREATE INDEX IF NOT EXISTS idx_pcomments_status ON public_comments(status);
CREATE INDEX IF NOT EXISTS idx_speaker_meeting ON speaker_requests(meeting_id);
CREATE INDEX IF NOT EXISTS idx_board_apps_status ON board_applications(status);
CREATE INDEX IF NOT EXISTS idx_bamend_line ON budget_amendments(budget_line_id);
CREATE INDEX IF NOT EXISTS idx_btx_line ON budget_transactions(budget_line_id);
CREATE INDEX IF NOT EXISTS idx_btx_date ON budget_transactions(tx_date);
CREATE INDEX IF NOT EXISTS idx_matters_type ON matters(type);
CREATE INDEX IF NOT EXISTS idx_history_matter ON matter_history(matter_id);
CREATE INDEX IF NOT EXISTS idx_agenda_meeting ON agenda_items(meeting_id);
CREATE INDEX IF NOT EXISTS idx_votes_item ON votes(agenda_item_id);
CREATE INDEX IF NOT EXISTS idx_reports_matter ON reports(matter_id);
CREATE INDEX IF NOT EXISTS idx_attendance_meeting ON attendance(meeting_id);
CREATE INDEX IF NOT EXISTS idx_mtopics_matter ON matter_topics(matter_id);
CREATE INDEX IF NOT EXISTS idx_mtopics_topic ON matter_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_wf_matter ON workflow_steps(matter_id);
CREATE INDEX IF NOT EXISTS idx_org_parent ON org_units(parent_id);
CREATE INDEX IF NOT EXISTS idx_mmotions_status ON member_motions(status);
CREATE INDEX IF NOT EXISTS idx_mmotions_body ON member_motions(body_id);
CREATE INDEX IF NOT EXISTS idx_policies_status ON policies(status);
CREATE INDEX IF NOT EXISTS idx_budget_lines_budget ON budget_lines(budget_id);
CREATE INDEX IF NOT EXISTS idx_office_staff_person ON office_staff(person_id);
`;

// Additive column migrations for databases created before a column existed
// (the Fly volume persists the DB across deploys).
const COLUMN_MIGRATIONS = {
  agenda_items: {
    mover_id: 'INTEGER REFERENCES people(id)',
    seconder_id: 'INTEGER REFERENCES people(id)',
    motion_text: 'TEXT',
    vote_status: "TEXT NOT NULL DEFAULT 'pending'",
    vote_threshold: "TEXT NOT NULL DEFAULT 'majority'", // majority | two_thirds | majority_full
    requires_vote: 'INTEGER NOT NULL DEFAULT 0',
    item_type: 'TEXT', // 'Action' | 'Discussion' | 'Information' | NULL
  },
  matters: {
    body_html: 'TEXT',
    fiscal_impact: 'REAL',                         // dollar impact of this item
    budget_line_id: 'INTEGER REFERENCES budget_lines(id) ON DELETE SET NULL',
    fiscal_recurring: 'INTEGER NOT NULL DEFAULT 0', // 1 = ongoing annual cost, 0 = one-time
    fiscal_note: 'TEXT',                            // narrative fiscal note
  },
  budgets: {
    adopted_matter_id: 'INTEGER REFERENCES matters(id) ON DELETE SET NULL', // adopting resolution
  },
  attachments: {
    file_path: 'TEXT',      // relative path under the uploads dir (uploaded files)
    size: 'INTEGER',
    content_type: 'TEXT',
  },
  meetings: {
    minutes_html: 'TEXT',
    minutes_status: "TEXT NOT NULL DEFAULT 'none'",
  },
  users: {
    sso_subject: 'TEXT',          // stable Entra object id (oid) for SSO accounts
    auth_provider: 'TEXT',        // 'local' | 'entra'
  },
  people: {
    office_name: 'TEXT',          // e.g. "Office of Governor Smith"
  },
  workflow_steps: {
    assignee_id: 'INTEGER REFERENCES users(id)',  // who this approval is routed to
  },
};

function migrate() {
  for (const [table, cols] of Object.entries(COLUMN_MIGRATIONS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    for (const [col, def] of Object.entries(cols)) {
      if (!existing.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def};`);
    }
  }
  // Backfill: matter-linked items existed before requires_vote was added (DEFAULT 0).
  // They should require a vote, so flip them to 1 if they haven't been explicitly toggled off.
  db.exec(`UPDATE agenda_items SET requires_vote=1 WHERE matter_id IS NOT NULL AND requires_vote=0`);
  renumberLegacyFileNumbers();
  setupFullTextSearch();
}

// Full-text index over legislative files, kept in sync with triggers so every
// writer (admin forms, member submissions, imports, seeds) is covered. If this
// build of SQLite lacks FTS5 the app silently falls back to LIKE search.
let FTS_ENABLED = false;
function ftsEnabled() { return FTS_ENABLED; }

function setupFullTextSearch() {
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS matters_fts USING fts5(
      file_number, title, summary, full_text, body_html)`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS matters_fts_ai AFTER INSERT ON matters BEGIN
        INSERT INTO matters_fts(rowid, file_number, title, summary, full_text, body_html)
        VALUES (new.id, new.file_number, new.title, new.summary, new.full_text, new.body_html);
      END;
      CREATE TRIGGER IF NOT EXISTS matters_fts_ad AFTER DELETE ON matters BEGIN
        DELETE FROM matters_fts WHERE rowid = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS matters_fts_au AFTER UPDATE ON matters BEGIN
        DELETE FROM matters_fts WHERE rowid = old.id;
        INSERT INTO matters_fts(rowid, file_number, title, summary, full_text, body_html)
        VALUES (new.id, new.file_number, new.title, new.summary, new.full_text, new.body_html);
      END;`);
    // Backfill rows created before the index/triggers existed.
    const indexed = db.prepare('SELECT COUNT(*) AS n FROM matters_fts').get().n;
    const total = db.prepare('SELECT COUNT(*) AS n FROM matters').get().n;
    if (indexed === 0 && total > 0) {
      db.exec(`INSERT INTO matters_fts(rowid, file_number, title, summary, full_text, body_html)
        SELECT id, file_number, title, summary, full_text, body_html FROM matters`);
    }
    FTS_ENABLED = true;
  } catch (e) {
    console.error('FTS5 unavailable, falling back to LIKE search:', e.message);
  }
}

// One-time data migration: rewrite legacy prefix-style file numbers
// (ORD-2026-0001, RES-2026-0002, ...) into the all-numeric YYMMXX scheme.
// Files are bucketed by the month they were received (intro_date, falling back
// to created_at) and sequenced within each month in receipt order. Rows already
// all-numeric are left untouched, so this is a no-op on subsequent boots.
function renumberLegacyFileNumbers() {
  const legacy = db.prepare(`
    SELECT id, COALESCE(intro_date, created_at) AS received
    FROM matters WHERE file_number GLOB '*[^0-9]*'
    ORDER BY received, id`).all();
  if (!legacy.length) return;

  const update = db.prepare('UPDATE matters SET file_number = ? WHERE id = ?');
  // Per-month counters, seeded past any numbers already issued in the new scheme.
  const counters = new Map();
  const maxSeq = db.prepare(`
    SELECT MAX(CAST(substr(file_number, 5) AS INTEGER)) AS m
    FROM matters
    WHERE file_number NOT GLOB '*[^0-9]*' AND file_number LIKE ? || '%'`);

  db.exec('SAVEPOINT sp_renumber');
  try {
    const today = new Date().toISOString();
    for (const row of legacy) {
      // received is ISO-ish text (YYYY-MM-DD...); fall back to today if malformed.
      const d = /^\d{4}-\d{2}/.test(String(row.received || '')) ? String(row.received) : today;
      const prefix = d.slice(2, 4) + d.slice(5, 7);
      if (!counters.has(prefix)) counters.set(prefix, (maxSeq.get(prefix).m || 0));
      const next = counters.get(prefix) + 1;
      counters.set(prefix, next);
      update.run(`${prefix}${String(next).padStart(2, '0')}`, row.id);
    }
    db.exec('RELEASE sp_renumber');
  } catch (e) {
    db.exec('ROLLBACK TO sp_renumber');
    db.exec('RELEASE sp_renumber');
    throw e;
  }
}

function init() {
  db.exec(SCHEMA);
  migrate();
  return db;
}

function reset() {
  const tables = ['matters_fts', 'sessions', 'audit_log', 'watches', 'speaker_requests', 'board_applications', 'public_comments', 'office_staff',
    'budget_amendments', 'budget_transactions', 'budget_lines', 'budgets', 'policies', 'member_motions', 'settings',
    'org_units', 'workflow_steps', 'matter_topics', 'matter_versions',
    'topics', 'attendance', 'reports',
    'users', 'votes', 'agenda_items', 'attachments', 'matter_history',
    'matter_sponsors', 'matters', 'meetings', 'body_members', 'bodies', 'people'];
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const t of tables) db.exec(`DROP TABLE IF EXISTS ${t};`);
  db.exec('PRAGMA foreign_keys = ON;');
  init();
}

module.exports = { db, init, reset, DB_PATH, ftsEnabled };
