'use strict';

const { db, ftsEnabled } = require('./db');
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
const ITEM_TYPES = ['Action', 'Discussion', 'Information'];

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
  update(id, p) {
    db.prepare(`UPDATE people SET full_name=?, title=?, district=?, party=?, email=?, phone=?,
      website=?, bio=?, active=? WHERE id=?`).run(
      p.full_name, p.title ?? null, p.district ?? null, p.party ?? null, p.email ?? null,
      p.phone ?? null, p.website ?? null, p.bio ?? null, p.active == null ? 1 : p.active, id);
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
      (name, type, description, meeting_location, meets, active, seats)
      VALUES (?,?,?,?,?,?,?)`).run(
      b.name, b.type ?? null, b.description ?? null, b.meeting_location ?? null,
      b.meets ?? null, b.active == null ? 1 : b.active, b.seats ?? null).lastInsertRowid;
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
    db.prepare(`UPDATE bodies SET name=?, type=?, description=?, meeting_location=?, meets=?, active=?, seats=?
      WHERE id=?`).run(
      b.name, b.type ?? null, b.description ?? null, b.meeting_location ?? null,
      b.meets ?? null, b.active == null ? 1 : b.active, b.seats ?? null, id);
  },
  // Members whose terms end within the window (or already ended), plus
  // seat vacancies, for the membership workspace.
  expiringTerms(days = 120) {
    return db.prepare(`
      SELECT bm.*, p.full_name, b.name AS body_name
      FROM body_members bm
      JOIN people p ON p.id = bm.person_id
      JOIN bodies b ON b.id = bm.body_id
      WHERE bm.end_date IS NOT NULL
        AND date(bm.end_date) <= date('now', '+' || ? || ' days')
      ORDER BY bm.end_date`).all(days);
  },
  vacancies() {
    return db.prepare(`
      SELECT b.id, b.name, b.seats,
        (SELECT COUNT(*) FROM body_members bm WHERE bm.body_id = b.id) AS filled
      FROM bodies b
      WHERE b.active = 1 AND b.seats IS NOT NULL
        AND b.seats > (SELECT COUNT(*) FROM body_members bm WHERE bm.body_id = b.id)
      ORDER BY b.name`).all();
  },
  setMemberTerm(memberId, { start_date, end_date }) {
    db.prepare('UPDATE body_members SET start_date=?, end_date=? WHERE id=?')
      .run(start_date || null, end_date || null, memberId);
  },
  setActive(id, active) {
    db.prepare('UPDATE bodies SET active=? WHERE id=?').run(active ? 1 : 0, id);
  },
  legislation(bodyId) {
    return db.prepare(`
      SELECT id, file_number, type, title, status, intro_date
      FROM matters WHERE body_id = ?
      ORDER BY intro_date DESC, id DESC`).all(bodyId);
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
// Turn free text into a safe FTS5 MATCH expression: each token becomes a
// quoted prefix phrase ("zoning"*), which sidesteps FTS query syntax entirely
// (AND/OR/NEAR/parens in user input can't cause errors).
function ftsQuery(q) {
  return String(q).split(/\s+/).filter(Boolean).slice(0, 12)
    .map((t) => `"${t.replace(/"/g, '')}"*`)
    .join(' ');
}

