/* Progressive-enhancement tabs. Without this script every .tab-panel renders
   (fully usable); with it, only the active panel shows. Vanilla, no deps. */
(function () {
  'use strict';
  function initTabs(box) {
    box.classList.add('js');
    var btns = box.querySelectorAll('.tab-btn');
    var panels = box.querySelectorAll('.tab-panel');
    function activate(id) {
      btns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === id); });
      panels.forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + id); });
    }
    btns.forEach(function (b) {
      b.addEventListener('click', function () { activate(b.getAttribute('data-tab')); });
    });
    // Activate the first tab (or one named in the URL hash).
    var hash = (location.hash || '').replace('#tab-', '');
    var first = btns[0] && btns[0].getAttribute('data-tab');
    activate(hash && box.querySelector('#tab-' + hash) ? hash : first);
  }
  function ready() { document.querySelectorAll('.tabs').forEach(initTabs); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
