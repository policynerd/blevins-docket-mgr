'use strict';

const { html, raw, formatDate } = require('../util');
const { layout, card, escapeText } = require('./layout');
const repo = require('../repo');

const REPORT_KINDS = ['Staff Report', 'Memorandum', 'Fiscal Note', 'Legal Analysis', 'Draft Legislation'];

// Reusable rich-text "word processor" field. `valueHtml` must already be
// sanitized (it is injected into the editable surface as real HTML).
function editorField(name, valueHtml, { label, rows = 12 } = {}) {
  const safe = valueHtml || '';
  return `
    <div class="wp">
      ${label ? `<div class="wp-label">${escapeText(label)}</div>` : ''}
      <div class="wp-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" class="wp-btn" data-cmd="bold" title="Bold"><b>B</b></button>
        <button type="button" class="wp-btn" data-cmd="italic" title="Italic"><i>I</i></button>
        <button type="button" class="wp-btn" data-cmd="underline" title="Underline"><u>U</u></button>
        <span class="wp-sep"></span>
        <button type="button" class="wp-btn" data-cmd="formatBlock" data-val="h2" title="Heading">H2</button>
        <button type="button" class="wp-btn" data-cmd="formatBlock" data-val="h3" title="Subheading">H3</button>
        <button type="button" class="wp-btn" data-cmd="formatBlock" data-val="p" title="Body text">¶</button>
        <span class="wp-sep"></span>
        <button type="button" class="wp-btn" data-cmd="insertUnorderedList" title="Bulleted list">• List</button>
        <button type="button" class="wp-btn" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
        <button type="button" class="wp-btn" data-cmd="formatBlock" data-val="blockquote" title="Quote">❝</button>
        <span class="wp-sep"></span>
        <button type="button" class="wp-btn" data-cmd="createLink" title="Insert link">🔗</button>
        <button type="button" class="wp-btn" data-cmd="removeFormat" title="Clear formatting">✕</button>
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
  const body = html`
    <p class="crumbs"><a href="/admin">Clerk Workspace</a> / <a href="/legislation/${encodeURIComponent(fileNo)}">${fileNo}</a> / ${isEdit ? 'Edit document' : 'New document'}</p>
    <h1>${isEdit ? 'Edit document' : 'New document'}</h1>
    ${raw(card('Word processor', form))}`;
  return layout({ title: isEdit ? 'Edit document' : 'New document', active: '/admin', body });
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
  return layout({ title: report.title, active: '/legislation', body });
}

module.exports = { editorField, reportForm, reportView, REPORT_KINDS };
