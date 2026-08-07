'use strict';

// Header "select all" for a checkbox table whose rows are bound to a form by
// the `form=` attribute rather than by nesting. Because the checkboxes live
// outside the <form>, a plain toggle has nothing to walk down into — the
// association is by form id, so that is what this follows.
//
//   <input type="checkbox" data-check-all="ready-queue">
//   <input type="checkbox" name="matter_id" form="ready-queue">
(function () {
  function targets(formId) {
    return Array.prototype.slice.call(
      document.querySelectorAll('input[type=checkbox][form="' + formId + '"]'));
  }

  document.addEventListener('change', function (e) {
    const master = e.target.closest && e.target.closest('[data-check-all]');
    if (master && master === e.target) {
      const boxes = targets(master.getAttribute('data-check-all'));
      boxes.forEach(function (b) { if (!b.disabled) b.checked = master.checked; });
      return;
    }
    // Keep the master honest when rows are ticked individually: all on, none
    // off, and indeterminate in between, so it never claims a state that is
    // not true of the rows below it.
    if (e.target.type === 'checkbox' && e.target.getAttribute('form')) {
      const id = e.target.getAttribute('form');
      const master2 = document.querySelector('[data-check-all="' + id + '"]');
      if (!master2) return;
      const boxes = targets(id).filter(function (b) { return b !== master2; });
      const on = boxes.filter(function (b) { return b.checked; }).length;
      master2.checked = on > 0 && on === boxes.length;
      master2.indeterminate = on > 0 && on < boxes.length;
    }
  });
})();
