/* Minimal rich-text "word processor". Vanilla JS, no dependencies.
   Each .wp couples a contenteditable surface with a hidden textarea that is
   submitted with the form; the server sanitizes the HTML on receipt. */
(function () {
  'use strict';

  function initEditor(wp) {
    var area = wp.querySelector('[data-wp-editor]');
    var output = wp.querySelector('[data-wp-output]');
    if (!area || !output) return;

    function sync() { output.value = area.innerHTML; }

    wp.querySelectorAll('.wp-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        area.focus();
        var cmd = btn.getAttribute('data-cmd');
        var val = btn.getAttribute('data-val') || null;
        if (cmd === 'createLink') {
          var url = window.prompt('Link URL (http://, https://, mailto:, / or #):', 'https://');
          if (url) document.execCommand('createLink', false, url);
        } else if (cmd === 'formatBlock') {
          document.execCommand('formatBlock', false, val);
        } else {
          document.execCommand(cmd, false, null);
        }
        sync();
      });
    });

    area.addEventListener('input', sync);
    area.addEventListener('blur', sync);
    sync();
  }

  function ready() {
    document.querySelectorAll('.wp').forEach(initEditor);
    // Ensure the hidden textareas are fresh at submit time.
    document.querySelectorAll('form[data-wp-form]').forEach(function (form) {
      form.addEventListener('submit', function () {
        form.querySelectorAll('.wp').forEach(function (wp) {
          var area = wp.querySelector('[data-wp-editor]');
          var output = wp.querySelector('[data-wp-output]');
          if (area && output) output.value = area.innerHTML;
        });
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
