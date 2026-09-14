'use strict';

const repo = require('./repo');
const kind = require('./procedure-kind');
const live = require('./live');
const liveViews = require('./views/live');
const skins = require('./views/chamber-skins');

function tag(row) {
  if (!row || !row.id) return row;
  try {
    const it = repo.meetings.getItem(row.id);
    row.kind = kind.kindOf(it);
    row.item_type = it && it.item_type;
    row.suggestedAction = it && it.action;
    row.vote_status = (it && it.vote_status) || row.vote_status;
    row.vote_closes_at = it && it.vote_closes_at;
  } catch (_) { /* */ }
  return row;
}

function decorate(s) {
  if (!s) return s;
  if (s.active) tag(s.active);
  if (s.items) s.items = s.items.map(tag);
  return s;
}

function install() {
  if (live.__decorated) return;
  live.__decorated = true;
  live.pushUpdate = function pushDecorated(id) {
    live.broadcast(id, decorate(live.snapshot(id)));
  };
  live.sendInitial = function sendDecorated(id, res) {
    try { res.write(`event: update\ndata: ${JSON.stringify(decorate(live.snapshot(id)))}\n\n`); } catch (_) { /* */ }
  };
  const origClerk = liveViews.clerkConsole;
  liveViews.clerkConsole = function clerkSkinned(meeting, user) {
    let page = origClerk(meeting, user);
    page = page.replace('<body>', '<body class="chamber-clerk">');
    if (!page.includes('run-strip')) {
      page = page.replace('<div class="live"', skins.clerkLiveHint(meeting) + '\n    <div class="live"');
    }
    if (!page.includes('chamber-clerk.js')) {
      page = page.replace('</body>', '  <script src="/assets/chamber-clerk.js" defer></script>\n</body>');
    }
    return page;
  };
}

module.exports = { install, decorate };
