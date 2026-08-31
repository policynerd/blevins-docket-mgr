'use strict';

const { db, ftsEnabled } = require('./db');
const ledger = require('./ledger');
const { todayISO } = require('./util');
const { ORG } = require('./org');

// ---------------------------------------------------------------------------
// Reference data used across the app (mirrors Legistar-style vocabularies)
// ---------------------------------------------------------------------------
// What the board is being asked to do with an item: act on it, or note it.
// That is the distinction an agenda actually turns on — whether the item needs
// a vote — and it is the one already used for agenda items in ITEM_TYPES.
const MATTER_TYPES = ['Action', 'Information'];

// The instrument-shaped list the docket used before. Kept valid, because 169
// files already carry these values: a stored type absent from the list would
// disappear from the type filter, fail import validation, and be silently
// rewritten the first time anyone saved the file. New files get the two above;
// old files keep what they were filed as until somebody decides otherwise.
const LEGACY_MATTER_TYPES = [
  'Ordinance', 'Resolution', 'Motion', 'Appointment',
  'Public Hearing', 'Proclamation', 'Contract', 'Report', 'Communication',
];
const ALL_MATTER_TYPES = MATTER_TYPES.concat(LEGACY_MATTER_TYPES);

const MATTER_STATUSES = [
  'Draft', 'Introduced', 'In Committee', 'On Agenda',
  'Passed', 'Failed', 'Enacted', 'Vetoed', 'Tabled', 'Withdrawn',
];

// The ballot, taken from the ledger rather than restated here.
//
// These two lists used to disagree, and the disagreement reached the room: the
// chamber offered an "Absent" button, this list accepted it, and the ledger —
// which is the authority — threw `Not a vote: Absent` and the member got a 500
// instead of a vote. Absence is not a choice anyone makes at the rail; it is
// what is left over once everyone who did vote has, and the board already
// derives it that way (seated minus present). "Present" is the choice that was
// missing: a member declining the merits while still being counted.
//
// Sourced from the ledger so the two cannot drift apart again. Anything this
// list admits, the ledger must be willing to seal.
const VOTE_VALUES = ledger.CHOICES;
const ITEM_TYPES = ['Action', 'Discussion', 'Information'];

