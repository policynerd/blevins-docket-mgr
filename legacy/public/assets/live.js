/* Live voting client. Subscribes to the meeting SSE stream and renders the
   active item, running tally and roster. Clerks get controls to open/close
   items and record votes; board members can cast their own vote. Vanilla JS.

   Updates are applied in place while the same item stays open — only the
   tally, roster chips and outcome bar change — so votes land smoothly without
   rebuilding the panel (no flicker, and a clerk's half-typed motion form is
   preserved). A full re-render only happens when the open item changes. */
(function () {
  'use strict';
  var root = document.querySelector('.live[data-meeting]');
  if (!root) return;

  var meetingId = root.getAttribute('data-meeting');
  var role = root.getAttribute('data-role');
  var control = root.getAttribute('data-control') === '1';
  var personId = root.getAttribute('data-person');
  var activeEl = root.querySelector('[data-live-active]');
  var agendaEl = root.querySelector('[data-live-agenda]');
  var pill = document.querySelector('[data-live-pill]');

  // Must match ledger.CHOICES. Offering a button the ledger will not seal is
  // how "Absent" used to hand a member a 500 at the rail.
  var VOTES = ['Yea', 'Nay', 'Present', 'Abstain', 'Recused'];
  var THRESHOLD_LABELS = {
    majority: 'Majority of votes cast',
    two_thirds: 'Two-thirds (⅔)',
    majority_full: 'Majority of full body',
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function post(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json().catch(function () { return {}; }); });
  }

  // Everyone seated lands in exactly one column of the board, so a choice the
  // board does not name has to be gathered here or the arithmetic stops adding
  // up. Voting Present declines the merits, which is what this column means.
  function notVoting(t) { return (t.Recused || 0) + (t.Absent || 0) + (t.Present || 0); }

  function tallyBoard(t) {
    return '<div class="vote-board">' +
      '<div class="vb-col vb-yea"><span class="vb-n" data-vb="Yea">' + (t.Yea || 0) + '</span><span class="vb-l">Yea</span></div>' +
      '<div class="vb-col vb-nay"><span class="vb-n" data-vb="Nay">' + (t.Nay || 0) + '</span><span class="vb-l">Nay</span></div>' +
      '<div class="vb-col vb-abs"><span class="vb-n" data-vb="Abstain">' + (t.Abstain || 0) + '</span><span class="vb-l">Abstain</span></div>' +
      '<div class="vb-col vb-nv"><span class="vb-n" data-vb="nv">' + notVoting(t) + '</span><span class="vb-l">Not Voting</span></div>' +
      '</div>';
  }

  /*
   * What it takes to carry, stated in full.
   *
   * This used to derive its own present count from seats minus absences, which
   * was a third implementation of the arithmetic and the only one that never
   * heard of recusal. It now reads the figures the close will actually use, so
   * the clerk is looking at the same numbers that decide the vote.
   */
  function outcomeBar(a) {
    var quorumClass = a.quorumMet ? 'qb-met' : 'qb-fail';
    var quorumText = a.quorumMet
      ? 'Quorum \u2713 ' + a.present + '/' + a.seatCount + ' present'
      : 'No quorum \u2014 ' + a.present + ' of ' + a.quorumNeeded + ' needed';
    var outcomeClass = a.projectedOutcome === 'Passes' ? 'out-pass'
      : (a.projectedOutcome === 'Fails' ? 'out-fail' : 'out-noquorum');

    var figures = [
      ['Present', a.present],
      ['Eligible', a.eligible],
      ['Recused', a.recused],
      ['Not voted', a.notVoted]
    ].map(function (f) {
      return '<span class="ob-fig"><b>' + f[1] + '</b> ' + f[0] + '</span>';
    }).join('');

    return '<div class="outcome-bar" data-outcome>'
      + '<span class="' + quorumClass + '">' + esc(quorumText) + '</span>'
      + '<span class="ob-sep">\u00b7</span>' + figures
      + '<span class="ob-sep">\u00b7</span>'
      + '<span class="ob-threshold">Requires <b>' + a.required + '</b> \u2014 '
      + esc(a.basis || THRESHOLD_LABELS[a.threshold] || a.threshold) + '</span>'
      + '<span class="ob-sep">\u00b7</span>'
      + '<strong class="' + outcomeClass + '">'
      + (a.closed ? 'Result: ' + esc(a.result || '') : 'Projected: ' + esc(a.projectedOutcome))
      + '</strong>'
      + (a.late ? '<span class="ob-late">' + a.late + ' after the close (not counted)</span>' : '')
      + '</div>';
  }

  /*
   * The clerk's controls, gated by where the item actually is.
   *
   * Showing every button always and rejecting the wrong ones server-side would
   * work, but it puts the clerk in the position of discovering the order of
   * business by being refused mid-meeting. The buttons that apply are the ones
   * offered.
   */
  function controlBar(a) {
    var h = '<div class="la-actions">';
    if (!a.closed) {
      h += '<button class="btn primary" data-close="' + a.id + '">Close roll &amp; record result</button>';
    } else {
      if (!a.announced) h += '<button class="btn" data-announce="' + a.id + '">Announce result</button>';
      if (a.announced && !a.certified) h += '<button class="btn primary" data-certify="' + a.id + '">Certify</button>';
      if (a.certified && !a.published) h += '<button class="btn" data-publish="' + a.id + '">Publish</button>';
      if (a.published) h += '<span class="muted">Published</span>';
      h += '<button class="btn-link" data-reopen="' + a.id + '">Reopen roll</button>';
    }
    // Voiding is destructive to a recorded outcome and always available, but
    // never the default: it sits apart and asks for a reason.
    h += '<button class="btn-link danger" data-void="' + a.id + '">Void this vote\u2026</button>';
    return h + '</div>';
  }

  function motionForm(a) {
    var rosterOpts = function (currentId) {
      return '<option value="">—</option>' + a.roster.map(function (m) {
        var sel = String(m.person_id) === String(currentId) ? ' selected' : '';
        return '<option value="' + esc(m.person_id) + '"' + sel + '>' + esc(m.name) + '</option>';
      }).join('');
    };
    var threshOpts = Object.keys(THRESHOLD_LABELS).map(function (v) {
      return '<option value="' + v + '"' + (a.threshold === v ? ' selected' : '') + '>' + esc(THRESHOLD_LABELS[v]) + '</option>';
    }).join('');
    return '<details class="la-motion-form"><summary>Set motion / threshold</summary>' +
      '<div class="la-motion-fields">' +
      '<label>Mover <select data-mf-mover>' + rosterOpts(a.mover_id) + '</select></label>' +
      '<label>Seconder <select data-mf-seconder>' + rosterOpts(a.seconder_id) + '</select></label>' +
      '<label>Threshold <select data-mf-threshold>' + threshOpts + '</select></label>' +
      '<label>Motion text <input type="text" data-mf-text value="' + esc(a.motion_text || '') + '" placeholder="I move to…"></label>' +
      '<button class="btn" data-mf-save="' + esc(a.id) + '">Save motion</button>' +
      '</div></details>';
  }

  function rosterRow(a, m) {
    var mine = personId && String(m.person_id) === String(personId);
    var voteClass = m.vote ? 'vt vt-' + esc(m.vote.toLowerCase()) : 'vt vt-pending';
    var voteLabel = m.vote ? esc(m.vote) : '—';
    var h = '<div class="la-row' + (mine ? ' mine' : '') + '" data-person="' + esc(m.person_id) + '">';
    h += '<span class="la-name">' + esc(m.name) + (mine ? ' <em>(you)</em>' : '') + '</span>';
    h += '<span class="la-vote"><span class="' + voteClass + '">' + voteLabel + '</span></span>';
    if (control) {
      h += '<span class="la-controls">';
      VOTES.forEach(function (v) {
        h += '<button class="chip-btn' + (m.vote === v ? ' active' : '') + '" data-cast="' + esc(m.person_id) + '" data-vote="' + v + '">' + v + '</button>';
      });
      h += '</span>';
    }
    return h + '</div>';
  }

  // Full (re)build — used on first paint and whenever the open item changes.
  function renderActiveFull(a) {
    if (!a) {
      activeEl.removeAttribute('data-item-id');
      activeEl.innerHTML = '<p class="empty">Waiting for the clerk to open an item…</p>';
      return;
    }
    var h = '';
    h += '<div class="la-title"><span class="ai-num">' + esc(a.agenda_number || '') + '</span> ' +
      (a.file_number ? '<span class="pk-file">' + esc(a.file_number) + '</span> ' : '') + esc(a.title) + '</div>';
    if (a.motion_text || a.mover || a.seconder) {
      h += '<p class="la-motion">' + (a.motion_text ? '<strong>Motion:</strong> ' + esc(a.motion_text) + ' · ' : '') +
        (a.mover ? 'Moved by ' + esc(a.mover) : '') + (a.seconder ? ', seconded by ' + esc(a.seconder) : '') + '</p>';
    }
    h += tallyBoard(a.tally);
    if (a.seatCount) h += outcomeBar(a);
    if (control) h += motionForm(a);

    h += '<div class="la-roster">';
    a.roster.forEach(function (m) { h += rosterRow(a, m); });
    h += '</div>';

    if (!control && role === 'member' && personId) {
      var onRoster = a.roster.some(function (m) { return String(m.person_id) === String(personId); });
      if (onRoster) {
        h += '<div class="la-myvote"><span class="muted">Cast your vote:</span> ';
        VOTES.forEach(function (v) { h += '<button class="btn vote-btn" data-myvote="' + v + '">' + v + '</button>'; });
        h += '</div>';
      }
    }
    if (control) h += controlBar(a);
    activeEl.innerHTML = h;
    activeEl.setAttribute('data-item-id', a.id);
    activeEl.classList.remove('la-active-fade'); void activeEl.offsetWidth; activeEl.classList.add('la-active-fade');
    bindActive(a);
  }

  function bump(el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  function flash(row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }

  // Can we update the current DOM in place, or is a full rebuild needed?
  function canPatch(a) {
    if (!a || activeEl.getAttribute('data-item-id') !== String(a.id)) return false;
    if (activeEl.querySelectorAll('.la-row').length !== a.roster.length) return false;
    if (!!activeEl.querySelector('[data-outcome]') !== !!a.seatCount) return false;
    return true;
  }

  // In-place update: tally numbers, roster chips, clerk button states, outcome
  // bar. Leaves the motion form (and any focused input) untouched.
  function patchActive(a) {
    var counts = { Yea: a.tally.Yea || 0, Nay: a.tally.Nay || 0, Abstain: a.tally.Abstain || 0, nv: notVoting(a.tally) };
    Object.keys(counts).forEach(function (k) {
      var el = activeEl.querySelector('.vb-n[data-vb="' + k + '"]');
      if (el && el.textContent !== String(counts[k])) { el.textContent = String(counts[k]); bump(el); }
    });
    var ob = activeEl.querySelector('[data-outcome]');
    if (ob && a.seatCount) {
      var tmp = document.createElement('div'); tmp.innerHTML = outcomeBar(a);
      ob.parentNode.replaceChild(tmp.firstChild, ob);
    }
    a.roster.forEach(function (m) {
      var row = activeEl.querySelector('.la-row[data-person="' + esc(m.person_id) + '"]');
      if (!row) return;
      var chip = row.querySelector('.la-vote .vt');
      var label = m.vote || '—';
      var cls = m.vote ? 'vt vt-' + esc(m.vote.toLowerCase()) : 'vt vt-pending';
      if (chip && chip.textContent !== label) { chip.textContent = label; chip.className = cls; flash(row); }
      else if (chip) { chip.className = cls; }
      if (control) {
        row.querySelectorAll('[data-cast]').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-vote') === m.vote);
        });
      }
    });
  }

  function bindActive(a) {
    activeEl.querySelectorAll('[data-cast]').forEach(function (b) {
      b.addEventListener('click', function () {
        post('/admin/agenda-items/' + a.id + '/cast', { person_id: b.getAttribute('data-cast'), vote: b.getAttribute('data-vote') });
      });
    });
    activeEl.querySelectorAll('[data-myvote]').forEach(function (b) {
      b.addEventListener('click', function () {
        post('/member/agenda-items/' + a.id + '/cast', { vote: b.getAttribute('data-myvote') });
      });
    });
    // Each control maps to one act on the item, and each act is one event in
    // the session chain. No button does two things.
    [['close', 'close'], ['announce', 'announce'], ['certify', 'certify'],
     ['publish', 'publish'], ['reopen', 'open']].forEach(function (pair) {
      var btn = activeEl.querySelector('[data-' + pair[0] + ']');
      if (!btn) return;
      btn.addEventListener('click', function () {
        btn.disabled = true;
        post('/admin/agenda-items/' + a.id + '/' + pair[1], {})
          .catch(function (e) { window.alert(e.message); })
          .then(function () { btn.disabled = false; });
      });
    });

    var voidBtn = activeEl.querySelector('[data-void]');
    if (voidBtn) voidBtn.addEventListener('click', function () {
      // A reason is required by the server; asking here means the clerk is not
      // sent round a rejection to find that out.
      var reason = window.prompt(
        'Voiding strikes the recorded outcome and clears the ballots.\n'
        + 'The ledger keeps them, and the reason goes on the record.\n\n'
        + 'Why is this vote being voided?');
      if (reason === null) return;
      if (!reason.trim()) { window.alert('A reason is required to void a vote.'); return; }
      post('/admin/agenda-items/' + a.id + '/void', { reason: reason })
        .catch(function (e) { window.alert(e.message); });
    });
    var mfSave = activeEl.querySelector('[data-mf-save]');
    if (mfSave) mfSave.addEventListener('click', function () {
      post('/admin/agenda-items/' + a.id + '/motion', {
        mover_id: (activeEl.querySelector('[data-mf-mover]') || {}).value || null,
        seconder_id: (activeEl.querySelector('[data-mf-seconder]') || {}).value || null,
        motion_text: (activeEl.querySelector('[data-mf-text]') || {}).value || null,
        vote_threshold: (activeEl.querySelector('[data-mf-threshold]') || {}).value || 'majority',
      });
    });
  }

  function renderActive(a) {
    if (canPatch(a)) patchActive(a);
    else renderActiveFull(a);
  }

  function renderAgenda(items) {
    agendaEl.innerHTML = items.map(function (it) {
      var st = it.vote_status === 'open' ? '<span class="badge st-on-agenda">VOTING OPEN</span>'
        : (it.result ? '<span class="badge st-' + esc(String(it.result).toLowerCase()) + '">' + esc(it.result) + '</span>'
          : '<span class="badge st-draft">' + esc(it.vote_status) + '</span>');
      var openBtn = control && it.vote_status !== 'open'
        ? '<button class="btn-link" data-open="' + it.id + '">Open voting</button>' : '';
      return '<li class="live-ag-item"><span class="ai-num">' + esc(it.agenda_number || '') + '</span>' +
        '<span class="lai-title">' + esc(it.title) + '</span>' + st + ' ' + openBtn + '</li>';
    }).join('');
    if (control) {
      agendaEl.querySelectorAll('[data-open]').forEach(function (b) {
        b.addEventListener('click', function () { post('/admin/agenda-items/' + b.getAttribute('data-open') + '/open', {}); });
      });
    }
  }

  function render(snap) {
    if (!snap || !snap.meeting) return;
    renderActive(snap.active);
    renderAgenda(snap.items || []);
  }

  var es = new EventSource('/live/' + meetingId + '/stream');
  /*
   * Chain health, in front of the person running the meeting.
   *
   * A record that has stopped verifying is not an audit finding to be turned
   * up months later — it is something the clerk needs while the meeting is
   * still in the room, when the ballots can still be re-taken. Shown only to
   * the console; the public board is not the place to raise it.
   */
  function renderChain(state) {
    if (!control || !state.chain) return;
    var bar = document.querySelector('[data-chain]');
    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute('data-chain', '');
      bar.className = 'chain-bar';
      root.insertBefore(bar, root.firstChild);
    }
    if (state.chain.ok) {
      bar.className = 'chain-bar ok';
      bar.textContent = 'Record verified';
    } else {
      bar.className = 'chain-bar broken';
      bar.textContent = 'RECORD DOES NOT VERIFY at entry '
        + state.chain.brokenAt + ' — ' + state.chain.reason;
    }
  }

  es.addEventListener('update', function (e) {
    try {
      var state = JSON.parse(e.data);
      render(state);
      renderChain(state);
    } catch (_) {}
  });
  es.onopen = function () { if (pill) pill.classList.add('on'); };
  es.onerror = function () { if (pill) pill.classList.remove('on'); };
})();
