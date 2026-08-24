'use strict';

// Bulk roster import from CSV — the "data populate" / direct-seat bootstrap.
// Creates people and seats them onto committees directly (bypassing the
// Nominate->Approve->Seat workflow, which is meant for ongoing changes), and
// optionally provisions SSO login accounts with a role.
//
// CSV columns (header row, case-insensitive):
//   name, email, login_role, committee, committee_role
// One row per person *per committee* (repeat a person on multiple rows to put
// them on multiple committees). login_role may be blank or member/staff/clerk.
const { db } = require('./db');
const repo = require('./repo');
const { parseCsv } = require('./csv');

const VALID_ROLES = ['public', 'member', 'staff', 'clerk', 'admin'];

function personByEmail(email) {
  return db.prepare('SELECT * FROM people WHERE lower(email) = lower(?)').get(email);
}
function bodyByName(name) {
  return db.prepare('SELECT * FROM bodies WHERE lower(name) = lower(?)').get(name);
}
function userByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
}

function importRoster(text) {
  const rows = parseCsv(text);
  const r = {
    rows: rows.length, peopleCreated: 0, usersCreated: 0, usersUpdated: 0,
    seats: 0, committeesCreated: 0, errors: [],
  };
  if (!rows.length) {
    r.errors.push('No data rows found. Include a header row (name,email,login_role,committee,committee_role) and at least one data row.');
    return r;
  }

  db.exec('SAVEPOINT sp_import');
  try {
    rows.forEach((row, idx) => {
      const line = idx + 2; // +1 for header, +1 for 1-based
      const name = row.name || '';
      const email = (row.email || '').toLowerCase();
      const loginRole = (row.login_role || row.role || '').toLowerCase();
      const committee = row.committee || row.body || '';
      const seatRole = row.committee_role || row.seat_role || 'Member';

      if (!name && !email) { r.errors.push(`Line ${line}: row needs at least a name or an email.`); return; }
      if (loginRole && !VALID_ROLES.includes(loginRole)) {
        r.errors.push(`Line ${line}: invalid login_role "${loginRole}" (use member, staff, or clerk).`); return;
      }
      if (loginRole && !email) { r.errors.push(`Line ${line}: login_role given but no email.`); return; }

      // A person record is created only when seating onto a committee — that's
      // what makes someone a board/committee member (and lists them publicly).
      // Login-only rows (e.g. staff) get a user account but no directory entry.
      let person = email ? personByEmail(email) : null;

      // Seat onto a committee (create the body if it doesn't exist yet).
      if (committee) {
        if (!person) {
          if (!name) { r.errors.push(`Line ${line}: a name is required to seat someone on "${committee}".`); return; }
          person = repo.people.get(repo.people.insert({ full_name: name, email: email || null }));
          r.peopleCreated++;
        }
        let body = bodyByName(committee);
        if (!body) {
          body = repo.bodies.get(repo.bodies.insert({ name: committee, type: 'Standing Committee' }));
          r.committeesCreated++;
        }
        const dup = db.prepare('SELECT id FROM body_members WHERE body_id = ? AND person_id = ?')
          .get(body.id, person.id);
        if (!dup) { repo.bodies.addMember(body.id, person.id, seatRole || 'Member'); r.seats++; }
      }

      // Provision / update an SSO login account with a role.
      if (loginRole) {
        const existing = userByEmail(email);
        if (existing) {
          db.prepare('UPDATE users SET role = ?, person_id = COALESCE(person_id, ?), active = 1 WHERE id = ?')
            .run(loginRole, person ? person.id : null, existing.id);
          r.usersUpdated++;
        } else {
          db.prepare(`INSERT INTO users (person_id, name, email, role, auth_provider)
            VALUES (?,?,?,?, 'entra')`).run(person ? person.id : null, name || email, email, loginRole);
          r.usersCreated++;
        }
      }
    });
    db.exec('RELEASE sp_import');
  } catch (e) {
    db.exec('ROLLBACK TO sp_import'); db.exec('RELEASE sp_import');
    throw e;
  }
  return r;
}

