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
const { layout, card, stepStrip, statusBadge, emptyState, escapeText } = require('./layout');
const { editorField } = require('./reports');
const { sanitizeHtml } = require('../sanitize');
const repo = require('../repo');
const legisdoc = require('../legisdoc');
const amend = require('../amend');
const docTemplates = require('../doc-templates');

// Drafting a measure is one job with four surfaces, not four errands. The
// strip is the same one the meeting workflow uses, so "where am I and what is
// left" reads identically in both places.
function draftSteps(matter, current) {
  const fn = encodeURIComponent(matter.file_number);
  const impact = amend.codeImpact(matter.id);
  const missing = repo.letters.missing(matter.id);
  const versions = repo.matters.versions(matter.id).length;
  return stepStrip([
    { id: 'draft', label: 'Draft the text', href: `/admin/legislation/${fn}/draft`,
      done: !!String(matter.full_text || '').trim() },
    { id: 'code', label: 'Changes to the Code', href: `/admin/legislation/${fn}/code`,
      done: impact.total > 0 },
    { id: 'letter', label: 'Board letter', href: `/admin/legislation/${fn}/letter`,
      done: missing.length === 0 },
    // A review surface rather than a thing to fill in: it is "done" once there
    // is something to review against — a prior version or an amending
    // instruction.
    { id: 'compare', label: 'Comparative print', href: `/admin/legislation/${fn}/compare`,
      done: versions >= 2 || impact.total > 0 },
  ], current, 'Drafting workflow');
}

// One line, on every drafting surface, answering the only question that
// governs whether the file can move: can it go before the board yet.
function readiness(matter) {
  const missing = repo.letters.missing(matter.id);
  const hasText = !!String(matter.full_text || '').trim();
  if (!hasText) {
    return `<p class="form-warn">Not ready to agendise — the measure has no text yet.</p>`;
  }
  if (missing.length) {
    return `<p class="form-warn">Not ready to agendise — ${missing.length} required board-letter
      section${missing.length === 1 ? '' : 's'} still blank:
      ${escapeText(missing.join(', '))}.
      <a href="/admin/legislation/${escapeText(encodeURIComponent(matter.file_number))}/letter">Write them →</a></p>`;
  }
  return `<p class="saved-banner">Ready to agendise — text written and every required board-letter section answered.</p>`;
}

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

// Offered only while the draft is empty: the drafting form for this file's
// type, and the amendatory form for a measure that changes the Board Code.
// Both produce structured text, so the draft starts inside the provision tree
// rather than as prose that has to be restructured later.
function startFromForm(matter, text) {
  if (String(text || '').trim()) return '';
  const t = escapeText(matter.type || 'measure');
  const has = !!docTemplates.draftingDefaults()[matter.type];
  return `<div class="start-form">
    <div>
      <b>Start from a drafting form.</b>
      <p class="muted">${has
    ? `The ${t} form lays out the customary sections — findings, definitions, the operative provision, severability and effective date — numbered so the outline, validation and comparison against current law work from the first save.`
    : `No form is defined for ${t}. The amendatory form suits a measure that changes the Board Code.`}</p>
    </div>
    <div class="head-actions">
      ${has ? `<form method="post" action="/admin/legislation/${escapeText(matter.file_number)}/draft/form" class="inline">
        <input type="hidden" name="form" value="type">
        <button type="submit" class="btn primary">Insert ${t} form</button></form>` : ''}
      <form method="post" action="/admin/legislation/${escapeText(matter.file_number)}/draft/form" class="inline">
        <input type="hidden" name="form" value="amendatory">
        <button type="submit" class="btn">Insert amendatory form</button></form>
    </div>
  </div>`;
}

