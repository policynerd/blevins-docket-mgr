'use strict';

// Who can see what.
//
// The application's authorization used to be three path prefixes and nothing
// else, so every record outside /admin, /govern and /member was readable by
// anyone who knew the URL — draft agendas, empty board letters, minutes the
// view itself labelled "Draft", and every uploaded attachment by integer id.
//
// These tests fix the rule in place: a signed-out visitor sees only what a
// clerk has deliberately published, and an insider sees exactly what they saw
// before. They are written against the predicates and against the queries the
// lists are built from, because a predicate that is right at the detail route
// and a query that is wrong at the index leaks just as much.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vis-test-')), 'test.db');

const { init } = require('../src/db');
init();
const repo = require('../src/repo');
const visibility = require('../src/visibility');

// The four kinds of reader the rule has to distinguish. `public` is a real
// stored role — vendor registration creates one — and it must rank with the
// signed-out visitor, not with the staff.
const anon = null;
const registered = { id: 1, role: 'public' };
const member = { id: 2, role: 'member' };
const chair = { id: 3, role: 'staff' };
const clerk = { id: 4, role: 'clerk' };

const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Body', seats: 5 });

// --- The predicates ---------------------------------------------------------

test('an unpublished matter is invisible to the public and visible to insiders', () => {
  const draft = { id: 1, published_at: null };
  assert.equal(visibility.canSeeMatter(anon, draft), false);
  assert.equal(visibility.canSeeMatter(registered, draft), false);
  assert.equal(visibility.canSeeMatter(member, draft), true);
  assert.equal(visibility.canSeeMatter(chair, draft), true);
  assert.equal(visibility.canSeeMatter(clerk, draft), true);
});

test('a published matter is visible to everyone', () => {
  const live = { id: 1, published_at: '2026-08-30 10:00:00' };
  for (const who of [anon, registered, member, chair, clerk]) {
    assert.equal(visibility.canSeeMatter(who, live), true);
  }
});

test('a missing record is invisible to everyone, clerk included', () => {
  for (const who of [anon, registered, member, clerk]) {
    assert.equal(visibility.canSeeMatter(who, null), false);
    assert.equal(visibility.canSeeAgenda(who, undefined), false);
    assert.equal(visibility.canSeeReport(who, null), false);
    assert.equal(visibility.canSeeMinutes(who, null), false);
  }
});

test('minutes follow the status column that already existed', () => {
  assert.equal(visibility.canSeeMinutes(anon, { minutes_status: 'none' }), false);
  assert.equal(visibility.canSeeMinutes(anon, { minutes_status: 'draft' }), false);
  assert.equal(visibility.canSeeMinutes(anon, { minutes_status: 'published' }), true);
  // The draft a clerk is still editing stays reachable for them.
  assert.equal(visibility.canSeeMinutes(clerk, { minutes_status: 'draft' }), true);
});

test('a board letter is not public merely because it exists', () => {
  // The failure this whole change undoes: `reports` had no state at all, so a
  // letter was at a public URL from the moment its empty template was inserted.
  assert.equal(visibility.canSeeReport(anon, { id: 7, published_at: null }), false);
  assert.equal(visibility.canSeeReport(clerk, { id: 7, published_at: null }), true);
});

// --- The queries the lists are built from -----------------------------------

test('an unpublished file is absent from the public list and present for a member', () => {
  const { id } = repo.matters.insertNumbered({
    type: 'Resolution', title: 'Unpublished measure', status: 'Draft', body_id: bodyId,
  });
  const publicRows = repo.matters.search({ publicOnly: true }).map((m) => m.id);
  const insiderRows = repo.matters.search({ publicOnly: false }).map((m) => m.id);
  assert.equal(publicRows.includes(id), false);
  assert.equal(insiderRows.includes(id), true);

  repo.matters.publish(id);
  assert.equal(repo.matters.search({ publicOnly: true }).map((m) => m.id).includes(id), true);
});

test('the pager counts the same rows the page shows', () => {
  // count() and search() share _filter, so a flag that reached only one of them
  // would page over rows nobody is shown and hand back empty trailing pages.
  const publicCount = repo.matters.count({ publicOnly: true });
  const publicRows = repo.matters.search({ publicOnly: true, limit: 1000 });
  assert.equal(publicCount, publicRows.length);
  assert.ok(repo.matters.count({}) >= publicCount);
});

