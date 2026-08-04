'use strict';

// The drafting workbench — structure-aware legislative editing.
//
// Three surfaces:
//   • Draft      — the bill's text with a live provision outline and structural
//                  validation, so a drafter sees the document as a tree.
//   • Amend Code — the amending instructions this bill carries against the
//                  Board Code (add / amend / repeal by section).
//   • Compare    — the comparative prints: version-to-version, bill vs. current
//                  law, and amendment impact.

const { html, raw, formatDate } = require('../util');
const { layout, card, statusBadge, emptyState, escapeText } = require('./layout');
const repo = require('../repo');
const legisdoc = require('../legisdoc');
const amend = require('../amend');

function opBadge(op) {
  const label = { add: 'Adds', amend: 'Amends', repeal: 'Repeals' }[op] || op;
  return `<span class="op op-${escapeText(op)}">${escapeText(label)}</span>`;
}

function issueList(issues) {
  if (!issues.length) return '<p class="val-ok">✓ No structural issues.</p>';
  return `<ul class="val-list">${issues.map((i) => `<li class="val-${escapeText(i.level)}">`
    + `<span class="val-tag">${escapeText(i.level)}</span>`
    + (i.id ? `<a href="#${escapeText(i.id)}">${escapeText(legisdoc.cite(i.id))}</a> ` : '')
    + escapeText(i.msg) + '</li>').join('')}</ul>`;
}

function outlineNav(doc) {
  const ol = legisdoc.outline(doc);
  if (!ol.length) return emptyState('No sections yet — start with “SECTION 1.”');
  return `<ol class="ld-outline">${ol.map((s) => `<li>
    <a class="ldo-sec" href="#${escapeText(s.id)}"><b>${escapeText(s.label)}</b> ${escapeText(s.heading || '')}</a>
    ${s.children.length ? `<ol>${s.children.map((c) =>
      `<li><a href="#${escapeText(c.id)}"><b>${escapeText(c.label)}</b> ${escapeText(c.heading)}</a></li>`).join('')}</ol>` : ''}
  </li>`).join('')}</ol>`;
}

