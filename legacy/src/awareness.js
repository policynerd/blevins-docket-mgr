'use strict';

// What changed, what is waiting, what is next.
//
// Legistar's InSite and Files module work because a clerk or a member can
// answer those three questions without opening a file. The data was already
// here — inbox, watches, history, the next meeting. It had never been asked
// together, and the pages that knew one of the answers did not know the others.
//
// The chamber display is not a consumer of this module.

const { db } = require('./db');
const auth = require('./auth');

function inboxCount(user) {
  if (!user) return 0;
  try {
    return require('./repo').workflow.inboxFor(user.id, auth.hasRole(user, 'clerk')).length;
  } catch (_) {
    return 0;
  }
}

function watchesFor(userId) {
  return db.prepare(`
    SELECT m.id, m.file_number, m.title, m.status, m.updated_at,
      w.created_at AS watched_at,
      (SELECT h.action FROM matter_history h WHERE h.matter_id = m.id
       ORDER BY h.action_date DESC, h.id DESC LIMIT 1) AS last_action,
      (SELECT h.action_date FROM matter_history h WHERE h.matter_id = m.id
       ORDER BY h.action_date DESC, h.id DESC LIMIT 1) AS last_action_date
    FROM watches w
    JOIN matters m ON m.id = w.matter_id
    WHERE w.user_id = ?
    ORDER BY m.updated_at DESC`).all(userId);
}

function movedSinceWatch(row) {
  if (!row.last_action_date || !row.watched_at) return false;
  return String(row.last_action_date) >= String(row.watched_at).slice(0, 10);
}

function recentActions({ limit = 8, publicOnly = false } = {}) {
  const vis = publicOnly ? 'AND m.published_at IS NOT NULL' : '';
  return db.prepare(`
    SELECT h.action_date, h.action, h.result, m.file_number, m.title, m.status,
           b.name AS body_name
    FROM matter_history h
    JOIN matters m ON m.id = h.matter_id
    LEFT JOIN bodies b ON b.id = h.body_id
    WHERE 1=1 ${vis}
    ORDER BY h.action_date DESC, h.id DESC
    LIMIT ?`).all(limit);
}

function nextHearing(matterId, today) {
  return db.prepare(`
    SELECT mt.id, mt.meeting_date, mt.meeting_time, b.name AS body_name
    FROM agenda_items ai
    JOIN meetings mt ON mt.id = ai.meeting_id
    JOIN bodies b ON b.id = mt.body_id
    WHERE ai.matter_id = ? AND mt.meeting_date >= ?
    ORDER BY mt.meeting_date ASC, mt.id ASC
    LIMIT 1`).get(matterId, today);
}

function lastAction(matterId) {
  return db.prepare(`
    SELECT h.action_date, h.action, h.result, b.name AS body_name
    FROM matter_history h
    LEFT JOIN bodies b ON b.id = h.body_id
    WHERE h.matter_id = ?
    ORDER BY h.action_date DESC, h.id DESC
    LIMIT 1`).get(matterId);
}

function desk(user) {
  if (!user) {
    return {
      inbox: 0,
      watches: [],
      moved: [],
      recent: recentActions({ publicOnly: true }),
    };
  }
  const watches = watchesFor(user.id);
  return {
    inbox: inboxCount(user),
    watches,
    moved: watches.filter(movedSinceWatch),
    recent: recentActions({ publicOnly: !auth.hasRole(user, 'member') }),
  };
}

module.exports = {
  inboxCount,
  watchesFor,
  movedSinceWatch,
  recentActions,
  nextHearing,
  lastAction,
  desk,
};