test('unpublishing takes a file back off the public list', () => {
  const { id } = repo.matters.insertNumbered({
    type: 'Ordinance', title: 'Briefly public', status: 'Introduced', body_id: bodyId,
  });
  repo.matters.publish(id);
  assert.equal(repo.matters.search({ publicOnly: true }).map((m) => m.id).includes(id), true);
  repo.matters.unpublish(id);
  assert.equal(repo.matters.search({ publicOnly: true }).map((m) => m.id).includes(id), false);
});

test('publish is idempotent and does not move the timestamp', () => {
  const { id } = repo.matters.insertNumbered({
    type: 'Resolution', title: 'Published twice', status: 'Introduced', body_id: bodyId,
  });
  repo.matters.publish(id);
  const first = repo.matters.get(id).published_at;
  repo.matters.publish(id);
  assert.equal(repo.matters.get(id).published_at, first);
});

test('an unpublished agenda is absent from the public calendar and meeting list', () => {
  const meetingId = repo.meetings.insert({ body_id: bodyId, meeting_date: '2026-09-15' });
  const ids = (rows) => rows.map((m) => m.id);
  assert.equal(ids(repo.meetings.all({ publicOnly: true })).includes(meetingId), false);
  assert.equal(ids(repo.meetings.all()).includes(meetingId), true);
  assert.equal(ids(repo.meetings.upcoming('2026-01-01', 50, { publicOnly: true })).includes(meetingId), false);

  repo.meetings.publishAgenda(meetingId);
  assert.equal(ids(repo.meetings.all({ publicOnly: true })).includes(meetingId), true);
  assert.equal(ids(repo.meetings.upcoming('2026-01-01', 50, { publicOnly: true })).includes(meetingId), true);

  repo.meetings.unpublishAgenda(meetingId);
  assert.equal(ids(repo.meetings.all({ publicOnly: true })).includes(meetingId), false);
});

test('the calendar pager and the calendar page agree for a public viewer', () => {
  const args = { view: 'all', today: '2026-01-01', publicOnly: true };
  assert.equal(
    repo.meetings.countCalendar(args),
    repo.meetings.searchCalendar({ ...args, limit: 1000 }).length
  );
});

test('a board letter reaches the public only when published', () => {
  const { id: matterId } = repo.matters.insertNumbered({
    type: 'Ordinance', title: 'Has a letter', status: 'Introduced', body_id: bodyId,
  });
  const reportId = repo.reports.insert({
    matter_id: matterId, title: 'Board letter', kind: 'Staff Report', body_html: '<p>Draft.</p>',
  });
  assert.equal(visibility.canSeeReport(anon, repo.reports.get(reportId)), false);
  repo.reports.publish(reportId);
  assert.equal(visibility.canSeeReport(anon, repo.reports.get(reportId)), true);
  repo.reports.unpublish(reportId);
  assert.equal(visibility.canSeeReport(anon, repo.reports.get(reportId)), false);
});

test('publishing a file does not publish its board letters, or the reverse', () => {
  // They are separate decisions: the record of a measure can be public while
  // the staff advice on it is not.
  const { id: matterId } = repo.matters.insertNumbered({
    type: 'Resolution', title: 'Public file, private advice', status: 'Introduced', body_id: bodyId,
  });
  const reportId = repo.reports.insert({ matter_id: matterId, title: 'Advice', kind: 'Staff Report' });
  repo.matters.publish(matterId);
  assert.equal(visibility.canSeeMatter(anon, repo.matters.get(matterId)), true);
  assert.equal(visibility.canSeeReport(anon, repo.reports.get(reportId)), false);
});

test('every record starts unpublished', () => {
  // The whole of the backfill: a new nullable column is NULL on every row that
  // already existed, so nothing carried over from before publication was a
  // decision stays readable.
  const { id } = repo.matters.insertNumbered({
    type: 'Ordinance', title: 'Fresh', status: 'Draft', body_id: bodyId,
  });
  assert.equal(repo.matters.get(id).published_at, null);
  const meetingId = repo.meetings.insert({ body_id: bodyId, meeting_date: '2026-10-01' });
  assert.equal(repo.meetings.get(meetingId).agenda_published_at, null);
  const reportId = repo.reports.insert({ matter_id: id, title: 'Fresh letter', kind: 'Staff Report' });
  assert.equal(repo.reports.get(reportId).published_at, null);
  assert.equal(repo.meetings.get(meetingId).minutes_status, 'none');
});
