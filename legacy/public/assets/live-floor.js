(function () {
  var root = document.querySelector('.live[data-role="member"][data-control="0"]');
  if (!root) return;
  var personId = root.getAttribute('data-person');
  if (!personId) return;
  function post(url) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.statusText); }); });
  }
  function paint() {
    var box = root.querySelector('[data-live-active]');
    if (!box || box.querySelector('[data-floor]')) return;
    var title = box.querySelector('.la-title');
    if (!title) return;
    var votes = box.querySelector('.la-myvote');
    var bar = document.createElement('div');
    bar.className = 'la-myvote';
    bar.innerHTML = '<span class="muted">From the floor:</span> '
      + '<button class="btn" data-floor="move" type="button">I move</button> '
      + '<button class="btn" data-floor="second" type="button">I second</button>';
    (votes || title).parentNode.insertBefore(bar, votes || title.nextSibling);
    bar.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute('data-floor');
      if (!act) return;
      var item = box.getAttribute('data-item-id');
      if (!item) return;
      post('/member/agenda-items/' + item + '/' + act).catch(function (err) { window.alert(err.message); });
    });
  }
  setInterval(paint, 800);
  paint();
})();
