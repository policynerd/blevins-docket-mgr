/* Drag-to-reorder for the agenda manager. Vanilla JS, no dependencies.
   Persists the new order to /admin/meetings/:id/agenda/reorder. */
(function () {
  'use strict';
  var list = document.querySelector('.agenda-manage[data-meeting]');
  if (!list) return;

  var meetingId = list.getAttribute('data-meeting');
  var statusEl = document.querySelector('[data-reorder-status]');
  var dragging = null;
  var saveTimer = null;

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.className = 'reorder-status' + (kind ? ' ' + kind : '');
  }

  list.addEventListener('dragstart', function (e) {
    var item = e.target.closest ? e.target.closest('.agenda-manage-item') : null;
    if (!item) return;
    dragging = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', item.getAttribute('data-id')); } catch (_) {}
  });

  list.addEventListener('dragend', function () {
    if (dragging) dragging.classList.remove('dragging');
    dragging = null;
  });

  list.addEventListener('dragover', function (e) {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var after = afterElement(e.clientY);
    if (after == null) list.appendChild(dragging);
    else list.insertBefore(dragging, after);
  });

  list.addEventListener('drop', function (e) {
    if (!dragging) return;
    e.preventDefault();
    scheduleSave();
  });

  function afterElement(y) {
    var els = Array.prototype.slice.call(
      list.querySelectorAll('.agenda-manage-item:not(.dragging)'));
    var closest = null;
    var closestOffset = -Infinity;
    els.forEach(function (el) {
      var box = el.getBoundingClientRect();
      var offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = el; }
    });
    return closest;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 150);
  }

  function save() {
    var order = Array.prototype.slice.call(
      list.querySelectorAll('.agenda-manage-item'))
      .map(function (el) { return el.getAttribute('data-id'); });
    setStatus('Saving…');
    fetch('/admin/meetings/' + meetingId + '/agenda/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: order })
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (d) { setStatus(d && d.ok ? 'Order saved ✓' : 'Save failed', d && d.ok ? 'ok' : 'err'); })
      .catch(function () { setStatus('Save failed — reload and retry', 'err'); });
  }
})();
