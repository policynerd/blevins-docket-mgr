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

-- Supporting material hung on an agenda item rather than a legislative file:
-- a presentation deck, a memo, the minutes being approved. Kept apart from
-- the attachments table on purpose. An attachment belongs to the legislative file
-- permanently and travels with it across every meeting that hears it; one of
-- these belongs to a single occurrence on a single agenda, and a procedural
-- item has no matter_id to hang an attachment from at all.
CREATE TABLE IF NOT EXISTS agenda_item_docs (
  id INTEGER PRIMARY KEY,
  agenda_item_id INTEGER NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT,
  file_path TEXT,
  size INTEGER,
  content_type TEXT,
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agenda_item_docs_item ON agenda_item_docs(agenda_item_id);

-- The named sections of a board letter, authored per file.
--
-- A board letter is not prose with incidental headings: it is a fixed set of
-- questions the body requires answered before it will hear an item -- what is
-- recommended, what it costs, what the background is. Each answer is stored
-- against its section key so the document can be assembled in the standard
-- order, a missing required section can be detected before the item is
-- agendised, and a section can be revised without rewriting the letter.
--
-- The section list itself is configuration (settings key 'letter.sections'),
-- because which questions a board asks is that board's policy.
CREATE TABLE IF NOT EXISTS letter_sections (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  body_html TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (matter_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_letter_sections_matter ON letter_sections(matter_id);

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

-- Outgoing email queue. Rows are only created when SMTP is configured;
-- a background loop delivers with retries and records the outcome.
CREATE TABLE IF NOT EXISTS mail_outbox (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Sent | Failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
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

-- Procurement (vendor/RFP portal): registered vendors, solicitations
-- (RFP/RFQ/IFB/bid notices), public Q&A, and bid submissions. Awarding a
-- solicitation can spawn a Contract legislative file and a budget commitment.
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  categories TEXT,
  status TEXT NOT NULL DEFAULT 'Registered',   -- Registered | Suspended
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS solicitations (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'RFP',            -- RFP | RFQ | IFB | Bid
  title TEXT NOT NULL,
  body_html TEXT,
  status TEXT NOT NULL DEFAULT 'Draft',        -- Draft | Open | Closed | Awarded | Cancelled
  open_date TEXT,
  close_date TEXT,
  budget_line_id INTEGER REFERENCES budget_lines(id) ON DELETE SET NULL,
  awarded_vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  award_amount REAL,
  matter_id INTEGER REFERENCES matters(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS solicitation_questions (
  id INTEGER PRIMARY KEY,
  solicitation_id INTEGER NOT NULL REFERENCES solicitations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  question TEXT NOT NULL,
  answer TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY,
  solicitation_id INTEGER NOT NULL REFERENCES solicitations(id) ON DELETE CASCADE,
  vendor_name TEXT NOT NULL,
  email TEXT,
  amount REAL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Treasury Account Symbol register: a federal-style chart of accounts that is
-- the source of truth for appropriation structure. A budget line's
-- appropriation_code joins to tas (the full composite symbol); this register
-- enriches it with agency, title, fund type, and availability. Maintained by
-- import, independent of any fiscal year.
CREATE TABLE IF NOT EXISTS tas_accounts (
  id INTEGER PRIMARY KEY,
  tas TEXT NOT NULL UNIQUE,             -- full composite symbol (join key)
  aid TEXT,                             -- agency identifier
  main TEXT,                            -- main account code
  avail TEXT,                           -- period of availability (the "X-YEAR" column)
  agency TEXT,
  title TEXT,
  fund_type TEXT,
  independent_agencies TEXT,            -- grouping/flag from the source register
  source_updated TEXT,                  -- "Last update" recorded in the source file
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The Board Code: the standing body of law, stored as addressable sections.
-- A section's body is structured drafting text (see src/legisdoc.js), so
-- amendments can target an individual provision rather than a whole document.
CREATE TABLE IF NOT EXISTS code_sections (
  id INTEGER PRIMARY KEY,
  citation TEXT NOT NULL UNIQUE,            -- "12-4"
  title_num TEXT,                           -- "12" (the Code title/chapter)
  heading TEXT NOT NULL,
  body_text TEXT,                           -- structured drafting text
  status TEXT NOT NULL DEFAULT 'Active',    -- Active | Repealed
  enacted_by INTEGER REFERENCES matters(id) ON DELETE SET NULL,
  effective_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Amending instructions carried by a bill: what it would do to the Code.
-- These are drafted with the bill and only applied to the Code on enactment,
-- which is what makes "current law as proposed to be changed" possible.
CREATE TABLE IF NOT EXISTS code_amendments (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  op TEXT NOT NULL,                         -- add | amend | repeal
  citation TEXT NOT NULL,                   -- target section, or the new number for add
  title_num TEXT,
  heading TEXT,                             -- heading for an added section
  new_text TEXT,                            -- proposed body (add / amend)
  note TEXT,
  applied_at TEXT,                          -- set when codified
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Authority trail: every change to a Code section, and the text it replaced.
-- Supports "which file changed this section" and point-in-time reconstruction.
CREATE TABLE IF NOT EXISTS code_history (
  id INTEGER PRIMARY KEY,
  code_section_id INTEGER NOT NULL REFERENCES code_sections(id) ON DELETE CASCADE,
  matter_id INTEGER REFERENCES matters(id) ON DELETE SET NULL,
  op TEXT NOT NULL,
  prior_text TEXT,                          -- body as it stood before this change
  effective_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Board actions by unanimous written consent (action without a meeting): a
-- resolution is circulated to every seated director; when all sign it is
-- adopted, and a single decline sends it back to a meeting. Signatures are
-- captured in-app, or via an e-signature provider (Adobe Acrobat Sign) when
-- ADOBE_SIGN_* is configured.
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,              -- WC-YYMM##
  title TEXT NOT NULL,
  body_html TEXT,                           -- the resolution text
  body_id INTEGER REFERENCES bodies(id) ON DELETE SET NULL,     -- which board
  matter_id INTEGER REFERENCES matters(id) ON DELETE SET NULL,  -- optional linked file
  status TEXT NOT NULL DEFAULT 'Draft',     -- Draft | Circulating | Adopted | Declined | Withdrawn
  esign_provider TEXT,                      -- 'adobe' once sent for e-signature
  esign_agreement_id TEXT,                  -- provider agreement/envelope id
  esign_status TEXT,                        -- raw provider status
  adopted_at TEXT,
  decline_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS consent_signers (
  id INTEGER PRIMARY KEY,
  consent_id INTEGER NOT NULL REFERENCES consents(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Signed | Declined
  signed_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Citizen proposals (Decidim-style): public ideas gather endorsements; past
-- the threshold they surface for clerk review, and accepting one creates a
-- legislative file linked back to the proposal.
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'Open',      -- Open | Accepted | Declined
  matter_id INTEGER REFERENCES matters(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proposal_endorsements (
  id INTEGER PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,                       -- dedupe key; never shown publicly
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (proposal_id, email)
);

-- Accountability (Decidim-style): implementation progress updates on
-- enacted/passed legislation, shown publicly.
CREATE TABLE IF NOT EXISTS implementation_updates (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  progress INTEGER NOT NULL DEFAULT 0,       -- 0..100
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Related files (companion / amends / supersedes), Congress.gov-style.
CREATE TABLE IF NOT EXISTS matter_relations (
  id INTEGER PRIMARY KEY,
  matter_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  related_id INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'Related',   -- Related | Companion | Amends | Supersedes
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (matter_id, related_id)
);

-- Saved legislation searches; new matching files trigger an email alert.
CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query_json TEXT NOT NULL,
  last_matter_id INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS motion_versions (
  id INTEGER PRIMARY KEY,
  agenda_item_id INTEGER NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  motion_text TEXT,
  mover_id INTEGER REFERENCES people(id),
  seconder_id INTEGER REFERENCES people(id),
  threshold TEXT NOT NULL DEFAULT 'majority',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id),
  UNIQUE (agenda_item_id, seq)
);

CREATE TABLE IF NOT EXISTS session_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,

  -- Denormalised from the payload for querying. Verification checks these
  -- against the hashed payload, so editing a column here to change a vote is
  -- caught exactly as editing the payload would be.
  agenda_item_id INTEGER REFERENCES agenda_items(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES people(id),
  choice TEXT,
  source TEXT,
  entered_by INTEGER REFERENCES users(id),
  supersedes_event_id TEXT REFERENCES session_events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_session_events_meeting ON session_events(meeting_id, seq);
CREATE INDEX IF NOT EXISTS idx_session_events_item ON session_events(agenda_item_id, seq);
CREATE INDEX IF NOT EXISTS idx_motion_versions_item ON motion_versions(agenda_item_id, seq);

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

-- One account per governor.
--
-- person_id says which member of the board a login speaks for, and a ballot is
-- recorded against the person, not the account. Two accounts pointing at one
-- person means two people can vote as that governor — and because the ledger
-- takes the latest standing choice, whoever clicks last owns the vote.
-- Partial, so the many accounts with no person behind them are unaffected.
-- (No backticks in here: this whole schema is a JS template literal.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_person ON users(person_id) WHERE person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_matters_status ON matters(status);
CREATE INDEX IF NOT EXISTS idx_mversions_matter ON matter_versions(matter_id);
CREATE INDEX IF NOT EXISTS idx_pcomments_matter ON public_comments(matter_id);
CREATE INDEX IF NOT EXISTS idx_pcomments_status ON public_comments(status);
CREATE INDEX IF NOT EXISTS idx_speaker_meeting ON speaker_requests(meeting_id);
CREATE INDEX IF NOT EXISTS idx_board_apps_status ON board_applications(status);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON mail_outbox(status);
CREATE INDEX IF NOT EXISTS idx_endorse_proposal ON proposal_endorsements(proposal_id);
CREATE INDEX IF NOT EXISTS idx_tas_agency ON tas_accounts(agency);
CREATE INDEX IF NOT EXISTS idx_consent_signers ON consent_signers(consent_id);
CREATE INDEX IF NOT EXISTS idx_consents_status ON consents(status);
CREATE INDEX IF NOT EXISTS idx_consents_agreement ON consents(esign_agreement_id);
CREATE INDEX IF NOT EXISTS idx_code_amend_matter ON code_amendments(matter_id);
CREATE INDEX IF NOT EXISTS idx_code_history_section ON code_history(code_section_id);
CREATE INDEX IF NOT EXISTS idx_code_sections_title ON code_sections(title_num);
CREATE INDEX IF NOT EXISTS idx_solic_status ON solicitations(status);
CREATE INDEX IF NOT EXISTS idx_solq_solic ON solicitation_questions(solicitation_id);
CREATE INDEX IF NOT EXISTS idx_bids_solic ON bids(solicitation_id);
CREATE INDEX IF NOT EXISTS idx_impl_matter ON implementation_updates(matter_id);
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
  matter_history: {
    // Which agenda item produced this entry. Without it a vote that is later
    // reopened cannot find the record it wrote, so the wrong outcome stays in
    // the legislative history with no way to identify it.
    agenda_item_id: 'INTEGER REFERENCES agenda_items(id)',
    // A retracted entry is struck through, never deleted. What the Board did
    // and later undid is itself part of the record; a history that quietly
    // loses its mistakes cannot be relied on to show what happened.
    voided_at: 'TEXT',
    void_reason: 'TEXT',
    voided_by: 'INTEGER REFERENCES users(id)',
  },
  agenda_items: {
    mover_id: 'INTEGER REFERENCES people(id)',
    seconder_id: 'INTEGER REFERENCES people(id)',
    motion_text: 'TEXT',
    vote_status: "TEXT NOT NULL DEFAULT 'pending'",
    vote_threshold: "TEXT NOT NULL DEFAULT 'majority'", // majority | two_thirds | majority_full
    requires_vote: 'INTEGER NOT NULL DEFAULT 0',
    item_type: 'TEXT', // 'Action' | 'Discussion' | 'Information' | NULL
    video_ts: 'TEXT',  // timestamp into the meeting video, "h:mm:ss" or seconds
    // Whether this item's supporting material is assembled into the packet.
    // Defaults on: the packet is the record of what members were given, so an
    // item is included unless the clerk deliberately holds it back.
    in_packet: 'INTEGER NOT NULL DEFAULT 1',
    // When the roll opened and closed, as timestamps rather than just a status.
    //
    // The tally is defined as of the close: events received after it are kept
    // but do not count. Without a recorded instant there is nothing to compare
    // them against, so a late arrival silently joins a settled vote and the
    // same meeting re-rendered next year reports a different outcome.
    vote_opened_at: 'TEXT',
    vote_closed_at: 'TEXT',
    // The rule that governed this roll, recorded with it. Standing orders
    // change; a vote taken last year must still evaluate under the rule in
    // force then, which it cannot do if the rule is only read from config.
    threshold_rule: 'TEXT',
    // The result lifecycle. Computing a result is not announcing it, and
    // announcing is not the Clerk attesting to it.
    result_computed_at: 'TEXT',
    result_announced_at: 'TEXT',
    result_certified_at: 'TEXT',
    result_certified_by: 'INTEGER REFERENCES users(id)',
    result_published_at: 'TEXT',
    certification_checkpoint: 'TEXT',
  },
  matters: {
    body_html: 'TEXT',
    fiscal_impact: 'REAL',                         // dollar impact of this item
    budget_line_id: 'INTEGER REFERENCES budget_lines(id) ON DELETE SET NULL',
    // The part of the organization that brought the measure. A department's
    // page can then show what it has before the Board, which is most of what
    // makes an org chart worth opening.
    org_unit_id: 'INTEGER REFERENCES org_units(id) ON DELETE SET NULL',
    fiscal_recurring: 'INTEGER NOT NULL DEFAULT 0', // 1 = ongoing annual cost, 0 = one-time
    fiscal_note: 'TEXT',                            // narrative fiscal note
    amends_policy_id: 'INTEGER REFERENCES policies(id) ON DELETE SET NULL', // comparative print target
    // When a clerk deliberately made this file readable by the public. NULL is
    // the whole of the backfill: every row that existed before publication was
    // a decision is unpublished, which is what "nothing is public until
    // somebody publishes it" has to mean on day one.
    published_at: 'TEXT',
  },
  budgets: {
    adopted_matter_id: 'INTEGER REFERENCES matters(id) ON DELETE SET NULL', // adopting resolution
  },
  body_members: {
    // How a term ended, recorded on the seat rather than only on the motion
    // that ended it. A roster answering "who served, and until when" should
    // not need the governance paperwork joined to it to say why they left.
    end_reason: 'TEXT',
  },
  member_motions: {
    // The last day of service, which is not the day the paperwork completed:
    // a retirement announced in March and executed in April ends the term in
    // March. Seating has the same distinction between decision and effect.
    effective_date: 'TEXT',
    // The end of a term being granted, where one is fixed at appointment.
    // effective_date carries the start; without this the length of a term
    // could only be recorded by editing the seat afterwards, which is how
    // seatings ended up with no dates at all.
    term_end_date: 'TEXT',
    // Whether the seat being granted carries a vote. Ex-officio members hold a
    // seat without one, and the roll excludes them from both quorum and the
    // denominator, so it has to be settled when the seat is granted.
    seat_voting: 'INTEGER',
    // How the service ended — retired, term expired, resigned, removed,
    // deceased. Retirement is the ordinary case and removal the rare one, and
    // conflating them is why the roster called an honourable exit a removal.
    // Distinct from `reason`, which is the free note; this is the category the
    // record is searched and reported by.
    cause: 'TEXT',
  },
  bodies: {
    seats: 'INTEGER', // authorized seat count (vacancies = seats - active members)
    // The body's accent in the lockup. Only the accent varies between bodies:
    // the Board's name is always slate, because it is the same Board. Null
    // leaves the body set in slate too — an arbitrary hue would read as
    // meaning something it does not.
    accent_color: 'TEXT',
  },
  budget_lines: {
    appropriation_code: 'TEXT', // legal appropriation account (e.g. 100-4200-51000)
    project_code: 'TEXT',       // capital project / grant tracking code
    // Which unit holds this appropriation. `category` remains the accounting
    // grouping; this is the part of the organization answerable for spending
    // it, and it is what lets a department page state its own budget instead
    // of the budget being a separate island keyed by a typed-in string.
    org_unit_id: 'INTEGER REFERENCES org_units(id) ON DELETE SET NULL',
  },
  attachments: {
    file_path: 'TEXT',      // relative path under the uploads dir (uploaded files)
    size: 'INTEGER',
    content_type: 'TEXT',
  },
  meetings: {
    minutes_html: 'TEXT',
    minutes_status: "TEXT NOT NULL DEFAULT 'none'",
    // `status` is the meeting's lifecycle — Scheduled, In Progress, Adjourned,
    // Final — and was never a statement about who may read the agenda. This is
    // that statement, kept separate so a meeting can be Final and unpublished,
    // or Scheduled and published, without one meaning implying the other.
    agenda_published_at: 'TEXT',
  },
  reports: {
    // A board letter had no state at all: `/reports/:id` sits outside the three
    // authorized prefixes, so a letter was at a public URL from the moment the
    // empty template was inserted — headings, blank sections and all.
    published_at: 'TEXT',
  },
  users: {
    sso_subject: 'TEXT',          // stable Entra object id (oid) for SSO accounts
    auth_provider: 'TEXT',        // 'local' | 'entra'
    digest: 'INTEGER NOT NULL DEFAULT 0', // opted into the daily email digest
  },
  people: {
    office_name: 'TEXT',          // e.g. "Office of Governor Smith"
  },
  workflow_steps: {
    assignee_id: 'INTEGER REFERENCES users(id)',  // who this approval is routed to
    // When this step became the one being waited on.
    //
    // The table recorded acted_at — when a step *finished* — and nothing for
    // when it started, so how long a file had been sitting with somebody was
    // not merely unreported but uncomputable. Nothing could be overdue even in
    // principle, and chasing a reviewer who never acts was done from memory.
    became_current_at: 'TEXT',
  },
  // The organization chart, given something to be about.
  //
  // org_units had exactly one foreign key: parent_id, pointing at itself.
  // Nothing else in fifty-two tables referenced it, and it referenced nothing
  // — the unit's leader was three loose text columns, so the person running a
  // department was a typed-in name rather than the people row sitting two
  // tables away. A tree that nothing points at and that points at nothing can
  // only be a directory, however it is presented.
  //
  // That is also why the sections read as unconnected: the relationships were
  // stored as text instead of references, so there was nothing to traverse.
  // The same department existed twice — once as an org_unit and once as a
  // budget_lines.category string — and the two could disagree without anything
  // noticing.
  org_units: {
    // The leader as the person record, not a retyped name. The text columns
    // stay for units led by someone who is not in the roster (a vacancy, an
    // outside administrator), and the person wins where both are set.
    leader_person_id: 'INTEGER REFERENCES people(id) ON DELETE SET NULL',
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
  const tables = ['matters_fts', 'sessions', 'audit_log', 'mail_outbox', 'watches', 'saved_searches', 'matter_relations',
    'code_history', 'code_amendments', 'code_sections',
    'consent_signers', 'consents',
    'bids', 'solicitation_questions', 'solicitations', 'vendors', 'tas_accounts',
    'proposal_endorsements', 'proposals', 'implementation_updates',
    'speaker_requests', 'board_applications', 'public_comments', 'office_staff',
    'budget_amendments', 'budget_transactions', 'budget_lines', 'budgets', 'policies', 'member_motions', 'settings',
    'org_units', 'workflow_steps', 'matter_topics', 'matter_versions',
    'topics', 'attendance', 'reports',
    // The vote ledger and the motion history. These were left standing while
    // every table they refer to was dropped, so the ids they hold pointed at
    // whatever was created next: after a reset the old ballots re-attached to
    // the new meeting 1 and its items, and three resets left fifty-four events
    // on a chain that should have had eighteen. It stayed internally coherent
    // — supersession resolved the stale ballots and the chain still verified —
    // which is exactly why it would have gone unnoticed. Nothing reached this
    // until the seeder began writing real ledger events instead of rows in the
    // projection.
    'session_events', 'motion_versions',
    'users', 'votes', 'agenda_item_docs', 'agenda_items', 'attachments', 'letter_sections', 'matter_history',
    'matter_sponsors', 'matters', 'meetings', 'body_members', 'bodies', 'people'];
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const t of tables) db.exec(`DROP TABLE IF EXISTS ${t};`);
  db.exec('PRAGMA foreign_keys = ON;');
  init();
}

module.exports = { db, init, reset, DB_PATH, ftsEnabled };
