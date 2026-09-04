/* Accessibility semantics for the live meeting console.
   This file deliberately changes no classes, styles, visible text, layout,
   spacing, colours, or control ordering. It only adds programmatic state,
   announcements, labels, and focus restoration around the existing UI. */
(function () {
  'use strict';

  var root = document.querySelector('.live[data-meeting]');
  if (!root) return;

  var active = root.querySelector('[data-live-active]');
  var agenda = root.querySelector('[data-live-agenda]');
  var announcer = root.querySelector('[data-live-announcer]');
  var pill = document.querySelector('[data-live-pill]');
  var role = root.getAttribute('data-role');

  var lastItemId = '';
  var lastStage = '';
  var lastOwnVote = '';
  var lastConnected = pill ? pill.classList.contains('on') : null;
  var focusMemory = null;

  function text(el) {
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function attrEsc(value) {
    return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function announce(message) {
    if (!announcer || !message) return;
    announcer.textContent = '';
    window.requestAnimationFrame(function () { announcer.textContent = message; });
  }

  function rememberFocus(el) {
    if (!active || !active.contains(el)) return;
    var itemId = active.getAttribute('data-item-id') || '';
    var selector = null;
    var lifecycle = false;

    if (el.hasAttribute('data-cast') && el.hasAttribute('data-vote')) {
      selector = '[data-cast="' + attrEsc(el.getAttribute('data-cast')) + '"][data-vote="'
        + attrEsc(el.getAttribute('data-vote')) + '"]';
    } else if (el.hasAttribute('data-myvote')) {
      selector = '[data-myvote="' + attrEsc(el.getAttribute('data-myvote')) + '"]';
    } else if (el.hasAttribute('data-mf-mover')) selector = '[data-mf-mover]';
    else if (el.hasAttribute('data-mf-seconder')) selector = '[data-mf-seconder]';
    else if (el.hasAttribute('data-mf-threshold')) selector = '[data-mf-threshold]';
    else if (el.hasAttribute('data-mf-text')) selector = '[data-mf-text]';
    else if (el.hasAttribute('data-mf-save')) selector = '[data-mf-save]';
    else if (el.hasAttribute('data-af-kind')) selector = '[data-af-kind]';
    else if (el.hasAttribute('data-af-mover')) selector = '[data-af-mover]';
    else if (el.hasAttribute('data-af-seconder')) selector = '[data-af-seconder]';
    else if (el.hasAttribute('data-af-threshold')) selector = '[data-af-threshold]';
    else if (el.hasAttribute('data-af-text')) selector = '[data-af-text]';
    else if (el.hasAttribute('data-af-save')) selector = '[data-af-save]';
    else if (el.matches('[data-close],[data-announce],[data-certify],[data-publish],[data-clear]')) {
      lifecycle = true;
      selector = '.la-act-row button';
    } else if (el.hasAttribute('data-reopen')) selector = '[data-reopen]';
    else if (el.hasAttribute('data-void')) selector = '[data-void]';

    if (selector) focusMemory = { itemId: itemId, selector: selector, lifecycle: lifecycle };
  }

  function restoreFocus() {
    if (!focusMemory || !active) return;
    if ((active.getAttribute('data-item-id') || '') !== focusMemory.itemId) return;
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== active) return;
    var target = active.querySelector(focusMemory.selector);
    if (!target && focusMemory.lifecycle) target = active.querySelector('.la-act-row button');
    if (target && typeof target.focus === 'function') {
      try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    }
  }

  function applyStepSemantics() {
    if (!active) return;
    var steps = active.querySelector('.la-steps');
    if (!steps) return;
    steps.setAttribute('aria-label', 'Vote processing status');
    steps.querySelectorAll('.la-step').forEach(function (li) {
      var label = text(li);
      if (li.classList.contains('current')) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
      if (li.classList.contains('done')) li.setAttribute('aria-label', label + ', completed');
      else li.removeAttribute('aria-label');
      var dot = li.querySelector('.la-step-dot');
      if (dot) dot.setAttribute('aria-hidden', 'true');
    });
  }

  function applyRosterSemantics() {
    if (!active) return;
    active.querySelectorAll('.la-row').forEach(function (row) {
      var name = text(row.querySelector('.la-name')).replace(/\s*\(you\)\s*$/, '');
      var controls = row.querySelector('.la-controls');
      if (!controls) return;
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', 'Record vote for ' + name);
      controls.querySelectorAll('[data-cast][data-vote]').forEach(function (button) {
        var vote = button.getAttribute('data-vote') || text(button);
        button.setAttribute('aria-label', 'Record ' + vote + ' for ' + name);
        button.setAttribute('aria-pressed', button.classList.contains('active') ? 'true' : 'false');
      });
    });
  }

  function applyMemberVoteSemantics() {
    if (!active) return;
    var group = active.querySelector('.la-myvote');
    if (!group) return;
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Cast your vote');

    var own = active.querySelector('.la-row.mine .la-vote .vt');
    var ownVote = text(own);
    if (ownVote === '—') ownVote = '';

    group.querySelectorAll('[data-myvote]').forEach(function (button) {
      var vote = button.getAttribute('data-myvote') || text(button);
      button.setAttribute('aria-pressed', ownVote === vote ? 'true' : 'false');
    });

    if (role === 'member' && lastOwnVote && ownVote && ownVote !== lastOwnVote) {
      announce('Your vote is recorded as ' + ownVote + '.');
    }
    if (ownVote) lastOwnVote = ownVote;
  }

  function applyChainSemantics() {
    var chain = root.querySelector('[data-chain]');
    if (!chain) return;
    if (chain.classList.contains('broken')) {
      chain.setAttribute('role', 'alert');
      chain.setAttribute('aria-live', 'assertive');
    } else {
      chain.setAttribute('role', 'status');
      chain.setAttribute('aria-live', 'polite');
    }
  }

  function applySemantics() {
    if (agenda) agenda.setAttribute('aria-label', 'Meeting agenda');
    applyStepSemantics();
    applyRosterSemantics();
    applyMemberVoteSemantics();
    applyChainSemantics();
  }

  function announceState() {
    if (!active) return;
    var itemId = active.getAttribute('data-item-id') || '';
    var title = text(active.querySelector('.la-title'));
    var current = active.querySelector('.la-step.current');
    var steps = active.querySelector('.la-steps');
    var stage = current ? text(current) : (steps ? 'Vote processing complete' : '');

    if (itemId !== lastItemId) {
      if (itemId && title) announce('Now before the body: ' + title + '.');
      else if (lastItemId && !itemId) announce('No item is currently before the body.');
    } else if (itemId && stage && stage !== lastStage) {
      announce(title + '. ' + stage + '.');
    }

    lastItemId = itemId;
    lastStage = stage;
  }

  root.addEventListener('focusin', function (event) { rememberFocus(event.target); });

  var observer = new MutationObserver(function () {
    applySemantics();
    announceState();
    restoreFocus();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-item-id'] });

  if (pill) {
    var pillObserver = new MutationObserver(function () {
      var connected = pill.classList.contains('on');
      pill.setAttribute('aria-label', connected ? 'Live connection established' : 'Live connection interrupted');
      if (lastConnected !== null && connected !== lastConnected) {
        announce(connected ? 'Live connection established.' : 'Live connection interrupted.');
      }
      lastConnected = connected;
    });
    pillObserver.observe(pill, { attributes: true, attributeFilter: ['class'] });
    pill.setAttribute('aria-label', lastConnected ? 'Live connection established' : 'Live connection not yet established');
  }

  applySemantics();
  announceState();
})();
