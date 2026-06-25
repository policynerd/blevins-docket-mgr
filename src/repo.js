'use strict';

const { db } = require('./db');
const { ORG } = require('./org');

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

// Allowlisted sort columns for the legislation grid (key -> SQL expression).
const SORT_COLUMNS = {
  file_number: 'm.file_number',
  type: 'm.type',
  title: 'm.title',
  body: 'b.name',
  intro_date: 'm.intro_date',
  status: 'm.status',
};

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
  // --- Office & staff (a board member's office) ---
  setOffice(personId, name) {
    db.prepare('UPDATE people SET office_name = ? WHERE id = ?').run(name || null, personId);
  },
  officeStaff(personId) {
    return db.prepare('SELECT * FROM office_staff WHERE person_id = ? ORDER BY sort_order, id')
      .all(personId);
  },
  getStaff(id) {
    return db.prepare('SELECT * FROM office_staff WHERE id = ?').get(id);
  },
  addStaff(s) {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM office_staff WHERE person_id = ?')
      .get(s.person_id).m;
    return db.prepare(`INSERT INTO office_staff (person_id, name, title, email, phone, sort_order)
      VALUES (?,?,?,?,?,?)`).run(s.person_id, s.name, s.title || null, s.email || null,
      s.phone || null, max + 1).lastInsertRowid;
  },
  updateStaff(id, s) {
    db.prepare('UPDATE office_staff SET name=?, title=?, email=?, phone=? WHERE id=?')
      .run(s.name, s.title || null, s.email || null, s.phone || null, id);
  },
  removeStaff(id) {
    db.prepare('DELETE FROM office_staff WHERE id = ?').run(id);
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
  memberById(memberId) {
    return db.prepare(`
      SELECT bm.*, p.full_name, b.name AS body_name
      FROM body_members bm JOIN people p ON p.id = bm.person_id
      JOIN bodies b ON b.id = bm.body_id WHERE bm.id = ?`).get(memberId);
  },
  removeMember(memberId) {
    db.prepare('DELETE FROM body_members WHERE id = ?').run(memberId);
  },
  update(id, b) {
    db.prepare(`UPDATE bodies SET name=?, type=?, description=?, meeting_location=?, meets=?, active=?
      WHERE id=?`).run(
      b.name, b.type ?? null, b.description ?? null, b.meeting_location ?? null,
      b.meets ?? null, b.active == null ? 1 : b.active, id);
  },
  setActive(id, active) {
    db.prepare('UPDATE bodies SET active=? WHERE id=?').run(active ? 1 : 0, id);
  },
  // Count rows that would block a hard delete (FK references without cascade).
  references(id) {
    const n = (sql) => db.prepare(sql).get(id).n;
    return {
      meetings: n('SELECT COUNT(*) AS n FROM meetings WHERE body_id = ?'),
      matters: n('SELECT COUNT(*) AS n FROM matters WHERE body_id = ?'),
      history: n('SELECT COUNT(*) AS n FROM matter_history WHERE body_id = ?'),
    };
  },
  // Permanently delete a body and its memberships. Caller must confirm there are
  // no meetings/matters/history references first (see references()).
  remove(id) {
    db.exec('SAVEPOINT sp_body_del');
    try {
      db.prepare('DELETE FROM body_members WHERE body_id = ?').run(id);
      db.prepare('DELETE FROM member_motions WHERE body_id = ?').run(id);
      db.prepare('DELETE FROM bodies WHERE id = ?').run(id);
      db.exec('RELEASE sp_body_del');
    } catch (e) { db.exec('ROLLBACK TO sp_body_del'); db.exec('RELEASE sp_body_del'); throw e; }
  },
};

