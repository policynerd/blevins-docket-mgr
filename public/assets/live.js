/* Live voting client. Subscribes to the meeting SSE stream and renders the
   active item, running tally and roster. Clerks get controls to open/close
   items and record votes; board members can cast their own vote. Vanilla JS. */
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

  var VOTES = ['Yea', 'Nay', 'Abstain', 'Recused', 'Absent'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function post(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json().catch(function () { return {}; }); });
  }

  function tallyBar(t) {
    return '<div class="tally">' +
      '<span class="v yea">Yea ' + (t.Yea || 0) + '</span>' +
      '<span class="v nay">Nay ' + (t.Nay || 0) + '</span>' +
      '<span class="v">Abstain ' + (t.Abstain || 0) + '</span>' +
      '<span class="v">Recused ' + (t.Recused || 0) + '</span>' +
      '<span class="v">Absent ' + (t.Absent || 0) + '</span>' +
      '</div>';
  }

  function renderActive(a) {
    if (!a) {
      activeEl.innerHTML = '<p class="empty">Waiting for the clerk to open an item…</p>';
      return;
    }
    var html = '';
    html += '<div class="la-title"><span class="ai-num">' + esc(a.agenda_number || '') + '</span> ' +
      (a.file_number ? '<span class="pk-file">' + esc(a.file_number) + '</span> ' : '') + esc(a.title) + '</div>';
    if (a.motion_text || a.mover || a.seconder) {
      html += '<p class="la-motion">' + (a.motion_text ? '<strong>Motion:</strong> ' + esc(a.motion_text) + ' · ' : '') +
        (a.mover ? 'Moved by ' + esc(a.mover) : '') + (a.seconder ? ', seconded by ' + esc(a.seconder) : '') + '</p>';
    }
    html += tallyBar(a.tally);

    // Roster with each member's recorded vote
    html += '<div class="la-roster">';
    a.roster.forEach(function (m) {
      var mine = personId && String(m.person_id) === String(personId);
      html += '<div class="la-row' + (mine ? ' mine' : '') + '">';
      html += '<span class="la-name">' + esc(m.name) + (mine ? ' <em>(you)</em>' : '') + '</span>';
      html += '<span class="la-vote">' + (m.vote
        ? '<span class="vt vt-' + esc(m.vote.toLowerCase()) + '">' + esc(m.vote) + '</span>'
        : '<span class="muted">—</span>') + '</span>';
      if (control) {
        html += '<span class="la-controls">';
        VOTES.forEach(function (v) {
          html += '<button class="chip-btn" data-cast="' + m.person_id + '" data-vote="' + v + '">' + v + '</button>';
        });
        html += '</span>';
      }
      html += '</div>';
    });
    html += '</div>';

    // Member self-vote controls
    if (!control && role === 'member' && personId) {
      var onRoster = a.roster.some(function (m) { return String(m.person_id) === String(personId); });
      if (onRoster) {
        html += '<div class="la-myvote"><span class="muted">Cast your vote:</span> ';
        VOTES.forEach(function (v) { html += '<button class="btn vote-btn" data-myvote="' + v + '">' + v + '</button>'; });
        html += '</div>';
      }
    }

    if (control) {
      html += '<div class="la-actions"><button class="btn primary" data-close="' + a.id + '">Close voting &amp; record result</button></div>';
    }
    activeEl.innerHTML = html;
    bindActive(a);
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
    var closeBtn = activeEl.querySelector('[data-close]');
    if (closeBtn) closeBtn.addEventListener('click', function () { post('/admin/agenda-items/' + a.id + '/close', {}); });
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
  es.addEventListener('update', function (e) {
    try { render(JSON.parse(e.data)); } catch (_) {}
  });
  es.onopen = function () { if (pill) pill.classList.add('on'); };
  es.onerror = function () { if (pill) pill.classList.remove('on'); };
})();
