/* Display preferences for /accessibility. Local to this browser. */
(function () {
  var root = document.documentElement;
  var TEXT_KEY = 'beg-a11y-text';
  var CONTRAST_KEY = 'beg-a11y-contrast';

  function apply() {
    var text = localStorage.getItem(TEXT_KEY) || 'default';
    var contrast = localStorage.getItem(CONTRAST_KEY) || 'default';
    if (text === 'default') root.removeAttribute('data-a11y-text');
    else root.setAttribute('data-a11y-text', text);
    if (contrast === 'default') root.removeAttribute('data-a11y-contrast');
    else root.setAttribute('data-a11y-contrast', contrast);
    document.querySelectorAll('[data-a11y-text]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-a11y-text') === text ? 'true' : 'false');
    });
    document.querySelectorAll('[data-a11y-contrast]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-a11y-contrast') === contrast ? 'true' : 'false');
    });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-a11y-text], [data-a11y-contrast]');
    if (!t) return;
    if (t.hasAttribute('data-a11y-text')) {
      localStorage.setItem(TEXT_KEY, t.getAttribute('data-a11y-text'));
    }
    if (t.hasAttribute('data-a11y-contrast')) {
      localStorage.setItem(CONTRAST_KEY, t.getAttribute('data-a11y-contrast'));
    }
    apply();
  });

  apply();
})();
