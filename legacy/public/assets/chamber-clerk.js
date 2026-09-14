(function () {
  if (!document.body.classList.contains('chamber-clerk')) return;
  var live = document.querySelector('.live[data-control="1"]');
  if (!live) return;
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); return j; }); });
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-voice')) {
      post('/admin/agenda-items/' + t.getAttribute('data-voice') + '/voice', { result: t.getAttribute('data-result') || 'Unanimous Yea' })
        .catch(function (err) { window.alert(err.message); });
    }
  });
  setInterval(function () {
    var bar = live.querySelector('.la-actions .la-act-row');
    var card = live.querySelector('[data-live-active]');
    if (!bar || !card || bar.querySelector('[data-voice]')) return;
    var id = card.getAttribute('data-item-id');
    if (!id) return;
    var b = document.createElement('button');
    b.className = 'btn';
    b.setAttribute('data-voice', id);
    b.setAttribute('data-result', 'Unanimous Yea');
    b.textContent = 'Voice: unanimous yea';
    bar.appendChild(b);
  }, 800);
})();