// --- Legislative file (matter) import ----------------------------------------
// CSV columns (header row, case-insensitive):
//   file_number, type, title, status, body, intro_date, final_date,
//   summary, sponsors, topics
// file_number blank = auto-assign (YYMMXX). sponsors/topics are
// semicolon-separated; the first sponsor is Primary. body matches an existing
// body by name — matters aren't allowed to invent bodies from typos.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function personByName(name) {
  return db.prepare('SELECT * FROM people WHERE lower(full_name) = lower(?)').get(name);
}
function matterByFileNumber(fn) {
  return db.prepare('SELECT id FROM matters WHERE file_number = ?').get(fn);
}

function importMatters(text) {
  const rows = parseCsv(text);
  const r = {
    rows: rows.length, created: 0, sponsorsLinked: 0, historyAdded: 0,
    errors: [], warnings: [],
  };
  if (!rows.length) {
    r.errors.push('No data rows found. Include a header row (file_number,type,title,status,body,intro_date,final_date,summary,sponsors,topics) and at least one data row.');
    return r;
  }

  db.exec('SAVEPOINT sp_import_matters');
  try {
    rows.forEach((row, idx) => {
      const line = idx + 2;
      const title = (row.title || '').trim();
      const type = (row.type || '').trim();
      const status = (row.status || 'Draft').trim();
      const fileNumber = (row.file_number || row['file #'] || '').trim();
      const bodyName = (row.body || row.committee || '').trim();
      const introDate = (row.intro_date || row.introduced || '').trim();
      const finalDate = (row.final_date || '').trim();

      if (!title) { r.errors.push(`Line ${line}: title is required.`); return; }
      if (!repo.ALL_MATTER_TYPES.includes(type)) {
        r.errors.push(`Line ${line}: invalid type "${type}" (use one of: ${repo.MATTER_TYPES.join(', ')}).`); return;
      }
      if (!repo.MATTER_STATUSES.includes(status)) {
        r.errors.push(`Line ${line}: invalid status "${status}" (use one of: ${repo.MATTER_STATUSES.join(', ')}).`); return;
      }
      if (introDate && !DATE_RE.test(introDate)) { r.errors.push(`Line ${line}: intro_date must be YYYY-MM-DD.`); return; }
      if (finalDate && !DATE_RE.test(finalDate)) { r.errors.push(`Line ${line}: final_date must be YYYY-MM-DD.`); return; }
      if (fileNumber && matterByFileNumber(fileNumber)) {
        r.errors.push(`Line ${line}: file number ${fileNumber} already exists — row skipped.`); return;
      }
      let body = null;
      if (bodyName) {
        body = bodyByName(bodyName);
        if (!body) { r.errors.push(`Line ${line}: unknown body "${bodyName}" — create it first (Admin → Bodies).`); return; }
      }

      const record = {
        type, title, status, body_id: body ? body.id : null,
        intro_date: introDate || null, summary: (row.summary || '').trim() || null,
        full_text: (row.full_text || '').trim() || null,
      };
      let id;
      if (fileNumber) {
        id = repo.matters.insert({ ...record, file_number: fileNumber });
      } else {
        id = repo.matters.insertNumbered(record).id;
      }
      if (finalDate) db.prepare('UPDATE matters SET final_date = ? WHERE id = ?').run(finalDate, id);
      r.created++;

      // Sponsors: semicolon-separated full names; first is Primary.
      const names = String(row.sponsors || '').split(';').map((s) => s.trim()).filter(Boolean);
      names.forEach((n, i) => {
        const p = personByName(n);
        if (!p) { r.warnings.push(`Line ${line}: sponsor "${n}" not found — skipped (file imported).`); return; }
        repo.matters.addSponsor(id, p.id, i === 0 ? 'Primary' : 'Co-Sponsor');
        r.sponsorsLinked++;
      });

      const topicNames = String(row.topics || '').split(';').map((s) => s.trim()).filter(Boolean);
      if (topicNames.length) repo.topics.setForMatter(id, topicNames);

      if (introDate) {
        repo.matters.addHistory({
          matter_id: id, action_date: introDate, body_id: body ? body.id : null,
          action: 'Introduced', notes: 'Imported record',
        });
        r.historyAdded++;
      }
    });
    db.exec('RELEASE sp_import_matters');
  } catch (e) {
    db.exec('ROLLBACK TO sp_import_matters'); db.exec('RELEASE sp_import_matters');
    throw e;
  }
  return r;
}

