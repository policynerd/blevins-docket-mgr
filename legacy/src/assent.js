'use strict';

require('./schema-extra').apply();

const { db } = require('./db');
const repo = require('./repo');

function assent(id, { actorId = null, actorName = null } = {}) {
  const m = repo.matters.get(id);
  if (!m) throw new Error('No such file.');
  if (m.assented_at) {
    const err = new Error('Already assented.'); err.code = 'ASSENTED'; throw err;
  }
  if (m.status !== 'Passed') {
    const err = new Error('Assent follows a pass. This file has not passed.');
    err.code = 'NOT_PASSED'; throw err;
  }
  const today = require('./util').todayISO();
  db.prepare(`UPDATE matters
    SET status='Enacted', final_date=COALESCE(final_date, ?),
        assented_at=datetime('now'), assented_by=?, assented_by_name=?,
        updated_at=datetime('now')
    WHERE id=? AND assented_at IS NULL`).run(today, actorId, actorName || null, id);
  repo.matters.addHistory({
    matter_id: id, action_date: today, action: 'Assented', result: 'Pass',
    notes: actorName ? `Assented by ${actorName}` : null,
  });
  return repo.matters.get(id);
}

repo.matters.assent = assent;

module.exports = { assent };
