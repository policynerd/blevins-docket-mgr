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

const VALID_ROLES = ['public', 'member', 'staff', 'clerk'];

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

      // Resolve / create the person (needed for a seat; created when we have a name).
      let person = email ? personByEmail(email) : null;
      if (!person && name) {
        person = repo.people.get(repo.people.insert({ full_name: name, email: email || null }));
        r.peopleCreated++;
      }

      // Seat onto a committee (create the body if it doesn't exist yet).
      if (committee) {
        if (!person) { r.errors.push(`Line ${line}: a name is required to seat someone on "${committee}".`); return; }
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

module.exports = { importRoster };