// --- Budget imports -----------------------------------------------------------
// Lines CSV: category, name, kind, amount, appropriation_code, project_code —
// one row per line item. The two code columns are optional and round-trip with
// the budget-lines export.
function importBudgetLines(budgetId, text) {
  const rows = parseCsv(text);
  const r = { rows: rows.length, created: 0, errors: [] };
  if (!rows.length) {
    r.errors.push('No data rows found. Include a header row (category,name,kind,amount).');
    return r;
  }
  db.exec('SAVEPOINT sp_import_blines');
  try {
    rows.forEach((row, idx) => {
      const line = idx + 2;
      const name = (row.name || row.line || '').trim();
      if (!name) { r.errors.push(`Line ${line}: name is required.`); return; }
      const kind = /^rev/i.test(row.kind || '') ? 'Revenue' : 'Expense';
      const amount = Number(String(row.amount || '0').replace(/[$,]/g, ''));
      if (!Number.isFinite(amount)) { r.errors.push(`Line ${line}: amount "${row.amount}" is not a number.`); return; }
      repo.budget.addLine({
        budget_id: budgetId, category: (row.category || '').trim() || null, name, kind, amount,
        appropriation_code: (row.appropriation_code || '').trim() || null,
        project_code: (row.project_code || '').trim() || null,
      });
      r.created++;
    });
    db.exec('RELEASE sp_import_blines');
  } catch (e) {
    db.exec('ROLLBACK TO sp_import_blines'); db.exec('RELEASE sp_import_blines');
    throw e;
  }
  return r;
}