// --- Draft: text + outline + validation -------------------------------------
function draftPage(matter, { saved = false } = {}) {
  const text = matter.full_text || '';
  const doc = legisdoc.parse(text);
  const issues = legisdoc.validate(doc);
  const flat = legisdoc.flatten(doc);
  const impact = amend.codeImpact(matter.id);

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / <a href="/legislation/${matter.file_number}">${matter.file_number}</a> / Drafting</p>
    <div class="detail-head">
      <h1>${matter.title}</h1>
      <span class="head-actions">
        <a class="btn" href="/admin/legislation/${matter.id}/code">Amend the Code${impact.total ? raw(` <span class="badge">${impact.total}</span>`) : ''}</a>
        <a class="btn" href="/admin/legislation/${matter.id}/compare">Comparative print</a>
      </span>
    </div>
    ${saved ? raw('<p class="saved-banner">Draft saved.</p>') : ''}
    <p class="muted">${matter.file_number} · ${statusBadge(matter.status)} ·
      ${flat.length} provision${flat.length === 1 ? '' : 's'} · ${doc.sections.length} section${doc.sections.length === 1 ? '' : 's'}</p>

    <div class="draft-grid">
      <div class="draft-side">
        ${raw(card('Outline', outlineNav(doc)))}
        ${raw(card('Validation', issueList(issues)))}
      </div>
      <div class="draft-main">
        ${raw(card('Structured preview', `<div class="ld-doc">${legisdoc.toHtml(doc)}</div>`))}
        ${raw(card('Drafting text', `
          <form class="form" method="post" action="/admin/legislation/${matter.id}/draft">
            <p class="muted" style="margin-top:0">Number provisions as
              <code>SECTION 1.</code> → <code>(a)</code> → <code>(1)</code> → <code>(A)</code> → <code>(i)</code>.
              Structure is parsed as you save, giving every provision a citable identifier.</p>
            <textarea name="full_text" rows="20" class="mono" spellcheck="false">${escapeText(text)}</textarea>
            <div class="form-actions">
              <button type="submit" class="btn primary">Save draft</button>
              <label class="chk"><input type="checkbox" name="snapshot" value="1"> Save as a new version</label>
            </div>
          </form>`))}
      </div>
    </div>`;
  return layout({ title: 'Drafting — ' + matter.file_number, active: '/admin', body });
}

// --- Amending instructions ---------------------------------------------------
function codePage(matter, { saved = false } = {}) {
  const rows = repo.code.amendments(matter.id);
  const impact = amend.codeImpact(matter.id);
  const sections = repo.code.sections();

  const list = rows.length ? `<table class="data compact">
    <thead><tr><th>Operation</th><th>Section</th><th>Heading</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows.map((a) => {
    const target = repo.code.byCitation(a.citation);
    return html`<tr>
        <td>${raw(opBadge(a.op))}</td>
        <td><b>§${a.citation}</b></td>
        <td>${a.heading || (target ? target.heading : raw('<span class="muted">— new —</span>'))}</td>
        <td>${a.applied_at ? raw('<span class="badge st-enacted">Codified</span>') : raw('<span class="badge st-draft">Pending</span>')}</td>
        <td>${a.applied_at ? '' : raw(`<form method="post" action="/admin/legislation/${matter.id}/code/${a.id}/delete" class="inline"><button class="btn-link" type="submit">Remove</button></form>`)}</td>
      </tr>`;
  }).join('')}</tbody></table>`
    : emptyState('This measure does not amend the Board Code yet.');

  const opts = sections.map((s) => `<option value="${escapeText(s.citation)}">§${escapeText(s.citation)} — ${escapeText(s.heading)}</option>`).join('');

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / <a href="/legislation/${matter.file_number}">${matter.file_number}</a> / Amend the Code</p>
    <div class="detail-head">
      <h1>Amending instructions</h1>
      <span class="head-actions">
        <a class="btn" href="/admin/legislation/${matter.id}/draft">Back to drafting</a>
        <a class="btn" href="/admin/legislation/${matter.id}/compare">Comparative print</a>
      </span>
    </div>
    <p class="muted">${matter.file_number} — ${matter.title}</p>
    ${saved ? raw('<p class="saved-banner">Instruction saved.</p>') : ''}
    ${impact.total ? raw(`<p class="code-impact-line">This measure would
      <b class="op-add-t">add ${impact.add}</b>, <b class="op-amend-t">amend ${impact.amend}</b>, and
      <b class="op-repeal-t">repeal ${impact.repeal}</b> section${impact.total === 1 ? '' : 's'}
      ${impact.titles.length ? ` of Title ${impact.titles.join(', ')}` : ''}.</p>`) : ''}
    ${raw(card('Instructions', list))}
    ${raw(card('Add an instruction', `
      <form class="form" method="post" action="/admin/legislation/${matter.id}/code">
        <div class="form-row">
          <label>Operation<select name="op" required>
            <option value="amend">Amend an existing section</option>
            <option value="add">Add a new section</option>
            <option value="repeal">Repeal a section</option>
          </select></label>
          <label>Section citation<input type="text" name="citation" required placeholder="12-4" list="code-sections">
            <datalist id="code-sections">${opts}</datalist></label>
        </div>
        <label>Heading <span class="muted">(for a new section)</span><input type="text" name="heading" placeholder="Tree Canopy Program"></label>
        <label>Proposed text <span class="muted">(the section as it would read; leave blank for a repeal)</span>
          <textarea name="new_text" rows="10" class="mono" spellcheck="false" placeholder="SECTION 1. Purpose.&#10;(a) ..."></textarea></label>
        <button type="submit" class="btn primary">Add instruction</button>
      </form>`))}`;
  return layout({ title: 'Amend the Code — ' + matter.file_number, active: '/admin', body });
}

