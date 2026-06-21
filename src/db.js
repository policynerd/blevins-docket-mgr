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

CREATE INDEX IF NOT EXISTS idx_matters_status ON matters(status);
CREATE INDEX IF NOT EXISTS idx_matters_type ON matters(type);
CREATE INDEX IF NOT EXISTS idx_history_matter ON matter_history(matter_id);
CREATE INDEX IF NOT EXISTS idx_agenda_meeting ON agenda_items(meeting_id);
CREATE INDEX IF NOT EXISTS idx_votes_item ON votes(agenda_item_id);
CREATE INDEX IF NOT EXISTS idx_reports_matter ON reports(matter_id);
CREATE INDEX IF NOT EXISTS idx_attendance_meeting ON attendance(meeting_id);
CREATE INDEX IF NOT EXISTS idx_mtopics_matter ON matter_topics(matter_id);
CREATE INDEX IF NOT EXISTS idx_mtopics_topic ON matter_topics(topic_id);
`;

// Additive column migrations for databases created before a column existed
// (the Fly volume persists the DB across deploys).
const COLUMN_MIGRATIONS = {
  agenda_items: {
    mover_id: 'INTEGER REFERENCES people(id)',
    seconder_id: 'INTEGER REFERENCES people(id)',
    motion_text: 'TEXT',
    vote_status: "TEXT NOT NULL DEFAULT 'pending'",
  },
  matters: {
    body_html: 'TEXT',
  },
  meetings: {
    minutes_html: 'TEXT',
    minutes_status: "TEXT NOT NULL DEFAULT 'none'",
  },
};

function migrate() {
  for (const [table, cols] of Object.entries(COLUMN_MIGRATIONS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    for (const [col, def] of Object.entries(cols)) {
      if (!existing.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def};`);
    }
  }
}

function init() {
  db.exec(SCHEMA);
  migrate();
  return db;
}

function reset() {
  const tables = ['reports', 'users', 'votes', 'agenda_items', 'attachments', 'matter_history',
    'matter_sponsors', 'matters', 'meetings', 'body_members', 'bodies', 'people'];
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const t of tables) db.exec(`DROP TABLE IF EXISTS ${t};`);
  db.exec('PRAGMA foreign_keys = ON;');
  init();
}

module.exports = { db, init, reset, DB_PATH };