// Transactions CSV: date, line, description, amount — matched to the budget's
// lines by name (optionally "Category — Name" / "Category - Name").
function importBudgetTransactions(budgetId, text) {
  const rows = parseCsv(text);
  const r = { rows: rows.length, created: 0, errors: [] };
  if (!rows.length) {
    r.errors.push('No data rows found. Include a header row (date,line,description,amount).');
    return r;
  }
  const lines = repo.budget.lines(budgetId);
  const byName = new Map();
  for (const l of lines) {
    byName.set(l.name.toLowerCase(), l);
    if (l.category) byName.set(`${l.category} — ${l.name}`.toLowerCase(), l);
    if (l.category) byName.set(`${l.category} - ${l.name}`.toLowerCase(), l);
  }
  db.exec('SAVEPOINT sp_import_btx');
  try {
    rows.forEach((row, idx) => {
      const n = idx + 2;
      const date = (row.date || row.tx_date || '').trim();
      const lineName = (row.line || row.name || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { r.errors.push(`Line ${n}: date must be YYYY-MM-DD.`); return; }
      const target = byName.get(lineName.toLowerCase());
      if (!target) { r.errors.push(`Line ${n}: no budget line named "${lineName}".`); return; }
      const amount = Number(String(row.amount || '').replace(/[$,]/g, ''));
      if (!Number.isFinite(amount)) { r.errors.push(`Line ${n}: amount "${row.amount}" is not a number.`); return; }
      repo.budget.addTransaction({
        budget_line_id: target.id, tx_date: date,
        description: (row.description || '').trim() || null, amount,
      });
      r.created++;
    });
    db.exec('RELEASE sp_import_btx');
  } catch (e) {
    db.exec('ROLLBACK TO sp_import_btx'); db.exec('RELEASE sp_import_btx');
    throw e;
  }
  return r;
}

// --- TAS register import -----------------------------------------------------
// Treasury Account Symbol catalog. Columns (headers are case-insensitive):
// AID, Main, X-YEAR, TAS, Agency, Title, Fund Type, Independent Agencies,
// Last update. TAS is the key and the only required field; re-importing the
// same TAS updates it in place, so the register is a maintainable source file.
function importTasRegister(text) {
  const rows = parseCsv(text);
  const r = { rows: rows.length, created: 0, updated: 0, errors: [] };
  if (!rows.length) {
    r.errors.push('No data rows found. Include a header row (AID,Main,X-YEAR,TAS,Agency,Title,Fund Type,Independent Agencies,Last update).');
    return r;
  }
  db.exec('SAVEPOINT sp_import_tas');
  try {
    rows.forEach((row, idx) => {
      const line = idx + 2;
      const tas = (row.tas || '').trim();
      if (!tas) { r.errors.push(`Line ${line}: TAS is required.`); return; }
      const outcome = repo.tas.upsert({
        tas,
        aid: (row.aid || '').trim(),
        main: (row.main || '').trim(),
        avail: (row['x-year'] || row.avail || '').trim(),
        agency: (row.agency || '').trim(),
        title: (row.title || '').trim(),
        fund_type: (row['fund type'] || row.fund_type || '').trim(),
        independent_agencies: (row['independent agencies'] || row.independent_agencies || '').trim(),
        source_updated: (row['last update'] || row.last_update || '').trim(),
      });
      if (outcome === 'created') r.created++;
      else if (outcome === 'updated') r.updated++;
    });
    db.exec('RELEASE sp_import_tas');
  } catch (e) {
    db.exec('ROLLBACK TO sp_import_tas'); db.exec('RELEASE sp_import_tas');
    throw e;
  }
  return r;
}

// --- Org chart import (units + their leaders) --------------------------------
// Columns: level, name, parent, leader_name, leader_title, leader_email,
// leader_phone, description. `parent` is another unit's name — list parents
// before their children (or they can already exist). Adds units; never deletes.
function importOrgUnits(text) {
  const rows = parseCsv(text);
  const r = { rows: rows.length, created: 0, errors: [] };
  if (!rows.length) {
    r.errors.push('No data rows found. Include a header row (level,name,parent,leader_name,leader_title,leader_email,leader_phone,description).');
    return r;
  }
  // name -> id for existing units plus any created during this import (parents).
  const byName = new Map();
  for (const u of repo.org.all()) byName.set(u.name.toLowerCase(), u.id);
  db.exec('SAVEPOINT sp_import_org');
  try {
    rows.forEach((row, idx) => {
      const line = idx + 2;
      const name = (row.name || '').trim();
      const level = (row.level || '').trim();
      if (!name) { r.errors.push(`Line ${line}: name is required.`); return; }
      if (!repo.ORG_LEVELS.includes(level)) {
        r.errors.push(`Line ${line}: invalid level "${level}" (use one of: ${repo.ORG_LEVELS.join(', ')}).`); return;
      }
      const parentName = (row.parent || row.parent_name || '').trim();
      let parentId = null;
      if (parentName) {
        parentId = byName.get(parentName.toLowerCase());
        if (parentId == null) {
          r.errors.push(`Line ${line}: parent "${parentName}" not found — list it earlier in the file or create it first.`); return;
        }
      }
      const id = repo.org.insert({
        parent_id: parentId, level, name,
        leader_name: (row.leader_name || row.leader || '').trim() || null,
        leader_title: (row.leader_title || row.title || '').trim() || null,
        leader_email: (row.leader_email || row.email || '').trim() || null,
        leader_phone: (row.leader_phone || row.phone || '').trim() || null,
        description: (row.description || '').trim() || null,
        sort_order: Number(row.sort_order) || 0,
      });
      byName.set(name.toLowerCase(), id);
      r.created++;
    });
    db.exec('RELEASE sp_import_org');
  } catch (e) {
    db.exec('ROLLBACK TO sp_import_org'); db.exec('RELEASE sp_import_org');
    throw e;
  }
  return r;
}

module.exports = {
  importRoster, importMatters, importBudgetLines, importBudgetTransactions, importTasRegister, importOrgUnits,
};
