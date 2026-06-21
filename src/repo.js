'use strict';

const { db } = require('./db');

// ---------------------------------------------------------------------------
// Reference data used across the app (mirrors Legistar-style vocabularies)
// ---------------------------------------------------------------------------
const MATTER_TYPES = [
  'Ordinance', 'Resolution', 'Motion', 'Appointment',
  'Public Hearing', 'Proclamation', 'Contract', 'Report', 'Communication',
];

const MATTER_STATUSES = [
  'Draft', 'Introduced', 'In Committee', 'On Agenda',
  'Passed', 'Failed', 'Enacted', 'Vetoed', 'Tabled', 'Withdrawn',
];

const VOTE_VALUES = ['Yea', 'Nay', 'Abstain', 'Recused', 'Absent'];

const AGENDA_SECTIONS = [
  'Call to Order', 'Roll Call', 'Approval of Minutes', 'Public Comment',
  'Consent Agenda', 'Public Hearings', 'Ordinances', 'Resolutions',
  'Old Business', 'New Business', 'Reports', 'Adjournment',
];

const TERMINAL_STATUSES = new Set(['Passed', 'Failed', 'Enacted', 'Vetoed', 'Withdrawn']);

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
const people = {
  all(activeOnly = false) {
    const where = activeOnly ? 'WHERE active = 1' : '';
    return db.prepare(`SELECT * FROM people ${where} ORDER BY full_name`).all();
  },
  get(id) {
    return db.prepare('SELECT * FROM people WHERE id = ?').get(id);
  },
  memberships(personId) {
    return db.prepare(`
      SELECT bm.*, b.name AS body_name, b.type AS body_type
      FROM body_members bm JOIN bodies b ON b.id = bm.body_id
      WHERE bm.person_id = ? ORDER BY b.name`).all(personId);
  },
  sponsored(personId) {
    return db.prepare(`
      SELECT m.*, ms.sponsor_type
      FROM matter_sponsors ms JOIN matters m ON m.id = ms.matter_id
      WHERE ms.person_id = ? ORDER BY m.intro_date DESC, m.id DESC`).all(personId);
  },
  insert(p) {
    return db.prepare(`INSERT INTO people
      (full_name, title, district, party, email, phone, website, photo_url, bio, active)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      p.full_name, p.title ?? null, p.district ?? null, p.party ?? null,
      p.email ?? null, p.phone ?? null, p.website ?? null, p.photo_url ?? null,
      p.bio ?? null, p.active == null ? 1 : p.active).lastInsertRowid;
  },
};

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------
const bodies = {
  all(activeOnly = false) {
    const where = activeOnly ? 'WHERE active = 1' : '';
    return db.prepare(`SELECT * FROM bodies ${where} ORDER BY
      CASE WHEN type = 'Primary Legislative Body' THEN 0 ELSE 1 END, name`).all();
  },
  get(id) {
    return db.prepare('SELECT * FROM bodies WHERE id = ?').get(id);
  },
  members(bodyId) {
    return db.prepare(`
      SELECT bm.*, p.full_name, p.district, p.photo_url, p.title
      FROM body_members bm JOIN people p ON p.id = bm.person_id
      WHERE bm.body_id = ?
      ORDER BY CASE bm.role WHEN 'Chair' THEN 0 WHEN 'Vice Chair' THEN 1 ELSE 2 END, p.full_name`)
      .all(bodyId);
  },
  upcomingMeetings(bodyId, limit = 10) {
    return db.prepare(`SELECT * FROM meetings WHERE body_id = ?
      ORDER BY meeting_date DESC LIMIT ?`).all(bodyId, limit);
  },
  insert(b) {
    return db.prepare(`INSERT INTO bodies
      (name, type, description, meeting_location, meets, active)
      VALUES (?,?,?,?,?,?)`).run(
      b.name, b.type ?? null, b.description ?? null, b.meeting_location ?? null,
      b.meets ?? null, b.active == null ? 1 : b.active).lastInsertRowid;
  },
  addMember(bodyId, personId, role = 'Member', voting = 1) {
    return db.prepare(`INSERT INTO body_members (body_id, person_id, role, voting)
      VALUES (?,?,?,?)`).run(bodyId, personId, role, voting).lastInsertRowid;
  },
};

// ---------------------------------------------------------------------------
// Matters (legislative files)
// ---------------------------------------------------------------------------
const matters = {
  search({ q, type, status, bodyId, sponsorId, limit = 200 } = {}) {
    const clauses = [];
    const args = [];
    if (q) {
      clauses.push('(m.title LIKE ? OR m.file_number LIKE ? OR m.summary LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like);
    }
    if (type) { clauses.push('m.type = ?'); args.push(type); }
    if (status) { clauses.push('m.status = ?'); args.push(status); }
    if (bodyId) { clauses.push('m.body_id = ?'); args.push(bodyId); }
    if (sponsorId) {
      clauses.push('m.id IN (SELECT matter_id FROM matter_sponsors WHERE person_id = ?)');
      args.push(sponsorId);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    args.push(limit);
    return db.prepare(`
      SELECT m.*, b.name AS body_name,
        (SELECT GROUP_CONCAT(p.full_name, ', ')
         FROM matter_sponsors ms JOIN people p ON p.id = ms.person_id
         WHERE ms.matter_id = m.id) AS sponsors
      FROM matters m LEFT JOIN bodies b ON b.id = m.body_id
      ${where}
      ORDER BY m.intro_date DESC, m.id DESC
      LIMIT ?`).all(...args);
  },
  get(id) {
    return db.prepare(`SELECT m.*, b.name AS body_name
      FROM matters m LEFT JOIN bodies b ON b.id = m.body_id WHERE m.id = ?`).get(id);
  },
  getByFileNumber(fileNumber) {
    return db.prepare(`SELECT m.*, b.name AS body_name
      FROM matters m LEFT JOIN bodies b ON b.id = m.body_id WHERE m.file_number = ?`)
      .get(fileNumber);
  },
  sponsors(matterId) {
    return db.prepare(`
      SELECT p.id, p.full_name, p.district, ms.sponsor_type
      FROM matter_sponsors ms JOIN people p ON p.id = ms.person_id
      WHERE ms.matter_id = ?
      ORDER BY CASE ms.sponsor_type WHEN 'Primary' THEN 0 ELSE 1 END, p.full_name`)
      .all(matterId);
  },
  history(matterId) {
    return db.prepare(`
      SELECT h.*, b.name AS body_name
      FROM matter_history h LEFT JOIN bodies b ON b.id = h.body_id
      WHERE h.matter_id = ?
      ORDER BY h.action_date DESC, h.id DESC`).all(matterId);
  },
  attachments(matterId) {
    return db.prepare('SELECT * FROM attachments WHERE matter_id = ? ORDER BY id').all(matterId);
  },
  appearsOn(matterId) {
    return db.prepare(`
      SELECT ai.*, mt.meeting_date, mt.meeting_time, mt.status AS meeting_status,
             b.name AS body_name
      FROM agenda_items ai
      JOIN meetings mt ON mt.id = ai.meeting_id
      JOIN bodies b ON b.id = mt.body_id
      WHERE ai.matter_id = ?
      ORDER BY mt.meeting_date DESC`).all(matterId);
  },
  nextFileNumber(type) {
    const prefix = ({
      Ordinance: 'ORD', Resolution: 'RES', Motion: 'MOT', Appointment: 'APT',
      'Public Hearing': 'PH', Proclamation: 'PRO', Contract: 'CON',
      Report: 'RPT', Communication: 'COM',
    })[type] || 'FILE';
    const year = new Date().getFullYear();
    const like = `${prefix}-${year}-%`;
    const row = db.prepare(
      `SELECT file_number FROM matters WHERE file_number LIKE ?
       ORDER BY file_number DESC LIMIT 1`).get(like);
    let next = 1;
    if (row) {
      const m = row.file_number.match(/(\d+)$/);
      if (m) next = parseInt(m[1], 10) + 1;
    }
    return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
  },
  insert(m) {
    const id = db.prepare(`INSERT INTO matters
      (file_number, type, title, status, body_id, intro_date, summary, full_text)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      m.file_number, m.type, m.title, m.status || 'Draft', m.body_id || null,
      m.intro_date || null, m.summary || null, m.full_text || null).lastInsertRowid;
    return id;
  },
  update(id, m) {
    db.prepare(`UPDATE matters SET
      type=?, title=?, status=?, body_id=?, intro_date=?, final_date=?, summary=?, full_text=?,
      updated_at=datetime('now') WHERE id=?`).run(
      m.type, m.title, m.status, m.body_id || null, m.intro_date || null,
      m.final_date || null, m.summary || null, m.full_text || null, id);
  },
  setStatus(id, status) {
    db.prepare(`UPDATE matters SET status=?, updated_at=datetime('now') WHERE id=?`)
      .run(status, id);
  },
  addSponsor(matterId, personId, type = 'Sponsor') {
    return db.prepare(`INSERT INTO matter_sponsors (matter_id, person_id, sponsor_type)
      VALUES (?,?,?)`).run(matterId, personId, type).lastInsertRowid;
  },
  clearSponsors(matterId) {
    db.prepare('DELETE FROM matter_sponsors WHERE matter_id = ?').run(matterId);
  },
  addHistory(h) {
    return db.prepare(`INSERT INTO matter_history
      (matter_id, action_date, body_id, action, result, notes, meeting_id)
      VALUES (?,?,?,?,?,?,?)`).run(
      h.matter_id, h.action_date, h.body_id || null, h.action,
      h.result || null, h.notes || null, h.meeting_id || null).lastInsertRowid;
  },
  addAttachment(a) {
    return db.prepare(`INSERT INTO attachments (matter_id, name, url, note)
      VALUES (?,?,?,?)`).run(a.matter_id, a.name, a.url || null, a.note || null).lastInsertRowid;
  },
};