// ---------------------------------------------------------------------------
// Matters (legislative files)
// ---------------------------------------------------------------------------
const matters = {
  // Build the shared WHERE clause + bound args for search/count.
  _filter({ q, type, status, bodyId, sponsorId, topicId, from, to } = {}) {
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
    if (topicId) {
      clauses.push('m.id IN (SELECT matter_id FROM matter_topics WHERE topic_id = ?)');
      args.push(topicId);
    }
    if (from) { clauses.push('m.intro_date >= ?'); args.push(from); }
    if (to) { clauses.push('m.intro_date <= ?'); args.push(to); }
    return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', args };
  },
  count(filters = {}) {
    const { where, args } = matters._filter(filters);
    return db.prepare(`SELECT COUNT(*) AS n FROM matters m ${where}`).get(...args).n;
  },
  search(filters = {}) {
    const { where, args } = matters._filter(filters);
    const order = SORT_COLUMNS[filters.sort] || SORT_COLUMNS.intro_date;
    const dir = String(filters.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = filters.limit == null ? 200 : filters.limit;
    const offset = filters.offset || 0;
    return db.prepare(`
      SELECT m.*, b.name AS body_name,
        (SELECT GROUP_CONCAT(p.full_name, ', ')
         FROM matter_sponsors ms JOIN people p ON p.id = ms.person_id
         WHERE ms.matter_id = m.id) AS sponsors
      FROM matters m LEFT JOIN bodies b ON b.id = m.body_id
      ${where}
      ORDER BY ${order} ${dir}, m.id DESC
      LIMIT ? OFFSET ?`).all(...args, limit, offset);
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
  // Filtered, paginated calendar query. view: upcoming | past | all.
  _calFilter({ bodyId, from, to, view, today } = {}) {
    const clauses = [];
    const args = [];
    if (view === 'upcoming') { clauses.push('mt.meeting_date >= ?'); args.push(today); }
    else if (view === 'past') { clauses.push('mt.meeting_date < ?'); args.push(today); }
    if (bodyId) { clauses.push('mt.body_id = ?'); args.push(bodyId); }
    if (from) { clauses.push('mt.meeting_date >= ?'); args.push(from); }
    if (to) { clauses.push('mt.meeting_date <= ?'); args.push(to); }
    return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', args };
  },
  countCalendar(filters = {}) {
    const { where, args } = meetings._calFilter(filters);
    return db.prepare(`SELECT COUNT(*) AS n FROM meetings mt ${where}`).get(...args).n;
  },
  searchCalendar(filters = {}) {
    const { where, args } = meetings._calFilter(filters);
    const dir = filters.view === 'upcoming' ? 'ASC' : 'DESC';
    const limit = filters.limit == null ? 25 : filters.limit;
    const offset = filters.offset || 0;
    return db.prepare(`
      SELECT mt.*, b.name AS body_name,
        (SELECT COUNT(*) FROM agenda_items ai WHERE ai.meeting_id = mt.id) AS item_count
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      ${where}
      ORDER BY mt.meeting_date ${dir}, mt.meeting_time ${dir}
      LIMIT ? OFFSET ?`).all(...args, limit, offset);
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
  setMotion(itemId, { mover_id, seconder_id, motion_text }) {
    db.prepare('UPDATE agenda_items SET mover_id=?, seconder_id=?, motion_text=? WHERE id=?')
      .run(mover_id || null, seconder_id || null, motion_text || null, itemId);
  },
  setVoteStatus(itemId, status) {
    db.prepare('UPDATE agenda_items SET vote_status=? WHERE id=?').run(status, itemId);
  },
  attendance(meetingId) {
    return db.prepare(`
      SELECT a.*, p.full_name, p.district
      FROM attendance a JOIN people p ON p.id = a.person_id
      WHERE a.meeting_id = ? ORDER BY p.full_name`).all(meetingId);
  },
  setAttendance(meetingId, rows) {
    db.exec('SAVEPOINT sp_att');
    try {
      db.prepare('DELETE FROM attendance WHERE meeting_id = ?').run(meetingId);
      const ins = db.prepare('INSERT INTO attendance (meeting_id, person_id, status) VALUES (?,?,?)');
      for (const r of rows) ins.run(meetingId, r.person_id, r.status);
      db.exec('RELEASE sp_att');
    } catch (e) { db.exec('ROLLBACK TO sp_att'); db.exec('RELEASE sp_att'); throw e; }
  },
  setMinutes(meetingId, html, status) {
    db.prepare('UPDATE meetings SET minutes_html=?, minutes_status=? WHERE id=?')
      .run(html || null, status || 'draft', meetingId);
  },
  // Persist a new ordering. Only items that belong to the meeting are touched,
  // so a stale or tampered id list can't move items between meetings.
  reorderItems(meetingId, orderedIds) {
    const owned = new Set(db.prepare('SELECT id FROM agenda_items WHERE meeting_id = ?')
      .all(meetingId).map((r) => r.id));
    const upd = db.prepare('UPDATE agenda_items SET sort_order = ? WHERE id = ? AND meeting_id = ?');
    let pos = 0;
    db.exec('SAVEPOINT sp_reorder');
    try {
      for (const id of orderedIds) {
        const n = Number(id);
        if (owned.has(n)) upd.run(++pos, n, meetingId);
      }
      db.exec('RELEASE sp_reorder');
    } catch (e) {
      db.exec('ROLLBACK TO sp_reorder'); db.exec('RELEASE sp_reorder');
      throw e;
    }
    return pos;
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
  clearPersonForItem(agendaItemId, personId) {
    db.prepare('DELETE FROM votes WHERE agenda_item_id = ? AND person_id = ?')
      .run(agendaItemId, personId);
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
// Reports (authored in the word processor)
// ---------------------------------------------------------------------------
const reports = {
  forMatter(matterId) {
    return db.prepare(`
      SELECT r.*, u.name AS author_name
      FROM reports r LEFT JOIN users u ON u.id = r.author_id
      WHERE r.matter_id = ? ORDER BY r.created_at DESC, r.id DESC`).all(matterId);
  },
  get(id) {
    return db.prepare(`
      SELECT r.*, u.name AS author_name, m.file_number, m.title AS matter_title
      FROM reports r
      LEFT JOIN users u ON u.id = r.author_id
      LEFT JOIN matters m ON m.id = r.matter_id
      WHERE r.id = ?`).get(id);
  },
  recent(limit = 25) {
    return db.prepare(`
      SELECT r.*, u.name AS author_name, m.file_number
      FROM reports r
      LEFT JOIN users u ON u.id = r.author_id
      LEFT JOIN matters m ON m.id = r.matter_id
      ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`).all(limit);
  },
  insert(r) {
    return db.prepare(`INSERT INTO reports (matter_id, title, kind, body_html, author_id)
      VALUES (?,?,?,?,?)`).run(
      r.matter_id || null, r.title, r.kind || 'Staff Report',
      r.body_html || null, r.author_id || null).lastInsertRowid;
  },
  update(id, r) {
    db.prepare(`UPDATE reports SET title=?, kind=?, body_html=?, updated_at=datetime('now')
      WHERE id=?`).run(r.title, r.kind || 'Staff Report', r.body_html || null, id);
  },
  remove(id) {
    db.prepare('DELETE FROM reports WHERE id = ?').run(id);
  },
};

// Add a rich-text body setter for matters (word-processor output).
matters.setBodyHtml = function (id, bodyHtml) {
  db.prepare(`UPDATE matters SET body_html=?, updated_at=datetime('now') WHERE id=?`)
    .run(bodyHtml || null, id);
};

// Fiscal impact of a matter, optionally tied to a budget line (rolls up there).
matters.setFiscal = function (id, { fiscal_impact, budget_line_id } = {}) {
  const amt = (fiscal_impact == null || fiscal_impact === '') ? null : Number(fiscal_impact);
  db.prepare(`UPDATE matters SET fiscal_impact=?, budget_line_id=?, updated_at=datetime('now') WHERE id=?`)
    .run(Number.isFinite(amt) ? amt : null, budget_line_id || null, id);
};

// ---------------------------------------------------------------------------
// Budget (fiscal-year line-item budget; matters' fiscal_impact rolls up)
// ---------------------------------------------------------------------------
const BUDGET_STATUSES = ['Draft', 'Adopted', 'Closed'];
const BUDGET_KINDS = ['Expense', 'Revenue'];

const budget = {
  all() {
    return db.prepare(`SELECT b.*,
      (SELECT COUNT(*) FROM budget_lines bl WHERE bl.budget_id = b.id) AS line_count,
      (SELECT COALESCE(SUM(amount),0) FROM budget_lines bl WHERE bl.budget_id = b.id) AS budgeted
      FROM budgets b ORDER BY b.fiscal_year DESC, b.id DESC`).all();
  },
  get(id) { return db.prepare('SELECT * FROM budgets WHERE id = ?').get(id); },
  create(b) {
    return db.prepare('INSERT INTO budgets (fiscal_year, status, notes) VALUES (?,?,?)')
      .run(b.fiscal_year, b.status || 'Draft', b.notes || null).lastInsertRowid;
  },
  update(id, b) {
    db.prepare('UPDATE budgets SET fiscal_year=?, status=?, notes=? WHERE id=?')
      .run(b.fiscal_year, b.status || 'Draft', b.notes || null, id);
  },
  remove(id) { db.prepare('DELETE FROM budgets WHERE id = ?').run(id); }, // cascades lines
  // Lines with committed rollup (sum of linked matters' fiscal_impact).
  lines(budgetId) {
    return db.prepare(`SELECT bl.*,
      COALESCE((SELECT SUM(m.fiscal_impact) FROM matters m WHERE m.budget_line_id = bl.id), 0) AS committed,
      (SELECT COUNT(*) FROM matters m WHERE m.budget_line_id = bl.id) AS item_count
      FROM budget_lines bl WHERE bl.budget_id = ?
      ORDER BY bl.category IS NULL, bl.category, bl.sort_order, bl.id`).all(budgetId);
  },
  getLine(id) {
    return db.prepare(`SELECT bl.*, b.fiscal_year FROM budget_lines bl
      JOIN budgets b ON b.id = bl.budget_id WHERE bl.id = ?`).get(id);
  },
  addLine(l) {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM budget_lines WHERE budget_id = ?')
      .get(l.budget_id).m;
    return db.prepare(`INSERT INTO budget_lines (budget_id, category, name, kind, amount, notes, sort_order)
      VALUES (?,?,?,?,?,?,?)`).run(l.budget_id, l.category || null, l.name, l.kind || 'Expense',
      Number(l.amount) || 0, l.notes || null, l.sort_order || (max + 1)).lastInsertRowid;
  },
  updateLine(id, l) {
    db.prepare('UPDATE budget_lines SET category=?, name=?, kind=?, amount=?, notes=? WHERE id=?')
      .run(l.category || null, l.name, l.kind || 'Expense', Number(l.amount) || 0, l.notes || null, id);
  },
  removeLine(id) { db.prepare('DELETE FROM budget_lines WHERE id = ?').run(id); },
  // Selectable lines for the matter fiscal-impact field (open budgets only).
  lineOptions() {
    return db.prepare(`SELECT bl.id AS value,
      (b.fiscal_year || ' · ' || COALESCE(bl.category || ' — ', '') || bl.name) AS label
      FROM budget_lines bl JOIN budgets b ON b.id = bl.budget_id
      WHERE b.status != 'Closed'
      ORDER BY b.fiscal_year DESC, bl.category, bl.name`).all();
  },
  summary(budgetId) {
    const lines = budget.lines(budgetId);
    let budgeted = 0; let committed = 0;
    for (const l of lines) { budgeted += l.amount; committed += l.committed; }
    return { budgeted, committed, remaining: budgeted - committed, lineCount: lines.length };
  },
  // Matters linked to a line (for drill-down).
  lineMatters(lineId) {
    return db.prepare(`SELECT m.id, m.file_number, m.title, m.status, m.fiscal_impact
      FROM matters m WHERE m.budget_line_id = ? ORDER BY m.intro_date DESC, m.id DESC`).all(lineId);
  },
};

// ---------------------------------------------------------------------------
// Topics / indexes
// ---------------------------------------------------------------------------
const topics = {
  all() {
    return db.prepare(`
      SELECT t.id, t.name, COUNT(mt.matter_id) AS n
      FROM topics t LEFT JOIN matter_topics mt ON mt.topic_id = t.id
      GROUP BY t.id ORDER BY t.name`).all();
  },
  get(id) {
    return db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  },
  forMatter(matterId) {
    return db.prepare(`
      SELECT t.id, t.name FROM matter_topics mt JOIN topics t ON t.id = mt.topic_id
      WHERE mt.matter_id = ? ORDER BY t.name`).all(matterId);
  },
  ensure(name) {
    const clean = String(name).trim();
    if (!clean) return null;
    const existing = db.prepare('SELECT id FROM topics WHERE lower(name) = lower(?)').get(clean);
    if (existing) return existing.id;
    return db.prepare('INSERT INTO topics (name) VALUES (?)').run(clean).lastInsertRowid;
  },
  setForMatter(matterId, names) {
    db.exec('SAVEPOINT sp_topics');
    try {
      db.prepare('DELETE FROM matter_topics WHERE matter_id = ?').run(matterId);
      const link = db.prepare('INSERT INTO matter_topics (matter_id, topic_id) VALUES (?,?)');
      const seen = new Set();
      for (const name of names) {
        const id = topics.ensure(name);
        if (id && !seen.has(id)) { link.run(matterId, id); seen.add(id); }
      }
      db.exec('RELEASE sp_topics');
    } catch (e) { db.exec('ROLLBACK TO sp_topics'); db.exec('RELEASE sp_topics'); throw e; }
  },
};

// ---------------------------------------------------------------------------
// Routing / approval workflow
// ---------------------------------------------------------------------------
// Built fresh each time so live branding changes (ORG.primaryBody / clerkTitle)
// are reflected in newly-started routes.
function workflowTemplate() {
  return [
    { name: 'Sponsor / Drafting', role: 'Sponsor' },
    { name: 'Department Review', role: 'Department' },
    { name: 'Legal Review', role: 'Legal' },
    { name: 'Clerk Review', role: ORG.clerkTitle },
    { name: 'Committee', role: 'Committee' },
    { name: `Full ${ORG.primaryBody}`, role: ORG.primaryBody },
  ];
}

const workflow = {
  forMatter(matterId) {
    return db.prepare(`
      SELECT w.*, u.name AS acted_by_name
      FROM workflow_steps w LEFT JOIN users u ON u.id = w.acted_by
      WHERE w.matter_id = ? ORDER BY w.seq`).all(matterId);
  },
  get(stepId) {
    return db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId);
  },
  // Create the default route if this matter has none. Returns the step count.
  start(matterId) {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM workflow_steps WHERE matter_id = ?').get(matterId).n;
    if (existing > 0) return existing;
    const ins = db.prepare('INSERT INTO workflow_steps (matter_id, seq, name, role, status) VALUES (?,?,?,?,?)');
    const template = workflowTemplate();
    template.forEach((s, i) => ins.run(matterId, i + 1, s.name, s.role, 'Pending'));
    return template.length;
  },
  // The active step = first that is Pending or Returned.
  current(matterId) {
    return db.prepare(`SELECT * FROM workflow_steps WHERE matter_id = ?
      AND status IN ('Pending','Returned') ORDER BY seq LIMIT 1`).get(matterId);
  },
  act(stepId, { status, userId, notes }) {
    db.prepare(`UPDATE workflow_steps SET status=?, acted_by=?, acted_at=datetime('now'), notes=?
      WHERE id=?`).run(status, userId || null, notes || null, stepId);
  },
  progress(matterId) {
    const row = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='Approved' THEN 1 ELSE 0 END) AS approved
      FROM workflow_steps WHERE matter_id = ?`).get(matterId);
    return { total: row.total || 0, approved: row.approved || 0 };
  },
};

// ---------------------------------------------------------------------------
// Organization (Divisions → Departments → Offices → Units)
// ---------------------------------------------------------------------------
const ORG_LEVELS = ['Division', 'Department', 'Office', 'Unit'];

const org = {
  all() {
    return db.prepare('SELECT * FROM org_units ORDER BY sort_order, name').all();
  },
  get(id) {
    return db.prepare('SELECT * FROM org_units WHERE id = ?').get(id);
  },
  children(parentId) {
    return parentId == null
      ? db.prepare('SELECT * FROM org_units WHERE parent_id IS NULL ORDER BY sort_order, name').all()
      : db.prepare('SELECT * FROM org_units WHERE parent_id = ? ORDER BY sort_order, name').all(parentId);
  },
  // Nested tree of all units ({...unit, children: [...]}).
  tree() {
    const rows = org.all();
    const byId = new Map();
    rows.forEach((r) => { r.children = []; byId.set(r.id, r); });
    const roots = [];
    rows.forEach((r) => {
      if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).children.push(r);
      else roots.push(r);
    });
    return roots;
  },
  ancestors(id) {
    const chain = [];
    let cur = org.get(id);
    while (cur && cur.parent_id) { cur = org.get(cur.parent_id); if (cur) chain.unshift(cur); }
    return chain;
  },
  counts() {
    const rows = db.prepare('SELECT level, COUNT(*) AS n FROM org_units GROUP BY level').all();
    const out = {};
    for (const lvl of ORG_LEVELS) out[lvl] = 0;
    for (const r of rows) out[r.level] = r.n;
    return out;
  },
  insert(u) {
    return db.prepare(`INSERT INTO org_units
      (parent_id, level, name, leader_name, leader_title, leader_email, leader_phone, description, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      u.parent_id || null, u.level, u.name, u.leader_name || null, u.leader_title || null,
      u.leader_email || null, u.leader_phone || null, u.description || null,
      u.sort_order || 0).lastInsertRowid;
  },
  update(id, u) {
    db.prepare(`UPDATE org_units SET parent_id=?, level=?, name=?, leader_name=?, leader_title=?,
      leader_email=?, leader_phone=?, description=?, sort_order=? WHERE id=?`).run(
      u.parent_id || null, u.level, u.name, u.leader_name || null, u.leader_title || null,
      u.leader_email || null, u.leader_phone || null, u.description || null, u.sort_order || 0, id);
  },
  remove(id) {
    db.prepare('DELETE FROM org_units WHERE id = ?').run(id);
  },
};

// ---------------------------------------------------------------------------
// Member motions (board membership changes: Nominate -> Approve -> Seat)
// ---------------------------------------------------------------------------
const MEMBER_MOTION_STATUSES = ['Nominated', 'Approved', 'Completed', 'Rejected'];

const memberMotions = {
  _select: `
    SELECT mm.*, b.name AS body_name,
      p.full_name AS person_name,
      nu.name AS nominated_by_name, au.name AS approved_by_name, cu.name AS completed_by_name
    FROM member_motions mm
    LEFT JOIN bodies b ON b.id = mm.body_id
    LEFT JOIN people p ON p.id = mm.person_id
    LEFT JOIN users nu ON nu.id = mm.nominated_by
    LEFT JOIN users au ON au.id = mm.approved_by
    LEFT JOIN users cu ON cu.id = mm.completed_by`,
  get(id) {
    return db.prepare(`${memberMotions._select} WHERE mm.id = ?`).get(id);
  },
  all() {
    return db.prepare(`${memberMotions._select}
      ORDER BY CASE mm.status WHEN 'Nominated' THEN 0 WHEN 'Approved' THEN 1 ELSE 2 END,
        mm.nominated_at DESC, mm.id DESC`).all();
  },
  pending() {
    return db.prepare(`${memberMotions._select}
      WHERE mm.status IN ('Nominated','Approved')
      ORDER BY mm.nominated_at ASC`).all();
  },
  // Display label for the subject of a motion (existing person or nominee name).
  subjectName(m) {
    return m.person_name || m.nominee_name || '(unnamed)';
  },
  nominate(m) {
    return db.prepare(`INSERT INTO member_motions
      (action, body_id, person_id, member_id, nominee_name, nominee_title, nominee_email,
       nominee_district, seat_role, reason, nominated_by, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'Nominated')`).run(
      m.action, m.body_id ?? null, m.person_id ?? null, m.member_id ?? null,
      m.nominee_name ?? null, m.nominee_title ?? null, m.nominee_email ?? null,
      m.nominee_district ?? null, m.seat_role ?? 'Member', m.reason ?? null,
      m.nominated_by ?? null).lastInsertRowid;
  },
  approve(id, userId, notes) {
    db.prepare(`UPDATE member_motions
      SET status='Approved', approved_by=?, approved_at=datetime('now'), decision_notes=?
      WHERE id=? AND status='Nominated'`).run(userId ?? null, notes ?? null, id);
  },
  reject(id, userId, notes) {
    db.prepare(`UPDATE member_motions
      SET status='Rejected', approved_by=?, approved_at=datetime('now'), decision_notes=?
      WHERE id=? AND status IN ('Nominated','Approved')`).run(userId ?? null, notes ?? null, id);
  },
  // Execute an approved motion: apply the roster change in one transaction and
  // mark it Completed. Returns the affected person id.
  complete(id, userId) {
    const m = memberMotions.get(id);
    if (!m || m.status !== 'Approved') throw new Error('Motion is not approved.');
    db.exec('SAVEPOINT sp_mm');
    try {
      let personId = m.person_id;
      if (m.action === 'seat') {
        if (!personId) {
          personId = people.insert({
            full_name: m.nominee_name, title: m.nominee_title || ORG.memberTitle,
            district: m.nominee_district, email: m.nominee_email,
          });
        }
        // Avoid duplicate membership on the same body.
        const dup = db.prepare(
          'SELECT id FROM body_members WHERE body_id = ? AND person_id = ?').get(m.body_id, personId);
        if (!dup) bodies.addMember(m.body_id, personId, m.seat_role || 'Member');
      } else if (m.action === 'remove') {
        if (m.member_id) db.prepare('DELETE FROM body_members WHERE id = ?').run(m.member_id);
        else if (m.body_id && personId) {
          db.prepare('DELETE FROM body_members WHERE body_id = ? AND person_id = ?')
            .run(m.body_id, personId);
        }
      }
      db.prepare(`UPDATE member_motions
        SET status='Completed', completed_by=?, completed_at=datetime('now'), result_person_id=?
        WHERE id=?`).run(userId ?? null, personId ?? null, id);
      db.exec('RELEASE sp_mm');
      return personId;
    } catch (e) { db.exec('ROLLBACK TO sp_mm'); db.exec('RELEASE sp_mm'); throw e; }
  },
};

// ---------------------------------------------------------------------------
// Policies (adopted governance documents / bylaws)
// ---------------------------------------------------------------------------
const POLICY_STATUSES = ['Draft', 'Active', 'Under Review', 'Superseded'];

const policies = {
  // Public listing = everything except Draft, grouped sensibly.
  published() {
    return db.prepare(`SELECT * FROM policies WHERE status != 'Draft'
      ORDER BY category IS NULL, category, policy_number, title`).all();
  },
  all() {
    return db.prepare(`SELECT * FROM policies
      ORDER BY category IS NULL, category, policy_number, title`).all();
  },
  get(id) {
    return db.prepare(`SELECT p.*, u.name AS author_name, m.file_number AS matter_file_number
      FROM policies p
      LEFT JOIN users u ON u.id = p.author_id
      LEFT JOIN matters m ON m.id = p.matter_id
      WHERE p.id = ?`).get(id);
  },
  insert(p) {
    return db.prepare(`INSERT INTO policies
      (policy_number, title, category, status, effective_date, body_html, matter_id, author_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      p.policy_number ?? null, p.title, p.category ?? null, p.status || 'Draft',
      p.effective_date ?? null, p.body_html ?? null, p.matter_id ?? null,
      p.author_id ?? null).lastInsertRowid;
  },
  update(id, p) {
    db.prepare(`UPDATE policies SET policy_number=?, title=?, category=?, status=?,
      effective_date=?, body_html=?, matter_id=?, updated_at=datetime('now') WHERE id=?`).run(
      p.policy_number ?? null, p.title, p.category ?? null, p.status || 'Draft',
      p.effective_date ?? null, p.body_html ?? null, p.matter_id ?? null, id);
  },
  remove(id) {
    db.prepare('DELETE FROM policies WHERE id = ?').run(id);
  },
};

// ---------------------------------------------------------------------------
// Users & roles (login accounts)
// ---------------------------------------------------------------------------
const USER_ROLES = ['member', 'staff', 'clerk', 'admin'];

const users = {
  all() {
    return db.prepare(`SELECT u.*, p.full_name AS person_name
      FROM users u LEFT JOIN people p ON p.id = u.person_id
      ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'clerk' THEN 1 WHEN 'staff' THEN 2 ELSE 3 END,
        u.name`).all();
  },
  get(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  byEmail(email) {
    return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
  },
  setRole(id, role) {
    if (!USER_ROLES.includes(role)) return;
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  },
  setActive(id, active) {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  },
  // Pre-provision an SSO login by email (matched on first Microsoft sign-in).
  create({ name, email, role }) {
    if (!USER_ROLES.includes(role)) role = 'member';
    return db.prepare(`INSERT INTO users (person_id, name, email, role, auth_provider)
      VALUES (NULL, ?, ?, ?, 'entra')`).run(name || email, email, role).lastInsertRowid;
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

// Permanently delete all domain data (people, bodies, legislation, meetings,
// votes, motions, org units, …) while KEEPING user accounts and settings, so a
// signed-in clerk can clear demo/sample data without losing their login or
// branding. Used by the admin "Clear all data" action.
function purgeDomainData() {
  const tables = ['office_staff', 'budget_lines', 'budgets', 'policies', 'member_motions', 'votes',
    'attendance', 'agenda_items', 'meetings', 'matter_topics', 'topics', 'matter_history',
    'matter_sponsors', 'attachments', 'reports', 'workflow_steps', 'matters', 'body_members',
    'bodies', 'org_units', 'people'];
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('SAVEPOINT sp_purge');
  try {
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare('UPDATE users SET person_id = NULL').run(); // people are gone
    db.exec('RELEASE sp_purge');
  } catch (e) {
    db.exec('ROLLBACK TO sp_purge'); db.exec('RELEASE sp_purge');
    db.exec('PRAGMA foreign_keys = ON;');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON;');
}

module.exports = {
  MATTER_TYPES, MATTER_STATUSES, VOTE_VALUES, AGENDA_SECTIONS, TERMINAL_STATUSES, SORT_COLUMNS,
  ORG_LEVELS, MEMBER_MOTION_STATUSES, POLICY_STATUSES, USER_ROLES,
  BUDGET_STATUSES, BUDGET_KINDS, workflowTemplate,
  people, bodies, matters, meetings, votes, reports, topics, workflow, org, memberMotions,
  policies, users, budget, stats, statusBuckets, purgeDomainData,
};
