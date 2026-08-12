/*
 * Chamber display client.
 *
 * Read-only by construction: this file contains no code that can send
 * anything to the server. The board is bolted to a wall in a public room, and
 * a screen that could act is a screen someone can act through.
 */
(function () {
  'use strict';

  var board = document.querySelector('.board');
  if (!board) return;
  var meetingId = board.getAttribute('data-meeting');

  var el = {
    banner: document.querySelector('[data-banner]'),
    head: document.querySelector('[data-board]'),
    itemNo: document.querySelector('[data-item-no]'),
    title: document.querySelector('[data-title]'),
    motion: document.querySelector('[data-motion]'),
    needed: document.querySelector('[data-votes-needed]'),
    movers: document.querySelector('[data-movers]'),
    mover: document.querySelector('[data-mover]'),
    seconder: document.querySelector('[data-seconder]'),
    roll: document.querySelector('[data-roll]'),
    counts: document.querySelector('[data-counts]'),
    basis: document.querySelector('[data-basis]'),
    status: document.querySelector('[data-status]'),
    stale: document.querySelector('[data-stale]')
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* One letter per choice. A letter inside a coloured block is legible from
     the back of the room and does not depend on distinguishing green from red,
     which colour alone would. */
  var LETTER = { Yea: 'Y', Nay: 'N', Abstain: 'A', Present: 'P', Recused: 'R' };

  function chip(seat) {
    var cls = seat.vote ? String(seat.vote).toLowerCase() : 'pending';
    var letter = seat.vote ? (LETTER[seat.vote] || String(seat.vote)[0]) : '·';
    var marks = '';
    // A revised vote and a clerk-entered one are marked on the public board,
    // not only in the record: someone watching should be able to see that a
    // member changed their vote, and that a vote was typed rather than pressed.
    if (seat.changed) marks += '<span class="mark">CHANGED</span>';
    if (seat.source === 'CLERK_ENTRY') marks += '<span class="mark">BY CLERK</span>';
    return marks + '<span class="chip ' + cls + '">' + esc(letter) + '</span>';
  }

  function countBlock(label, n, cls) {
    return '<span>' + label + '<span class="n ' + cls + '">' + (n || 0) + '</span></span>';
  }

  function render(state) {
    var a = state.active;
    if (!a) {
      el.banner.hidden = true;
      el.head.hidden = true;
      el.counts.hidden = true;
      el.movers.hidden = true;
      el.basis.textContent = '';
      el.roll.innerHTML = '<div class="waiting">'
        + esc(state.meeting && state.meeting.status === 'In Progress'
          ? 'The Board Meeting is in Recess.'
          : 'No item before the body') + '</div>';
      el.status.textContent = 'Awaiting the chair';
      el.status.className = 'status idle';
      return;
    }

    // The outcome gets its own bar once the roll is closed. Until then there
    // is no result to state, and projecting one onto the wall mid-vote would
    // invite members to vote against a number rather than a motion.
    if (a.closed && a.result) {
      el.banner.hidden = false;
      el.banner.textContent = a.result === 'Pass' ? 'Motion Passes' : 'Motion Fails';
      el.banner.className = 'banner ' + (a.result === 'Pass' ? 'passes' : 'fails');
    } else {
      el.banner.hidden = true;
    }

    el.head.hidden = false;
    el.itemNo.textContent = a.agenda_number ? String(a.agenda_number) : '';
    el.title.textContent = a.title || '';
    el.title.className = (a.title || '').length > 90 ? 'long' : '';
    el.motion.textContent = a.motion_text || '';
    el.motion.hidden = !a.motion_text;
    el.needed.textContent = a.required ? '(' + a.required + ' VOTES REQUIRED)' : '';
    el.needed.hidden = !a.required;

    var hasMovers = a.mover || a.seconder;
    el.movers.hidden = !hasMovers;
    if (hasMovers) {
      el.mover.textContent = a.mover || '—';
      el.seconder.textContent = a.seconder || '—';
    }

    el.roll.innerHTML = (a.roster || []).map(function (m) {
      return '<div class="seat"><span class="name">' + esc(m.name) + '</span>'
        + chip(m) + '</div>';
    }).join('');

    el.counts.hidden = false;
    el.counts.innerHTML =
      countBlock('Yes', a.tally.Yea, 'yea')
      + countBlock('No', a.tally.Nay, 'nay')
      + countBlock('Abstain', a.tally.Abstain, 'abstain')
      + (a.recused ? countBlock('Recused', a.recused, 'recused') : '');

    // The denominator in words. "YES 2 NO 1" alone leaves the room unable to
    // tell whether that carries.
    el.basis.textContent = a.eligible != null
      ? a.required + ' of ' + a.eligible + ' eligible — ' + (a.basis || '')
      : '';

    var s;
    if (a.certified) s = { text: 'Result certified', cls: 'certified' };
    else if (a.closed) s = { text: 'Voting closed', cls: 'closed' };
    else if (!a.quorumMet) s = { text: 'No quorum', cls: 'closed' };
    else s = { text: 'Voting open', cls: 'open' };
    el.status.textContent = s.text;
    el.status.className = 'status ' + s.cls;
  }

  /*
   * Staleness.
   *
   * A board frozen on a live vote is worse than a dark one, because it looks
   * authoritative. If no update arrives for long enough that the server would
   * have sent a keep-alive twice over, the board says so across the whole
   * screen rather than continuing to show numbers it cannot vouch for.
   */
  var lastUpdate = Date.now();
  setInterval(function () {
    el.stale.hidden = Date.now() - lastUpdate < 60000;
  }, 5000);

  var source = new EventSource('/live/' + meetingId + '/stream');
  source.addEventListener('update', function (ev) {
    lastUpdate = Date.now();
    el.stale.hidden = true;
    try { render(JSON.parse(ev.data)); } catch (_) { /* keep the last good frame */ }
  });
  source.addEventListener('error', function () {
    // EventSource retries on its own; the staleness overlay is what tells the
    // room, so there is nothing to do here but let it.
  });
}());