// --- Draft: text + outline + validation -------------------------------------
function draftPage(matter, { saved = false } = {}) {
  const text = matter.full_text || '';
  const doc = legisdoc.parse(text);
  const issues = legisdoc.validate(doc);
  const flat = legisdoc.flatten(doc);
  const impact = amend.codeImpact(matter.id);

  const body = html`
    ${raw(draftSteps(matter, 'draft'))}
    ${saved ? raw('<p class="saved-banner">Draft saved.</p>') : ''}
    ${raw(readiness(matter))}
    <p class="muted">${statusBadge(matter.status)} ·
      ${flat.length} provision${flat.length === 1 ? '' : 's'} · ${doc.sections.length} section${doc.sections.length === 1 ? '' : 's'}</p>

    ${raw(startFromForm(matter, text))}

    <div class="draft-grid">
      <div class="draft-side">
        ${raw(card('Outline', outlineNav(doc)))}
        ${raw(card('Validation', issueList(issues)))}
      </div>
      <div class="draft-main">
        ${raw(card('Structured preview', `<div class="ld-doc">${legisdoc.toHtml(doc)}</div>`))}
        ${raw(card('Drafting text', `
          <form class="form" method="post" action="/admin/legislation/${encodeURIComponent(matter.file_number)}/draft">
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
  return layout({
    title: 'Drafting — ' + matter.file_number,
    h1: matter.title,
    active: '/admin',
    crumbs: [
      { label: 'Clerk Workspace', href: '/admin' },
      { label: matter.file_number, href: `/legislation/${encodeURIComponent(matter.file_number)}` },
      { label: 'Drafting' },
    ],
    actions: `<a class="btn" href="/legislation/${escapeText(encodeURIComponent(matter.file_number))}">View the file</a>`,
    subtitle: matter.file_number,
    body,
  });
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
        <td>${a.applied_at ? '' : raw(`<form method="post" action="/admin/legislation/${encodeURIComponent(matter.file_number)}/code/${a.id}/delete" class="inline"><button class="btn-link" type="submit">Remove</button></form>`)}</td>
      </tr>`;
  }).join('')}</tbody></table>`
    : emptyState('This measure does not amend the Board Code yet.');

  const opts = sections.map((s) => `<option value="${escapeText(s.citation)}">§${escapeText(s.citation)} — ${escapeText(s.heading)}</option>`).join('');

  const body = html`
    ${raw(draftSteps(matter, 'code'))}
    ${saved ? raw('<p class="saved-banner">Instruction saved.</p>') : ''}
    ${impact.total ? raw(`<p class="code-impact-line">This measure would
      <b class="op-add-t">add ${impact.add}</b>, <b class="op-amend-t">amend ${impact.amend}</b>, and
      <b class="op-repeal-t">repeal ${impact.repeal}</b> section${impact.total === 1 ? '' : 's'}
      ${impact.titles.length ? ` of Title ${impact.titles.join(', ')}` : ''}.</p>`) : ''}
    ${raw(card('Instructions', list))}
    ${raw(card('Add an instruction', `
      <form class="form" method="post" action="/admin/legislation/${encodeURIComponent(matter.file_number)}/code">
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
  return layout({
    title: 'Amend the Code — ' + matter.file_number,
    h1: 'Changes to the Code',
    active: '/admin',
    crumbs: [
      { label: 'Clerk Workspace', href: '/admin' },
      { label: matter.file_number, href: `/legislation/${encodeURIComponent(matter.file_number)}` },
      { label: 'Changes to the Code' },
    ],
    subtitle: matter.title,
    body,
  });
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
    `<a class="cp-tab${mode === k ? ' active' : ''}" href="/admin/legislation/${encodeURIComponent(matter.file_number)}/compare?mode=${k}">${escapeText(label)}</a>`).join('')}</nav>`;

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
      : `<form class="form inline-form" method="get" action="/admin/legislation/${encodeURIComponent(matter.file_number)}/compare">
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
      <form class="form" method="post" action="/admin/legislation/${encodeURIComponent(matter.file_number)}/compare/impact">
        <label>Proposed text<textarea name="proposed" rows="12" class="mono" spellcheck="false">${escapeText(proposed)}</textarea></label>
        <button class="btn primary" type="submit">Show impact</button>
      </form>
      ${res ? `<div class="cp-head"><span class="cp-stats">+${res.stats.added} / −${res.stats.removed} words</span></div>
        <div class="cp-body df-body">${res.diff}</div>
        ${res.issues.length ? `<div class="cp-issues">${issueList(res.issues)}</div>` : ''}` : ''}`;
  }

  const body = html`
    ${raw(draftSteps(matter, 'compare'))}
    ${raw(nav)}
    ${raw(`<div class="cp-panel">${panel}</div>`)}`;
  return layout({
    title: 'Comparative print — ' + matter.file_number,
    h1: 'Comparative print',
    active: '/admin',
    crumbs: [
      { label: 'Clerk Workspace', href: '/admin' },
      { label: matter.file_number, href: `/legislation/${encodeURIComponent(matter.file_number)}` },
      { label: 'Comparative print' },
    ],
    subtitle: matter.title,
    body,
  });
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
    ${sections.length ? raw(groups) : emptyState('No sections have been codified yet.')}`;
  return layout({
    title: 'Board Code',
    h1: 'The Board Code',
    active: '/code',
    crumbs: [{ label: 'Home', href: '/' }, { label: 'Board Code' }],
    subtitle: `${st.sections} sections in force`
      + `${st.repealed ? ` · ${st.repealed} repealed` : ''}`
      + `${st.pending ? ` · ${st.pending} pending amendment${st.pending === 1 ? '' : 's'}` : ''}.`
      + ' Each section links back to the measure that enacted it.',
    body,
  });
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
    ${pendingBox}
    <dl class="meta">
      <dt>Status</dt><dd>${section.status}</dd>
      <dt>Effective</dt><dd>${section.effective_date ? raw(formatDate(section.effective_date)) : '—'}</dd>
      <dt>Enacted by</dt><dd>${enactedBy ? raw(`<a href="/legislation/${escapeText(enactedBy.file_number)}">${escapeText(enactedBy.file_number)}</a> — ${escapeText(enactedBy.title)}`) : '—'}</dd>
    </dl>
    ${raw(card('Text', `<div class="ld-doc">${legisdoc.toHtml(doc)}</div>`))}
    ${raw(card('Amendment history', histRows))}`;
  return layout({
    title: `§${section.citation}`,
    h1: `§${section.citation} — ${section.heading}`,
    active: '/code',
    crumbs: [
      { label: 'Board Code', href: '/code' },
      { label: `Title ${section.title_num || '—'}` },
      { label: `§${section.citation}` },
    ],
    actions: section.status === 'Repealed' ? '<span class="badge st-failed">Repealed</span>' : '',
    body,
  });
}

module.exports = {
  letterPage, letterSectionsAdmin, draftPage, codePage, comparePage, codeIndex, codeSection };

// --- Board letter authoring --------------------------------------------------
// The letter is a fixed set of questions the body requires answered before it
// will hear an item, so it is authored as those questions rather than as free
// prose. Each section saves on its own: a clerk writes the background on
// Tuesday and the recommendation on Thursday, and a single all-or-nothing form
// would lose whichever half was open when the session expired.
function letterPage(matter, opts = {}) {
  const composed = repo.letters.compose(matter.id);
  const missing = composed.filter((s) => s.required && !s.filled);
  const done = composed.filter((s) => s.filled).length;

  const status = missing.length
    ? `<p class="form-warn">Not ready to agendise — ${missing.length} required section${missing.length === 1 ? '' : 's'} still blank:
       ${escapeText(missing.map((s) => s.label).join(', '))}.</p>`
    : `<p class="saved-banner">All required sections are written.</p>`;

  // Sanitized on the way out as well as the way in: rows written before the
  // save path sanitized are still in the table, and this value is injected
  // into the editing surface as real markup.
  const blocks = composed.map((s) => `
    <section class="ls-block${s.filled ? ' ls-filled' : ''}${s.required && !s.filled ? ' ls-missing' : ''}">
      <form class="form" method="post" data-wp-form action="/admin/legislation/${encodeURIComponent(matter.file_number)}/letter">
        <input type="hidden" name="section" value="${escapeText(s.key)}">
        <div class="ls-head">
          <h3>${escapeText(s.label)}</h3>
          ${s.required ? '<span class="badge pending-badge">Required</span>' : '<span class="muted">Optional</span>'}
        </div>
        <p class="muted ls-hint">${escapeText(s.hint || '')}</p>
        ${editorField('body_html', sanitizeHtml(s.body_html || ''), { rows: 6, toolbar: 'basic' })}
        <div class="form-actions">
          <button type="submit" class="btn">Save ${escapeText(s.label.toLowerCase())}</button>
        </div>
      </form>
    </section>`).join('');

  const body = html`
    ${raw(draftSteps(matter, 'letter'))}
    ${opts.saved ? raw('<p class="saved-banner">Section saved.</p>') : ''}
    ${raw(status)}
    <p class="muted">${raw(String(done))} of ${raw(String(composed.length))} sections written.
      The section list is set under <a href="/admin/letter-sections">Board letter sections</a>.</p>
    ${raw(blocks)}
    <script src="/assets/editor.js" defer></script>`;
  return layout({
    title: 'Board letter — ' + matter.file_number,
    h1: 'Board letter',
    active: '/admin',
    crumbs: [
      { label: 'Clerk Workspace', href: '/admin' },
      { label: matter.file_number, href: `/legislation/${encodeURIComponent(matter.file_number)}` },
      { label: 'Board letter' },
    ],
    actions: `<a class="btn primary" href="/legislation/${escapeText(encodeURIComponent(matter.file_number))}/doc/board-letter.pdf">Preview the letter</a>`,
    subtitle: matter.title,
    body,
  });
}

// The standard section list, edited as one section per line: KEY | LABEL | required
function letterSectionsAdmin(saved, opts = {}) {
  const current = repo.letters.sections();
  // Serialise every field the parser reads back, hint included. Emitting a
  // narrower form than the parser accepts means saving the list unchanged
  // silently strips whatever was left out — here, the guidance under every
  // section heading.
  const asText = current.map((s) =>
    [s.key, s.label, s.required ? 'required' : 'optional', s.hint || ''].join(' | ').replace(/ \| $/, '')
  ).join('\n');
  const body = html`
    ${saved ? raw('<p class="saved-banner">Section list saved.</p>') : ''}
    ${opts.error ? raw(`<p class="form-error">${escapeText(opts.error)}</p>`) : ''}
    ${raw(card('Standard sections', `
      <p class="muted">One per line: <code>key | LABEL | required | hint</code>.
        The third field is <code>required</code> or <code>optional</code>; the hint is the
        guidance shown under the heading while authoring. The key is what the stored text is
        filed under, so renaming a key orphans anything already written for it.
        A line that does not parse rejects the whole list rather than quietly dropping a section.</p>
      <form class="form" method="post" action="/admin/letter-sections">
        <textarea name="sections" rows="12">${escapeText(asText)}</textarea>
        <div class="form-actions">
          <button type="submit" class="btn primary">Save section list</button>
          <a class="btn-link" href="/admin">Cancel</a>
        </div>
      </form>`))}`;
  return layout({
    title: 'Board letter sections',
    active: '/admin',
    crumbs: [{ label: 'Clerk Workspace', href: '/admin' }, { label: 'Board letter sections' }],
    subtitle: 'The questions every board letter must answer, in the order they appear. '
      + 'Which questions a board asks is its own policy, so this list is configuration.',
    body,
  });
}
