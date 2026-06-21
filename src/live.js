'use strict';

// Server-Sent Events hub for live voting. Subscribers are grouped by meeting;
// the clerk console and public/member live views receive pushed tally updates.
// Built on the raw HTTP response object — no websocket dependency.
const repo = require('./repo');
const channels = new Map(); // meetingId -> Set<res>

function nameOf(id) {
  if (!id) return null;
  const p = repo.people.get(id);
  return p ? p.full_name : null;
}

// Build the live state for a meeting: the currently-open item (with roster,
// motion, running tally and individual votes) plus a compact agenda overview.
function snapshot(meetingId) {
  const meeting = repo.meetings.get(meetingId);
  if (!meeting) return { meeting: null };
  const items = repo.meetings.items(meetingId);
  const members = repo.bodies.members(meeting.body_id);
  const open = items.find((i) => i.vote_status === 'open') || null;

  let active = null;
  if (open) {
    const cast = repo.votes.forItem(open.id);
    const castBy = {};
    for (const v of cast) castBy[v.person_id] = v.vote;
    active = {
      id: open.id,
      agenda_number: open.agenda_number,
      file_number: open.file_number || null,
      title: open.matter_id ? open.matter_title : open.title,
      motion_text: open.motion_text || null,
      mover: nameOf(open.mover_id),
      seconder: nameOf(open.seconder_id),
      tally: repo.votes.tally(open.id),
      roster: members.map((m) => ({
        person_id: m.person_id, name: m.full_name, vote: castBy[m.person_id] || null,
      })),
    };
  }

  return {
    ts: Date.now(),
    meeting: { id: meeting.id, body: meeting.body_name, status: meeting.status,
      date: meeting.meeting_date, time: meeting.meeting_time },
    active,
    items: items.map((i) => ({
      id: i.id, agenda_number: i.agenda_number,
      title: i.matter_id ? `${i.file_number} — ${i.matter_title}` : (i.title || '(item)'),
      vote_status: i.vote_status || 'pending', result: i.result || null,
    })),
  };
}

function pushUpdate(meetingId) {
  broadcast(meetingId, snapshot(meetingId));
}

function sendInitial(meetingId, res) {
  try { res.write(`event: update\ndata: ${JSON.stringify(snapshot(meetingId))}\n\n`); } catch (_) { /* ignore */ }
}

function subscribe(meetingId, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let set = channels.get(meetingId);
  if (!set) { set = new Set(); channels.set(meetingId, set); }
  set.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
  }, 25000);

  const cleanup = () => {
    clearInterval(keepAlive);
    const s = channels.get(meetingId);
    if (s) { s.delete(res); if (s.size === 0) channels.delete(meetingId); }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

function broadcast(meetingId, payload) {
  const set = channels.get(meetingId);
  if (!set || set.size === 0) return;
  const data = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch (_) { /* drop on next cleanup */ }
  }
}

function subscriberCount(meetingId) {
  const set = channels.get(meetingId);
  return set ? set.size : 0;
}

module.exports = { subscribe, broadcast, subscriberCount, snapshot, pushUpdate, sendInitial };
