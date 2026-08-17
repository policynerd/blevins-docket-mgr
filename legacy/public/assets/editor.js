/* Minimal rich-text "word processor". Vanilla JS, no dependencies.
   Each .wp couples a contenteditable surface with a hidden textarea that is
   submitted with the form; the server sanitizes the HTML on receipt.

   The toolbar deliberately offers only formatting that survives the server's
   allowlist (see src/sanitize.js). Offering alignment or colour here would let
   a drafter apply something the save silently discards, which is worse than
   not offering it — hence no justify* commands and no font controls. */
(function () {
  'use strict';

  // Mirror of ALLOWED in src/sanitize.js. Kept in sync by hand; the server is
  // the authority, this only stops the editing surface from displaying
  // formatting that will not survive the round trip.
  var ALLOWED = {
    p: 1, br: 1, b: 1, strong: 1, i: 1, em: 1, u: 1, s: 1, strike: 1,
    ul: 1, ol: 1, li: 1, h2: 1, h3: 1, h4: 1, blockquote: 1, a: 1, hr: 1,
    code: 1, pre: 1, table: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, th: 1,
    td: 1, caption: 1, sup: 1, sub: 1
  };
  // Dropped with their contents, rather than unwrapped: unwrapping a <style>
  // would paste the stylesheet in as body text.
  var DROP_WHOLE = 'script,style,meta,link,title,noscript,iframe,object,embed';

  function safeHref(h) {
    if (!h) return false;
    var l = h.toLowerCase();
    return h.charAt(0) === '/' || h.charAt(0) === '#'
      || l.indexOf('http://') === 0 || l.indexOf('https://') === 0
      || l.indexOf('mailto:') === 0;
  }

  function unwrap(el) {
    var p = el.parentNode;
    if (!p) return;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
  }

  // Strip a pasted subtree down to the allowlist, in place.
  function scrub(root) {
    var gone = root.querySelectorAll(DROP_WHOLE);
    for (var g = 0; g < gone.length; g++) {
      if (gone[g].parentNode) gone[g].parentNode.removeChild(gone[g]);
    }
    var els = root.querySelectorAll('*');
    // Reverse document order, so a child is cleaned before its parent is
    // unwrapped out from under it.
    for (var i = els.length - 1; i >= 0; i--) {
      var el = els[i];
      var name = el.nodeName.toLowerCase();
      if (!ALLOWED[name]) { unwrap(el); continue; }
      var keep = name === 'a' && safeHref(el.getAttribute('href'))
        ? el.getAttribute('href') : null;
      for (var j = el.attributes.length - 1; j >= 0; j--) {
        el.removeAttribute(el.attributes[j].name);
      }
      if (keep) {
        el.setAttribute('href', keep);
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }

  function nodeAtCursor(area) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var n = sel.getRangeAt(0).startContainer;
    if (n.nodeType === 3) n = n.parentNode;
    return (n && area.contains(n)) ? n : null;
  }

  function insertTable() {
    var cols = parseInt(window.prompt('How many columns?', '3'), 10);
    if (!(cols > 0)) return;
    var rows = parseInt(window.prompt('How many rows, not counting the header?', '3'), 10);
    if (!(rows > 0)) return;
    cols = Math.min(cols, 12);
    rows = Math.min(rows, 60);
    var h = '<table><thead><tr>';
    for (var c = 0; c < cols; c++) h += '<th>Column ' + (c + 1) + '</th>';
    h += '</tr></thead><tbody>';
    for (var r = 0; r < rows; r++) {
      h += '<tr>';
      for (var c2 = 0; c2 < cols; c2++) h += '<td>&nbsp;</td>';
      h += '</tr>';
    }
    // The trailing paragraph is an escape hatch: a table flush against the end
    // of the document is otherwise impossible to type past.
    h += '</tbody></table><p><br></p>';
    document.execCommand('insertHTML', false, h);
  }

  function addRow(area) {
    var n = nodeAtCursor(area);
    var tr = n && n.closest ? n.closest('tr') : null;
    if (!tr) return false;
    var fresh = document.createElement('tr');
    for (var i = 0; i < tr.children.length; i++) {
      var td = document.createElement('td');
      td.innerHTML = '&nbsp;';
      fresh.appendChild(td);
    }
    // From the header row the new row belongs at the top of the body, not
    // inside <thead> where it would read as a second set of column titles.
    var inHead = tr.parentNode.nodeName.toLowerCase() === 'thead';
    if (inHead) {
      var table = tr.closest('table');
      var body = table && table.querySelector('tbody');
      if (!body) return false;
      body.insertBefore(fresh, body.firstChild);
    } else {
      tr.parentNode.insertBefore(fresh, tr.nextSibling);
    }
    return true;
  }

  // Move already-scrubbed nodes from the inert document into the selection.
  function insertNodes(area, nodeList) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (!area.contains(range.commonAncestorContainer)) return;
    // Snapshot first: childNodes is live, and importing as we go would walk a
    // list that shifts under the loop.
    var nodes = Array.prototype.slice.call(nodeList);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < nodes.length; i++) {
      frag.appendChild(document.importNode(nodes[i], true));
    }
    var last = frag.lastChild;
    range.deleteContents();
    range.insertNode(frag);
    // Leave the caret after what was pasted, not before it.
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  var STATE_CMDS = ['bold', 'italic', 'underline', 'strikeThrough',
    'insertUnorderedList', 'insertOrderedList', 'superscript', 'subscript'];

  function initEditor(wp) {
    var area = wp.querySelector('[data-wp-editor]');
    var output = wp.querySelector('[data-wp-output]');
    if (!area || !output) return;

    function sync() { output.value = area.innerHTML; }

    // Produce <b>/<i> rather than <span style>. Several browsers default to
    // CSS-styled output, which the server's allowlist strips on save — the
    // formatting would appear to apply and then vanish.
    try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* older engines */ }

    function refreshState() {
      if (!area.contains(document.activeElement) && document.activeElement !== area) return;
      wp.querySelectorAll('.wp-btn[data-cmd]').forEach(function (btn) {
        var cmd = btn.getAttribute('data-cmd');
        if (STATE_CMDS.indexOf(cmd) === -1) return;
        var on = false;
        try { on = document.queryCommandState(cmd); } catch (e) { on = false; }
        btn.classList.toggle('wp-on', !!on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    wp.querySelectorAll('.wp-btn').forEach(function (btn) {
      var cmd = btn.getAttribute('data-cmd');
      if (STATE_CMDS.indexOf(cmd) !== -1) btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        area.focus();
        var val = btn.getAttribute('data-val') || null;
        if (cmd === 'createLink') {
          var url = window.prompt('Link URL (http://, https://, mailto:, / or #):', 'https://');
          if (url && safeHref(url)) document.execCommand('createLink', false, url);
          else if (url) window.alert('That link was not saved: only http://, https://, mailto:, / and # addresses are allowed.');
        } else if (cmd === 'insertTable') {
          insertTable();
        } else if (cmd === 'addRow') {
          if (!addRow(area)) window.alert('Put the cursor inside a table first.');
        } else if (cmd === 'formatBlock') {
          document.execCommand('formatBlock', false, val);
        } else {
          document.execCommand(cmd, false, null);
        }
        sync();
        refreshState();
      });
    });

    // Paste is where a word processor's markup gets in. Clean it here so the
    // surface shows what the server will actually keep.
    area.addEventListener('paste', function (e) {
      var dt = e.clipboardData || window.clipboardData;
      if (!dt) return;
      var pastedHtml = dt.getData('text/html');
      var pastedText = dt.getData('text/plain');
      if (!pastedHtml && !pastedText) return;
      e.preventDefault();
      if (pastedHtml) {
        // Parsed into a document with no browsing context, so nothing in it
        // runs and no resource is fetched. Assigning the clipboard to a live
        // element's innerHTML instead would fire an <img onerror> in the gap
        // before scrub() could strip it — the element belongs to this
        // document, so the load is attempted even while it is detached.
        var doc = new DOMParser().parseFromString(pastedHtml, 'text/html');
        scrub(doc.body);
        // The scrubbed nodes are moved across directly rather than serialized
        // back to a string and re-parsed. Nothing here is ever handed to an
        // HTML parser a second time, which is where mutation-XSS lives: a
        // round trip can re-read markup as something the scrub never saw.
        insertNodes(area, doc.body.childNodes);
      } else {
        document.execCommand('insertText', false, pastedText);
      }
      sync();
    });

    area.addEventListener('input', sync);
    area.addEventListener('blur', sync);
    area.addEventListener('keyup', refreshState);
    area.addEventListener('mouseup', refreshState);
    area.addEventListener('focus', refreshState);
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
