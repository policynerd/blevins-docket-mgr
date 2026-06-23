-- Initial schema for the BEG Docket Manager (Legistar-style legislative
-- management). Postgres translation of the app's SQLite schema. Already applied
-- to project qpoupyodhhiupgalgbuf via the management API; committed here so the
-- schema is version-controlled and `supabase db push`/`db pull` stay in sync.

create table if not exists people (
  id bigint generated always as identity primary key,
  full_name text not null, title text, district text, party text,
  email text, phone text, website text, photo_url text, bio text,
  active integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists bodies (
  id bigint generated always as identity primary key,
  name text not null, type text, description text, meeting_location text, meets text,
  active integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id bigint generated always as identity primary key,
  person_id bigint references people(id),
  name text not null, email text unique not null,
  role text not null default 'member',
  password_hash text, password_salt text,
  active integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists matters (
  id bigint generated always as identity primary key,
  file_number text unique not null,
  type text not null, title text not null,
  status text not null default 'Draft',
  body_id bigint references bodies(id),
  intro_date text, final_date text, summary text, full_text text, body_html text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists meetings (
  id bigint generated always as identity primary key,
  body_id bigint not null references bodies(id),
  meeting_date text not null, meeting_time text, location text,
  status text not null default 'Scheduled',
  agenda_url text, minutes_url text, video_url text, notes text,
  minutes_html text, minutes_status text not null default 'none',
  created_at timestamptz not null default now()
);

create table if not exists body_members (
  id bigint generated always as identity primary key,
  body_id bigint not null references bodies(id) on delete cascade,
  person_id bigint not null references people(id) on delete cascade,
  role text default 'Member', voting integer not null default 1,
  start_date text, end_date text
);

create table if not exists matter_sponsors (
  id bigint generated always as identity primary key,
  matter_id bigint not null references matters(id) on delete cascade,
  person_id bigint not null references people(id) on delete cascade,
  sponsor_type text not null default 'Sponsor'
);

create table if not exists matter_history (
  id bigint generated always as identity primary key,
  matter_id bigint not null references matters(id) on delete cascade,
  action_date text, body_id bigint references bodies(id),
  action text not null, result text, notes text,
  meeting_id bigint references meetings(id)
);

create table if not exists attachments (
  id bigint generated always as identity primary key,
  matter_id bigint not null references matters(id) on delete cascade,
  name text not null, url text, note text
);

create table if not exists agenda_items (
  id bigint generated always as identity primary key,
  meeting_id bigint not null references meetings(id) on delete cascade,
  matter_id bigint references matters(id),
  sort_order integer not null default 0,
  agenda_number text, section text, title text, action text, result text, notes text,
  mover_id bigint references people(id), seconder_id bigint references people(id),
  motion_text text, vote_status text not null default 'pending'
);

create table if not exists votes (
  id bigint generated always as identity primary key,
  agenda_item_id bigint not null references agenda_items(id) on delete cascade,
  person_id bigint not null references people(id),
  vote text not null
);

create table if not exists reports (
  id bigint generated always as identity primary key,
  matter_id bigint references matters(id) on delete cascade,
  title text not null, kind text not null default 'Staff Report',
  body_html text, author_id bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists attendance (
  id bigint generated always as identity primary key,
  meeting_id bigint not null references meetings(id) on delete cascade,
  person_id bigint not null references people(id),
  status text not null default 'Present'
);

create table if not exists topics (
  id bigint generated always as identity primary key,
  name text unique not null
);

create table if not exists matter_topics (
  id bigint generated always as identity primary key,
  matter_id bigint not null references matters(id) on delete cascade,
  topic_id bigint not null references topics(id) on delete cascade
);

create table if not exists workflow_steps (
  id bigint generated always as identity primary key,
  matter_id bigint not null references matters(id) on delete cascade,
  seq integer not null, name text not null, role text,
  status text not null default 'Pending',
  acted_by bigint references users(id), acted_at timestamptz, notes text
);

create table if not exists org_units (
  id bigint generated always as identity primary key,
  parent_id bigint references org_units(id) on delete cascade,
  level text not null, name text not null,
  leader_name text, leader_title text, leader_email text, leader_phone text,
  description text, sort_order integer not null default 0
);

create index if not exists idx_matters_status on matters(status);
create index if not exists idx_agenda_meeting on agenda_items(meeting_id);
create index if not exists idx_votes_item on votes(agenda_item_id);
create index if not exists idx_wf_matter on workflow_steps(matter_id);
create index if not exists idx_org_parent on org_units(parent_id);