// A file's type already names where it belongs on an agenda. Only the types
// with a corresponding section are mapped; anything else falls through to the
// caller's choice.
function sectionForType(type) {
  return { Ordinance: 'Ordinances', Resolution: 'Resolutions' }[type] || null;
}

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
  /**
   * The people entitled to vote on this body, as of a date.
   *
   * The one definition of the roll. Everything that counts a vote, sets a
   * quorum or admits a ballot comes through here, so the tally and the guard
   * on the cast routes cannot disagree about who is on the body.
   *
   * Two columns the roll used to ignore, both of which change outcomes:
   *
   * `voting = 0` — ex-officio and similar. Excluded from the roll entirely, so
   * they count toward neither the threshold nor the quorum. They attend and
   * speak; they are not part of the body's arithmetic.
   *
   * `end_date` in the past — a term that has run out. Not simply dropped: a
   * member holds over until a successor is seated, which is how the Board's
   * seats actually work. A holdover is displaced only when someone has taken
   * the seat.
   *
   * "Taken the seat" is approximated by count, because `body_members` records
   * no seat identity — there is no column saying which of the seven seats a
   * member occupies. Current members fill the authorized seats first; any
   * seats still free are held by the most recently expired members. So a body
   * whose current members already fill it has no holdovers, and one that is
   * short keeps them until it is not. Where `seats` is unknown every holdover
   * stays, because nothing here can then say a successor exists.
   *
   * The exact rule — this seat, that successor — needs seat identity in the
   * schema. This is the closest the present data supports, and it is right
   * wherever seats are filled in order.
   */
  votingRoll(bodyId, asOf = null) {
    const today = asOf || require('./util').todayISO();
    const rows = db.prepare(`
      SELECT p.id, p.full_name, p.district, bm.end_date, bm.start_date, bm.voting
      FROM body_members bm JOIN people p ON p.id = bm.person_id
      WHERE bm.body_id = ?
      ORDER BY p.full_name`).all(bodyId);

    // Occupancy and eligibility are different questions, and answering them in
    // the wrong order gets holdovers wrong. An ex-officio member holds a seat
    // whether or not they vote, so a successor arriving into the last free
    // seat displaces the holdover even though neither of them is countable —
    // filtering the non-voting out first hid that seat and kept the holdover
    // on the roll after they had been replaced.
    const begun = rows.filter((r) => !r.start_date || r.start_date <= today);
    const occupying = begun.filter((r) => !r.end_date || r.end_date >= today);
    const holdovers = begun.filter((r) => r.end_date && r.end_date < today)
      // Most recently expired first: the longest-standing vacancy is the one
      // most likely to have been filled.
      .sort((a, b) => String(b.end_date).localeCompare(String(a.end_date)));

    const body = db.prepare('SELECT seats FROM bodies WHERE id = ?').get(bodyId);
    // Where the seat count is unknown, nothing here can say a successor
    // exists, so every holdover keeps their seat.
    const kept = (!body || body.seats == null)
      ? holdovers
      : holdovers.slice(0, Math.max(0, Number(body.seats) - occupying.length));

    return occupying.concat(kept)
      .filter((r) => r.voting === 1)
      .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
  },

  /**
   * The roster, reconciled against the roll.
   *
   * The membership screen listed `members()` — every row in body_members — and
   * the quorum denominator came from `votingRoll()`, which is a different
   * list. Nothing on the screen said which was which, so a body could show
   * eight members and take a quorum of four from five, and both numbers were
   * right about different questions.
   *
   * It also catches the contradiction that put a former governor in a live
   * quorum: `people.title` is prose a clerk types, and it can say "Former
   * Member" while the seat record it is meant to describe has no end date.
   * The seat record governs — a title is not a resignation — so this does not
   * quietly pick a side. It reports that the two disagree, which is the only
   * honest answer and the only one a clerk can act on.
   */
  seatStatus(bodyId, asOf = null) {
    const today = asOf || require('./util').todayISO();
    const onRoll = new Set(this.votingRoll(bodyId, today).map((r) => r.id));
    return this.members(bodyId).map((m) => {
      let reason = null;
      if (!onRoll.has(m.person_id)) {
        if (m.start_date && m.start_date > today) reason = 'term has not begun';
        else if (m.voting !== 1) reason = 'holds the seat without a vote';
        else if (m.end_date && m.end_date < today) reason = 'term expired, seat filled';
        else reason = 'not on the roll';
      }
      // Prose against the record. Only the plainly retrospective words: a
      // title is free text and guessing harder than this would flag titles
      // that are simply descriptive.
      const contradiction = (onRoll.has(m.person_id)
        && /\b(former|past|outgoing|retired|ex[- ]member)\b/i.test(String(m.title || '')))
        ? `recorded as “${m.title}” but holds an open seat and counts toward quorum`
        : null;
      return Object.assign({}, m, { onRoll: onRoll.has(m.person_id), reason, contradiction });
    });
  },

  /**
   * May a ballot be recorded for this person on this body?
   *
   * The question both cast routes have to answer before writing one. A vote
   * from off the roll is counted by nothing and shown in no roster — while
   * still sealing an entry into the ledger, which is the authoritative
   * account. Asked against the same roll the tally uses, so a ballot is
   * refused exactly when it would not have counted.
   */
  isSeated(bodyId, personId) {
    const id = Number(personId);
    if (!Number.isInteger(id) || id <= 0) return false;
    return this.votingRoll(bodyId).some((r) => r.id === id);
  },
  upcomingMeetings(bodyId, limit = 10) {
    return db.prepare(`SELECT * FROM meetings WHERE body_id = ?
      ORDER BY meeting_date DESC LIMIT ?`).all(bodyId, limit);
  },
  insert(b) {
    return db.prepare(`INSERT INTO bodies
      (name, type, description, meeting_location, meets, active, seats, accent_color)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      b.name, b.type ?? null, b.description ?? null, b.meeting_location ?? null,
      b.meets ?? null, b.active == null ? 1 : b.active, b.seats ?? null,
      b.accent_color ?? null).lastInsertRowid;
  },
  addMember(bodyId, personId, role = 'Member', voting = 1, term = {}) {
    return db.prepare(`INSERT INTO body_members (body_id, person_id, role, voting, start_date, end_date)
      VALUES (?,?,?,?,?,?)`).run(bodyId, personId, role, voting ? 1 : 0,
      term.start_date ?? null, term.end_date ?? null).lastInsertRowid;
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
    db.prepare(`UPDATE bodies SET name=?, type=?, description=?, meeting_location=?, meets=?, active=?, seats=?,
      accent_color=? WHERE id=?`).run(
      b.name, b.type ?? null, b.description ?? null, b.meeting_location ?? null,
      b.meets ?? null, b.active == null ? 1 : b.active, b.seats ?? null,
      b.accent_color ?? null, id);
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
  _filter({ q, type, status, bodyId, sponsorId, topicId, from, to, publicOnly } = {}) {
    const clauses = [];
    const args = [];
    // The one place the public/insider split has to be enforced for lists.
    // Search, count, the CSV, the RSS feeds and the JSON API all build on this
    // clause, so filtering here means none of them can forget to.
    if (publicOnly) clauses.push('m.published_at IS NOT NULL');
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
      SELECT h.*, b.name AS body_name, u.name AS voided_by_name
      FROM matter_history h
      LEFT JOIN bodies b ON b.id = h.body_id
      LEFT JOIN users u ON u.id = h.voided_by
      WHERE h.matter_id = ?
      ORDER BY h.action_date DESC, h.id DESC`).all(matterId);
  },
  /**
   * Entries a given agenda item wrote and that still stand.
   *
   * Used to find what a vote recorded so reopening it can retract exactly that
   * and nothing else. Voided rows are excluded so reopening twice cannot
   * retract the same entry again.
   */
  liveHistoryForItem(agendaItemId) {
    return db.prepare(`SELECT * FROM matter_history
      WHERE agenda_item_id = ? AND voided_at IS NULL
      ORDER BY id`).all(agendaItemId);
  },
  /**
   * Strike an entry from the record without removing it.
   *
   * Deleting would make the history agree with the present at the cost of no
   * longer describing the past. A board that took a vote, then voided it,
   * did both things, and an auditor asking "was this ever carried?" has to be
   * able to see the answer.
   */
  voidHistory(id, { reason, userId = null } = {}) {
    db.prepare(`UPDATE matter_history
      SET voided_at = datetime('now'), void_reason = ?, voided_by = ?
      WHERE id = ? AND voided_at IS NULL`).run(reason || null, userId, id);
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
  // Publication, as an act with a time on it.
  //
  // Deliberately not folded into `setStatus`. A file's status is where it is in
  // the Board's process; publication is who may read it. Tying them would mean
  // that advancing a file to Introduced silently put it on the internet, which
  // is the failure this whole change exists to undo.
  publish(id) {
    db.prepare(`UPDATE matters SET published_at=datetime('now'), updated_at=datetime('now')
      WHERE id=? AND published_at IS NULL`).run(id);
  },
  unpublish(id) {
    db.prepare(`UPDATE matters SET published_at=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(id);
  },
  addSponsor(matterId, personId, type = 'Sponsor') {
    return db.prepare(`INSERT INTO matter_sponsors (matter_id, person_id, sponsor_type)
      VALUES (?,?,?)`).run(matterId, personId, type).lastInsertRowid;
  },
  clearSponsors(matterId) {
    db.prepare('DELETE FROM matter_sponsors WHERE matter_id = ?').run(matterId);
  },
  /**
   * The status an action implies, so the clerk does not have to say it twice.
   *
   * Recording one event used to take three fields: the action, its result, and
   * then, separately, the new status. That is not merely extra typing — the
   * status field was optional, so a clerk who recorded "Adopted / Pass" and
   * tabbed past it left a file whose history said it had carried and whose
   * status still said Introduced. The record disagreed with itself, and
   * nothing anywhere would say so.
   *
   * An action and a result already determine the status in every ordinary
   * case, so this derives it. It is a suggestion, not a seizure: the form
   * pre-selects what this returns and the clerk can override it, because the
   * unusual case is exactly the one a rule like this gets wrong.
   *
   * @returns {string|null} a status from MATTER_STATUSES, or null if the
   *   action does not imply one and the current status should stand.
   */
  /**
   * Can this file go before the board yet, and if not, why.
   *
   * The answer was computed in the drafting view and nowhere else, so the
   * drafting screen refused a file while the agenda's "ready queue" offered
   * the same file with a checkbox — the queue filtered on status and on not
   * being booked already, and on nothing about whether the thing was written.
   * One definition, so the two screens cannot disagree.
   *
   * Returns { ready, reasons: [{ code, label }] } rather than a sentence: the
   * drafting page wants a paragraph, the queue wants a short flag on a table
   * row, and the caller should decide how to say it.
   */
  readiness(matterOrId) {
    const m = typeof matterOrId === 'object' ? matterOrId : matters.get(matterOrId);
    if (!m) return { ready: false, reasons: [{ code: 'missing', label: 'No such file' }] };
    const reasons = [];
    if (!String(m.full_text || '').trim() && !String(m.body_html || '').trim()) {
      reasons.push({ code: 'no_text', label: 'no text yet' });
    }
    const missing = letters.missing(m.id);
    if (missing.length) {
      reasons.push({
        code: 'letter',
        label: `${missing.length} required board-letter section${missing.length === 1 ? '' : 's'} blank`,
        detail: missing,
      });
    }
    return { ready: reasons.length === 0, reasons };
  },

  statusFromAction(action, result, currentStatus = null) {
    const a = String(action || '').toLowerCase();
    const r = String(result || '').toLowerCase();

    // A recorded failure is a failure whatever the verb was.
    if (r === 'fail') {
      if (/veto/.test(a)) return 'Vetoed';
      return 'Failed';
    }
    // Disposals that are neither pass nor fail, checked before the pass rules
    // because "motion to table" carries a result of Pass when the tabling
    // succeeds — and a tabled measure is Tabled, not Passed.
    if (/withdraw/.test(a)) return 'Withdrawn';
    if (/\btabl/.test(a)) return 'Tabled';
    if (/refer|committed to|sent to committee/.test(a)) return 'In Committee';
    if (/veto/.test(a)) return 'Vetoed';
    if (/enact|sign(ed)? into|chaptered/.test(a)) return 'Enacted';
    if (/introduc|first reading|filed/.test(a)) return 'Introduced';
    if (/placed on|set for|agenda/.test(a)) return 'On Agenda';
    if (/adopt|pass|approv|carri/.test(a)) return 'Passed';
    // A bare Pass on an action with no verb we recognise still means it
    // carried; a bare result with no action at all implies nothing.
    if (r === 'pass' && a) return 'Passed';
    void currentStatus;
    return null;
  },

  addHistory(h) {
    const id = db.prepare(`INSERT INTO matter_history
      (matter_id, action_date, body_id, action, result, notes, meeting_id, agenda_item_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      h.matter_id, h.action_date, h.body_id || null, h.action,
      h.result || null, h.notes || null, h.meeting_id || null,
      h.agenda_item_id || null).lastInsertRowid;
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
  all({ publicOnly = false } = {}) {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name, b.type AS body_type,
        (SELECT COUNT(*) FROM agenda_items ai WHERE ai.meeting_id = mt.id) AS item_count
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      ${publicOnly ? 'WHERE mt.agenda_published_at IS NOT NULL' : ''}
      ORDER BY mt.meeting_date DESC, mt.meeting_time DESC`).all();
  },
  upcoming(fromDate, limit = 25, { publicOnly = false } = {}) {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      WHERE mt.meeting_date >= ? AND mt.status != 'Cancelled'
      ${publicOnly ? 'AND mt.agenda_published_at IS NOT NULL' : ''}
      ORDER BY mt.meeting_date ASC LIMIT ?`).all(fromDate, limit);
  },
  past(fromDate, limit = 25) {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      WHERE mt.meeting_date < ?
      ORDER BY mt.meeting_date DESC LIMIT ?`).all(fromDate, limit);
  },
  /**
   * Meetings with the state of the work on each, for the meetings index.
   *
   * The calendar answers "when"; this answers "what still needs doing". Those
   * are different questions and the app only had the first one, which is why
   * running a meeting meant remembering which of five screens you had reached
   * for each of them.
   */
  board(today, { limit = 60 } = {}) {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name, b.type AS body_type,
        (SELECT COUNT(*) FROM agenda_items ai WHERE ai.meeting_id = mt.id) AS item_count,
        (SELECT COUNT(*) FROM agenda_items ai
           WHERE ai.meeting_id = mt.id AND ai.in_packet = 1) AS packet_count,
        (SELECT COUNT(*) FROM agenda_items ai
           WHERE ai.meeting_id = mt.id AND ai.result IS NOT NULL) AS decided_count,
        (SELECT COUNT(*) FROM agenda_items ai
           WHERE ai.meeting_id = mt.id AND ai.vote_status = 'open') AS open_rolls
      FROM meetings mt JOIN bodies b ON b.id = mt.body_id
      ORDER BY (mt.meeting_date < ?) ASC,
               CASE WHEN mt.meeting_date >= ? THEN mt.meeting_date END ASC,
               mt.meeting_date DESC
      LIMIT ?`).all(today, today, limit);
  },

  // Filtered, paginated calendar query. view: upcoming | past | all.
  _calFilter({ bodyId, from, to, view, today, publicOnly } = {}) {
    const clauses = [];
    const args = [];
    // Same seam as matters._filter: countCalendar and searchCalendar both build
    // on this, so the pager and the page agree about what exists.
    if (publicOnly) clauses.push('mt.agenda_published_at IS NOT NULL');
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
  /**
   * The consent calendar.
   *
   * A board disposing of twelve routine items ran twelve roll calls, because a
   * roll is opened on an agenda item and there was no way to say "these
   * twelve, together". The Consent Agenda section has existed since the
   * beginning — items could be *filed* under it, and then still had to be
   * voted one at a time.
   *
   * The group is itself an agenda item. That is the whole design: the ledger,
   * the threshold rules, the certification lifecycle and the wall board all go
   * on working unchanged, taking one roll on one item. Nothing about how a
   * vote is recorded changes. What changes is how many items one recorded vote
   * disposes of.
   */
  consentMembers(groupId) {
    return db.prepare(`
      SELECT ai.*, m.file_number, m.type AS matter_type, m.title AS matter_title,
             m.status AS matter_status
      FROM agenda_items ai LEFT JOIN matters m ON m.id = ai.matter_id
      WHERE ai.consent_group_id = ?
      ORDER BY ai.sort_order, ai.id`).all(groupId);
  },

  /**
   * Put items into a consent group, creating the group if there is not one.
   *
   * Refuses items that have already been voted: a consent calendar is a way of
   * disposing of business, not of re-disposing of it, and quietly folding a
   * decided item into a fresh roll would overwrite a result nobody asked to
   * revisit. Refuses a group item too, so groups cannot nest.
   */
  groupIntoConsent(meetingId, itemIds, { title = 'Consent Calendar' } = {}) {
    const wanted = (itemIds || []).map(Number).filter(Boolean);
    if (!wanted.length) return null;

    const all = meetings.items(meetingId);
    const byId = new Map(all.map((i) => [i.id, i]));
    const eligible = wanted
      .map((id) => byId.get(id))
      .filter((it) => it && !it.is_consent_group && !it.result && (it.vote_status || 'pending') === 'pending');
    if (!eligible.length) return null;

    let group = all.find((i) => i.is_consent_group && (i.vote_status || 'pending') === 'pending');
    if (!group) {
      const groupId = meetings.addItem({
        meeting_id: meetingId,
        section: 'Consent Agenda',
        title,
        requires_vote: 1,
        is_consent_group: 1,
        notes: 'Moved that the items on the consent calendar be adopted together.',
      });
      group = meetings.getItem(groupId);
    }

    const set = db.prepare('UPDATE agenda_items SET consent_group_id = ? WHERE id = ?');
    for (const it of eligible) set.run(group.id, it.id);
    meetings.renumber(meetingId);
    return meetings.getItem(group.id);
  },

  /** Take one item back off the calendar, so it can be considered on its own. */
  ungroupConsent(itemId) {
    const it = meetings.getItem(itemId);
    if (!it || !it.consent_group_id) return null;
    const groupId = it.consent_group_id;
    db.prepare('UPDATE agenda_items SET consent_group_id = NULL WHERE id = ?').run(itemId);
    // A calendar with nothing on it is furniture. Remove the group rather than
    // leaving an empty heading for the room to wonder about — but only while
    // it is still unvoted, since after a roll it is part of the record.
    const group = meetings.getItem(groupId);
    if (group && !group.result && !meetings.consentMembers(groupId).length) {
      meetings.removeItem(groupId);
    } else {
      meetings.renumber(it.meeting_id);
    }
    return meetings.getItem(itemId);
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
      'SELECT id, section, agenda_number, sort_order FROM agenda_items WHERE meeting_id = ? ORDER BY sort_order')
      .all(it.meeting_id);
    const maxOrder = existing.length ? existing[existing.length - 1].sort_order : 0;

    /**
     * Where the new item physically goes.
     *
     * It went at the end of the agenda, always. An item filed under a section
     * that already exists therefore landed *below* every other section, and
     * because the agenda prints a heading whenever the section changes, the
     * clerk got a second copy of that heading at the bottom of the page — the
     * item in a duplicate of a category that was already there. renumber()
     * then gave it a number from its section's rank, so the running order and
     * the numbers disagreed: a consent calendar numbered 3A sitting after 4A
     * and 5A, or a packet listing Tab 12 4D after 7A Adjournment.
     *
     * So an item joins the block its section already occupies, after the last
     * item in it. Where the section is new to this meeting there is nothing to
     * join and the end of the agenda is right.
     */
    let insertAt = maxOrder + 1;
    if (it.section) {
      const inSection = existing.filter((r) => r.section === it.section);
      if (inSection.length) {
        const lastOfSection = inSection[inSection.length - 1].sort_order;
        // Everything at or below that point stays; everything after it moves
        // down one to make room.
        db.prepare(`UPDATE agenda_items SET sort_order = sort_order + 1
          WHERE meeting_id = ? AND sort_order > ?`).run(it.meeting_id, lastOfSection);
        insertAt = lastOfSection + 1;
      }
    }

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
      (meeting_id, matter_id, sort_order, agenda_number, section, title, action, result, notes,
       requires_vote, item_type, is_consent_group)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      it.meeting_id, it.matter_id || null, it.sort_order || insertAt,
      agendaNum, it.section || null, it.title || null,
      it.action || null, it.result || null, it.notes || null, requiresVote, itemType,
      it.is_consent_group ? 1 : 0).lastInsertRowid;
  },
  getItem(id) {
    return db.prepare(`
      SELECT ai.*, m.file_number, m.title AS matter_title, mt.body_id
      FROM agenda_items ai
      LEFT JOIN matters m ON m.id = ai.matter_id
      JOIN meetings mt ON mt.id = ai.meeting_id
      WHERE ai.id = ?`).get(id);
  },
  // Amend an item already on the agenda. Until this existed the only way to
  // correct a section, a title or a linked file was to delete the item and add
  // it again — which threw away its votes, its packet documents and its place
  // in the running order.
  //
  // Deliberately narrow: it touches how the item is presented and how it will
  // be voted, and nothing about how it *was* voted. Results, timestamps and
  // certification are written by the voting path alone, so a clerk tidying a
  // title cannot disturb a recorded outcome.
  updateItem(itemId, it) {
    const cur = meetings.getItem(itemId);
    if (!cur) return false;
    const VALID_THRESHOLDS = new Set(['majority', 'two_thirds', 'majority_full']);
    const threshold = VALID_THRESHOLDS.has(it.vote_threshold)
      ? it.vote_threshold : (cur.vote_threshold || 'majority');
    db.prepare(`UPDATE agenda_items SET
        section = ?, agenda_number = ?, title = ?, matter_id = ?, item_type = ?,
        requires_vote = ?, notes = ?, vote_threshold = ?
      WHERE id = ?`).run(
      it.section || null,
      it.agenda_number || null,
      it.title || null,
      it.matter_id || null,
      it.item_type || null,
      it.requires_vote ? 1 : 0,
      it.notes || null,
      threshold,
      itemId,
    );
    return true;
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
    const row = db.prepare('SELECT meeting_id FROM agenda_items WHERE id = ?').get(itemId);
    db.prepare('DELETE FROM agenda_items WHERE id = ?').run(itemId); // votes cascade
    // Deleting 2B used to leave the agenda reading A, C, D — the next insert
    // computed its letter from the survivors.
    if (row) meetings.renumber(row.meeting_id);
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
  // Publishing the agenda is also what opens the room: the chamber display and
  // the public live board are gated on it, because a board that showed an
  // unpublished agenda on the wall would be publishing it by other means.
  publishAgenda(meetingId) {
    db.prepare(`UPDATE meetings SET agenda_published_at=datetime('now')
      WHERE id=? AND agenda_published_at IS NULL`).run(meetingId);
  },
  unpublishAgenda(meetingId) {
    db.prepare('UPDATE meetings SET agenda_published_at=NULL WHERE id=?').run(meetingId);
  },
  // Persist a new ordering. Only items that belong to the meeting are touched,
  // so a stale or tampered id list can't move items between meetings.
  /**
   * Recompute every agenda number from the running order.
   *
   * Numbers were assigned once, at insert, and never revisited. Dragging an
   * item rewrote sort_order only, so 2C could sit above 2A; deleting 2B left
   * the next insert computing 2D from the surviving A and C, giving A, C, D;
   * and a section's numeric prefix was whatever order its first item happened
   * to be placed in, so placing New Business before Ordinances made New
   * Business section 1. The agenda a clerk arranged and the agenda the public
   * page printed were different documents.
   *
   * Sections are numbered in the order AGENDA_SECTIONS declares them — the
   * order a meeting is actually run in — and items lettered within a section by
   * their position in the running order. Anything unsectioned keeps plain
   * integers after the sectioned blocks. A clerk who typed a number by hand
   * loses it here, which is the trade: one authority for the numbering, and it
   * is the order of business.
   */
  /**
   * Recompute the running order and the numbers, so they agree.
   *
   * This numbered by the canonical section order and left `sort_order` alone,
   * which let the two drift apart: an item appended to a section it did not
   * physically sit near got that section's number while staying where it was,
   * so an agenda could read Consent Agenda, New Business, Consent Agenda, New
   * Business — the same heading printed four times, with numbers that did not
   * follow the page. Sorting is part of numbering, not a separate act.
   *
   * The model this settles on: sections run in the canonical order
   * AGENDA_SECTIONS declares, and items run in their existing order within a
   * section. Dragging reorders items inside a section; moving an item to a
   * different section is done by editing the item, which is where its section
   * is actually recorded. That is the only arrangement in which an item's
   * number can be trusted to describe where it is.
   */
  renumber(meetingId) {
    const items = db.prepare(
      'SELECT id, section FROM agenda_items WHERE meeting_id = ? ORDER BY sort_order, id').all(meetingId);
    const order = new Map(AGENDA_SECTIONS.map((name, i) => [name, i]));
    // Sections in canonical order, but only those actually used, so the
    // numbering has no gaps for sections this meeting does not hold.
    const used = [...new Set(items.map((i) => i.section).filter(Boolean))]
      .sort((a, b) => (order.has(a) ? order.get(a) : 999) - (order.has(b) ? order.get(b) : 999));
    const prefixOf = new Map(used.map((name, i) => [name, i + 1]));

    // Gather each section's items into one block, keeping the order they are
    // already in, and lay the blocks out in canonical order. Unsectioned items
    // keep their relative order and follow, having no section to sit in.
    const ranked = [...items].sort((a, b) => {
      const ra = a.section ? (order.has(a.section) ? order.get(a.section) : 998) : 999;
      const rb = b.section ? (order.has(b.section) ? order.get(b.section) : 998) : 999;
      if (ra !== rb) return ra - rb;
      return items.indexOf(a) - items.indexOf(b);
    });

    const seen = new Map();
    let plain = 0;
    const upd = db.prepare(
      'UPDATE agenda_items SET agenda_number = ?, sort_order = ? WHERE id = ?');
    db.exec('SAVEPOINT sp_renumber');
    try {
      let pos = 0;
      for (const it of ranked) {
        pos += 1;
        if (!it.section) { upd.run(String(++plain), pos, it.id); continue; }
        const n = (seen.get(it.section) || 0) + 1;
        seen.set(it.section, n);
        // Past Z, fall back to a numeric suffix rather than emitting punctuation.
        const letter = n <= 26 ? String.fromCharCode(64 + n) : `-${n}`;
        upd.run(`${prefixOf.get(it.section)}${letter}`, pos, it.id);
      }
      db.exec('RELEASE sp_renumber');
    } catch (e) {
      db.exec('ROLLBACK TO sp_renumber'); db.exec('RELEASE sp_renumber');
      throw e;
    }
    return items.length;
  },

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
    meetings.renumber(meetingId);
    return pos;
  },
  // --- Agenda assembly ------------------------------------------------------
  // Legislative files that could be heard at this meeting: live business, in
  // this meeting's body (or not yet assigned to one), and not already sitting
  // on an agenda that has not happened yet. A file that was heard at a past
  // meeting is eligible again — that is how something comes back on appeal,
  // after a continuance, or for a second reading.
  readyForAgenda(meetingId) {
    const mt = meetings.get(meetingId);
    if (!mt) return [];
    return db.prepare(`
      SELECT m.*, b.name AS body_name,
        (SELECT COUNT(*) FROM reports r WHERE r.matter_id = m.id) AS report_count,
        (SELECT COUNT(*) FROM attachments a WHERE a.matter_id = m.id) AS attachment_count
      FROM matters m
      LEFT JOIN bodies b ON b.id = m.body_id
      WHERE m.status IN ('Introduced', 'In Committee', 'On Agenda', 'Tabled')
        AND (m.body_id = ? OR m.body_id IS NULL)
        -- Never offer what is already on this agenda, whatever state the
        -- meeting is in. Testing this against the meeting's own date and
        -- status let a Final or Adjourned meeting offer its own items back.
        AND NOT EXISTS (
          SELECT 1 FROM agenda_items ai
          WHERE ai.matter_id = m.id AND ai.meeting_id = ?
        )
        -- Nor what is booked on another meeting that has not happened. The
        -- comparison is against today, not against this meeting's date: when
        -- building a December agenda, business already set down for November
        -- is spoken for, even though November falls earlier. A meeting in
        -- session blocks regardless of the date on it.
        AND NOT EXISTS (
          SELECT 1 FROM agenda_items ai
          JOIN meetings m2 ON m2.id = ai.meeting_id
          WHERE ai.matter_id = m.id
            AND m2.id <> ?
            AND m2.status IN ('Scheduled', 'In Progress')
            AND (m2.status = 'In Progress' OR m2.meeting_date >= date('now'))
        )
      ORDER BY m.intro_date, m.file_number`).all(mt.body_id, meetingId, meetingId);
  },

  // Place several files onto the agenda in one action. Each lands as its own
  // item so it can be numbered, moved and voted separately; addItem() assigns
  // the agenda number from what is already there.
  addMatters(meetingId, matterIds, opts = {}) {
    const ids = (Array.isArray(matterIds) ? matterIds : [matterIds])
      .map((n) => parseInt(n, 10)).filter(Number.isInteger);
    if (!ids.length) return { added: 0, skipped: 0 };
    // Only files this meeting is actually allowed to hear, so a tampered id
    // list cannot schedule an unrelated matter.
    const eligible = new Set(meetings.readyForAgenda(meetingId).map((m) => m.id));
    let added = 0; let skipped = 0;
    db.exec('SAVEPOINT sp_add_matters');
    try {
      for (const id of ids) {
        if (!eligible.has(id)) { skipped++; continue; }
        // Spend the id. The eligible set is computed once, so without this a
        // submitted list of [id, id] would place the same file on the agenda
        // twice — the one duplicate the query itself cannot see.
        eligible.delete(id);
        const m = matters.get(id);
        meetings.addItem({
          meeting_id: meetingId,
          matter_id: id,
          // The file's own type already names the section it belongs under:
          // AGENDA_SECTIONS carries "Ordinances" and "Resolutions" under
          // exactly the names matters.type uses. Everything landed in New
          // Business regardless, and the clerk sorted it out by dragging.
          section: opts.section || sectionForType(m && m.type) || null,
          item_type: opts.item_type || 'Action',
          requires_vote: opts.requires_vote == null ? 1 : (opts.requires_vote ? 1 : 0),
        });
        // Scheduling a file is what puts it on the agenda, so it is what
        // should say so. 'On Agenda' was reachable only by a clerk later
        // typing an action string that happened to match a regex, so a file
        // could be scheduled, packeted and heard while its status still read
        // 'Introduced'. Terminal statuses are left alone: a file that has
        // already passed or failed is being reheard, which is not a step back.
        if (m && !TERMINAL_STATUSES.has(m.status)) matters.setStatus(id, 'On Agenda');
        added++;
      }
      db.exec('RELEASE sp_add_matters');
    } catch (e) {
      db.exec('ROLLBACK TO sp_add_matters'); db.exec('RELEASE sp_add_matters');
      throw e;
    }
    return { added, skipped };
  },

  setInPacket(itemId, val) {
    db.prepare('UPDATE agenda_items SET in_packet=? WHERE id=?').run(val ? 1 : 0, itemId);
  },

  // --- Supporting document assembly ----------------------------------------
  // Everything that goes into the packet, in agenda order, with each item's
  // supporting material gathered behind it: the staff reports and attachments
  // that travel with the legislative file, plus any documents hung on this
  // occurrence. Tab numbers are assigned here so the builder screen, the
  // table of contents and the assembled PDF all agree on them — the tab is
  // what a member says out loud ("turn to tab 4"), so it cannot be computed
  // twice and disagree.
  packet(meetingId) {
    const items = meetings.items(meetingId);
    let tab = 0;
    return items.map((it) => {
      const included = it.in_packet == null ? true : !!it.in_packet;
      const reports = it.matter_id
        ? db.prepare('SELECT id, title, kind FROM reports WHERE matter_id = ? ORDER BY id').all(it.matter_id)
        : [];
      const attachments = it.matter_id ? matters.attachments(it.matter_id) : [];
      const docs = meetings.itemDocs(it.id);
      // Two different questions, kept apart because they have different answers.
      //
      // `material` is what somebody wrote or attached. It drives the builder's
      // warning that members will have nothing to read on an item — a board
      // letter assembled from an empty file is not substance.
      const material = reports.length + attachments.length + docs.length;
      // `generated` is what the system will produce for this item regardless:
      // every legislative file yields a board letter, and an ordinance also
      // yields the clean text, the redline and the published notice. These are
      // pages that will sit behind the divider, so they decide whether the item
      // earns a tab at all. Counting only authored material left an ordinance
      // with drafted text but no attachments untabbed, and therefore unbound.
      const generated = it.matter_id
        ? (1 + (it.matter_type === 'Ordinance' ? 3 : 0))
        : 0;
      // A procedural line like "Call to Order" produces nothing and would
      // otherwise burn a number members hunt for behind a divider that is not
      // there.
      const hasTab = included && (material + generated) > 0;
      return {
        item: it,
        included,
        tab: hasTab ? ++tab : null,
        reports,
        attachments,
        docs,
        material,
        generated,
      };
    });
  },

  itemDocs(itemId) {
    return db.prepare('SELECT * FROM agenda_item_docs WHERE agenda_item_id = ? ORDER BY sort_order, id')
      .all(itemId);
  },
  addItemDoc(itemId, d) {
    return db.prepare(`INSERT INTO agenda_item_docs
      (agenda_item_id, name, url, file_path, size, content_type, note, sort_order)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      itemId, d.name, d.url || null, d.file_path || null, d.size || null,
      d.content_type || null, d.note || null, d.sort_order || 0).lastInsertRowid;
  },
  getItemDoc(id) {
    return db.prepare('SELECT * FROM agenda_item_docs WHERE id = ?').get(id);
  },
  deleteItemDoc(id) {
    db.prepare('DELETE FROM agenda_item_docs WHERE id = ?').run(id);
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
  // The next meeting at which a given file is actually set to be heard.
  //
  // Distinct from nextScheduled(), which answers "what meets next" across every
  // body. A published notice states that this ordinance will be considered at
  // the named meeting, so it has to be a meeting the ordinance is on — the
  // global next meeting may belong to another body entirely, and naming it
  // would put a false statement into a legal notice.
  nextAppearance(matterId, fromDate) {
    return db.prepare(`
      SELECT mt.*, b.name AS body_name
      FROM agenda_items ai
      JOIN meetings mt ON mt.id = ai.meeting_id
      JOIN bodies b ON b.id = mt.body_id
      WHERE ai.matter_id = ?
        AND mt.meeting_date >= ?
        AND mt.status NOT IN ('Cancelled', 'Adjourned', 'Final')
      ORDER BY mt.meeting_date ASC, mt.meeting_time ASC
      LIMIT 1`).get(matterId, fromDate);
  },

  // Whether a file is on a given meeting's agenda. The notice route needs this
  // because the meeting arrives as a query parameter.
  isOnAgenda(meetingId, matterId) {
    return !!db.prepare('SELECT 1 FROM agenda_items WHERE meeting_id = ? AND matter_id = ?')
      .get(meetingId, matterId);
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
    // Absent stays in the shape even though it can no longer be cast: rows
    // recorded before the ballot was reconciled still carry it, and a reader
    // asking for last year's tally should get the number that was announced.
    const t = { Yea: 0, Nay: 0, Present: 0, Abstain: 0, Recused: 0, Absent: 0 };
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
    const t = { Yea: 0, Nay: 0, Present: 0, Abstain: 0, Recused: 0, Absent: 0, total: 0 };
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
  // A board letter is written in the open inside the organization and reaches
  // the public only here. Publishing does not lock it: a published letter can
  // still be edited, and unpublishing takes it back off the site.
  publish(id) {
    db.prepare(`UPDATE reports SET published_at=datetime('now'), updated_at=datetime('now')
      WHERE id=? AND published_at IS NULL`).run(id);
  },
  unpublish(id) {
    db.prepare(`UPDATE reports SET published_at=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(id);
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
      (SELECT COUNT(*) FROM budget_transactions t WHERE t.budget_line_id = bl.id) AS tx_count,
      ou.name AS org_unit_name
      FROM budget_lines bl
      LEFT JOIN org_units ou ON ou.id = bl.org_unit_id
      WHERE bl.budget_id = ?
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
  // --- Appropriation ledger ("follow the money") ------------------------------
  // The appropriation code is the spine that ties budget lines, the contracts
  // and legislation drawing on them, and the actuals ledger together — across
  // every fiscal year the code appears in.
  appropriationRollup() {
    return db.prepare(`SELECT bl.appropriation_code AS code,
        COUNT(DISTINCT bl.id) AS line_count,
        COUNT(DISTINCT bl.budget_id) AS year_count,
        SUM(bl.amount) AS adopted,
        SUM(COALESCE((SELECT SUM(a.amount) FROM budget_amendments a WHERE a.budget_line_id = bl.id),0)) AS amended,
        SUM(COALESCE((SELECT SUM(m.fiscal_impact) FROM matters m WHERE m.budget_line_id = bl.id),0)) AS committed,
        SUM(COALESCE((SELECT SUM(t.amount) FROM budget_transactions t WHERE t.budget_line_id = bl.id),0)) AS actual
      FROM budget_lines bl
      WHERE bl.appropriation_code IS NOT NULL AND TRIM(bl.appropriation_code) != ''
      GROUP BY bl.appropriation_code
      ORDER BY bl.appropriation_code`).all();
  },
  appropriationCount() {
    return db.prepare(`SELECT COUNT(DISTINCT appropriation_code) AS n FROM budget_lines
      WHERE appropriation_code IS NOT NULL AND TRIM(appropriation_code) != ''`).get().n;
  },
  // Everything charged to one appropriation account: the lines, the linked
  // contracts/legislation (committed), and any solicitations against it.
  appropriationDetail(code) {
    const lines = db.prepare(`SELECT bl.*, b.fiscal_year, b.status AS budget_status,
        COALESCE((SELECT SUM(a.amount) FROM budget_amendments a WHERE a.budget_line_id = bl.id),0) AS amended,
        COALESCE((SELECT SUM(m.fiscal_impact) FROM matters m WHERE m.budget_line_id = bl.id),0) AS committed,
        COALESCE((SELECT SUM(t.amount) FROM budget_transactions t WHERE t.budget_line_id = bl.id),0) AS actual
      FROM budget_lines bl JOIN budgets b ON b.id = bl.budget_id
      WHERE bl.appropriation_code = ?
      ORDER BY b.fiscal_year DESC, bl.category, bl.name`).all(code);
    const contracts = db.prepare(`SELECT m.id, m.file_number, m.title, m.type, m.status, m.fiscal_impact,
        bl.name AS line_name, b.fiscal_year
      FROM matters m JOIN budget_lines bl ON bl.id = m.budget_line_id
      JOIN budgets b ON b.id = bl.budget_id
      WHERE bl.appropriation_code = ? AND m.fiscal_impact IS NOT NULL
      ORDER BY ABS(m.fiscal_impact) DESC, m.id DESC`).all(code);
    const solicitations = db.prepare(`SELECT s.id, s.number, s.title, s.kind, s.status, s.award_amount,
        v.name AS awarded_vendor_name, bl.name AS line_name
      FROM solicitations s JOIN budget_lines bl ON bl.id = s.budget_line_id
      LEFT JOIN vendors v ON v.id = s.awarded_vendor_id
      WHERE bl.appropriation_code = ?
      ORDER BY CASE s.status WHEN 'Awarded' THEN 0 WHEN 'Open' THEN 1 ELSE 2 END, s.number`).all(code);
    return { code, lines, contracts, solicitations };
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
    return db.prepare(`SELECT bl.*, b.fiscal_year, ou.name AS org_unit_name
      FROM budget_lines bl
      JOIN budgets b ON b.id = bl.budget_id
      LEFT JOIN org_units ou ON ou.id = bl.org_unit_id
      WHERE bl.id = ?`).get(id);
  },
  addLine(l) {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM budget_lines WHERE budget_id = ?')
      .get(l.budget_id).m;
    return db.prepare(`INSERT INTO budget_lines
      (budget_id, category, name, kind, amount, notes, sort_order, appropriation_code,
       project_code, org_unit_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(l.budget_id, l.category || null, l.name, l.kind || 'Expense',
      Number(l.amount) || 0, l.notes || null, l.sort_order || (max + 1),
      l.appropriation_code || null, l.project_code || null,
      l.org_unit_id || null).lastInsertRowid;
  },
  updateLine(id, l) {
    db.prepare(`UPDATE budget_lines SET category=?, name=?, kind=?, amount=?, notes=?,
      appropriation_code=?, project_code=?, org_unit_id=? WHERE id=?`)
      .run(l.category || null, l.name, l.kind || 'Expense', Number(l.amount) || 0,
        l.notes || null, l.appropriation_code || null, l.project_code || null,
        l.org_unit_id || null, id);
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
  /**
   * Who took each step the last time a file was routed.
   *
   * The routing form offered six selects of every active user, all defaulting
   * to "— any clerk —", on every file, for ever: the helper that built them
   * declared a `selected` parameter and never used it. In practice the same
   * handful of people review everything, so the clerk retyped the same six
   * choices on every file while the answer sat in the last route's rows.
   *
   * Keyed by step name rather than by seq, so the memory survives a change to
   * the template's order. Only steps that were actually assigned are
   * remembered — "any clerk" is the absence of a choice, not a choice.
   */
  /**
   * Every file currently waiting on somebody, oldest first.
   *
   * There was no query for this at all: progress() was dead code, the only
   * indicator anywhere was a count on a nav badge, and "what is stuck" was
   * answered by a clerk remembering. `days` is null for steps that predate
   * became_current_at rather than being reported as zero — an unknown age is
   * not a fresh one.
   */
  waiting({ olderThanDays = null } = {}) {
    const rows = db.prepare(`
      SELECT w.id AS step_id, w.matter_id, w.seq, w.name AS step_name, w.status,
             w.assignee_id, w.became_current_at,
             u.name AS assignee_name,
             m.file_number, m.title, m.type, m.status AS matter_status,
             CAST(julianday('now') - julianday(w.became_current_at) AS INTEGER) AS days
      FROM workflow_steps w
      JOIN matters m ON m.id = w.matter_id
      LEFT JOIN users u ON u.id = w.assignee_id
      WHERE w.status IN ('Pending','Returned')
        AND w.seq = (SELECT MIN(seq) FROM workflow_steps x
                     WHERE x.matter_id = w.matter_id AND x.status IN ('Pending','Returned'))
      ORDER BY w.became_current_at IS NULL, w.became_current_at ASC`).all();
    if (olderThanDays == null) return rows;
    return rows.filter((r) => r.days != null && r.days >= olderThanDays);
  },

  /**
   * Files that were never routed at all.
   *
   * Nothing starts a route automatically and creating a file redirects to the
   * public page, so forgetting is the default outcome rather than an unusual
   * one. Terminal files are excluded: a measure already decided does not need
   * review it will never receive.
   */
  unrouted() {
    return db.prepare(`
      SELECT m.id, m.file_number, m.title, m.type, m.status, m.intro_date
      FROM matters m
      WHERE NOT EXISTS (SELECT 1 FROM workflow_steps w WHERE w.matter_id = m.id)
        AND m.status NOT IN ('Passed','Failed','Enacted','Vetoed','Withdrawn')
      ORDER BY m.intro_date IS NULL, m.intro_date ASC, m.id ASC`).all();
  },

  lastAssignees() {
    const rows = db.prepare(`
      SELECT w.name, w.assignee_id
      FROM workflow_steps w
      WHERE w.assignee_id IS NOT NULL
      ORDER BY w.matter_id DESC, w.seq ASC`).all();
    const seen = new Map();
    for (const r of rows) if (!seen.has(r.name)) seen.set(r.name, r.assignee_id);
    return seen;
  },

  start(matterId, assigneeIds = []) {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM workflow_steps WHERE matter_id = ?').get(matterId).n;
    if (existing > 0) return existing;
    const ins = db.prepare(`INSERT INTO workflow_steps (matter_id, seq, name, role, status, assignee_id)
      VALUES (?,?,?,?,?,?)`);
    const template = workflowTemplate();
    template.forEach((s, i) => ins.run(matterId, i + 1, s.name, s.role, 'Pending', assigneeIds[i] || null));
    // Only the first step is being waited on; the rest are nobody's problem
    // yet, and stamping them all would make every step look equally old.
    db.prepare(`UPDATE workflow_steps SET became_current_at = datetime('now')
      WHERE matter_id = ? AND seq = 1`).run(matterId);
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
    const step = db.prepare('SELECT matter_id, seq FROM workflow_steps WHERE id = ?').get(stepId);
    db.prepare(`UPDATE workflow_steps SET status=?, acted_by=?, acted_at=datetime('now'), notes=?
      WHERE id=?`).run(status, userId || null, notes || null, stepId);
    // Finishing one step starts the next, and "started" is the instant a file
    // lands on somebody. Recorded rather than inferred, because acted_at says
    // when a step ended and nothing said when it began — so how long a
    // reviewer had been sitting on something was not merely unreported, it
    // was uncomputable.
    if (step && (status === 'Approved' || status === 'Skipped')) {
      db.prepare(`UPDATE workflow_steps SET became_current_at = datetime('now')
        WHERE matter_id = ? AND seq = ? AND became_current_at IS NULL`)
        .run(step.matter_id, step.seq + 1);
    }
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
      (parent_id, level, name, leader_person_id, leader_name, leader_title, leader_email,
       leader_phone, description, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      u.parent_id || null, u.level, u.name, u.leader_person_id || null,
      u.leader_name || null, u.leader_title || null,
      u.leader_email || null, u.leader_phone || null, u.description || null,
      u.sort_order || 0).lastInsertRowid;
  },
  update(id, u) {
    db.prepare(`UPDATE org_units SET parent_id=?, level=?, name=?, leader_person_id=?,
      leader_name=?, leader_title=?, leader_email=?, leader_phone=?, description=?,
      sort_order=? WHERE id=?`).run(
      u.parent_id || null, u.level, u.name, u.leader_person_id || null,
      u.leader_name || null, u.leader_title || null,
      u.leader_email || null, u.leader_phone || null, u.description || null, u.sort_order || 0, id);
  },
  remove(id) {
    db.prepare('DELETE FROM org_units WHERE id = ?').run(id);
  },

  // --- What a unit actually holds ------------------------------------------
  //
  // The queries below are the difference between an org chart and a directory.
  // Until org_units was referenced by anything there was nothing to ask it, so
  // its page could only repeat the name and the leader back at you.

  /**
   * The leader as a person record where one is linked, falling back to the
   * loose text for units led by someone not in the roster.
   * @returns {{id:number|null, full_name:string, title:string, email:string, phone:string}|null}
   */
  leader(unit) {
    if (!unit) return null;
    if (unit.leader_person_id) {
      const p = db.prepare('SELECT id, full_name, title, email, phone FROM people WHERE id = ?')
        .get(unit.leader_person_id);
      if (p) {
        return {
          id: p.id,
          full_name: p.full_name,
          title: unit.leader_title || p.title || '',
          email: p.email || unit.leader_email || '',
          phone: p.phone || unit.leader_phone || '',
        };
      }
    }
    if (!unit.leader_name) return null;
    return {
      id: null,
      full_name: unit.leader_name,
      title: unit.leader_title || '',
      email: unit.leader_email || '',
      phone: unit.leader_phone || '',
    };
  },

  /** Appropriations this unit holds, across every budget. */
  budgetLines(unitId) {
    return db.prepare(`
      SELECT bl.*, b.fiscal_year, b.status AS budget_status
      FROM budget_lines bl JOIN budgets b ON b.id = bl.budget_id
      WHERE bl.org_unit_id = ?
      ORDER BY b.fiscal_year DESC, bl.sort_order, bl.name`).all(unitId);
  },

  /**
   * What the unit is budgeted, and what it has actually spent.
   *
   * Expense and revenue are kept apart: netting them would let a department
   * that collects fees appear to spend nothing.
   */
  budgetTotals(unitId) {
    const t = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN bl.kind = 'Revenue' THEN bl.amount ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN bl.kind != 'Revenue' THEN bl.amount ELSE 0 END), 0) AS expense
      FROM budget_lines bl WHERE bl.org_unit_id = ?`).get(unitId);
    const spent = db.prepare(`
      SELECT COALESCE(SUM(tx.amount), 0) AS spent
      FROM budget_transactions tx JOIN budget_lines bl ON bl.id = tx.budget_line_id
      WHERE bl.org_unit_id = ? AND bl.kind != 'Revenue'`).get(unitId);
    return { revenue: t.revenue, expense: t.expense, spent: spent.spent };
  },

  /** Measures this unit has brought to the Board. */
  matters(unitId, limit = 25) {
    return db.prepare(`
      SELECT id, file_number, title, type, status, intro_date
      FROM matters WHERE org_unit_id = ?
      ORDER BY COALESCE(intro_date, '') DESC, id DESC
      LIMIT ?`).all(unitId, limit);
  },

  /** Everyone recorded as leading this unit or one directly beneath it. */
  staff(unitId) {
    return db.prepare(`
      SELECT p.id, p.full_name, p.title, p.email, u.id AS unit_id, u.name AS unit_name
      FROM org_units u JOIN people p ON p.id = u.leader_person_id
      WHERE u.id = ? OR u.parent_id = ?
      ORDER BY (u.id = ?) DESC, u.sort_order, u.name`).all(unitId, unitId, unitId);
  },

  /** Unit options for a select, indented to show the tree. */
  options() {
    const out = [];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        out.push({ value: n.id, label: `${'  '.repeat(depth)}${depth ? '└ ' : ''}${n.name}` });
        if (n.children && n.children.length) walk(n.children, depth + 1);
      }
    };
    walk(org.tree(), 0);
    return out;
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
       nominee_district, seat_role, reason, effective_date, term_end_date, seat_voting,
       cause, nominated_by, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Nominated')`).run(
      m.action, m.body_id ?? null, m.person_id ?? null, m.member_id ?? null,
      m.nominee_name ?? null, m.nominee_title ?? null, m.nominee_email ?? null,
      m.nominee_district ?? null, m.seat_role ?? 'Member', m.reason ?? null,
      m.effective_date ?? null, m.term_end_date ?? null,
      m.seat_voting == null ? null : (m.seat_voting ? 1 : 0), m.cause ?? null,
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
        // The term is granted with the seat. addMember used to take neither
        // date, so every governor seated through this path started with no
        // start date at all and someone had to remember a second form — the
        // roll reads start_date to decide who was seated when.
        if (!dup) {
          bodies.addMember(m.body_id, personId, m.seat_role || 'Member',
            m.seat_voting == null ? 1 : m.seat_voting,
            { start_date: m.effective_date || null, end_date: m.term_end_date || null });
        }
      } else if (m.action === 'remove') {
        // Close the term; do not delete the seat.
        //
        // This used to DELETE the body_members row, which destroyed the record
        // that the governor ever sat — their term dates with it. Their votes
        // survived, because those key on the person, but "who sat on this body
        // in March 2025" became unanswerable. That is the opposite of how the
        // rest of the record behaves: a voided vote is struck and kept,
        // precisely so the past stays describable.
        //
        // end_date is also what the roll now reads. An ended term leaves the
        // quorum and the denominator on its own, holding over only until a
        // successor takes the seat, so closing it is sufficient — nothing has
        // to be removed for the arithmetic to be right.
        const ends = m.effective_date || new Date().toISOString().slice(0, 10);
        const cause = m.cause || 'Retired';
        if (m.member_id) {
          db.prepare('UPDATE body_members SET end_date = ?, end_reason = ? WHERE id = ?')
            .run(ends, cause, m.member_id);
        } else if (m.body_id && personId) {
          db.prepare('UPDATE body_members SET end_date = ?, end_reason = ? WHERE body_id = ? AND person_id = ?')
            .run(ends, cause, m.body_id, personId);
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
  /**
   * Say which member of the board this login speaks for.
   *
   * Signing in proves an account is authorized. This says which governor it
   * is, and a ballot is recorded against the person rather than the account —
   * so without it a user holds the member role, sees the roll, and is told
   * "no member identity" the moment they vote.
   *
   * Every route that creates a user leaves this null: the admin form and the
   * SSO provisioner both insert NULL, and only the boot-time seed and the CSV
   * importer ever set it. So anyone onboarded through the interface could not
   * vote and there was no way to repair it from the interface either.
   *
   * Returns { ok } or { error }, because each refusal means something
   * different to whoever is looking at the form:
   *
   *  - `no_such_person` — the number does not name anyone. A mistyped id must
   *    not silently link nobody, leaving the account looking configured.
   *  - `taken` — that governor already has an account. Two logins for one
   *    person means two people can cast that governor's vote, and the later
   *    click wins.
   */
  setPerson(userId, personId) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) return { error: 'no_such_user' };
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return { error: 'no_such_user' };

    // Clearing the link is allowed: an account may outlive a term.
    if (personId === null || personId === undefined || personId === '') {
      db.prepare('UPDATE users SET person_id = NULL WHERE id = ?').run(uid);
      return { ok: true, person: null };
    }

    const pid = Number(personId);
    if (!Number.isInteger(pid) || pid <= 0) return { error: 'no_such_person' };
    const person = db.prepare('SELECT id, full_name FROM people WHERE id = ?').get(pid);
    if (!person) return { error: 'no_such_person' };

    const held = db.prepare('SELECT id, email FROM users WHERE person_id = ? AND id != ?').get(pid, uid);
    if (held) return { error: 'taken', by: held.email };

    db.prepare('UPDATE users SET person_id = ? WHERE id = ?').run(pid, uid);
    return { ok: true, person };
  },

  // Pre-provision an SSO login by email (matched on first Microsoft sign-in).
  create({ name, email, role, person_id: personId = null }) {
    if (!USER_ROLES.includes(role)) role = 'member';
    const pid = Number(personId);
    // Refuse a person already spoken for rather than raising on the unique
    // index; the caller renders this as a message beside the form.
    const linked = Number.isInteger(pid) && pid > 0
      && db.prepare('SELECT 1 FROM people WHERE id = ?').get(pid)
      && !db.prepare('SELECT 1 FROM users WHERE person_id = ?').get(pid)
      ? pid : null;
    return db.prepare(`INSERT INTO users (person_id, name, email, role, auth_provider)
      VALUES (?, ?, ?, ?, 'entra')`).run(linked, name || email, email, role).lastInsertRowid;
  },
};

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------
// The dashboard counters.
//
// These must follow publication or the front page both leaks and lies: it
// would announce "169 legislative files" over a list showing none of them, and
// the count alone tells a visitor how much work the Board has in hand. Bodies
// and people are the roster, which is not draft work and stays as it was.
function stats({ publicOnly = false } = {}) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const pub = publicOnly ? 'AND m.published_at IS NOT NULL' : '';
  const pubOnly = publicOnly ? 'WHERE m.published_at IS NOT NULL' : '';
  return {
    matters: one(`SELECT COUNT(*) AS n FROM matters m ${pubOnly}`).n,
    pending: one(
      `SELECT COUNT(*) AS n FROM matters m
       WHERE m.status IN ('Introduced','In Committee','On Agenda') ${pub}`).n,
    enacted: one(
      `SELECT COUNT(*) AS n FROM matters m WHERE m.status IN ('Passed','Enacted') ${pub}`).n,
    meetings: one(`SELECT COUNT(*) AS n FROM meetings mt
      ${publicOnly ? 'WHERE mt.agenda_published_at IS NOT NULL' : ''}`).n,
    bodies: one('SELECT COUNT(*) AS n FROM bodies WHERE active = 1').n,
    people: one('SELECT COUNT(*) AS n FROM people WHERE active = 1').n,
  };
}

