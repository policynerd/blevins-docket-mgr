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
    threshold: document.querySelector('[data-threshold]'),
    reopened: document.querySelector('[data-reopened]'),
    consent: document.querySelector('[data-consent]'),
    floor: document.querySelector('[data-floor]'),
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
  function setCols(n, cols) {
    el.roll.setAttribute('data-cols', String(cols));
    // Equal columns, so every chip sits at its column's right edge and the
    // results read down the board in straight lines. A chip does end up nearer
    // the next column's name than its own — but every column carries the same
    // name-then-chip pattern, so the room reads the structure once and the
    // ambiguity does not survive it. Ragged chips, each stopping wherever its
    // name happened to end, are the harder thing to take a tally off.
    el.roll.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    el.roll.style.gridTemplateRows = 'repeat(' + Math.ceil(n / cols) + ', auto)';
  }

  /*
   * Fitting the roll to the screen.
   *
   * Seat count is only the opening guess. What actually decides this is
   * whether the whole board fits, and that depends on everything above the
   * roll — a long title, a motion, a reopened badge, a consent calendar
   * listing twelve items. A rule keyed to seat count alone was right until the
   * threshold bar was added and a twenty-five seat roll started running 44px
   * past the bottom of a 1080p screen.
   *
   * So: guess, then measure, then add a column if it did not fit. Columns are
   * cheaper than shrinking type on a board read from the back of a room.
   */
  function fitRoll(n) {
    var cols = n > 24 ? 3 : (n > 12 ? 2 : 1);
    setCols(n, cols);
    while (cols < 4 && document.body.scrollHeight > window.innerHeight) {
      cols += 1;
      setCols(n, cols);
    }
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
    // After the title is sized, because sizing it changes how much room the
    // roll has. Only when there is a roll to fit.
    var seats = el.roll.querySelectorAll('.seat').length;
    if (seats) fitRoll(seats);
  }

  /*
   * The floor, when no vote is open.
   *
   * The clock is drawn client-side from the start time in the snapshot rather
   * than pushed as a number: SSE frames arrive when something changes, and a
   * countdown that only moved when the server spoke would sit still for three
   * minutes. The tick below advances it between frames; the snapshot is what
   * says whose clock it is.
   *
   * It counts past zero rather than stopping. Nothing here cuts a speaker off
   * — that is a ruling the chair makes, not a board — so the useful thing to
   * show a chair is how far over they have run.
   */
  var floorState = null;

  function clockText(secs) {
    var over = secs < 0;
    var t = Math.abs(secs);
    var m = Math.floor(t / 60);
    var ss = t % 60;
    return (over ? '+' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function paintClock() {
    if (!floorState || !floorState.speaking || !floorState.speaking.startedAt) return;
    var el2 = el.floor.querySelector('[data-clock]');
    if (!el2) return;
    var started = Date.parse(String(floorState.speaking.startedAt).replace(' ', 'T') + 'Z');
    if (isNaN(started)) return;
    var left = Math.round(floorState.speaking.limitSeconds - (Date.now() - started) / 1000);
    el2.textContent = clockText(left);
    el2.className = 'floor-clock' + (left < 0 ? ' over' : '');
  }

  function renderFloor(floor) {
    floorState = floor;
    var has = floor && (floor.speaking || (floor.queue && floor.queue.length));
    el.floor.hidden = !has;
    if (!has) return '';

    var out = '';
    if (floor.speaking) {
      out += '<div class="floor-label">Now speaking</div>'
        + '<div class="floor-name">' + esc(floor.speaking.name) + '</div>'
        + (floor.speaking.item ? '<div class="floor-item">On ' + esc(floor.speaking.item) + '</div>' : '')
        + '<div class="floor-clock" data-clock>—</div>';
    }
    if (floor.queue && floor.queue.length) {
      out += '<div class="floor-queue"><div class="floor-label">Next ('
        + floor.queue.length + ')</div><ol>'
        + floor.queue.slice(0, 6).map(function (q) {
          return '<li>' + esc(q.name) + (q.item ? ' <span class="muted">' + esc(q.item) + '</span>' : '') + '</li>';
        }).join('')
        + (floor.queue.length > 6 ? '<li>… and ' + (floor.queue.length - 6) + ' more</li>' : '')
        + '</ol></div>';
    }
    el.floor.innerHTML = out;
    paintClock();
    return out;
  }

  // One tick a second, only ever repainting digits that already exist.
  setInterval(paintClock, 1000);

  function countBlock(label, n, cls) {
    return '<span>' + label + '<span class="n ' + cls + '">' + (n || 0) + '</span></span>';
  }

  /*
   * Where the count stands against what it takes.
   *
   * The denominator existed only as a line of small grey text under the tally
   * — "5 of 25 eligible — majority of those voting" — which is the one thing
   * on this board a room cannot read from the back, and the only thing it
   * actually wants to know: is this carrying?
   *
   * Bars are drawn against the eligible roll, and the marker sits at the
   * threshold. When the green passes the marker the motion has it.
   */
  function thresholdBar(a) {
    if (!a.eligible || !a.required) return '';
    var pct = function (n) { return Math.min(100, (n / a.eligible) * 100); };
    var yea = a.tally.Yea || 0;
    var nay = a.tally.Nay || 0;
    return '<div class="thr-track">'
      + '<div class="thr-yea" style="width:' + pct(yea) + '%"></div>'
      + '<div class="thr-nay" style="width:' + pct(nay) + '%"></div>'
      + '<div class="thr-mark" style="left:' + pct(a.required) + '%"></div>'
      + '</div>'
      + '<div class="thr-legend"><span>' + esc(String(a.required))
      + ' of ' + esc(String(a.eligible)) + ' eligible needed</span>'
      + '<span>' + esc(a.basis || '') + '</span></div>';
  }

  function render(state) {
    var a = state.active;

    // Somebody holding the floor outranks a finished vote.
    //
    // `active` falls back to the last closed item so the room keeps seeing a
    // result after the roll shuts, which is right — until the chair gives
    // somebody the floor. That is a deliberate act, later in time, and it is
    // what is happening in the room; a tally from ten minutes ago is not.
    if (state.floor && state.floor.speaking) {
      el.banner.hidden = true;
      el.head.hidden = true;
      el.counts.hidden = true;
      el.movers.hidden = true;
      el.threshold.hidden = true;
      el.reopened.hidden = true;
      el.consent.hidden = true;
      el.basis.textContent = '';
      el.roll.innerHTML = '';
      renderFloor(state.floor);
      el.status.textContent = 'Public comment';
      el.status.className = 'status open';
      return;
    }

    if (!a) {
      el.banner.hidden = true;
      el.head.hidden = true;
      el.counts.hidden = true;
      el.movers.hidden = true;
      el.threshold.hidden = true;
      el.reopened.hidden = true;
      el.consent.hidden = true;
      el.basis.textContent = '';
      // The floor takes the screen when somebody has it; only when nobody is
      // speaking and nobody is waiting does the board fall back to saying so.
      var onFloor = renderFloor(state.floor);
      fitRoll(1);
      el.roll.innerHTML = onFloor ? '' : '<div class="waiting">'
        + esc(state.meeting && state.meeting.status === 'In Progress'
          ? 'The Board Meeting is in Recess.'
          : 'No item before the body') + '</div>';
      el.status.textContent = onFloor ? 'Public comment' : 'Awaiting the chair';
      el.status.className = 'status ' + (onFloor ? 'open' : 'idle');
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

    el.floor.hidden = true;
    floorState = null;
    el.head.hidden = false;
    el.itemNo.textContent = a.agenda_number ? String(a.agenda_number) : '';
    el.title.textContent = a.title || '';
    el.motion.textContent = a.motion_text || '';
    el.motion.hidden = !a.motion_text;
    el.needed.textContent = a.required ? '(' + a.required + ' VOTES REQUIRED)' : '';
    el.needed.hidden = !a.required;

    // A roll taken more than once says so. The room is entitled to know it is
    // watching a second answer to the same question.
    el.reopened.hidden = !a.reopened;
    if (a.reopened) {
      el.reopened.innerHTML = '<span class="reopened">ROLL REOPENED'
        + (a.reopened > 1 ? ' \u00d7' + a.reopened : '') + '</span>';
    }

    // What a consent calendar disposes of, listed, because one roll standing
    // for twelve items must show the twelve.
    el.consent.hidden = !(a.consentItems && a.consentItems.length);
    if (a.consentItems && a.consentItems.length) {
      el.consent.innerHTML = '<div class="consent-head">This vote adopts '
        + a.consentItems.length + ' item' + (a.consentItems.length === 1 ? '' : 's')
        + '</div><ol>' + a.consentItems.map(function (c) {
          return '<li>' + esc(c.agenda_number ? c.agenda_number + '. ' : '')
            + esc(c.file_number ? c.file_number + ' — ' : '') + esc(c.title || '') + '</li>';
        }).join('') + '</ol>';
    }

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

    // The denominator, as a bar rather than a sentence. "YES 2 NO 1" alone
    // leaves the room unable to tell whether that carries, and the sentence
    // that used to say so was 2.2vh of grey text.
    var bar = thresholdBar(a);
    el.threshold.hidden = !bar;
    el.threshold.innerHTML = bar;
    el.basis.textContent = '';

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
