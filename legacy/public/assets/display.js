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

  function chip(seat, justCast) {
    var cls = seat.vote ? String(seat.vote).toLowerCase() : 'pending';
    var letter = seat.vote ? (LETTER[seat.vote] || String(seat.vote)[0]) : '·';
    var marks = '';
    // A revised vote and a clerk-entered one are marked on the public board,
    // not only in the record: someone watching should be able to see that a
    // member changed their vote, and that a vote was typed rather than pressed.
    if (seat.changed) marks += '<span class="mark">CHANGED</span>';
    if (seat.source === 'CLERK_ENTRY') marks += '<span class="mark">BY CLERK</span>';
    // `just-cast` is the pulse, and is not the same thing as `changed`: that
    // one is a permanent mark on a revised vote, this is a one-shot cue that
    // the ballot landed while the room was watching. Because the roll is
    // rebuilt wholesale on each frame, the class fires its animation once on
    // the new node and is gone by the next frame.
    return marks + '<span class="chip ' + cls + (justCast ? ' just-cast' : '')
      + '">' + esc(letter) + '</span>';
  }

  /*
   * What changed since the last frame.
   *
   * Keyed by person, reset whenever a different item comes before the body —
   * otherwise reopening a roll would pulse every seat at once, which is
   * precisely the moment the room should be told nothing has been cast yet.
   * A seat with no previous entry never pulses, so the first frame after the
   * board connects mid-vote arrives quietly rather than as a firework.
   */
  var prevVotes = {};
  var prevItemId = null;

  function pulseSet(active) {
    var fresh = {};
    if (active.id !== prevItemId) { prevVotes = {}; prevItemId = active.id; }
    (active.roster || []).forEach(function (m) {
      var was = prevVotes[m.person_id];
      var now = m.vote || null;
      if (was !== undefined && was !== now && now) fresh[m.person_id] = true;
      prevVotes[m.person_id] = now;
    });
    return fresh;
  }

  /*
   * Fitting the roll to the screen.
   *
   * The column count comes from the size of the roll, not from CSS auto-fit:
   * what runs out here is vertical space, and auto-fit responds to width. A
   * board of nine belongs in one column however wide the screen is; a board of
   * twenty-five does not fit in one however tall.
   */
  function fitRoll(n) {
    var cols = n > 24 ? 3 : (n > 12 ? 2 : 1);
    el.roll.setAttribute('data-cols', String(cols));
    // Both axes explicitly: with grid-auto-flow:column, seats fill down one
    // column and then start the next, which is the order a roll is read in.
    // Left to implicit columns they would come out at whatever width their
    // longest name wanted, and the roll would sit lopsided on the wall.
    el.roll.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    el.roll.style.gridTemplateRows = 'repeat(' + Math.ceil(n / cols) + ', auto)';
  }

  /*
   * Fitting text to the space it has.
   *
   * The title was sized by counting characters — over ninety got a smaller
   * class — which is a guess about a proportional font at an unknown viewport,
   * and a multi-paragraph zoning amendment overran it either way, pushing the
   * roll off the bottom of the screen. This measures instead.
   *
   * One proportional guess lands close, because rendered height scales roughly
   * with font size; the loop after it covers the rest, since line count is a
   * step function and the estimate can come back a line over. Bounded, so a
   * text that cannot fit at the floor stops there and clips rather than
   * spinning.
   */
  function fitText(node, maxVh, minVh, budgetVh) {
    if (!node || node.hidden || !node.textContent) return;
    node.style.fontSize = maxVh + 'vh';
    var budget = budgetVh * (window.innerHeight / 100);
    if (node.scrollHeight <= budget) return;
    var size = Math.max(minVh, maxVh * (budget / node.scrollHeight));
    node.style.fontSize = size + 'vh';
    for (var i = 0; i < 12 && node.scrollHeight > budget && size > minVh; i++) {
      size = Math.max(minVh, size - 0.15);
      node.style.fontSize = size + 'vh';
    }
  }

  // Everything that depends on the size of the screen rather than on the
  // state, so a resized or rotated display can re-run it without a new frame.
  function layout() {
    fitText(el.title, 4.2, 1.8, 24);
    fitText(el.motion, 2.6, 1.4, 16);
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
      fitRoll(1);
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

    var fresh = pulseSet(a);
    var roster = a.roster || [];
    el.roll.innerHTML = roster.map(function (m) {
      return '<div class="seat"><span class="name">' + esc(m.name) + '</span>'
        + chip(m, fresh[m.person_id]) + '</div>';
    }).join('');
    fitRoll(roster.length);

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
    layout();
  }

  /*
   * Staleness.
   *
   * A board frozen on a live vote is worse than a dark one, because it looks
   * authoritative. If no update arrives for long enough that the server would
   * have sent a keep-alive twice over, the board says so across the whole
   * screen rather than continuing to show numbers it cannot vouch for.
   */
  /*
   * A display that changed size.
   *
   * Wall screens get rotated, swapped and zoomed, and a board that only
   * re-fits when a vote arrives would sit wrong until somebody voted — which
   * during a long item is the whole item. Debounced, because resize fires in a
   * stream and each call measures.
   */
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 150);
  });

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
  /*
   * The server's keep-alive, which carries no data.
   *
   * Its only job is to prove the stream is still there. Without it the clock
   * above measures time since the tally last changed, not time since the
   * server was last heard from, and a meeting with nothing happening in it
   * reads exactly like a dead board.
   */
  source.addEventListener('ping', function () {
    lastUpdate = Date.now();
    el.stale.hidden = true;
  });
  source.addEventListener('error', function () {
    // EventSource retries on its own; the staleness overlay is what tells the
    // room, so there is nothing to do here but let it.
  });
}());
