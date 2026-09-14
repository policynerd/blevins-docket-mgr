(function () {
  var root = document.querySelector('.vc[data-meeting]');
  if (!root) return;
  var id = root.getAttribute('data-meeting');
  var person = root.getAttribute('data-person');
  var card = root.querySelector('[data-vc-card]');
  var clockEl = root.querySelector('[data-vc-clock]');
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; });
      });
  }
  function render(s) {
    var a = s && s.active;
    if (!a) {
      card.innerHTML = '<p class="empty">Waiting for the chair to put a question…</p>';
      if (clockEl) clockEl.hidden = true;
      return;
    }
    var k = a.kind || 'action';
    var h = '';
    h += '<p class="vc-type">' + esc(k === 'consent' ? 'Consent calendar' : (a.item_type || 'Action')) + '</p>';
    h += '<h2>' + (a.agenda_number ? '<span class="vc-num">' + esc(a.agenda_number) + '</span> ' : '') + esc(a.title) + '</h2>';
    if (a.file_number) h += '<p class="vc-file">' + esc(a.file_number) + '</p>';
    if (a.suggestedAction) h += '<p class="vc-rec">Recommended: ' + esc(a.suggestedAction) + '</p>';
    if (k === 'information') h += '<p class="vc-state">Information — received, not put.</p>';
    else if (k === 'discussion') h += '<p class="vc-state">Discussion — heard, not put.</p>';
    else if (k === 'consent-member') h += '<p class="vc-state">On the consent calendar.</p>';
    else {
      if (a.motion_text || a.mover) {
        h += '<p class="vc-motion">' + esc(a.motion_text || 'The question is before the body.') + '</p>';
        h += '<p class="vc-who">' + (a.mover ? 'Moved by ' + esc(a.mover) : 'Needs a mover') + (a.seconder ? ' · Seconded by ' + esc(a.seconder) : '') + '</p>';
      }
      if (a.tally) h += '<p class="vc-tally">Yea ' + (a.tally.Yea || 0) + ' · Nay ' + (a.tally.Nay || 0) + ' · Abstain ' + (a.tally.Abstain || 0) + '</p>';
      if (a.result) h += '<p class="vc-result">' + esc(a.result) + '</p>';
    }
    if (person && !a.closed && (k === 'action' || k === 'consent')) {
      if (!a.mover_id && k === 'action') h += '<div class="vc-acts"><button class="btn primary" data-act="move">I move</button></div>';
      else if (a.mover_id && !a.seconder_id && k === 'action' && String(a.mover_id) !== String(person)) {
        h += '<div class="vc-acts"><button class="btn primary" data-act="second">I second</button></div>';
      }
      if (a.vote_status === 'open') {
        h += '<div class="vc-acts">'
          + '<button class="btn vote yea" data-vote="Yea">Yea</button>'
          + '<button class="btn vote nay" data-vote="Nay">Nay</button>'
          + '<button class="btn vote abs" data-vote="Abstain">Abstain</button></div>';
      }
    }
    card.innerHTML = h;
  }
  card.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !root._activeId) return;
    if (t.getAttribute('data-act')) post('/member/agenda-items/' + root._activeId + '/' + t.getAttribute('data-act'), {}).catch(function (err) { window.alert(err.message); });
    if (t.getAttribute('data-vote')) post('/member/agenda-items/' + root._activeId + '/cast', { vote: t.getAttribute('data-vote') }).catch(function (err) { window.alert(err.message); });
  });
  var src = new EventSource('/live/' + id + '/stream');
  src.addEventListener('update', function (ev) {
    var s;
    try { s = JSON.parse(ev.data); } catch (_) { return; }
    if (s.active) root._activeId = s.active.id;
    render(s);
  });
})();