// ---------------------------------------------------------------------------
// Meetings & agendas
// ---------------------------------------------------------------------------
const meetings = {
  all() {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name, b.type AS body_type,
        (SELECT COUNT(*) FROM agenda_items ai WHERE ai.meeting_id = mt.id) AS item_count
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      ORDER BY mt.meeting_date DESC, mt.meeting_time DESC`).all();
  },
  upcoming(fromDate, limit = 25) {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      WHERE mt.meeting_date >= ? AND mt.status != 'Cancelled'
      ORDER BY mt.meeting_date ASC LIMIT ?`).all(fromDate, limit);
  },
  past(fromDate, limit = 25) {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      WHERE mt.meeting_date < ?
      ORDER BY mt.meeting_date DESC LIMIT ?`).all(fromDate, limit);
  },
  get(id) {
    return db.prepare(`SELECT mt.*, b.name AS body_name, b.type AS body_type
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id WHERE mt.id = ?`).get(id);
  },
  items(meetingId) {
    return db.prepare(`
      SELECT ai.*, m.file_number, m.type AS matter_type, m.title AS matter_title,
             m.status AS matter_status
      FROM agenda_items ai LEFT JOIN matters m ON m.id = ai.matter_id
      WHERE ai.meeting_id = ?
      ORDER BY ai.sort_order, ai.id`).all(meetingId);
  },
  insert(mt) {
    return db.prepare(`INSERT INTO meetings
      (body_id, meeting_date, meeting_time, location, status, agenda_url, minutes_url, video_url, notes)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      mt.body_id, mt.meeting_date, mt.meeting_time || null, mt.location || null,
      mt.status || 'Scheduled', mt.agenda_url || null, mt.minutes_url || null,
      mt.video_url || null, mt.notes || null).lastInsertRowid;
  },
  addItem(it) {
    const maxOrder = db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS m FROM agenda_items WHERE meeting_id = ?')
      .get(it.meeting_id).m;
    return db.prepare(`INSERT INTO agenda_items
      (meeting_id, matter_id, sort_order, agenda_number, section, title, action, result, notes)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      it.meeting_id, it.matter_id || null, it.sort_order || (maxOrder + 1),
      it.agenda_number || null, it.section || null, it.title || null,
      it.action || null, it.result || null, it.notes || null).lastInsertRowid;
  },
  getItem(id) {
    return db.prepare(`
      SELECT ai.*, m.file_number, m.title AS matter_title, mt.body_id
      FROM agenda_items ai
      LEFT JOIN matters m ON m.id = ai.matter_id
      JOIN meetings mt ON mt.id = ai.meeting_id
      WHERE ai.id = ?`).get(id);
  },
  setItemResult(itemId, action, result) {
    db.prepare('UPDATE agenda_items SET action=?, result=? WHERE id=?')
      .run(action || null, result || null, itemId);
  },
};

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------
const votes = {
  forItem(agendaItemId) {
    return db.prepare(`
      SELECT v.*, p.full_name, p.district
      FROM votes v JOIN people p ON p.id = v.person_id
      WHERE v.agenda_item_id = ?
      ORDER BY p.full_name`).all(agendaItemId);
  },
  tally(agendaItemId) {
    const rows = db.prepare(
      'SELECT vote, COUNT(*) AS n FROM votes WHERE agenda_item_id = ? GROUP BY vote')
      .all(agendaItemId);
    const t = { Yea: 0, Nay: 0, Abstain: 0, Recused: 0, Absent: 0 };
    for (const r of rows) t[r.vote] = r.n;
    return t;
  },
  clearForItem(agendaItemId) {
    db.prepare('DELETE FROM votes WHERE agenda_item_id = ?').run(agendaItemId);
  },
  record(agendaItemId, personId, vote) {
    return db.prepare(`INSERT INTO votes (agenda_item_id, person_id, vote)
      VALUES (?,?,?)`).run(agendaItemId, personId, vote).lastInsertRowid;
  },
  byPerson(personId) {
    return db.prepare(`
      SELECT v.vote, ai.agenda_number, ai.action AS item_action, ai.result AS item_result,
             m.file_number, m.title AS matter_title, m.type AS matter_type,
             mt.id AS meeting_id, mt.meeting_date, b.name AS body_name
      FROM votes v
      JOIN agenda_items ai ON ai.id = v.agenda_item_id
      JOIN meetings mt ON mt.id = ai.meeting_id
      JOIN bodies b ON b.id = mt.body_id
      LEFT JOIN matters m ON m.id = ai.matter_id
      WHERE v.person_id = ?
      ORDER BY mt.meeting_date DESC, ai.sort_order`).all(personId);
  },
  personSummary(personId) {
    const rows = db.prepare(
      'SELECT vote, COUNT(*) AS n FROM votes WHERE person_id = ? GROUP BY vote').all(personId);
    const t = { Yea: 0, Nay: 0, Abstain: 0, Recused: 0, Absent: 0, total: 0 };
    for (const r of rows) { t[r.vote] = r.n; t.total += r.n; }
    return t;
  },
};

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------
function stats() {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  return {
    matters: one('SELECT COUNT(*) AS n FROM matters').n,
    pending: one(
      `SELECT COUNT(*) AS n FROM matters WHERE status IN ('Introduced','In Committee','On Agenda')`).n,
    enacted: one(`SELECT COUNT(*) AS n FROM matters WHERE status IN ('Passed','Enacted')`).n,
    meetings: one('SELECT COUNT(*) AS n FROM meetings').n,
    bodies: one('SELECT COUNT(*) AS n FROM bodies WHERE active = 1').n,
    people: one('SELECT COUNT(*) AS n FROM people WHERE active = 1').n,
  };
}

function statusBuckets() {
  return db.prepare(
    'SELECT status, COUNT(*) AS n FROM matters GROUP BY status ORDER BY n DESC').all();
}

module.exports = {
  MATTER_TYPES, MATTER_STATUSES, VOTE_VALUES, AGENDA_SECTIONS, TERMINAL_STATUSES,
  people, bodies, matters, meetings, votes, stats, statusBuckets,
};