// --- Comparative print -------------------------------------------------------
function comparePage(matter, mode, query = {}) {
  const versions = repo.matters.versions(matter.id);
  const tabs = [
    ['law', 'Bill vs. current law'],
    ['versions', 'Version to version'],
    ['impact', 'Amendment impact'],
  ];
  const nav = `<nav class="cp-tabs">${tabs.map(([k, label]) =>
    `<a class="cp-tab${mode === k ? ' active' : ''}" href="/admin/legislation/${matter.id}/compare?mode=${k}">${escapeText(label)}</a>`).join('')}</nav>`;

  let panel = '';
  if (mode === 'law') {
    const prints = amend.comparativePrint(matter.id);
    panel = prints.length ? prints.map((p) => `
      <section class="cp-sec">
        <div class="cp-head">
          ${opBadge(p.op)}
          <b>§${escapeText(p.citation)}</b>
          <span class="muted">${escapeText(p.heading || '')}</span>
          ${!p.exists && p.op !== 'add' ? '<span class="cp-warn">target not found in the Code</span>' : ''}
          <span class="cp-stats">+${p.stats.added} / −${p.stats.removed} words</span>
        </div>
        <div class="cp-body df-body">${p.diff || '<span class="muted">No text.</span>'}</div>
        ${p.issues.length ? `<div class="cp-issues">${issueList(p.issues)}</div>` : ''}
      </section>`).join('')
      : emptyState('This measure carries no amending instructions. Add them under “Amend the Code”.');
  } else if (mode === 'versions') {
    const a = Number(query.a) || (versions[1] ? versions[1].version : 0);
    const b = Number(query.b) || (versions[0] ? versions[0].version : 0);
    const va = versions.find((v) => v.version === a);
    const vb = versions.find((v) => v.version === b);
    const opts = (sel) => versions.map((v) =>
      `<option value="${v.version}"${v.version === sel ? ' selected' : ''}>v${v.version} — ${escapeText(formatDate(v.created_at) || '')}</option>`).join('');
    panel = versions.length < 2
      ? emptyState('At least two saved versions are needed to compare.')
      : `<form class="form inline-form" method="get" action="/admin/legislation/${matter.id}/compare">
          <input type="hidden" name="mode" value="versions">
          <div class="form-row">
            <label>From<select name="a">${opts(a)}</select></label>
            <label>To<select name="b">${opts(b)}</select></label>
          </div>
          <button class="btn" type="submit">Compare</button>
        </form>
        <div class="cp-body df-body">${va && vb
    ? require('../diff').diffHtml(va.full_text || '', vb.full_text || '')
    : '<span class="muted">Pick two versions.</span>'}</div>`;
  } else {
    const proposed = query.proposed || '';
    const base = matter.full_text || '';
    const res = proposed ? amend.amendmentImpact(base, proposed) : null;
    // POSTed, not GET: a real draft would overflow the request line (414) and
    // would otherwise sit in browser history and access logs.
    panel = `<p class="muted">Paste a proposed amendment to this measure's text to see how it would change the bill if adopted.</p>
      <form class="form" method="post" action="/admin/legislation/${matter.id}/compare/impact">
        <label>Proposed text<textarea name="proposed" rows="12" class="mono" spellcheck="false">${escapeText(proposed)}</textarea></label>
        <button class="btn primary" type="submit">Show impact</button>
      </form>
      ${res ? `<div class="cp-head"><span class="cp-stats">+${res.stats.added} / −${res.stats.removed} words</span></div>
        <div class="cp-body df-body">${res.diff}</div>
        ${res.issues.length ? `<div class="cp-issues">${issueList(res.issues)}</div>` : ''}` : ''}`;
  }

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / <a href="/legislation/${matter.file_number}">${matter.file_number}</a> / Comparative print</p>
    <div class="detail-head">
      <h1>Comparative print</h1>
      <span class="head-actions">
        <a class="btn" href="/admin/legislation/${matter.id}/draft">Back to drafting</a>
      </span>
    </div>
    <p class="muted">${matter.file_number} — ${matter.title}</p>
    ${raw(nav)}
    ${raw(`<div class="cp-panel">${panel}</div>`)}`;
  return layout({ title: 'Comparative print — ' + matter.file_number, active: '/admin', body });
}

// --- The Board Code (public) -------------------------------------------------
function codeIndex() {
  const sections = repo.code.sections();
  const st = repo.code.stats();
  const byTitle = {};
  for (const s of sections) (byTitle[s.title_num || '—'] = byTitle[s.title_num || '—'] || []).push(s);

  const groups = Object.keys(byTitle).sort((a, b) => Number(a) - Number(b)).map((t) => `
    <section class="code-title">
      <h2>Title ${escapeText(t)}</h2>
      <ul class="code-list">${byTitle[t].map((s) => `<li>
        <a href="/code/${encodeURIComponent(s.citation)}"><b>§${escapeText(s.citation)}</b> ${escapeText(s.heading)}</a>
      </li>`).join('')}</ul>
    </section>`).join('');

  const body = html`
    <p class="crumbs"><a href="/">Home</a> / Board Code</p>
    <h1>The Board Code</h1>
    <p class="muted">${st.sections} sections in force${st.repealed ? ` · ${st.repealed} repealed` : ''}${st.pending ? ` · ${st.pending} pending amendment${st.pending === 1 ? '' : 's'}` : ''}.
      Each section links back to the measure that enacted it.</p>
    ${sections.length ? raw(groups) : emptyState('No sections have been codified yet.')}`;
  return layout({ title: 'Board Code', active: '/code', body });
}

function codeSection(section) {
  const doc = legisdoc.parse(section.body_text || '');
  const history = repo.code.historyFor(section.id);
  const pending = repo.code.pendingFor(section.citation);
  const enactedBy = section.enacted_by ? repo.matters.get(section.enacted_by) : null;

  const histRows = history.length ? `<table class="data compact">
    <thead><tr><th>Change</th><th>Authority</th><th>Effective</th></tr></thead>
    <tbody>${history.map((h) => html`<tr>
      <td>${raw(opBadge(h.op))}</td>
      <td>${h.file_number ? raw(`<a href="/legislation/${escapeText(h.file_number)}">${escapeText(h.file_number)}</a> — ${escapeText(h.matter_title || '')}`) : raw('<span class="muted">—</span>')}</td>
      <td>${h.effective_date ? raw(formatDate(h.effective_date)) : raw(formatDate(h.created_at))}</td>
    </tr>`).join('')}</tbody></table>`
    : emptyState('No recorded amendments.');

  const pendingBox = pending.length ? raw(`<div class="pending-box">
    <b>Pending legislation.</b> ${pending.map((p) => `<a href="/legislation/${escapeText(p.file_number)}">${escapeText(p.file_number)}</a>
      would ${escapeText(p.op)} this section`).join('; ')}.
    <a href="/legislation/${escapeText(pending[0].file_number)}">View the measure →</a>
  </div>`) : '';

  const body = html`
    <p class="crumbs"><a href="/code">Board Code</a> / Title ${section.title_num || '—'} / §${section.citation}</p>
    <div class="detail-head">
      <h1>§${section.citation} — ${section.heading}</h1>
      ${section.status === 'Repealed' ? raw('<span class="badge st-failed">Repealed</span>') : ''}
    </div>
    ${pendingBox}
    <dl class="meta">
      <dt>Status</dt><dd>${section.status}</dd>
      <dt>Effective</dt><dd>${section.effective_date ? raw(formatDate(section.effective_date)) : '—'}</dd>
      <dt>Enacted by</dt><dd>${enactedBy ? raw(`<a href="/legislation/${escapeText(enactedBy.file_number)}">${escapeText(enactedBy.file_number)}</a> — ${escapeText(enactedBy.title)}`) : '—'}</dd>
    </dl>
    ${raw(card('Text', `<div class="ld-doc">${legisdoc.toHtml(doc)}</div>`))}
    ${raw(card('Amendment history', histRows))}`;
  return layout({ title: `§${section.citation}`, active: '/code', body });
}

module.exports = { draftPage, codePage, comparePage, codeIndex, codeSection };