function statusBuckets({ publicOnly = false } = {}) {
  return db.prepare(
    `SELECT status, COUNT(*) AS n FROM matters m
     ${publicOnly ? 'WHERE m.published_at IS NOT NULL' : ''}
     GROUP BY status ORDER BY n DESC`).all();
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
  // Resolve a vendor by name, creating it if new. An optional email backfills a
  // missing contact (so awarding from a bid captures the bidder's address).
  findOrCreate(name, email = null) {
    const existing = this.byName(name);
    if (!existing) return this.register({ name, email });
    if (email && !existing.email) {
      db.prepare('UPDATE vendors SET email = ? WHERE id = ?').run(email, existing.id);
    }
    return existing.id;
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
// Treasury Account Symbol register (chart of accounts / source of truth for
// appropriation structure). Maintained by import; upsert is keyed on the TAS.
// ---------------------------------------------------------------------------
const tas = {
  // Insert or update one account by its TAS. Returns 'created' | 'updated'.
  upsert(t) {
    const tasCode = String(t.tas || '').trim();
    if (!tasCode) return null;
    const existing = db.prepare('SELECT id FROM tas_accounts WHERE tas = ?').get(tasCode);
    const cols = {
      aid: t.aid || null, main: t.main || null, avail: t.avail || null,
      agency: t.agency || null, title: t.title || null, fund_type: t.fund_type || null,
      independent_agencies: t.independent_agencies || null, source_updated: t.source_updated || null,
    };
    if (existing) {
      db.prepare(`UPDATE tas_accounts SET aid=?, main=?, avail=?, agency=?, title=?, fund_type=?,
        independent_agencies=?, source_updated=?, updated_at=datetime('now') WHERE id=?`).run(
        cols.aid, cols.main, cols.avail, cols.agency, cols.title, cols.fund_type,
        cols.independent_agencies, cols.source_updated, existing.id);
      return 'updated';
    }
    db.prepare(`INSERT INTO tas_accounts (tas, aid, main, avail, agency, title, fund_type,
      independent_agencies, source_updated) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      tasCode, cols.aid, cols.main, cols.avail, cols.agency, cols.title, cols.fund_type,
      cols.independent_agencies, cols.source_updated);
    return 'created';
  },
  byTas(tasCode) { return db.prepare('SELECT * FROM tas_accounts WHERE tas = ?').get(String(tasCode || '').trim()); },
  get(id) { return db.prepare('SELECT * FROM tas_accounts WHERE id = ?').get(id); },
  count() { return db.prepare('SELECT COUNT(*) AS n FROM tas_accounts').get().n; },
  // Optional case-insensitive search across TAS / agency / title.
  all({ q = '' } = {}) {
    const term = String(q || '').trim();
    if (term) {
      const like = `%${term.toLowerCase()}%`;
      return db.prepare(`SELECT * FROM tas_accounts
        WHERE lower(tas) LIKE ? OR lower(agency) LIKE ? OR lower(title) LIKE ?
        ORDER BY tas`).all(like, like, like);
    }
    return db.prepare('SELECT * FROM tas_accounts ORDER BY tas').all();
  },
};

// ---------------------------------------------------------------------------
// The Board Code — the standing body of law, addressable by section, plus the
// amending instructions a bill carries against it.
// ---------------------------------------------------------------------------
const CODE_OPS = ['add', 'amend', 'repeal'];

// Sort citations naturally: 8-3 before 12-4 before 12-40.
function citationKey(c) {
  return String(c || '').split('-').map((p) => String(p).padStart(6, '0')).join('-');
}

const code = {
  OPS: CODE_OPS,
  sections({ includeRepealed = false } = {}) {
    const rows = includeRepealed
      ? db.prepare('SELECT * FROM code_sections').all()
      : db.prepare("SELECT * FROM code_sections WHERE status = 'Active'").all();
    return rows.sort((a, b) => citationKey(a.citation).localeCompare(citationKey(b.citation)));
  },
  titles() {
    const rows = db.prepare(`SELECT title_num, COUNT(*) AS n FROM code_sections
      WHERE status = 'Active' GROUP BY title_num`).all();
    return rows.sort((a, b) => citationKey(a.title_num).localeCompare(citationKey(b.title_num)));
  },
  get(id) { return db.prepare('SELECT * FROM code_sections WHERE id = ?').get(id); },
  byCitation(citation) {
    return db.prepare('SELECT * FROM code_sections WHERE citation = ?').get(String(citation || '').trim());
  },
  insertSection(s) {
    return db.prepare(`INSERT INTO code_sections (citation, title_num, heading, body_text, status, enacted_by, effective_date)
      VALUES (?,?,?,?,?,?,?)`).run(String(s.citation).trim(), s.title_num || titleOf(s.citation),
      s.heading, s.body_text || null, s.status || 'Active', s.enacted_by || null,
      s.effective_date || null).lastInsertRowid;
  },
  updateSection(id, s) {
    db.prepare(`UPDATE code_sections SET heading = ?, body_text = ?, status = ?, effective_date = ?,
      updated_at = datetime('now') WHERE id = ?`).run(s.heading, s.body_text || null,
      s.status || 'Active', s.effective_date || null, id);
  },
  // --- amending instructions carried by a bill ---
  amendments(matterId) {
    return db.prepare('SELECT * FROM code_amendments WHERE matter_id = ? ORDER BY sort_order, id').all(matterId);
  },
  amendment(id) { return db.prepare('SELECT * FROM code_amendments WHERE id = ?').get(id); },
  addAmendment(matterId, a) {
    if (!CODE_OPS.includes(a.op)) return null;
    const { m } = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM code_amendments WHERE matter_id = ?').get(matterId);
    const citation = String(a.citation || '').trim();
    return db.prepare(`INSERT INTO code_amendments (matter_id, op, citation, title_num, heading, new_text, note, sort_order)
      VALUES (?,?,?,?,?,?,?,?)`).run(matterId, a.op, citation, a.title_num || titleOf(citation),
      a.heading || null, a.new_text || null, a.note || null, (m || 0) + 1).lastInsertRowid;
  },
  removeAmendment(id) { db.prepare('DELETE FROM code_amendments WHERE id = ?').run(id); },
  // Which files amend a given section (the authority trail, newest first).
  historyFor(codeSectionId) {
    return db.prepare(`SELECT h.*, m.file_number, m.title AS matter_title
      FROM code_history h LEFT JOIN matters m ON m.id = h.matter_id
      WHERE h.code_section_id = ? ORDER BY h.id DESC`).all(codeSectionId);
  },
  // Bills that touch a section but have not been codified yet. Measures that
  // died (failed, vetoed, tabled, withdrawn) are excluded — their instructions
  // will never take effect, so they must not linger as "pending legislation".
  pendingFor(citation) {
    return db.prepare(`SELECT ca.*, m.file_number, m.title AS matter_title, m.status AS matter_status
      FROM code_amendments ca JOIN matters m ON m.id = ca.matter_id
      WHERE ca.citation = ? AND ca.applied_at IS NULL
        AND m.status NOT IN ('Failed','Vetoed','Tabled','Withdrawn')`).all(String(citation || '').trim());
  },
  recordHistory(h) {
    return db.prepare(`INSERT INTO code_history (code_section_id, matter_id, op, prior_text, effective_date)
      VALUES (?,?,?,?,?)`).run(h.code_section_id, h.matter_id || null, h.op,
      h.prior_text == null ? null : h.prior_text, h.effective_date || null).lastInsertRowid;
  },
  markApplied(amendmentId) {
    db.prepare("UPDATE code_amendments SET applied_at = datetime('now') WHERE id = ?").run(amendmentId);
  },
  stats() {
    return {
      sections: db.prepare("SELECT COUNT(*) AS n FROM code_sections WHERE status = 'Active'").get().n,
      repealed: db.prepare("SELECT COUNT(*) AS n FROM code_sections WHERE status = 'Repealed'").get().n,
      pending: db.prepare(`SELECT COUNT(*) AS n FROM code_amendments ca
        JOIN matters m ON m.id = ca.matter_id
        WHERE ca.applied_at IS NULL
          AND m.status NOT IN ('Failed','Vetoed','Tabled','Withdrawn')`).get().n,
    };
  },
};

function titleOf(citation) {
  const m = /^(\d+[A-Za-z]?)-/.exec(String(citation || '').trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Board actions by unanimous written consent (action without a meeting).
// ---------------------------------------------------------------------------
const CONSENT_STATUSES = ['Draft', 'Circulating', 'Adopted', 'Declined', 'Withdrawn'];

const consents = {
  STATUSES: CONSENT_STATUSES,
  nextNumber() {
    const now = new Date();
    const prefix = `WC-${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
    // "WC-" (3) + "YYMM" (4) = a 7-char prefix, so the suffix starts at position 8.
    const { m } = db.prepare(
      `SELECT MAX(CAST(substr(number, 8) AS INTEGER)) AS m FROM consents WHERE number LIKE ? || '%'`).get(prefix);
    return `${prefix}${String((m || 0) + 1).padStart(2, '0')}`;
  },
  // Create a consent and seed one signer per seated director of the body.
  create(c) {
    const number = this.nextNumber();
    const id = db.prepare(`INSERT INTO consents (number, title, body_html, body_id, matter_id, status)
      VALUES (?,?,?,?,?, 'Draft')`).run(number, c.title, c.body_html || null,
      c.body_id || null, c.matter_id || null).lastInsertRowid;
    if (c.body_id) {
      const members = db.prepare(`SELECT bm.person_id, p.full_name AS name, p.email
        FROM body_members bm JOIN people p ON p.id = bm.person_id
        WHERE bm.body_id = ? ORDER BY p.full_name`).all(c.body_id);
      members.forEach((m, i) => this.addSigner(id, {
        person_id: m.person_id, name: m.name, email: m.email, sort_order: i,
      }));
    }
    return { id, number };
  },
  addSigner(consentId, s) {
    return db.prepare(`INSERT INTO consent_signers (consent_id, person_id, name, email, sort_order)
      VALUES (?,?,?,?,?)`).run(consentId, s.person_id || null, s.name, s.email || null,
      s.sort_order || 0).lastInsertRowid;
  },
  get(id) {
    return db.prepare(`SELECT c.*, b.name AS body_name, m.file_number,
      (SELECT COUNT(*) FROM consent_signers s WHERE s.consent_id = c.id) AS signer_count,
      (SELECT COUNT(*) FROM consent_signers s WHERE s.consent_id = c.id AND s.status = 'Signed') AS signed_count
      FROM consents c
      LEFT JOIN bodies b ON b.id = c.body_id
      LEFT JOIN matters m ON m.id = c.matter_id
      WHERE c.id = ?`).get(id);
  },
  list({ includeAll = true } = {}) {
    const where = includeAll ? '' : "WHERE c.status != 'Withdrawn'";
    return db.prepare(`SELECT c.*, b.name AS body_name,
      (SELECT COUNT(*) FROM consent_signers s WHERE s.consent_id = c.id) AS signer_count,
      (SELECT COUNT(*) FROM consent_signers s WHERE s.consent_id = c.id AND s.status = 'Signed') AS signed_count
      FROM consents c LEFT JOIN bodies b ON b.id = c.body_id
      ${where}
      ORDER BY CASE c.status WHEN 'Circulating' THEN 0 WHEN 'Draft' THEN 1 ELSE 2 END, c.id DESC`).all();
  },
  openCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM consents WHERE status = 'Circulating'").get().n;
  },
  signers(consentId) {
    return db.prepare('SELECT * FROM consent_signers WHERE consent_id = ? ORDER BY sort_order, id').all(consentId);
  },
  // Record one signer's decision by row id (in-app path), then recompute.
  setSignerStatus(signerId, status) {
    if (!['Signed', 'Declined', 'Pending'].includes(status)) return;
    const row = db.prepare('SELECT consent_id FROM consent_signers WHERE id = ?').get(signerId);
    if (!row) return;
    const signed = status === 'Signed' ? "datetime('now')" : 'NULL';
    db.prepare(`UPDATE consent_signers SET status = ?, signed_at = ${signed} WHERE id = ?`).run(status, signerId);
    return this.recompute(row.consent_id);
  },
  setStatus(id, status) {
    if (!CONSENT_STATUSES.includes(status)) return;
    db.prepare("UPDATE consents SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  },
  setEsign(id, { provider, agreementId, status }) {
    db.prepare(`UPDATE consents SET esign_provider = ?, esign_agreement_id = ?, esign_status = ?,
      updated_at = datetime('now') WHERE id = ?`).run(provider || null, agreementId || null, status || null, id);
  },
  getByAgreement(agreementId) {
    return db.prepare('SELECT * FROM consents WHERE esign_agreement_id = ?').get(agreementId);
  },
  // Record a signer's decision, matched by person or email, then recompute.
  markSigner(consentId, { personId = null, email = null }, status) {
    if (!['Signed', 'Declined', 'Pending'].includes(status)) return;
    const signed = status === 'Signed' ? "datetime('now')" : 'NULL';
    let sql = `UPDATE consent_signers SET status = ?, signed_at = ${signed} WHERE consent_id = ? AND `;
    const args = [status, consentId];
    if (personId != null) { sql += 'person_id = ?'; args.push(personId); }
    else { sql += 'lower(email) = lower(?)'; args.push(String(email || '')); }
    db.prepare(sql).run(...args);
    return this.recompute(consentId);
  },
  // Adopt when every signer has signed; a single decline sends it back.
  recompute(consentId) {
    const c = this.get(consentId);
    if (!c || (c.status !== 'Circulating' && c.status !== 'Draft')) return c;
    const rows = this.signers(consentId);
    if (!rows.length) return c;
    if (rows.some((s) => s.status === 'Declined')) {
      db.prepare("UPDATE consents SET status = 'Declined', updated_at = datetime('now') WHERE id = ?").run(consentId);
    } else if (rows.every((s) => s.status === 'Signed')) {
      db.prepare("UPDATE consents SET status = 'Adopted', adopted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(consentId);
    }
    return this.get(consentId);
  },
  // Apply a provider's [{ email, status }] snapshot to the signers.
  syncFromMembers(consentId, members) {
    (members || []).forEach((m) => {
      if (!m.email) return;
      const st = m.status === 'Signed' || m.status === 'Declined' ? m.status : 'Pending';
      db.prepare(`UPDATE consent_signers SET status = ?, signed_at = CASE WHEN ? = 'Signed' THEN datetime('now') ELSE signed_at END
        WHERE consent_id = ? AND lower(email) = lower(?)`).run(st, st, consentId, m.email);
    });
    return this.recompute(consentId);
  },
  remove(id) { db.prepare('DELETE FROM consents WHERE id = ?').run(id); },
};

// ---------------------------------------------------------------------------
// Audit log (state-changing requests by signed-in users)
// ---------------------------------------------------------------------------
// --- Board letter sections ---------------------------------------------------
// The standard sections, in the order they appear in the letter. Modelled on
// the form a Legistar-backed board uses, but held as configuration: which
// questions a board requires answered before it will hear an item is that
// board's policy, not this application's.
//
// `required` marks a section the letter is incomplete without. The rest are
// answered when they apply and omitted when they do not — printing an empty
// heading imitates the form while saying nothing.
const LETTER_SECTIONS_DEFAULT = [
  { key: 'overview', label: 'OVERVIEW', required: true,
    hint: 'What is before the body, in a paragraph.' },
  { key: 'recommendation', label: 'RECOMMENDATION(S)', required: true,
    hint: 'The numbered actions being asked for, and on what date.' },
  { key: 'equity', label: 'EQUITY IMPACT STATEMENT', required: false,
    hint: 'Who this reaches, and who it may miss.' },
  { key: 'sustainability', label: 'SUSTAINABILITY IMPACT STATEMENT', required: false,
    hint: "Effect on the board's sustainability commitments." },
  { key: 'fiscal', label: 'FISCAL IMPACT', required: true,
    hint: 'Cost, funding source, and whether it recurs. State "None" if there is none.' },
  { key: 'business', label: 'BUSINESS IMPACT STATEMENT', required: false,
    hint: 'Effect on regulated or contracting businesses.' },
  { key: 'advisory', label: 'ADVISORY BOARD STATEMENT', required: false,
    hint: 'Any advisory body that considered this, and what it said.' },
  { key: 'background', label: 'BACKGROUND', required: true,
    hint: 'How the item arrived here: prior direction, authority, what changed.' },
  { key: 'linkage', label: 'LINKAGE TO THE STRATEGIC PLAN', required: false,
    hint: 'Which strategic objective this serves.' },
];

const letters = {
  // The configured section list, falling back to the standard form. A stored
  // list that cannot be parsed is ignored rather than allowed to blank the
  // letter form for every file.
  sections() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'letter.sections'").get();
    if (row && row.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed) && parsed.length && parsed.every((x) => x && x.key && x.label)) return parsed;
      } catch (_) { /* fall through to the default */ }
    }
    return LETTER_SECTIONS_DEFAULT;
  },
  // Parse the edited section list. Strict on purpose: a row that silently
  // fails to parse removes a section from the form and orphans everything
  // already written under it, while the clerk is told the save succeeded.
  // Any bad row rejects the whole submission.
  //
  // Format: key | LABEL | required | hint     (required and hint optional)
  parseSectionList(text) {
    const rows = String(text || '').split('\n')
      .map((l) => l.trim()).filter(Boolean);
    if (!rows.length) return { ok: false, error: 'The section list cannot be empty.' };
    const list = [];
    const seen = new Set();
    for (const [i, row] of rows.entries()) {
      const parts = row.split('|').map((x) => x.trim());
      const [key, label, flag, hint] = parts;
      if (!key || !label) {
        return { ok: false, error: `Line ${i + 1}: expected "key | LABEL", got "${row}".` };
      }
      if (!/^[a-z0-9_-]+$/i.test(key)) {
        return { ok: false, error: `Line ${i + 1}: "${key}" is not a valid key (letters, digits, - and _ only).` };
      }
      if (seen.has(key.toLowerCase())) {
        // A duplicate key renders the same stored answer under two headings.
        return { ok: false, error: `Line ${i + 1}: "${key}" appears more than once.` };
      }
      if (flag && !/^(required|optional)$/i.test(flag)) {
        return { ok: false, error: `Line ${i + 1}: third field must be "required" or "optional", got "${flag}".` };
      }
      seen.add(key.toLowerCase());
      list.push({
        key, label,
        required: /^required$/i.test(flag || ''),
        hint: hint || '',
      });
    }
    return { ok: true, list };
  },

  setSections(list) {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('letter.sections', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(JSON.stringify(list));
  },

  forMatter(matterId) {
    const rows = db.prepare('SELECT section_key, body_html FROM letter_sections WHERE matter_id = ?')
      .all(matterId);
    const byKey = {};
    for (const r of rows) byKey[r.section_key] = r.body_html || '';
    return byKey;
  },

  // The letter as it will be assembled: every configured section, in order,
  // carrying whatever has been written for it.
  compose(matterId) {
    const written = letters.forMatter(matterId);
    return letters.sections().map((s) => Object.assign({}, s, {
      body_html: written[s.key] || '',
      filled: !!String(written[s.key] || '').trim(),
    }));
  },

  // Which required sections are still blank. The clerk needs this before the
  // item goes on an agenda, which is the point at which it stops being fixable.
  missing(matterId) {
    return letters.compose(matterId).filter((s) => s.required && !s.filled).map((s) => s.label);
  },

  save(matterId, key, html) {
    const valid = letters.sections().some((s) => s.key === key);
    if (!valid) return false;
    db.prepare(`INSERT INTO letter_sections (matter_id, section_key, body_html, updated_at)
      VALUES (?,?,?,datetime('now'))
      ON CONFLICT(matter_id, section_key)
      DO UPDATE SET body_html = excluded.body_html, updated_at = excluded.updated_at`)
      .run(matterId, key, html);
    return true;
  },
};

/**
 * The vote ledger.
 *
 * Every cast, change and correction is an append. Nothing here updates or
 * deletes, which is what lets the record answer "who voted what, when, and did
 * anyone change their mind after the tally was visible".
 *
 * `votes` is kept in step as a projection of this, so the seven existing
 * readers of that table — tallies, member history, minutes, exports — keep
 * working unchanged while the ledger becomes the thing of record underneath.
 */
const voteLedger = {
  /**
   * The signing key. See the note on tamper evidence in ledger.js: the chain
   * is what defends the record, and it needs no key. This only adds "this
   * server wrote it".
   */
  key() {
    if (process.env.VOTE_LEDGER_KEY) return process.env.VOTE_LEDGER_KEY;
    if (this._key) return this._key;
    const row = db.prepare("SELECT value FROM settings WHERE key = 'vote_ledger_key'").get();
    if (row && row.value) return (this._key = row.value);
    const generated = require('node:crypto').randomBytes(32).toString('hex');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('vote_ledger_key', ?)")
      .run(generated);
    return (this._key = generated);
  },

  /** The whole chain for a meeting, in order. */
  forMeeting(meetingId) {
    return db.prepare('SELECT * FROM session_events WHERE meeting_id = ? ORDER BY seq')
      .all(meetingId);
  },

  /** The chain filtered to one item — still ordered by the session sequence. */
  forItem(agendaItemId) {
    return db.prepare('SELECT * FROM session_events WHERE agenda_item_id = ? ORDER BY seq')
      .all(agendaItemId);
  },

  /**
   * Append any session event.
   *
   * One chain per meeting. Everything consequential goes through here, so the
   * order of the session is itself part of the evidence.
   */
  appendEvent(meetingId, eventType, payload = {}, cols = {}) {
    const last = db.prepare(
      'SELECT event_hash FROM session_events WHERE meeting_id = ? ORDER BY seq DESC LIMIT 1')
      .get(meetingId);
    const eventId = require('node:crypto').randomUUID();
    const now = new Date().toISOString();
    const full = { ...payload, eventId, eventType, meetingId, receivedAt: now };

    const built = ledger.buildEntry({
      previousEntryHash: last ? last.event_hash : ledger.GENESIS,
      payload: full,
      key: this.key(),
      eventType,
    });

    db.prepare(`INSERT INTO session_events
      (event_id, meeting_id, event_type, payload_json, previous_hash, event_hash, received_at,
       agenda_item_id, person_id, choice, source, entered_by, supersedes_event_id,
       motion_version_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      eventId, meetingId, eventType, JSON.stringify(full),
      built.previousEventHash, built.entryHash, now,
      cols.agendaItemId || null, cols.personId || null, cols.choice || null,
      cols.source || null, cols.enteredBy || null, cols.supersedesEventId || null,
      // Which question this event belongs to. An index over what the payload
      // already carried; the hash is taken over the payload, so this column
      // is invisible to verification.
      cols.motionVersionId || null);

    return { eventId, eventHash: built.entryHash, receivedAt: now };
  },

  /**
   * Record a vote.
   *
   * `source` is required and not defaulted. A vote the clerk typed from the
   * spoken roll and a vote a governor pressed are different facts, and the
   * difference has to survive into the record rather than being decided by
   * whichever caller forgot to say.
   */
  append(agendaItemId, personId, choice, opts = {}) {
    const item = meetings.getItem(agendaItemId);
    if (!item) throw new Error(`No agenda item ${agendaItemId}`);
    const source = opts.source || 'MEMBER_TERMINAL';
    // The question this ballot answers. Taken from the item unless the caller
    // names one, so that no route has to remember: a ballot that does not say
    // which motion it was cast on is a ballot that can be counted twice.
    const version = opts.motionVersionId !== undefined
      ? opts.motionVersionId : this.motionVersionFor(agendaItemId);

    // Superseding is within the question, not across it. A member who voted
    // Yea on the amendment and Nay on the measure has not changed their vote;
    // they answered two questions. Reading the standing position across
    // versions would file the second ballot as a retraction of the first.
    const standing = this.current(agendaItemId, {
      asOf: null, throughSeq: null, motionVersionId: version,
    }).get(personId);
    return this.appendEvent(item.meeting_id, standing ? 'VOTE_CHANGED' : 'VOTE_CAST', {
      agendaItemId,
      choice,
      credentialId: opts.credentialId || null,
      motionVersionId: version || null,
      personId,
      source,
      stationId: opts.stationId || null,
      submittedAt: opts.submittedAt || null,
      supersedesEventId: standing ? standing.event_id : null,
    }, {
      agendaItemId, personId, choice, source,
      enteredBy: opts.userId || null,
      supersedesEventId: standing ? standing.event_id : null,
      motionVersionId: version || null,
    });
  },

  /**
   * The question currently before the body on this item.
   *
   * Undefined — not null — where the item has no motion versions at all, so
   * that every item recorded before amendments existed windows exactly as it
   * always did rather than being narrowed to "the ballots with no version",
   * which is a filter it has never been asked to pass.
   */
  motionVersionFor(agendaItemId) {
    const latest = motionVersions.latest(agendaItemId);
    return latest ? latest.id : undefined;
  },

  /** Where the roll closed, as a position in the chain. */
  closedSeq(agendaItemId, motionVersionId) {
    const item = meetings.getItem(agendaItemId);
    if (!item) return null;
    const version = motionVersionId !== undefined
      ? motionVersionId : this.motionVersionFor(agendaItemId);
    return ledger.closedAtSeq(this.forMeeting(item.meeting_id), agendaItemId, version);
  },

  /**
   * Each member's standing position, as of the close by default.
   *
   * Bounded by chain position rather than a clock wherever a close exists: a
   * sequence number cannot be backdated, a timestamp column can.
   */
  current(agendaItemId, opts = {}) {
    const version = opts.motionVersionId !== undefined
      ? opts.motionVersionId : this.motionVersionFor(agendaItemId);
    const throughSeq = opts.throughSeq !== undefined
      ? opts.throughSeq : this.closedSeq(agendaItemId, version);
    const entries = this.forItem(agendaItemId);
    return ledger.currentChoices(entries, {
      asOf: opts.asOf !== undefined ? opts.asOf : null,
      throughSeq,
      motionVersionId: version,
      // A vote the Board has struck stops counting. The ballots stay in the
      // chain; this is the floor beneath which they no longer project.
      afterSeq: opts.afterSeq !== undefined
        ? opts.afterSeq : ledger.voidedAtSeq(entries, agendaItemId),
    });
  },

  /** Ballots recorded after the roll closed: kept, counted by nothing. */
  late(agendaItemId, motionVersionId) {
    const version = motionVersionId !== undefined
      ? motionVersionId : this.motionVersionFor(agendaItemId);
    const throughSeq = this.closedSeq(agendaItemId, version);
    if (throughSeq == null) return [];
    const entries = version === undefined ? this.forItem(agendaItemId)
      : this.forItem(agendaItemId)
        .filter((e) => (e.motion_version_id ?? null) === (version ?? null));
    return ledger.lateEvents(entries, { throughSeq });
  },

  /**
   * Recompute the chain for a whole meeting.
   *
   * The payload is rehydrated from `payload_json` and the indexed columns are
   * checked against it, so editing `choice` in the table to flip a vote is
   * caught even though the hash covers the payload rather than the column.
   */
  verify(meetingId) {
    const rows = this.forMeeting(meetingId).map((r) => {
      const payload = JSON.parse(r.payload_json);
      return {
        ...r,
        previous_event_hash: r.previous_hash,
        entry_hash: r.event_hash,
        payload_hash: ledger.payloadHash(payload),
        payload,
        _mirrors: (payload.choice ?? null) === (r.choice ?? null)
          && (payload.personId ?? null) === (r.person_id ?? null)
          && (payload.source ?? null) === (r.source ?? null)
          && (payload.agendaItemId ?? null) === (r.agenda_item_id ?? null),
      };
    });
    const bad = rows.findIndex((r) => !r._mirrors);
    if (bad !== -1) {
      return { ok: false, brokenAt: bad, reason: 'indexed columns disagree with the sealed payload' };
    }
    return ledger.verifyChain(rows, this.key());
  },

  /** Convenience: verify the meeting an item belongs to. */
  verifyItem(agendaItemId) {
    const item = meetings.getItem(agendaItemId);
    return item ? this.verify(item.meeting_id) : { ok: false, reason: 'no such item' };
  },
};

/**
 * Undoing a vote.
 *
 * Two different acts, deliberately not one. Reopening says "we are taking this
 * again now"; voiding says "that vote should not have counted" and leaves the
 * floor closed. Both must retract what closing recorded, because closing does
 * two things beyond setting a status — it stamps a Pass/Fail on the item and
 * writes a row into the matter's legislative history. Leaving either behind
 * means the record asserts an outcome the Board has withdrawn.
 */
const voteAdmin = {
  /**
   * Open the roll: an event in the chain, and the rule fixed at that moment.
   */
  openRoll(itemId, { userId = null } = {}) {
    const item = meetings.getItem(itemId);
    if (!item) return null;
    // An item on the consent calendar is disposed of by the calendar's roll.
    // Opening its own would take a second vote on business the board is about
    // to decide once, and leave two results on one item with nothing saying
    // which governs. Take it off the calendar first if it needs debating.
    if (item.consent_group_id) {
      const e = new Error('This item is on the consent calendar. '
        + 'Remove it from the calendar to consider it separately.');
      e.code = 'ON_CONSENT_CALENDAR';
      throw e;
    }
    // The rule the roll is taken under. Freezing it at open is deliberate: a
    // closed roll must be read against the rule in force when it was taken,
    // not whatever the config says later. But a *reopen* is a fresh roll, so
    // it takes the item's current threshold — previously `threshold_rule` won
    // for ever, and a clerk who corrected the threshold and reopened got the
    // old arithmetic with no indication anything had been ignored.
    const rule = item.vote_threshold || item.threshold_rule || 'majority';
    // The first time the body actually reaches this item, whatever the agenda
    // said the order would be. Set once: a reopened roll is the same item being
    // reconsidered, not the body arriving at it again.
    db.prepare(`UPDATE agenda_items SET reached_at = COALESCE(reached_at, datetime('now'))
      WHERE id = ?`).run(itemId);
    db.prepare(`UPDATE agenda_items
      SET vote_status = 'open', vote_opened_at = datetime('now'), vote_closed_at = NULL,
          cleared_at = NULL, tabled_at = NULL, tabled_reason = NULL,
          threshold_rule = ?, result_computed_at = NULL, result_announced_at = NULL,
          result_certified_at = NULL, result_certified_by = NULL, result_published_at = NULL,
          certification_checkpoint = NULL
      WHERE id = ?`).run(rule, itemId);
    // The question this roll is on. An item with no motion recorded takes its
    // roll unversioned, exactly as every item did before amendments existed —
    // so nothing already in the record windows differently.
    const version = motionVersions.latest(itemId);
    if (version) motionVersions.recordOpen(version.id);
    voteLedger.appendEvent(item.meeting_id, 'ROLL_OPENED',
      { agendaItemId: itemId, thresholdRule: rule,
        motionVersionId: version ? version.id : null },
      { agendaItemId: itemId, enteredBy: userId,
        motionVersionId: version ? version.id : null });
    return meetings.getItem(itemId);
  },

  /**
   * Close the roll.
   *
   * The event's position in the chain is what bounds the tally; the timestamp
   * is for people to read. Everything after this slot is late by construction.
   */
  closeRoll(itemId, { userId = null } = {}) {
    const item = meetings.getItem(itemId);
    if (!item) return null;
    // Closing an already-closed roll is not a repeat of the same act. Every
    // close appends a ROLL_CLOSED and the tally is bounded by the *last* one
    // (ledger.closedAtSeq), so a second close moves the boundary forward and
    // quietly promotes ballots that were late into the count. Nobody presses
    // it twice on purpose — until this was fixed the button simply never
    // stopped saying "Close roll & record result".
    if (item.vote_status === 'closed') return eligibility.outcome(itemId);
    const version = motionVersions.latest(itemId);
    voteLedger.appendEvent(item.meeting_id, 'ROLL_CLOSED',
      { agendaItemId: itemId, motionVersionId: version ? version.id : null },
      { agendaItemId: itemId, enteredBy: userId,
        motionVersionId: version ? version.id : null });
    db.prepare(`UPDATE agenda_items
      SET vote_status = 'closed', vote_closed_at = datetime('now') WHERE id = ?`).run(itemId);

    const outcome = eligibility.outcome(itemId);
    // The result belongs to the question, not only to the item. An item that
    // was amended holds several: the vote on the amendment and the vote on the
    // measure as amended are both real results, and the item's own `result` is
    // the last of them — the disposition of the business.
    if (version) motionVersions.recordClose(version.id, outcome.result);
    // Persist the result here, where it is computed. It used to be set by the
    // route instead, so closing the roll through the repo left the item with
    // a computed timestamp and no outcome on it — and the board, which reads
    // the item, showed a finished vote with no result.
    meetings.setItemResult(itemId,
      item.action || (item.motion_text ? 'Motion' : 'Vote taken'), outcome.result);
    db.prepare("UPDATE agenda_items SET result_computed_at = datetime('now') WHERE id = ?").run(itemId);
    voteLedger.appendEvent(item.meeting_id, 'RESULT_COMPUTED', {
      agendaItemId: itemId, yea: outcome.yea, nay: outcome.nay,
      eligible: outcome.eligible, required: outcome.required,
      thresholdRule: outcome.threshold, result: outcome.result,
    }, { agendaItemId: itemId, enteredBy: userId });

    // A consent calendar carries its items with it.
    //
    // The result is written onto each one so that the agenda, the minutes and
    // every matter's own page read the same as they would after a separate
    // vote — a member should not have to know the item travelled on a consent
    // calendar to find out what happened to it. The ledger is untouched:
    // there is exactly one roll, on the group, and each item points at it.
    if (item.is_consent_group) {
      const carried = meetings.consentMembers(itemId);
      // Closed, not merely resulted.
      //
      // This stamped result_computed_at and set the result but left
      // vote_status at 'pending', so every screen that asks "has this been
      // voted?" — the agenda manager, the live console's item list, the
      // minutes, the per-item report — answered no while a result hung off
      // the row. The calendar worked and looked as though it had not.
      //
      // The close time is the calendar's own: these items were disposed of at
      // the instant that roll shut, not at some later moment of bookkeeping.
      const stamp = db.prepare(`UPDATE agenda_items
        SET vote_status = 'closed', vote_closed_at = ?, result_computed_at = datetime('now')
        WHERE id = ?`);
      const closedAt = meetings.getItem(itemId).vote_closed_at;
      for (const member of carried) {
        meetings.setItemResult(member.id,
          member.action || 'Adopted on the consent calendar', outcome.result);
        stamp.run(closedAt, member.id);
      }
      voteLedger.appendEvent(item.meeting_id, 'RESULT_COMPUTED', {
        agendaItemId: itemId, consentCalendar: true,
        carriedItemIds: carried.map((c) => c.id), result: outcome.result,
      }, { agendaItemId: itemId, enteredBy: userId });
    }
    return outcome;
  },

  /**
   * Lay the item on the table.
   *
   * A state on the item, not a string a clerk types. 'Tabled' existed only as
   * a *matter* status, inferred by regex from the action text — so an item
   * laid on the table went on reading 'pending' beside items genuinely still
   * to come, and an agenda could not show which was which.
   *
   * The matter's status follows, where there is one, because a file whose item
   * was tabled is a tabled file. Taking it back up clears both.
   */
  table(itemId, { reason = '', userId = null } = {}) {
    const item = meetings.getItem(itemId);
    if (!item) return null;
    if (item.vote_status === 'open') {
      const e = new Error('Close or void the open roll before tabling this item.');
      e.code = 'ROLL_OPEN';
      throw e;
    }
    db.prepare(`UPDATE agenda_items
      SET tabled_at = datetime('now'), tabled_reason = ?, cleared_at = datetime('now')
      WHERE id = ?`).run(String(reason || '').trim() || null, itemId);
    voteLedger.appendEvent(item.meeting_id, 'AGENDA_ITEM_CALLED',
      { agendaItemId: itemId, tabled: true, reason: String(reason || '').trim() || null },
      { agendaItemId: itemId, enteredBy: userId });
    if (item.matter_id) matters.setStatus(item.matter_id, 'Tabled');
    return meetings.getItem(itemId);
  },

  /** Take it back up. */
  untable(itemId, { userId = null } = {}) {
    const item = meetings.getItem(itemId);
    if (!item || !item.tabled_at) return null;
    db.prepare(`UPDATE agenda_items
      SET tabled_at = NULL, tabled_reason = NULL, cleared_at = NULL WHERE id = ?`).run(itemId);
    voteLedger.appendEvent(item.meeting_id, 'AGENDA_ITEM_CALLED',
      { agendaItemId: itemId, tabled: false },
      { agendaItemId: itemId, enteredBy: userId });
    if (item.matter_id) matters.setStatus(item.matter_id, 'On Agenda');
    return meetings.getItem(itemId);
  },

  /**
   * Done with this item: take it off the board.
   *
   * Deliberately not part of the vote lifecycle. It records nothing in the
   * ledger and changes no result — it is the clerk saying the room has moved
   * on, and it is undone the moment the item is opened again.
   */
  clear(itemId) {
    const item = meetings.getItem(itemId);
    if (!item) return null;
    db.prepare("UPDATE agenda_items SET cleared_at = datetime('now') WHERE id = ?").run(itemId);
    return meetings.getItem(itemId);
  },

  /** The chair states the result to the room. */
  announce(itemId, { userId = null } = {}) {
    const item = meetings.getItem(itemId);
    if (!item || !item.result_computed_at) return null;
    db.prepare("UPDATE agenda_items SET result_announced_at = datetime('now') WHERE id = ?").run(itemId);
    voteLedger.appendEvent(item.meeting_id, 'RESULT_ANNOUNCED',
      { agendaItemId: itemId, result: item.result }, { agendaItemId: itemId, enteredBy: userId });
    return meetings.getItem(itemId);
  },

  /**
   * The Clerk attests to the result.
   *
   * Anchored to a chain position: the checkpoint records exactly what the
   * record consisted of at the moment of attestation, so "what did the Clerk
   * certify" is answerable by hash rather than by inference.
   */
  certify(itemId, { userId = null } = {}) {
    const item = meetings.getItem(itemId);
    if (!item) return null;
    if (!item.result_computed_at) throw new Error('A result must be computed before it can be certified.');
    const checkpoint = db.prepare(
      'SELECT event_hash FROM session_events WHERE meeting_id = ? ORDER BY seq DESC LIMIT 1')
      .get(item.meeting_id);
    db.prepare(`UPDATE agenda_items
      SET result_certified_at = datetime('now'), result_certified_by = ?, certification_checkpoint = ?
      WHERE id = ?`).run(userId, checkpoint ? checkpoint.event_hash : null, itemId);
    voteLedger.appendEvent(item.meeting_id, 'RESULT_CERTIFIED', {
      agendaItemId: itemId, result: item.result,
      preCertificationCheckpoint: checkpoint ? checkpoint.event_hash : null,
    }, { agendaItemId: itemId, enteredBy: userId });
    return meetings.getItem(itemId);
  },

  /** Published to the public record. */
  publish(itemId, { userId = null } = {}) {
    const item = meetings.getItem(itemId);
    if (!item) return null;
    if (!item.result_certified_at) throw new Error('A result must be certified before it is published.');
    db.prepare("UPDATE agenda_items SET result_published_at = datetime('now') WHERE id = ?").run(itemId);
    voteLedger.appendEvent(item.meeting_id, 'RESULT_PUBLISHED',
      { agendaItemId: itemId, result: item.result }, { agendaItemId: itemId, enteredBy: userId });
    return meetings.getItem(itemId);
  },

  /** Retract the outcome a close recorded, without touching the ballots. */
  retractOutcome(item, { reason, userId = null }) {
    meetings.setItemResult(item.id, item.action, null);
    if (!item.matter_id) return 0;
    let n = 0;
    for (const h of matters.liveHistoryForItem(item.id)) {
      matters.voidHistory(h.id, { reason, userId });
      n++;
    }
    return n;
  },

  /**
   * Reopen the floor on an item that was closed.
   *
   * Ballots are kept: reopening is usually a correction to the roll, not a
   * repudiation of everyone's vote, and members who are not changing their
   * position should not have to cast again.
   */
  reopen(itemId, { userId = null } = {}) {
    const item = meetings.getItem(itemId);
    if (!item) return null;
    // Before anything is retracted. openRoll refuses this too, but by then
    // retractOutcome has already voided the item's history rows — a refusal
    // that has already destroyed something is not a refusal.
    if (item.consent_group_id) {
      const e = new Error('This item is on the consent calendar. '
        + 'Remove it from the calendar to consider it separately.');
      e.code = 'ON_CONSENT_CALENDAR';
      throw e;
    }
    /*
     * Putting a new question is not reopening the old one.
     *
     * After a body amends, the item's roll has closed on the amendment and the
     * main question as amended is still to be taken — on the same item, so it
     * arrives here. Retracting would strip the amendment's certification and
     * void the matter's history rows for a result that stands: the body did
     * vote on the amendment, and that outcome is not superseded by the vote
     * that follows it.
     *
     * A motion version created since the last close and never put to a roll is
     * exactly that case, and nothing else is.
     */
    const pending = motionVersions.latest(item.id);
    const newQuestion = !!pending && !pending.vote_opened_at && !pending.vote_closed_at;
    const wasClosed = item.vote_status === 'closed' && !newQuestion;
    if (wasClosed) {
      this.retractOutcome(item, {
        reason: 'Vote reopened; this outcome was superseded', userId,
      });
    }
    // An item whose roll is still open is not something to tidy away. Setting
    // it back to 'pending' appended no ROLL_CLOSED, computed no result and
    // wrote no history, so its ballots stayed in the ledger while the item
    // showed as never voted. Refuse instead, and name the item in the way —
    // closing it for the clerk would record an outcome nobody asked for.
    const stillOpen = meetings.items(item.meeting_id)
      .find((it) => it.vote_status === 'open' && it.id !== item.id);
    if (stillOpen) {
      const err = new Error('The roll on '
        + (stillOpen.agenda_number ? `item ${stillOpen.agenda_number}` : 'another item')
        + ' is still open. Close it before opening this one.');
      err.code = 'ROLL_ALREADY_OPEN';
      throw err;
    }
    meetings.setVoteStatus(item.id, 'open');
    // Reopening clears the close: the previous instant no longer bounds
    // anything, and leaving it would make the live roll compute against a
    // window that has already ended.
    this.openRoll(item.id, { userId });
    return { reopened: wasClosed };
  },

  /**
   * Void the vote entirely.
   *
   * The ballots go too. A voided vote whose individual Yeas and Nays remained
   * attributable would keep every member on record for a vote the Board has
   * said did not happen. They remain in the ledger — that is what the ledger
   * is for — but they stop counting and stop being displayed as anyone's
   * current position.
   *
   * A reason is required. A vote struck from the record on no stated ground is
   * precisely what someone auditing that record needs to be able to rule out.
   */
  void(itemId, { reason, userId = null } = {}) {
    const clean = String(reason || '').trim();
    if (!clean) throw new Error('A reason is required to void a vote.');
    const item = meetings.getItem(itemId);
    if (!item) return null;

    this.retractOutcome(item, { reason: clean, userId });
    votes.clearForItem(item.id);
    meetings.setVoteStatus(item.id, 'pending');
    db.prepare(`UPDATE agenda_items SET vote_closed_at = NULL, result_computed_at = NULL,
      threshold_rule = NULL,
      result_announced_at = NULL, result_certified_at = NULL, result_published_at = NULL
      WHERE id = ?`).run(item.id);
    // The question the void was on gives up its result too. Leaving it would
    // put the item back to pending with a decided motion still sitting on it,
    // and the next attempt to state the motion would be refused as an edit to
    // something already voted on — a vote the board has said did not happen.
    const version = motionVersions.latest(item.id);
    if (version) {
      db.prepare(`UPDATE motion_versions
        SET vote_closed_at = NULL, result = NULL WHERE id = ?`).run(version.id);
    }
    // VOTE_VOIDED, not CORRECTION_APPROVED. This borrowed the corrections type
    // because there was nothing else, which left the striking of a vote
    // indistinguishable from an approved minutes correction — and left nothing
    // for the projection to key on, so the struck ballots went on counting.
    voteLedger.appendEvent(item.meeting_id, 'VOTE_VOIDED',
      { agendaItemId: item.id, reason: clean,
        motionVersionId: version ? version.id : null },
      { agendaItemId: item.id, enteredBy: userId });
    if (item.matter_id) {
      // The voiding is itself an act the record should show. A history that
      // simply loses the entry would read as though the vote never happened.
      matters.addHistory({
        matter_id: item.matter_id, action_date: todayISO(),
        body_id: item.body_id, action: 'Vote voided', result: null,
        notes: clean, meeting_id: item.meeting_id, agenda_item_id: item.id,
      });
    }
    return { voided: true };
  },
};

/**
 * Who may vote on an item, and what it takes to carry.
 *
 * The distinction the previous arithmetic missed: *seated* is not *present* is
 * not *eligible*. A recused member is present and seated but must not count
 * toward the threshold — leaving them in the denominator means a motion needing
 * "a majority of eligible members" can be defeated by the recusal itself,
 * which inverts the point of recusing.
 *
 * `majority_full` previously divided the whole seat count, so an absent or
 * recused member counted as an effective No. That is right for some bodies and
 * wrong for others, and it was never a decision anyone made — it was the only
 * denominator to hand.
 */
const eligibility = {
  /**
   * @returns {{seated:number, present:number, recused:number, eligible:number,
   *            notVoted:number, roll:Array}}
   */
  forItem(agendaItemId, opts = {}) {
    // getItem, not a bare SELECT: body_id is the meeting's, reaching the item
    // only through that join. Reading the row directly yields undefined and a
    // silently empty roll.
    const item = meetings.getItem(agendaItemId);
    if (!item) return null;
    // The one roll. This used to select body_members directly, which counted a
    // member whose term had run out and an ex-officio member who does not
    // vote — both toward the quorum and both into the majority_full
    // denominator. A three-member body could carry a motion 2–1 and have it
    // recorded as failed, because the base was five.
    const seated = bodies.votingRoll(item.body_id || 0);

    // Attendance is recorded per meeting; absent anything explicit, a seated
    // member is treated as present. Assuming absence would silently shrink the
    // body every time a clerk had not yet taken the roll.
    const attendance = new Map(
      db.prepare('SELECT person_id, status FROM attendance WHERE meeting_id = ?')
        .all(item.meeting_id).map((a) => [a.person_id, a.status]));

    // No bound here on purpose: the roll shown to the clerk is what has been
    // received. Whether a given event counts is decided by outcome(), against
    // the close.
    const standing = voteLedger.current(agendaItemId, Object.assign({},
      opts.throughSeq !== undefined ? { throughSeq: opts.throughSeq } : {},
      opts.motionVersionId !== undefined ? { motionVersionId: opts.motionVersionId } : {}));
    const roll = seated.map((p) => {
      const att = attendance.get(p.id) || 'Present';
      const ev = standing.get(p.id);
      const choice = ev ? ev.choice : null;
      // A ballot in the ledger settles whether someone was in the room.
      // Attendance is a radio button a clerk may not have got back to; the
      // ledger is the append-only record this system exists to keep, and a
      // vote cannot be cast by somebody who was not there.
      //
      // The defect this replaces was not the choice of winner but the
      // incoherence: presence excluded the member from `eligible` while
      // outcome() counted their Yea regardless, so an absent member's ballot
      // raised the numerator and not the denominator, and a motion could carry
      // on arithmetic that appeared nowhere on the board.
      //
      // The contradiction is reported rather than resolved silently.
      const markedAway = att === 'Absent' || att === 'Excused';
      const present = !markedAway || !!choice;
      const attendanceConflict = markedAway && !!choice;
      const recused = choice === 'Recused';
      return {
        person_id: p.id, full_name: p.full_name, district: p.district,
        attendance: att, present, recused, choice, attendanceConflict,
        changed: !!(ev && ev.supersedes_event_id),
        // Shown, not hidden: a vote the clerk entered from the spoken roll is
        // a different fact from one the member pressed, and the board should
        // say which it is rather than presenting them identically.
        source: ev ? ev.source : null,
      };
    });

    const present = roll.filter((r) => r.present).length;
    const recused = roll.filter((r) => r.recused).length;
    return {
      seated: seated.length,
      present,
      recused,
      eligible: present - recused,
      notVoted: roll.filter((r) => r.present && !r.recused && !r.choice).length,
      roll,
    };
  },

  /**
   * Does the item carry?
   *
   * Returns the arithmetic as well as the answer, because a board that is told
   * only "Fail" cannot check the ruling, and the chair has to be able to state
   * the basis aloud.
   */
  outcome(agendaItemId, { throughSeq, motionVersionId } = {}) {
    const item = meetings.getItem(agendaItemId);
    if (!item) return null;
    // Which question is being counted. An item the body amended took more than
    // one roll, and re-deriving the amendment's tally after the measure was
    // voted on must read the amendment's ballots, not the measure's.
    const version = motionVersionId !== undefined
      ? motionVersionId : voteLedger.motionVersionFor(agendaItemId);
    // Bounded by the close's position in the chain. Anything after it is kept
    // and excluded here, so a settled result cannot drift.
    const bound = throughSeq !== undefined
      ? throughSeq : voteLedger.closedSeq(agendaItemId, version);
    const e = this.forItem(agendaItemId, { throughSeq: bound, motionVersionId: version });
    if (!e) return null;
    // The rule recorded with the roll, not whatever the config says today. A
    // version carries the rule its own roll was taken under, which is not
    // necessarily the item's: an amendment can need a majority where the
    // measure it amends needs two thirds.
    const forVersion = version != null ? motionVersions.get(version) : null;
    const threshold = (forVersion && forVersion.vote_closed_at && forVersion.threshold)
      || item.threshold_rule || item.vote_threshold || 'majority';
    const yea = e.roll.filter((r) => r.choice === 'Yea').length;
    const nay = e.roll.filter((r) => r.choice === 'Nay').length;

    let required;
    let passes;
    if (threshold === 'two_thirds') {
      const cast = yea + nay;
      required = cast ? Math.ceil((cast * 2) / 3) : 0;
      passes = cast > 0 && yea >= required;
    } else if (threshold === 'majority_full') {
      required = Math.floor(e.eligible / 2) + 1;
      passes = yea >= required;
    } else {
      required = nay + 1;
      passes = yea > nay;
    }
    return {
      ...e, yea, nay, threshold, required, passes,
      throughSeq: bound,
      motionVersionId: version ?? null,
      closed: bound != null,
      late: bound != null ? voteLedger.late(agendaItemId, version).length : 0,
      result: passes ? 'Pass' : 'Fail',
      basis: threshold === 'majority_full'
        ? `majority of ${e.eligible} eligible`
        : threshold === 'two_thirds' ? 'two-thirds of those voting' : 'majority of those voting',
    };
  },
};

/** Motion text, versioned, so a vote binds to what was actually on the floor. */
/**
 * The motion as the body actually put it, version by version.
 *
 * This table has existed since the vote ledger did and nothing wrote to it.
 * `agenda_items` carries one motion_text, one mover, one threshold and one
 * result, so a question that was moved, amended, and then voted on as amended
 * could be recorded only as its final state — the record said what was adopted
 * and never that it had been changed, by whom, or that the amendment was itself
 * voted on first. That is the difference between recording outcomes and
 * recording proceedings, and it is why a clerk still keeps a paper pad.
 *
 * Two verbs, deliberately different acts:
 *
 *   ensure()  states the motion as it stands. It creates the first version and
 *             thereafter edits it in place. Typing in the motion box is not an
 *             amendment; it is a clerk writing down what was moved.
 *   amend()   puts a new question. A new version, a new roll, a new result.
 *
 * The distinction is not cosmetic. Ballots are windowed by version, so a
 * version created by accident — a clerk fixing a typo mid-roll — would silently
 * discard every vote already cast. `ensure` can therefore never create one.
 */
const MOTION_KINDS = ['main', 'amendment', 'substitute', 'procedural'];

const motionVersions = {
  /**
   * Record the motion as it stands, in place.
   *
   * Never creates a second version: see above. Returns the version the item's
   * ballots belong to.
   */
  ensure(agendaItemId, { motionText, moverId, seconderId, threshold, kind, userId = null } = {}) {
    const latest = this.latest(agendaItemId);
    if (!latest) {
      const id = db.prepare(`INSERT INTO motion_versions
        (agenda_item_id, seq, motion_text, mover_id, seconder_id, threshold, kind, created_by)
        VALUES (?,1,?,?,?,?,?,?)`).run(agendaItemId, motionText || null,
        moverId || null, seconderId || null, threshold || 'majority',
        MOTION_KINDS.includes(kind) ? kind : 'main', userId).lastInsertRowid;
      const item = meetings.getItem(agendaItemId);
      if (item) {
        voteLedger.appendEvent(item.meeting_id, 'MOTION_CREATED',
          { agendaItemId, motionVersionId: id, seq: 1, motionText: motionText || null },
          { agendaItemId, enteredBy: userId, motionVersionId: id });
      }
      return this.get(id);
    }
    // Rewording the question is not the same edit as naming who moved it.
    //
    // motion_text and threshold are the question and the arithmetic: change
    // either and the ballots already cast answered something else. Mover and
    // seconder are attribution, and a clerk filling in a seconder they missed
    // is bookkeeping, not a new motion — so those stay editable throughout.
    const wantsThreshold = threshold || latest.threshold || 'majority';
    const changesQuestion = (motionText || null) !== (latest.motion_text || null)
      || wantsThreshold !== latest.threshold;
    if (changesQuestion) {
      if (latest.vote_closed_at) {
        const e = new Error('This motion has already been voted on. '
          + 'Move an amendment to put a new question.');
        e.code = 'MOTION_DECIDED';
        throw e;
      }
      // Ballots, not the open roll.
      //
      // The console's motion form lives on the active card, which exists only
      // once the roll is open — so refusing every edit under an open roll made
      // the form unusable for the thing it is for. What is actually unsafe is
      // rewording a question somebody has already answered; before the first
      // ballot the clerk is still writing down what was moved.
      if (voteLedger.current(agendaItemId, { throughSeq: null, motionVersionId: latest.id }).size) {
        const e = new Error('Members have already voted on this question. '
          + 'Void the roll to reword it, or move an amendment to put a new one.');
        e.code = 'MOTION_ON_FLOOR';
        throw e;
      }
    }
    db.prepare(`UPDATE motion_versions
      SET motion_text = ?, mover_id = ?, seconder_id = ?, threshold = ? WHERE id = ?`)
      .run(motionText || null, moverId || null, seconderId || null,
        wantsThreshold, latest.id);
    return this.get(latest.id);
  },

  /**
   * Put a new question on this item.
   *
   * The act a body performs when it amends, substitutes, or moves something
   * incidental during consideration. A version that never took a roll is
   * marked superseded rather than deleted: it was moved, and the record of a
   * meeting includes what was moved and withdrawn.
   */
  amend(agendaItemId, { motionText, moverId, seconderId, threshold, kind = 'amendment',
    userId = null } = {}) {
    const latest = this.latest(agendaItemId);
    // Ballots, not the roll, are what makes this unsafe.
    //
    // A chair opens the roll and a member moves to amend before anybody has
    // voted: ordinary, and nothing is lost by putting the new question. Once
    // ballots exist they were cast on the question as it stood, and a new
    // version would window them out of every tally — the votes would still be
    // in the ledger and counted by nothing. So that case is refused, and the
    // clerk voids the roll with a reason instead, which leaves a record of why
    // the first question was abandoned.
    if (latest && !latest.vote_closed_at
      && voteLedger.current(agendaItemId, { throughSeq: null, motionVersionId: latest.id }).size) {
      const e = new Error('Members have already voted on this question. '
        + 'Close or void the roll before putting a new one.');
      e.code = 'BALLOTS_CAST';
      throw e;
    }
    const seq = latest ? latest.seq + 1 : 1;
    // An amendment is subsidiary: it does not withdraw the motion it amends.
    //
    // Marking the main motion superseded the moment an amendment was moved
    // made the minutes read "Main motion: … Withdrawn before the question was
    // put", which is the opposite of what happened — the body was about to
    // vote on it, as amended. Only a motion that replaces the question itself
    // supersedes what came before.
    const replaces = kind === 'main' || kind === 'substitute';
    if (replaces) {
      db.prepare(`UPDATE motion_versions SET superseded_at = datetime('now')
        WHERE agenda_item_id = ? AND vote_closed_at IS NULL AND superseded_at IS NULL
          AND kind IN ('main','substitute')`).run(agendaItemId);
    }
    const id = db.prepare(`INSERT INTO motion_versions
      (agenda_item_id, seq, motion_text, mover_id, seconder_id, threshold, kind, created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(agendaItemId, seq, motionText || null,
      moverId || null, seconderId || null,
      threshold || (latest && latest.threshold) || 'majority',
      MOTION_KINDS.includes(kind) ? kind : 'amendment', userId).lastInsertRowid;
    const item = meetings.getItem(agendaItemId);
    if (item) {
      voteLedger.appendEvent(item.meeting_id, 'MOTION_AMENDED',
        { agendaItemId, motionVersionId: id, seq, kind, motionText: motionText || null,
          supersedes: latest ? latest.id : null },
        { agendaItemId, enteredBy: userId, motionVersionId: id });
    }
    return this.get(id);
  },

  /** The roll on one version, written where the version can be read with it. */
  recordOpen(id) {
    db.prepare(`UPDATE motion_versions
      SET vote_opened_at = datetime('now'), vote_closed_at = NULL, result = NULL
      WHERE id = ?`).run(id);
  },
  recordClose(id, result) {
    db.prepare("UPDATE motion_versions SET vote_closed_at = datetime('now'), result = ? WHERE id = ?")
      .run(result || null, id);
  },

  get(id) {
    return db.prepare('SELECT * FROM motion_versions WHERE id = ?').get(id);
  },
  latest(agendaItemId) {
    return db.prepare(
      'SELECT * FROM motion_versions WHERE agenda_item_id = ? ORDER BY seq DESC LIMIT 1')
      .get(agendaItemId);
  },
  /**
   * The whole sequence, with the people named.
   *
   * The minutes and the item report both need "moved by X, seconded by Y",
   * and joining people at every call site is how two screens end up
   * disagreeing about the same motion.
   */
  all(agendaItemId) {
    return db.prepare(`
      SELECT mv.*, mo.full_name AS mover_name, se.full_name AS seconder_name
      FROM motion_versions mv
      LEFT JOIN people mo ON mo.id = mv.mover_id
      LEFT JOIN people se ON se.id = mv.seconder_id
      WHERE mv.agenda_item_id = ? ORDER BY mv.seq`).all(agendaItemId);
  },
  /**
   * The sequence in the words minutes use.
   *
   * Phrased once, here, because the meeting page, the per-item report, the
   * minutes and the packet all have to say the same thing about the same
   * motion — and a phrase assembled independently at four call sites is four
   * chances for two screens to describe one vote differently.
   *
   * Returns nothing at all for an item with a single motion: that is already
   * printed as the item's motion line, and a one-entry "sequence" would be an
   * elaborate way of repeating it.
   */
  narrative(agendaItemId) {
    const all = this.all(agendaItemId);
    if (all.length < 2) return [];
    const LABEL = {
      main: 'Main motion', amendment: 'Amendment',
      substitute: 'Substitute motion', procedural: 'Procedural motion',
    };
    return all.map((m) => {
      const who = [];
      if (m.mover_name) who.push(`moved by ${m.mover_name}`);
      if (m.seconder_name) who.push(`seconded by ${m.seconder_name}`);
      // A motion replaced after the body amended it was not withdrawn — it was
      // amended, and the amendment is in this same sequence saying so. Only a
      // motion replaced with nothing carried against it was given up on.
      const amended = all.some((o) => o.seq > m.seq && o.kind === 'amendment' && o.result === 'Pass');
      let outcome = null;
      if (m.result) outcome = m.result === 'Pass' ? 'Carried' : 'Failed';
      else if (m.superseded_at && !amended) outcome = 'Withdrawn before the question was put';
      // A motion is a sentence and is printed as one. Clerks type "That it be
      // adopted" without a full stop, which ran into the next clause: "That it
      // be adopted Moved by Daniel Cho".
      const text = m.motion_text ? m.motion_text.trim() : null;
      return {
        seq: m.seq,
        kind: m.kind || 'main',
        label: LABEL[m.kind] || 'Motion',
        text: text && !/[.!?]$/.test(text) ? `${text}.` : text,
        moved: who.length ? who.join(', ').replace(/^m/, 'M') : null,
        outcome,
        threshold: m.threshold,
      };
    });
  },
  MOTION_KINDS,
};

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

  /**
   * Give this person the floor.
   *
   * Whoever held it before is marked as having spoken: only one person has the
   * floor, and leaving the previous speaker started would leave the board
   * counting two clocks and the record unable to say when the first sat down.
   */
  startSpeaking(id) {
    const s = speakers.get(id);
    if (!s) return null;
    db.prepare(`UPDATE speaker_requests SET status = 'Spoke'
      WHERE meeting_id = ? AND started_at IS NOT NULL AND status <> 'Spoke'`).run(s.meeting_id);
    db.prepare("UPDATE speaker_requests SET started_at = datetime('now'), status = 'Approved' WHERE id = ?")
      .run(id);
    return speakers.get(id);
  },

  /** Whoever currently holds the floor, if anyone. */
  speaking(meetingId) {
    return db.prepare(`
      SELECT s.*, ai.agenda_number, COALESCE(m.title, ai.title) AS item_title
      FROM speaker_requests s
      LEFT JOIN agenda_items ai ON ai.id = s.agenda_item_id
      LEFT JOIN matters m ON m.id = ai.matter_id
      WHERE s.meeting_id = ? AND s.started_at IS NOT NULL AND s.status <> 'Spoke'
      ORDER BY s.started_at DESC LIMIT 1`).get(meetingId);
  },

  /** Approved and still waiting, in the order they signed up. */
  queue(meetingId) {
    return db.prepare(`
      SELECT s.*, ai.agenda_number, COALESCE(m.title, ai.title) AS item_title
      FROM speaker_requests s
      LEFT JOIN agenda_items ai ON ai.id = s.agenda_item_id
      LEFT JOIN matters m ON m.id = ai.matter_id
      WHERE s.meeting_id = ? AND s.status = 'Approved' AND s.started_at IS NULL
      ORDER BY s.created_at`).all(meetingId);
  },
};

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
  MATTER_TYPES, LEGACY_MATTER_TYPES, ALL_MATTER_TYPES, MATTER_STATUSES, VOTE_VALUES, ITEM_TYPES, AGENDA_SECTIONS, TERMINAL_STATUSES, SORT_COLUMNS,
  ORG_LEVELS, MEMBER_MOTION_STATUSES, POLICY_STATUSES, USER_ROLES,
  BUDGET_STATUSES, BUDGET_KINDS, COMMENT_POSITIONS, workflowTemplate,
  people, bodies, matters, meetings, votes, reports, topics, workflow, org, memberMotions,
  letters, LETTER_SECTIONS_DEFAULT,
  policies, users, budget, comments, watches, speakers, applications, audit, savedSearches,
  implementation, vendors, procurement, tas, consents, code,
  voteLedger, motionVersions, eligibility, voteAdmin,
  RELATION_TYPES, SOLICITATION_KINDS, SOLICITATION_STATUSES, CONSENT_STATUSES, CODE_OPS,
  stats, statusBuckets, purgeDomainData,
};