const matters = {
  // Build the shared WHERE clause + bound args for search/count.
  _filter({ q, type, status, bodyId, sponsorId, topicId, from, to } = {}) {
    const clauses = [];
    const args = [];
    if (q) {
      const match = ftsEnabled() ? ftsQuery(q) : '';
      if (match) {
        // Full text (title, summary, full text, document body) OR a partial
        // file-number match, which FTS prefix queries don't cover mid-string.
        clauses.push('(m.id IN (SELECT rowid FROM matters_fts WHERE matters_fts MATCH ?) OR m.file_number LIKE ?)');
        args.push(match, `%${q}%`);
      } else {
        clauses.push('(m.title LIKE ? OR m.file_number LIKE ? OR m.summary LIKE ?)');
        const like = `%${q}%`;
        args.push(like, like, like);
      }
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
  nextFileNumber() {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `${yy}${mm}`;
    // Max sequence computed numerically: lexicographic ordering would rank
    // 260799 above 2607100 once a month passes 99 files and mint a duplicate.
    const { m } = db.prepare(
      `SELECT MAX(CAST(substr(file_number, 5) AS INTEGER)) AS m
       FROM matters
       WHERE file_number LIKE ? || '%' AND file_number NOT GLOB '*[^0-9]*'`).get(prefix);
    return `${prefix}${String((m || 0) + 1).padStart(2, '0')}`;
  },
  // Insert with an auto-assigned file number, retrying if a concurrent request
  // claimed the same number between generation and insert (UNIQUE constraint).
  insertNumbered(m) {
    for (let attempt = 0; ; attempt++) {
      const file_number = this.nextFileNumber();
      try {
        return { id: this.insert({ ...m, file_number }), file_number };
      } catch (e) {
        if (attempt >= 2 || !/UNIQUE/i.test(String(e.message))) throw e;
      }
    }
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
    const id = db.prepare(`INSERT INTO matter_history
      (matter_id, action_date, body_id, action, result, notes, meeting_id)
      VALUES (?,?,?,?,?,?,?)`).run(
      h.matter_id, h.action_date, h.body_id || null, h.action,
      h.result || null, h.notes || null, h.meeting_id || null).lastInsertRowid;
    // Tell watchers (no-op unless SMTP is configured). Lazy require: notify
    // never imports repo, but keeping the edge lazy avoids load-order surprises.
    try {
      require('./notify').matterActivity(h.matter_id,
        `${h.action}${h.result ? ' — ' + h.result : ''}`);
    } catch (_) { /* notifications are best-effort */ }
    return id;
  },
  addAttachment(a) {
    return db.prepare(`INSERT INTO attachments (matter_id, name, url, note, file_path, size, content_type)
      VALUES (?,?,?,?,?,?,?)`).run(a.matter_id, a.name, a.url || null, a.note || null,
      a.file_path || null, a.size || null, a.content_type || null).lastInsertRowid;
  },
  getAttachment(id) {
    return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  },
  removeAttachment(id) {
    db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
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
  update(id, mt) {
    db.prepare(`UPDATE meetings SET body_id=?, meeting_date=?, meeting_time=?, location=?, status=?,
      agenda_url=?, video_url=?, minutes_url=?, notes=? WHERE id=?`).run(
      mt.body_id, mt.meeting_date, mt.meeting_time || null, mt.location || null,
      mt.status || 'Scheduled', mt.agenda_url || null, mt.video_url || null,
      mt.minutes_url || null, mt.notes || null, id);
  },
  addItem(it) {
    const existing = db.prepare(
      'SELECT section, agenda_number, sort_order FROM agenda_items WHERE meeting_id = ? ORDER BY sort_order')
      .all(it.meeting_id);
    const maxOrder = existing.length ? existing[existing.length - 1].sort_order : 0;

    // Auto-assign agenda_number when not provided: "1A", "1B" within sections,
    // or "1", "2", "3" for unsectioned items. Derived from existing agenda_number
    // values so deletes and reorders never cause collisions.
    let agendaNum = it.agenda_number || null;
    if (!agendaNum) {
      if (it.section) {
        const sectionItems = existing.filter((r) => r.section === it.section && r.agenda_number);
        if (sectionItems.length > 0) {
          // Reuse the numeric prefix already established for this section.
          const prefixMatch = sectionItems[0].agenda_number.match(/^(\d+)/);
          const prefix = prefixMatch ? prefixMatch[1] : '1';
          // Find the highest letter suffix in use and take the next one.
          let maxCode = 64; // one before 'A'
          for (const si of sectionItems) {
            const lm = si.agenda_number.match(/([A-Za-z]+)$/);
            if (lm && lm[1].length === 1) maxCode = Math.max(maxCode, lm[1].toUpperCase().charCodeAt(0));
          }
          agendaNum = maxCode < 90 ? `${prefix}${String.fromCharCode(maxCode + 1)}` : `${prefix}-${maxCode - 63}`;
        } else {
          // New section: assign the next unused numeric prefix.
          const usedPrefixes = new Set();
          for (const row of existing) {
            if (row.section && row.agenda_number) {
              const m = row.agenda_number.match(/^(\d+)/);
              if (m) usedPrefixes.add(Number(m[1]));
            }
          }
          let next = 1;
          while (usedPrefixes.has(next)) next++;
          agendaNum = `${next}A`;
        }
      } else {
        // Unsectioned: max existing numeric agenda_number + 1.
        let maxN = 0;
        for (const row of existing) {
          if (!row.section && row.agenda_number) {
            const n = parseInt(row.agenda_number, 10);
            if (!isNaN(n)) maxN = Math.max(maxN, n);
          }
        }
        agendaNum = String(maxN + 1);
      }
    }

    const itemType = ITEM_TYPES.includes(it.item_type) ? it.item_type : null;
    const requiresVote = it.requires_vote != null
      ? (it.requires_vote ? 1 : 0)
      : (it.matter_id || itemType === 'Action' ? 1 : 0);
    return db.prepare(`INSERT INTO agenda_items
      (meeting_id, matter_id, sort_order, agenda_number, section, title, action, result, notes, requires_vote, item_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      it.meeting_id, it.matter_id || null, it.sort_order || (maxOrder + 1),
      agendaNum, it.section || null, it.title || null,
      it.action || null, it.result || null, it.notes || null, requiresVote, itemType).lastInsertRowid;
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
  setItemVideoTs(itemId, ts) {
    db.prepare('UPDATE agenda_items SET video_ts=? WHERE id=?').run(ts, itemId);
  },
  setRequiresVote(itemId, val) {
    db.prepare('UPDATE agenda_items SET requires_vote=? WHERE id=?').run(val ? 1 : 0, itemId);
  },
  removeItem(itemId) {
    db.prepare('DELETE FROM agenda_items WHERE id = ?').run(itemId); // votes cascade
  },
  setMotion(itemId, { mover_id, seconder_id, motion_text, vote_threshold }) {
    const VALID_THRESHOLDS = new Set(['majority', 'two_thirds', 'majority_full']);
    if (vote_threshold !== undefined) {
      const safeThreshold = VALID_THRESHOLDS.has(vote_threshold) ? vote_threshold : 'majority';
      db.prepare('UPDATE agenda_items SET mover_id=?, seconder_id=?, motion_text=?, vote_threshold=? WHERE id=?')
        .run(mover_id || null, seconder_id || null, motion_text || null, safeThreshold, itemId);
    } else {
      db.prepare('UPDATE agenda_items SET mover_id=?, seconder_id=?, motion_text=? WHERE id=?')
        .run(mover_id || null, seconder_id || null, motion_text || null, itemId);
    }
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
  inSession() {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      WHERE mt.status = 'In Progress'
      ORDER BY mt.meeting_date DESC, mt.meeting_time DESC`).all();
  },
  nextScheduled(fromDate) {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      WHERE mt.meeting_date >= ? AND mt.status NOT IN ('Cancelled', 'Adjourned', 'Final', 'In Progress')
      ORDER BY mt.meeting_date ASC, mt.meeting_time ASC
      LIMIT 1`).get(fromDate);
  },
  todayDocket(date) {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      WHERE mt.meeting_date = ? AND mt.status != 'Cancelled'
      ORDER BY mt.meeting_time ASC`).all(date);
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

matters.setAmendsPolicy = function (id, policyId) {
  db.prepare('UPDATE matters SET amends_policy_id=? WHERE id=?').run(policyId || null, id);
};

// --- Related files -------------------------------------------------------------
const RELATION_TYPES = ['Related', 'Companion', 'Amends', 'Supersedes'];

matters.addRelation = function (matterId, relatedId, relation) {
  if (Number(matterId) === Number(relatedId)) return;
  try {
    db.prepare('INSERT INTO matter_relations (matter_id, related_id, relation) VALUES (?,?,?)')
      .run(matterId, relatedId, RELATION_TYPES.includes(relation) ? relation : 'Related');
  } catch (_) { /* duplicate pair — already linked */ }
};
matters.getRelation = function (id) {
  return db.prepare('SELECT * FROM matter_relations WHERE id = ?').get(id);
};
matters.removeRelation = function (id) {
  db.prepare('DELETE FROM matter_relations WHERE id = ?').run(id);
};
// Both directions: links this file created and links pointing at it.
matters.relationsFor = function (matterId) {
  return db.prepare(`
    SELECT r.id, r.relation, 1 AS outgoing, m.id AS other_id, m.file_number, m.title, m.status
    FROM matter_relations r JOIN matters m ON m.id = r.related_id WHERE r.matter_id = ?
    UNION ALL
    SELECT r.id, r.relation, 0 AS outgoing, m.id AS other_id, m.file_number, m.title, m.status
    FROM matter_relations r JOIN matters m ON m.id = r.matter_id WHERE r.related_id = ?
    ORDER BY file_number`).all(matterId, matterId);
};

// --- Text versioning ---------------------------------------------------------
// The matters row holds the current text; before an edit changes it, the
// outgoing text is archived as the next numbered version.
matters.versions = function (matterId) {
  return db.prepare('SELECT * FROM matter_versions WHERE matter_id = ? ORDER BY version DESC')
    .all(matterId);
};
matters.getVersion = function (matterId, version) {
  return db.prepare('SELECT * FROM matter_versions WHERE matter_id = ? AND version = ?')
    .get(matterId, version);
};
matters.currentVersion = function (matterId) {
  return 1 + db.prepare('SELECT COUNT(*) AS n FROM matter_versions WHERE matter_id = ?')
    .get(matterId).n;
};
// Snapshot the current text if the incoming text differs. Fields left
// undefined are treated as "unchanged". Returns true when a version was cut.
matters.snapshotIfChanged = function (id, next = {}) {
  const cur = this.get(id);
  if (!cur) return false;
  const nextFull = next.full_text === undefined ? (cur.full_text || null) : (next.full_text || null);
  const nextHtml = next.body_html === undefined ? (cur.body_html || null) : (next.body_html || null);
  if ((cur.full_text || null) === nextFull && (cur.body_html || null) === nextHtml) return false;
  // Don't archive an all-empty state (first real text isn't an "amendment").
  if (!cur.full_text && !cur.body_html) return false;
  const version = db.prepare('SELECT COUNT(*) AS n FROM matter_versions WHERE matter_id = ?').get(id).n + 1;
  db.prepare(`INSERT INTO matter_versions (matter_id, version, full_text, body_html, note)
    VALUES (?,?,?,?,?)`).run(id, version, cur.full_text || null, cur.body_html || null, next.note || null);
  return true;
};

// Fiscal impact of a matter, optionally tied to a budget line (rolls up there).
matters.setFiscal = function (id, { fiscal_impact, budget_line_id, fiscal_recurring, fiscal_note } = {}) {
  const amt = (fiscal_impact == null || fiscal_impact === '') ? null : Number(fiscal_impact);
  db.prepare(`UPDATE matters SET fiscal_recurring=?, fiscal_note=? WHERE id=?`)
    .run(fiscal_recurring ? 1 : 0, (fiscal_note || '').trim() || null, id);
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
    db.prepare('UPDATE budgets SET fiscal_year=?, status=?, notes=?, adopted_matter_id=? WHERE id=?')
      .run(b.fiscal_year, b.status || 'Draft', b.notes || null,
        b.adopted_matter_id || null, id);
  },
  remove(id) { db.prepare('DELETE FROM budgets WHERE id = ?').run(id); }, // cascades lines
  // Lines with rollups. amount = ADOPTED figure (never overwritten by
  // amendments); amended = SUM(amendments); current = adopted + amended;
  // committed = linked legislation's fiscal impact; actual = ledger total.
  lines(budgetId) {
    return db.prepare(`SELECT bl.*,
      COALESCE((SELECT SUM(m.fiscal_impact) FROM matters m WHERE m.budget_line_id = bl.id), 0) AS committed,
      (SELECT COUNT(*) FROM matters m WHERE m.budget_line_id = bl.id) AS item_count,
      COALESCE((SELECT SUM(a.amount) FROM budget_amendments a WHERE a.budget_line_id = bl.id), 0) AS amended,
      (SELECT COUNT(*) FROM budget_amendments a WHERE a.budget_line_id = bl.id) AS amendment_count,
      COALESCE((SELECT SUM(t.amount) FROM budget_transactions t WHERE t.budget_line_id = bl.id), 0) AS actual,
      (SELECT COUNT(*) FROM budget_transactions t WHERE t.budget_line_id = bl.id) AS tx_count
      FROM budget_lines bl WHERE bl.budget_id = ?
      ORDER BY bl.category IS NULL, bl.category, bl.sort_order, bl.id`).all(budgetId);
  },
  // A single line with the same rollups (for the drill-down page).
  lineFull(lineId) {
    return db.prepare(`SELECT bl.*, b.fiscal_year, b.status AS budget_status,
      COALESCE((SELECT SUM(m.fiscal_impact) FROM matters m WHERE m.budget_line_id = bl.id), 0) AS committed,
      COALESCE((SELECT SUM(a.amount) FROM budget_amendments a WHERE a.budget_line_id = bl.id), 0) AS amended,
      COALESCE((SELECT SUM(t.amount) FROM budget_transactions t WHERE t.budget_line_id = bl.id), 0) AS actual
      FROM budget_lines bl JOIN budgets b ON b.id = bl.budget_id WHERE bl.id = ?`).get(lineId);
  },
  // --- Amendments (adopted amounts are immutable history) --------------------
  addAmendment(a) {
    return db.prepare(`INSERT INTO budget_amendments (budget_line_id, matter_id, amount, note, author_id)
      VALUES (?,?,?,?,?)`).run(a.budget_line_id, a.matter_id || null, Number(a.amount) || 0,
      a.note || null, a.author_id || null).lastInsertRowid;
  },
  amendments(lineId) {
    return db.prepare(`SELECT a.*, m.file_number, m.title AS matter_title
      FROM budget_amendments a LEFT JOIN matters m ON m.id = a.matter_id
      WHERE a.budget_line_id = ? ORDER BY a.created_at DESC, a.id DESC`).all(lineId);
  },
  amendmentsForBudget(budgetId) {
    return db.prepare(`SELECT a.*, bl.name AS line_name, bl.category AS line_category,
      m.file_number, m.title AS matter_title
      FROM budget_amendments a
      JOIN budget_lines bl ON bl.id = a.budget_line_id
      LEFT JOIN matters m ON m.id = a.matter_id
      WHERE bl.budget_id = ? ORDER BY a.created_at DESC, a.id DESC`).all(budgetId);
  },
  // --- Actuals ledger ---------------------------------------------------------
  addTransaction(t) {
    return db.prepare(`INSERT INTO budget_transactions (budget_line_id, tx_date, description, amount)
      VALUES (?,?,?,?)`).run(t.budget_line_id, t.tx_date, t.description || null,
      Number(t.amount) || 0).lastInsertRowid;
  },
  transactions(lineId) {
    return db.prepare(`SELECT * FROM budget_transactions WHERE budget_line_id = ?
      ORDER BY tx_date DESC, id DESC`).all(lineId);
  },
  getTransaction(id) {
    return db.prepare(`SELECT t.*, bl.budget_id FROM budget_transactions t
      JOIN budget_lines bl ON bl.id = t.budget_line_id WHERE t.id = ?`).get(id);
  },
  removeTransaction(id) {
    db.prepare('DELETE FROM budget_transactions WHERE id = ?').run(id);
  },
  // --- Reporting ---------------------------------------------------------------
  // Actual spend/receipts per month (expense lines only for the spend trend).
  monthlyActuals(budgetId) {
    return db.prepare(`SELECT substr(t.tx_date, 1, 7) AS month,
      SUM(CASE WHEN bl.kind != 'Revenue' THEN t.amount ELSE 0 END) AS spent,
      SUM(CASE WHEN bl.kind = 'Revenue' THEN t.amount ELSE 0 END) AS received
      FROM budget_transactions t JOIN budget_lines bl ON bl.id = t.budget_line_id
      WHERE bl.budget_id = ? GROUP BY month ORDER BY month`).all(budgetId);
  },
  // Match two budgets' lines by category+name for year-over-year comparison.
  compareYears(aId, bId) {
    const key = (l) => `${(l.category || '').toLowerCase()}|${l.name.toLowerCase()}`;
    const a = new Map(budget.lines(aId).map((l) => [key(l), l]));
    const b = new Map(budget.lines(bId).map((l) => [key(l), l]));
    const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
    return keys.map((k) => {
      const la = a.get(k) || null;
      const lb = b.get(k) || null;
      const ref = la || lb;
      return { category: ref.category, name: ref.name, kind: ref.kind, a: la, b: lb };
    });
  },
  getLine(id) {
    return db.prepare(`SELECT bl.*, b.fiscal_year FROM budget_lines bl
      JOIN budgets b ON b.id = bl.budget_id WHERE bl.id = ?`).get(id);
  },
  addLine(l) {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM budget_lines WHERE budget_id = ?')
      .get(l.budget_id).m;
    return db.prepare(`INSERT INTO budget_lines
      (budget_id, category, name, kind, amount, notes, sort_order, appropriation_code, project_code)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(l.budget_id, l.category || null, l.name, l.kind || 'Expense',
      Number(l.amount) || 0, l.notes || null, l.sort_order || (max + 1),
      l.appropriation_code || null, l.project_code || null).lastInsertRowid;
  },
  updateLine(id, l) {
    db.prepare(`UPDATE budget_lines SET category=?, name=?, kind=?, amount=?, notes=?, appropriation_code=?, project_code=?
      WHERE id=?`).run(l.category || null, l.name, l.kind || 'Expense', Number(l.amount) || 0,
      l.notes || null, l.appropriation_code || null, l.project_code || null, id);
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
    const s = {
      expBudgeted: 0, expCommitted: 0, revBudgeted: 0, revCommitted: 0,
      expAmended: 0, revAmended: 0, expActual: 0, revActual: 0,
      lineCount: lines.length, hasRevenue: false,
    };
    for (const l of lines) {
      if (l.kind === 'Revenue') {
        s.revBudgeted += l.amount; s.revCommitted += l.committed;
        s.revAmended += l.amended; s.revActual += l.actual; s.hasRevenue = true;
      } else {
        s.expBudgeted += l.amount; s.expCommitted += l.committed;
        s.expAmended += l.amended; s.expActual += l.actual;
      }
    }
    s.expCurrent = s.expBudgeted + s.expAmended;
    s.revCurrent = s.revBudgeted + s.revAmended;
    s.expRemaining = s.expCurrent - s.expActual;
    s.revRemaining = s.revCurrent - s.revActual;
    return s;
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
      SELECT w.*, u.name AS acted_by_name, a.name AS assignee_name
      FROM workflow_steps w
      LEFT JOIN users u ON u.id = w.acted_by
      LEFT JOIN users a ON a.id = w.assignee_id
      WHERE w.matter_id = ? ORDER BY w.seq`).all(matterId);
  },
  get(stepId) {
    return db.prepare(`
      SELECT w.*, a.name AS assignee_name
      FROM workflow_steps w LEFT JOIN users a ON a.id = w.assignee_id
      WHERE w.id = ?`).get(stepId);
  },
  // Create the default route if this matter has none, routing each step to the
  // chosen user (assigneeIds is parallel to the template; null = any clerk).
  // Returns the step count.
  start(matterId, assigneeIds = []) {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM workflow_steps WHERE matter_id = ?').get(matterId).n;
    if (existing > 0) return existing;
    const ins = db.prepare(`INSERT INTO workflow_steps (matter_id, seq, name, role, status, assignee_id)
      VALUES (?,?,?,?,?,?)`);
    const template = workflowTemplate();
    template.forEach((s, i) => ins.run(matterId, i + 1, s.name, s.role, 'Pending', assigneeIds[i] || null));
    return template.length;
  },
  // Approvals inbox: the active (first Pending/Returned) step of each routed
  // matter that is either assigned to this user, or unassigned and the user
  // can act as a clerk.
  inboxFor(userId, actsAsClerk = false) {
    return db.prepare(`
      SELECT w.*, m.file_number, m.title AS matter_title, a.name AS assignee_name
      FROM workflow_steps w
      JOIN matters m ON m.id = w.matter_id
      LEFT JOIN users a ON a.id = w.assignee_id
      WHERE w.status IN ('Pending','Returned')
        AND w.seq = (SELECT MIN(w2.seq) FROM workflow_steps w2
                     WHERE w2.matter_id = w.matter_id AND w2.status IN ('Pending','Returned'))
        AND (w.assignee_id = ? OR (w.assignee_id IS NULL AND ?))
      ORDER BY w.id`).all(userId, actsAsClerk ? 1 : 0);
  },
  inboxCount(userId, actsAsClerk = false) {
    return this.inboxFor(userId, actsAsClerk).length;
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
  setDigest(id, on) {
    db.prepare('UPDATE users SET digest = ? WHERE id = ?').run(on ? 1 : 0, id);
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
  const tables = ['bids', 'solicitation_questions', 'solicitations', 'vendors',
    'office_staff', 'budget_lines', 'budgets', 'policies', 'member_motions', 'votes',
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

// ---------------------------------------------------------------------------
// Public comments on legislative files (eComment) — clerk-moderated.
// ---------------------------------------------------------------------------
const COMMENT_POSITIONS = ['Support', 'Oppose', 'Neutral'];

const comments = {
  add(c) {
    return db.prepare(`INSERT INTO public_comments (matter_id, name, email, position, body)
      VALUES (?,?,?,?,?)`).run(
      c.matter_id, c.name, c.email || null,
      COMMENT_POSITIONS.includes(c.position) ? c.position : null,
      c.body).lastInsertRowid;
  },
  get(id) {
    return db.prepare('SELECT * FROM public_comments WHERE id = ?').get(id);
  },
  approvedForMatter(matterId) {
    return db.prepare(`SELECT * FROM public_comments
      WHERE matter_id = ? AND status = 'Approved'
      ORDER BY created_at DESC`).all(matterId);
  },
  pending() {
    return db.prepare(`SELECT c.*, m.file_number, m.title AS matter_title
      FROM public_comments c JOIN matters m ON m.id = c.matter_id
      WHERE c.status = 'Pending' ORDER BY c.created_at`).all();
  },
  recentDecided(limit = 25) {
    return db.prepare(`SELECT c.*, m.file_number, m.title AS matter_title
      FROM public_comments c JOIN matters m ON m.id = c.matter_id
      WHERE c.status != 'Pending' ORDER BY c.created_at DESC LIMIT ?`).all(limit);
  },
  pendingCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM public_comments WHERE status = 'Pending'").get().n;
  },
  setStatus(id, status) {
    if (!['Approved', 'Rejected', 'Pending'].includes(status)) return;
    db.prepare('UPDATE public_comments SET status = ? WHERE id = ?').run(status, id);
  },
  // Position tally over approved comments (shown with the public list).
  tally(matterId) {
    const out = { Support: 0, Oppose: 0, Neutral: 0 };
    for (const r of db.prepare(`SELECT position, COUNT(*) AS n FROM public_comments
      WHERE matter_id = ? AND status = 'Approved' GROUP BY position`).all(matterId)) {
      if (out[r.position] != null) out[r.position] = r.n;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Procurement: vendors, solicitations (RFP/RFQ/IFB/bid), Q&A, bids
// ---------------------------------------------------------------------------
const SOLICITATION_KINDS = ['RFP', 'RFQ', 'IFB', 'Bid'];
const SOLICITATION_STATUSES = ['Draft', 'Open', 'Closed', 'Awarded', 'Cancelled'];

const vendors = {
  register(v) {
    return db.prepare(`INSERT INTO vendors (name, contact_name, email, phone, categories)
      VALUES (?,?,?,?,?)`).run(v.name, v.contact_name || null, v.email || null,
      v.phone || null, v.categories || null).lastInsertRowid;
  },
  all() {
    return db.prepare('SELECT * FROM vendors ORDER BY name').all();
  },
  get(id) { return db.prepare('SELECT * FROM vendors WHERE id = ?').get(id); },
  byName(name) { return db.prepare('SELECT * FROM vendors WHERE lower(name) = lower(?)').get(name); },
  findOrCreate(name) {
    const existing = this.byName(name);
    return existing ? existing.id : this.register({ name });
  },
  setStatus(id, status) {
    if (!['Registered', 'Suspended'].includes(status)) return;
    db.prepare('UPDATE vendors SET status = ? WHERE id = ?').run(status, id);
  },
  count() { return db.prepare('SELECT COUNT(*) AS n FROM vendors').get().n; },
};

const procurement = {
  KINDS: SOLICITATION_KINDS,
  STATUSES: SOLICITATION_STATUSES,
  // Solicitation numbers: SOL-YYMM## (monthly sequence), numeric-safe.
  nextNumber() {
    const now = new Date();
    const prefix = `SOL-${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
    // The suffix begins at position 9: "SOL-" (4) + "YYMM" (4) = an 8-char
    // prefix, so substr must start at 9 or it swallows the final month digit.
    const { m } = db.prepare(
      `SELECT MAX(CAST(substr(number, 9) AS INTEGER)) AS m FROM solicitations WHERE number LIKE ? || '%'`)
      .get(prefix);
    return `${prefix}${String((m || 0) + 1).padStart(2, '0')}`;
  },
  create(s) {
    const number = this.nextNumber();
    const id = db.prepare(`INSERT INTO solicitations (number, kind, title, body_html, status, open_date, close_date, budget_line_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(number,
      SOLICITATION_KINDS.includes(s.kind) ? s.kind : 'RFP', s.title, s.body_html || null,
      SOLICITATION_STATUSES.includes(s.status) ? s.status : 'Draft',
      s.open_date || null, s.close_date || null, s.budget_line_id || null).lastInsertRowid;
    return { id, number };
  },
  update(id, s) {
    db.prepare(`UPDATE solicitations SET kind=?, title=?, body_html=?, status=?, open_date=?, close_date=?, budget_line_id=?
      WHERE id=?`).run(
      SOLICITATION_KINDS.includes(s.kind) ? s.kind : 'RFP', s.title, s.body_html || null,
      SOLICITATION_STATUSES.includes(s.status) ? s.status : 'Draft',
      s.open_date || null, s.close_date || null, s.budget_line_id || null, id);
  },
  get(id) {
    return db.prepare(`SELECT s.*, v.name AS awarded_vendor_name, bl.name AS budget_line_name,
      b.fiscal_year, m.file_number,
      (SELECT COUNT(*) FROM bids bd WHERE bd.solicitation_id = s.id) AS bid_count,
      (SELECT COUNT(*) FROM solicitation_questions q WHERE q.solicitation_id = s.id AND q.answer IS NULL) AS open_questions
      FROM solicitations s
      LEFT JOIN vendors v ON v.id = s.awarded_vendor_id
      LEFT JOIN budget_lines bl ON bl.id = s.budget_line_id
      LEFT JOIN budgets b ON b.id = bl.budget_id
      LEFT JOIN matters m ON m.id = s.matter_id
      WHERE s.id = ?`).get(id);
  },
  // Public listing excludes Draft; admin listing shows everything.
  list({ includeAll = false } = {}) {
    const where = includeAll ? '' : "WHERE s.status != 'Draft'";
    return db.prepare(`SELECT s.*, v.name AS awarded_vendor_name,
      (SELECT COUNT(*) FROM bids bd WHERE bd.solicitation_id = s.id) AS bid_count
      FROM solicitations s LEFT JOIN vendors v ON v.id = s.awarded_vendor_id
      ${where}
      ORDER BY CASE s.status WHEN 'Open' THEN 0 WHEN 'Closed' THEN 1 WHEN 'Awarded' THEN 2 ELSE 3 END,
        s.close_date, s.id DESC`).all();
  },
  setStatus(id, status) {
    if (!SOLICITATION_STATUSES.includes(status)) return;
    db.prepare('UPDATE solicitations SET status = ? WHERE id = ?').run(status, id);
  },
  openCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM solicitations WHERE status = 'Open'").get().n;
  },
  // A solicitation accepts bids only while Open AND within its posted window,
  // so a missed manual status change can't admit an early or late bid. The
  // bid form and the POST handler share this predicate.
  biddable(s) {
    if (!s || s.status !== 'Open') return false;
    const today = new Date().toISOString().slice(0, 10);
    if (s.open_date && s.open_date > today) return false;
    if (s.close_date && s.close_date < today) return false;
    return true;
  },
  award(id, { vendorId, amount, matterId = null }) {
    db.prepare(`UPDATE solicitations SET awarded_vendor_id=?, award_amount=?, matter_id=?, status='Awarded'
      WHERE id=?`).run(vendorId || null, amount == null || amount === '' ? null : Number(amount), matterId, id);
  },
  // --- Q&A ---
  addQuestion(q) {
    return db.prepare(`INSERT INTO solicitation_questions (solicitation_id, name, email, question)
      VALUES (?,?,?,?)`).run(q.solicitation_id, q.name, q.email || null, q.question).lastInsertRowid;
  },
  questions(solicitationId) {
    return db.prepare(`SELECT * FROM solicitation_questions WHERE solicitation_id = ?
      ORDER BY created_at`).all(solicitationId);
  },
  getQuestion(id) { return db.prepare('SELECT * FROM solicitation_questions WHERE id = ?').get(id); },
  answerQuestion(id, answer) {
    db.prepare('UPDATE solicitation_questions SET answer = ? WHERE id = ?').run(answer || null, id);
  },
  // --- Bids ---
  addBid(b) {
    return db.prepare(`INSERT INTO bids (solicitation_id, vendor_name, email, amount, note)
      VALUES (?,?,?,?,?)`).run(b.solicitation_id, b.vendor_name, b.email || null,
      b.amount == null || b.amount === '' ? null : Number(b.amount), b.note || null).lastInsertRowid;
  },
  bids(solicitationId) {
    return db.prepare(`SELECT * FROM bids WHERE solicitation_id = ? ORDER BY amount IS NULL, amount, id`)
      .all(solicitationId);
  },
};

// ---------------------------------------------------------------------------
// Audit log (state-changing requests by signed-in users)
// ---------------------------------------------------------------------------
const audit = {
  record({ userId, userName, method, path, ip }) {
    db.prepare(`INSERT INTO audit_log (user_id, user_name, method, path, ip)
      VALUES (?,?,?,?,?)`).run(userId || null, userName || null, method, path, ip || null);
    // Cheap opportunistic prune so the table stays bounded.
    if ((this._n = (this._n || 0) + 1) % 200 === 0) {
      db.exec(`DELETE FROM audit_log WHERE id < (
        SELECT MIN(id) FROM (SELECT id FROM audit_log ORDER BY id DESC LIMIT 20000))`);
    }
  },
  recent(limit = 200) {
    return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  },
};

// ---------------------------------------------------------------------------
// Applications to serve on a board/commission
// ---------------------------------------------------------------------------
const applications = {
  add(a) {
    return db.prepare(`INSERT INTO board_applications (body_id, name, email, phone, statement)
      VALUES (?,?,?,?,?)`).run(a.body_id, a.name, a.email || null, a.phone || null,
      a.statement || null).lastInsertRowid;
  },
  get(id) {
    return db.prepare(`SELECT a.*, b.name AS body_name FROM board_applications a
      JOIN bodies b ON b.id = a.body_id WHERE a.id = ?`).get(id);
  },
  pending() {
    return db.prepare(`SELECT a.*, b.name AS body_name FROM board_applications a
      JOIN bodies b ON b.id = a.body_id WHERE a.status = 'Pending' ORDER BY a.created_at`).all();
  },
  recentDecided(limit = 25) {
    return db.prepare(`SELECT a.*, b.name AS body_name FROM board_applications a
      JOIN bodies b ON b.id = a.body_id WHERE a.status != 'Pending'
      ORDER BY a.created_at DESC LIMIT ?`).all(limit);
  },
  pendingCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM board_applications WHERE status = 'Pending'").get().n;
  },
  decide(id, { status, motionId = null }) {
    if (!['Nominated', 'Declined', 'Pending'].includes(status)) return;
    db.prepare('UPDATE board_applications SET status = ?, motion_id = ? WHERE id = ?')
      .run(status, motionId, id);
  },
};

// ---------------------------------------------------------------------------
// Request to speak (public sign-ups for upcoming meetings)
// ---------------------------------------------------------------------------
const speakers = {
  add(s) {
    return db.prepare(`INSERT INTO speaker_requests (meeting_id, agenda_item_id, name, email, position)
      VALUES (?,?,?,?,?)`).run(
      s.meeting_id, s.agenda_item_id || null, s.name, s.email || null,
      COMMENT_POSITIONS.includes(s.position) ? s.position : null).lastInsertRowid;
  },
  get(id) {
    return db.prepare('SELECT * FROM speaker_requests WHERE id = ?').get(id);
  },
  forMeeting(meetingId) {
    return db.prepare(`
      SELECT s.*, ai.agenda_number, COALESCE(m.title, ai.title) AS item_title
      FROM speaker_requests s
      LEFT JOIN agenda_items ai ON ai.id = s.agenda_item_id
      LEFT JOIN matters m ON m.id = ai.matter_id
      WHERE s.meeting_id = ?
      ORDER BY CASE s.status WHEN 'Pending' THEN 0 WHEN 'Approved' THEN 1 ELSE 2 END, s.created_at`)
      .all(meetingId);
  },
  setStatus(id, status) {
    if (!['Pending', 'Approved', 'Rejected', 'Spoke'].includes(status)) return;
    db.prepare('UPDATE speaker_requests SET status = ? WHERE id = ?').run(status, id);
  },
};

// ---------------------------------------------------------------------------
// Citizen proposals (Decidim-style) with endorsements
// ---------------------------------------------------------------------------
const PROPOSAL_THRESHOLD_DEFAULT = 10;

const proposals = {
  threshold() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'proposals.threshold'").get();
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : PROPOSAL_THRESHOLD_DEFAULT;
  },
  add(p) {
    return db.prepare('INSERT INTO proposals (title, body, name, email) VALUES (?,?,?,?)')
      .run(p.title, p.body, p.name, p.email || null).lastInsertRowid;
  },
  get(id) {
    return db.prepare(`SELECT p.*, m.file_number,
      (SELECT COUNT(*) FROM proposal_endorsements e WHERE e.proposal_id = p.id) AS endorsements
      FROM proposals p LEFT JOIN matters m ON m.id = p.matter_id WHERE p.id = ?`).get(id);
  },
  list(status = null) {
    const where = status ? 'WHERE p.status = ?' : '';
    return db.prepare(`SELECT p.*, m.file_number,
      (SELECT COUNT(*) FROM proposal_endorsements e WHERE e.proposal_id = p.id) AS endorsements
      FROM proposals p LEFT JOIN matters m ON m.id = p.matter_id ${where}
      ORDER BY endorsements DESC, p.id DESC`).all(...(status ? [status] : []));
  },
  endorse(proposalId, name, email) {
    try {
      db.prepare('INSERT INTO proposal_endorsements (proposal_id, name, email) VALUES (?,?,?)')
        .run(proposalId, name, email.toLowerCase());
      return true;
    } catch (_) { return false; } // duplicate email for this proposal
  },
  decide(id, { status, matterId = null }) {
    if (!['Accepted', 'Declined', 'Open'].includes(status)) return;
    db.prepare('UPDATE proposals SET status = ?, matter_id = ? WHERE id = ?')
      .run(status, matterId, id);
  },
  openCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'Open'").get().n;
  },
};

// ---------------------------------------------------------------------------
// Accountability: implementation progress on enacted legislation
// ---------------------------------------------------------------------------
const implementation = {
  add(matterId, progress, note) {
    const p = Math.max(0, Math.min(100, Number(progress) || 0));
    return db.prepare('INSERT INTO implementation_updates (matter_id, progress, note) VALUES (?,?,?)')
      .run(matterId, p, note || null).lastInsertRowid;
  },
  forMatter(matterId) {
    return db.prepare(`SELECT * FROM implementation_updates WHERE matter_id = ?
      ORDER BY created_at DESC, id DESC`).all(matterId);
  },
  // Enacted/passed matters with their latest progress, for the public page.
  overview() {
    return db.prepare(`
      SELECT m.id, m.file_number, m.title, m.status, m.final_date,
        (SELECT i.progress FROM implementation_updates i WHERE i.matter_id = m.id
         ORDER BY i.id DESC LIMIT 1) AS progress,
        (SELECT i.note FROM implementation_updates i WHERE i.matter_id = m.id
         ORDER BY i.id DESC LIMIT 1) AS last_note,
        (SELECT i.created_at FROM implementation_updates i WHERE i.matter_id = m.id
         ORDER BY i.id DESC LIMIT 1) AS last_update
      FROM matters m
      WHERE m.status IN ('Enacted', 'Passed')
      ORDER BY m.final_date DESC, m.id DESC`).all();
  },
};

// ---------------------------------------------------------------------------
// Saved legislation searches (alert when new files match)
// ---------------------------------------------------------------------------
const savedSearches = {
  add(userId, name, filters) {
    const maxId = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM matters').get().m;
    return db.prepare(`INSERT INTO saved_searches (user_id, name, query_json, last_matter_id)
      VALUES (?,?,?,?)`).run(userId, name, JSON.stringify(filters || {}), maxId).lastInsertRowid;
  },
  forUser(userId) {
    return db.prepare('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY id DESC').all(userId);
  },
  get(id) {
    return db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(id);
  },
  remove(id, userId) {
    db.prepare('DELETE FROM saved_searches WHERE id = ? AND user_id = ?').run(id, userId);
  },
  all() {
    return db.prepare(`SELECT s.*, u.email, u.active FROM saved_searches s
      JOIN users u ON u.id = s.user_id WHERE u.active = 1 AND u.email IS NOT NULL`).all();
  },
  // New matters (created after the saved high-water mark) matching the query.
  newMatches(saved) {
    let filters = {};
    try { filters = JSON.parse(saved.query_json); } catch (_) { /* legacy/corrupt */ }
    const results = matters.search({ ...filters, limit: 100 });
    return results.filter((m) => m.id > saved.last_matter_id);
  },
  bump(id, lastMatterId) {
    db.prepare('UPDATE saved_searches SET last_matter_id = ? WHERE id = ?').run(lastMatterId, id);
  },
};

// ---------------------------------------------------------------------------
// Watch lists (follow a legislative file)
// ---------------------------------------------------------------------------
const watches = {
  isWatching(userId, matterId) {
    return !!db.prepare('SELECT 1 FROM watches WHERE user_id = ? AND matter_id = ?').get(userId, matterId);
  },
  toggle(userId, matterId) {
    if (this.isWatching(userId, matterId)) {
      db.prepare('DELETE FROM watches WHERE user_id = ? AND matter_id = ?').run(userId, matterId);
      return false;
    }
    db.prepare('INSERT INTO watches (user_id, matter_id) VALUES (?,?)').run(userId, matterId);
    return true;
  },
  // Watched files with their most recent recorded action.
  forUser(userId) {
    return db.prepare(`
      SELECT m.*, b.name AS body_name, w.created_at AS watched_at,
        (SELECT h.action FROM matter_history h WHERE h.matter_id = m.id
         ORDER BY h.action_date DESC, h.id DESC LIMIT 1) AS last_action,
        (SELECT h.action_date FROM matter_history h WHERE h.matter_id = m.id
         ORDER BY h.action_date DESC, h.id DESC LIMIT 1) AS last_action_date
      FROM watches w
      JOIN matters m ON m.id = w.matter_id
      LEFT JOIN bodies b ON b.id = m.body_id
      WHERE w.user_id = ?
      ORDER BY m.updated_at DESC`).all(userId);
  },
};

module.exports = {
  MATTER_TYPES, MATTER_STATUSES, VOTE_VALUES, ITEM_TYPES, AGENDA_SECTIONS, TERMINAL_STATUSES, SORT_COLUMNS,
  ORG_LEVELS, MEMBER_MOTION_STATUSES, POLICY_STATUSES, USER_ROLES,
  BUDGET_STATUSES, BUDGET_KINDS, COMMENT_POSITIONS, workflowTemplate,
  people, bodies, matters, meetings, votes, reports, topics, workflow, org, memberMotions,
  policies, users, budget, comments, watches, speakers, applications, audit, savedSearches,
  proposals, implementation, vendors, procurement,
  RELATION_TYPES, SOLICITATION_KINDS, SOLICITATION_STATUSES, stats, statusBuckets, purgeDomainData,
};
