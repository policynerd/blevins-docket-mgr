'use strict';

const repo = require('./repo');
const { db } = require('./db');

function kindOf(item) {
  if (!item) return 'action';
  if (item.is_consent_group) return 'consent';
  if (item.consent_group_id) return 'consent-member';
  if (item.item_type === 'Information') return 'information';
  if (item.item_type === 'Discussion') return 'discussion';
  return 'action';
}

function assertCanOpenRoll(item) {
  const k = kindOf(item);
  if (k === 'information') {
    const e = new Error('An information item is received, not put. There is no question and no roll.');
    e.code = 'NOT_A_QUESTION';
    throw e;
  }
  if (k === 'discussion') {
    const e = new Error('A discussion item is heard, not put. Change it to Action if the body will vote.');
    e.code = 'NOT_A_QUESTION';
    throw e;
  }
  if (k === 'consent-member') {
    const e = new Error('This item is on the consent calendar. Remove it from the calendar to consider it separately.');
    e.code = 'ON_CONSENT_CALENDAR';
    throw e;
  }
}

function assertCanMove(item) {
  const k = kindOf(item);
  if (k === 'information' || k === 'discussion') {
    const e = new Error('There is nothing to move. This item is not before the body as a question.');
    e.code = 'NOT_A_QUESTION';
    throw e;
  }
  if (k === 'consent-member') {
    const e = new Error('Consent items are not moved from the floor. Pull it from the calendar first.');
    e.code = 'ON_CONSENT_CALENDAR';
    throw e;
  }
}

function receive(itemId, { disposition } = {}) {
  const item = repo.meetings.getItem(itemId);
  if (!item) throw new Error('No such item.');
  const k = kindOf(item);
  if (k !== 'information' && k !== 'discussion') {
    const e = new Error('Receive is for information and discussion items.');
    e.code = 'IS_A_QUESTION';
    throw e;
  }
  const result = disposition || (k === 'discussion' ? 'Heard' : 'Received');
  db.prepare(`UPDATE agenda_items
    SET result=?, vote_status='closed',
        reached_at=COALESCE(reached_at, datetime('now')),
        vote_closed_at=datetime('now')
    WHERE id=?`).run(result, itemId);
  if (item.matter_id) {
    repo.matters.addHistory({
      matter_id: item.matter_id,
      action_date: require('./util').todayISO(),
      body_id: item.body_id,
      action: result === 'Heard' ? 'Heard' : 'Received',
      result,
      agenda_item_id: itemId,
    });
  }
  return repo.meetings.getItem(itemId);
}

function voice(itemId, { result } = {}) {
  const item = repo.meetings.getItem(itemId);
  if (!item) throw new Error('No such item.');
  assertCanOpenRoll(item);
  if (result !== 'Unanimous Yea' && result !== 'Unanimous Nay') {
    const e = new Error('A voice vote is Unanimous Yea or Unanimous Nay. Anything else is a roll.');
    e.code = 'NOT_VOICE';
    throw e;
  }
  db.prepare(`UPDATE agenda_items
    SET result=?, vote_status='closed',
        reached_at=COALESCE(reached_at, datetime('now')),
        vote_closed_at=datetime('now')
    WHERE id=?`).run(result, itemId);
  if (item.matter_id) {
    repo.matters.addHistory({
      matter_id: item.matter_id,
      action_date: require('./util').todayISO(),
      body_id: item.body_id,
      action: 'Voice vote',
      result,
      agenda_item_id: itemId,
    });
  }
  return repo.meetings.getItem(itemId);
}

function install() {
  if (repo.__kindInstalled) return;
  repo.__kindInstalled = true;
  const origOpen = repo.voteAdmin.openRoll.bind(repo.voteAdmin);
  repo.voteAdmin.openRoll = function openRollKind(itemId, opts) {
    assertCanOpenRoll(repo.meetings.getItem(itemId));
    return origOpen(itemId, opts);
  };
  const origAdd = repo.meetings.addItem.bind(repo.meetings);
  repo.meetings.addItem = function addItemKind(it) {
    const row = Object.assign({}, it);
    if (row.item_type === 'Information' || row.item_type === 'Discussion') row.requires_vote = 0;
    return origAdd(row);
  };
  const origUp = repo.meetings.updateItem.bind(repo.meetings);
  repo.meetings.updateItem = function updateItemKind(id, it) {
    const row = Object.assign({}, it);
    const type = row.item_type != null ? row.item_type : (repo.meetings.getItem(id) || {}).item_type;
    if (type === 'Information' || type === 'Discussion') row.requires_vote = 0;
    return origUp(id, row);
  };
}

module.exports = { kindOf, assertCanOpenRoll, assertCanMove, receive, voice, install };
