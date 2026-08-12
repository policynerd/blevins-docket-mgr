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
  // The item before the body: the open roll if there is one, otherwise the
  // most recently closed one that has a result.
  //
  // A board that empties the instant the gavel falls is a board that never
  // shows the outcome, which is the moment the room is actually waiting for.
  // A real chamber board holds the result up until the chair calls the next
  // item, and so does this.
  const open = items.find((i) => i.vote_status === 'open')
    || [...items].reverse().find((i) => i.vote_status === 'closed' && i.result_computed_at)
    || null;

  const seatCount = members.length;
  const quorumNeeded = seatCount ? Math.floor(seatCount / 2) + 1 : 0;

  let active = null;
  if (open) {
    // One arithmetic, shared with the close.
    //
    // This used to compute its own tally and threshold, which meant the board
    // could project "Passes" while closing the roll recorded Fail — the two
    // disagreeing about recusal, since only one of them removed a recused
    // member from the denominator. The live view now asks the same function
    // that decides the outcome, so the room and the record cannot diverge.
    // Unbounded only while the roll is open — that is the live count. Once it
    // is closed the board must show the official tally, bounded by the close,
    // or the wall would report a different number from the minutes the moment
    // a late ballot arrived.
    const isOpen = open.vote_status === 'open';
    const o = isOpen
      ? repo.eligibility.outcome(open.id, { throughSeq: null })
      : repo.eligibility.outcome(open.id);
    const quorumMet = o.present >= quorumNeeded;

    active = {
      id: open.id,
      agenda_number: open.agenda_number,
      file_number: open.file_number || null,
      title: open.matter_id ? open.matter_title : open.title,
      motion_text: open.motion_text || null,
      mover_id: open.mover_id || null,
      seconder_id: open.seconder_id || null,
      mover: nameOf(open.mover_id),
      seconder: nameOf(open.seconder_id),
      // Kept in the old shape so the existing client keeps rendering, with the
      // counts now derived from the ledger rather than the mutable projection.
      tally: {
        Yea: o.yea,
        Nay: o.nay,
        Abstain: o.roll.filter((r) => r.choice === 'Abstain').length,
        Present: o.roll.filter((r) => r.choice === 'Present').length,
        Recused: o.recused,
        Absent: o.seated - o.present,
      },
      roster: o.roll.map((r) => ({
        person_id: r.person_id,
        name: r.full_name,
        vote: r.choice,
        present: r.present,
        changed: r.changed,
        source: r.source || null,
      })),
      seatCount,
      quorumNeeded,
      quorumMet,
      // What the room needs to see: who may vote, what it takes, and where the
      // count stands against that.
      present: o.present,
      eligible: o.eligible,
      recused: o.recused,
      notVoted: o.notVoted,
      required: o.required,
      basis: o.basis,
      threshold: o.threshold,
      projectedOutcome: !quorumMet ? 'No quorum' : (o.passes ? 'Passes' : 'Fails'),
      // Lifecycle, so the board can say "closed" and "certified" rather than
      // inferring either from the presence of a number.
      closed: o.closed,
      result: open.result || null,
      certified: !!open.result_certified_at,
      published: !!open.result_published_at,
      late: o.late,
      announced: !!open.result_announced_at,
      computedAt: open.result_computed_at || null,
    };
  }

  // Chain health, surfaced to the clerk rather than left to be discovered.
  // A record that has stopped verifying is something the person running the
  // meeting needs to know during it, not months later during an audit.
  const chain = repo.voteLedger.verify(meetingId);

  return {
    ts: Date.now(),
    chain: { ok: chain.ok, brokenAt: chain.brokenAt ?? null, reason: chain.reason || null },
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
