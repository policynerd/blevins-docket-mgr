'use strict';

const { html, raw, formatDate } = require('../util');
const { layout, card, escapeText } = require('./layout');
const repo = require('../repo');

const REPORT_KINDS = ['Staff Report', 'Memorandum', 'Fiscal Note', 'Legal Analysis', 'Draft Legislation'];

// Reusable rich-text "word processor" field. `valueHtml` must already be
// sanitized (it is injected into the editable surface as real HTML).
//
// `toolbar: 'basic'` is for the short prose answers — a board-letter section,
// a note — where the full set is nine stacked toolbars of noise around three
// sentences. Documents that are actually laid out (staff reports, policies,
// minutes) keep the full set.
function editorField(name, valueHtml, { label, rows = 12, toolbar = 'full' } = {}) {
  const safe = valueHtml || '';
  const full = toolbar !== 'basic';
  return `
    <div class="wp wp-${full ? 'full' : 'basic'}">
      ${label ? `<div class="wp-label">${escapeText(label)}</div>` : ''}
      <div class="wp-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" class="wp-btn" data-cmd="bold" title="Bold"><b>B</b></button>
        <button type="button" class="wp-btn" data-cmd="italic" title="Italic"><i>I</i></button>
        <button type="button" class="wp-btn" data-cmd="underline" title="Underline — new language"><u>U</u></button>
        <button type="button" class="wp-btn" data-cmd="strikeThrough" title="Strike through — language to be deleted"><s>S</s></button>
        <span class="wp-sep"></span>
        ${full ? `<button type="button" class="wp-btn" data-cmd="formatBlock" data-val="h2" title="Heading">H2</button>
        <button type="button" class="wp-btn" data-cmd="formatBlock" data-val="h3" title="Subheading">H3</button>
        <button type="button" class="wp-btn" data-cmd="formatBlock" data-val="h4" title="Sub-subheading">H4</button>
        <button type="button" class="wp-btn" data-cmd="formatBlock" data-val="p" title="Body text">¶</button>
        <span class="wp-sep"></span>` : ''}
        <button type="button" class="wp-btn" data-cmd="insertUnorderedList" title="Bulleted list">• List</button>
        <button type="button" class="wp-btn" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
        ${full ? `<button type="button" class="wp-btn" data-cmd="indent" title="Indent">&rarr;|</button>
        <button type="button" class="wp-btn" data-cmd="outdent" title="Outdent">|&larr;</button>
        <button type="button" class="wp-btn" data-cmd="formatBlock" data-val="blockquote" title="Quote">&#10077;</button>
        <span class="wp-sep"></span>
        <button type="button" class="wp-btn" data-cmd="superscript" title="Superscript — footnote markers">x&sup2;</button>
        <button type="button" class="wp-btn" data-cmd="subscript" title="Subscript">x&#8322;</button>
        <span class="wp-sep"></span>
        <button type="button" class="wp-btn" data-cmd="insertTable" title="Insert a table">&#9638; Table</button>
        <button type="button" class="wp-btn" data-cmd="addRow" title="Add a row below the cursor">+ Row</button>` : ''}
        <span class="wp-sep"></span>
        <button type="button" class="wp-btn" data-cmd="createLink" title="Insert link">&#128279;</button>
        <button type="button" class="wp-btn" data-cmd="removeFormat" title="Clear formatting">&#10005;</button>
      </div>
      <div class="wp-area" contenteditable="true" data-wp-editor style="min-height:${rows * 1.5}em">${safe}</div>
      <textarea name="${name}" hidden data-wp-output>${escapeText(safe)}</textarea>
    </div>`;
}

function reportForm(report, matter, opts = {}) {
  const isEdit = !!(report && report.id);
  const action = isEdit ? `/admin/reports/${report.id}` : `/admin/matters/${matter.id}/reports`;
  const kindOptions = REPORT_KINDS.map((k) =>
    `<option value="${escapeText(k)}"${report && report.kind === k ? ' selected' : ''}>${escapeText(k)}</option>`).join('');

  const form = html`
    <form class="form" method="post" action="${action}" data-wp-form>
      <div class="form-row">
        <label>Title<input type="text" name="title" required value="${report ? report.title : ''}" placeholder="Staff report on…"></label>
        <label>Type<select name="kind">${raw(kindOptions)}</select></label>
      </div>
      ${raw(editorField('body_html', report ? report.body_html : '', { label: 'Document', rows: 16 }))}
      <div class="form-actions">
        <button type="submit" class="btn primary">${isEdit ? 'Save document' : 'Create document'}</button>
        <a class="btn-link" href="/legislation/${encodeURIComponent((report && report.file_number) || matter.file_number)}">Cancel</a>
      </div>
    </form>
    <script src="/assets/editor.js" defer></script>`;

  const fileNo = (matter && matter.file_number) || (report && report.file_number);
  const heading = isEdit ? 'Edit document' : 'New document';
  const body = html`${raw(card('Word processor', form))}`;
  return layout({
    title: heading,
    active: '/admin',
    crumbs: [
      { label: 'Clerk Workspace', href: '/admin' },
      { label: fileNo, href: `/legislation/${encodeURIComponent(fileNo)}` },
      { label: heading },
    ],
    subtitle: (report && report.title) || (matter && matter.title) || '',
    body,
  });
}

function reportView(report) {
  const body = html`
    <p class="crumbs"><a href="/legislation">Legislation</a>${report.file_number
      ? raw(` / <a href="/legislation/${encodeURIComponent(report.file_number)}">${escapeText(report.file_number)}</a>`) : ''} / Document</p>
    <article class="doc-view">
      <header class="doc-head">
        <span class="badge type">${report.kind}</span>
        <h1>${report.title}</h1>
        <p class="muted">${report.author_name ? 'By ' + report.author_name + ' · ' : ''}${raw(formatDate(report.updated_at))}${report.matter_title ? ' · Re: ' + report.matter_title : ''}</p>
      </header>
      <div class="doc-body">${raw(report.body_html || '<p class="empty">This document is empty.</p>')}</div>
    </article>`;
  // The page is the document, so it carries its own masthead rather than a
  // second page heading above it.
  return layout({ title: report.title, active: '/legislation', heading: false, body });
}

module.exports = { editorField, reportForm, reportView, REPORT_KINDS };
