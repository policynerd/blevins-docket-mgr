'use strict';

// Procurement / vendor portal: public solicitation listings (RFP/RFQ/IFB/bid),
// vendor registration, public Q&A and bid submission; clerk-side create/edit,
// question answering, bid review, and award (optionally spawning a Contract
// legislative file + budget commitment).
const { html, raw, formatDate, todayISO } = require('../util');
const { layout, card, statusBadge, emptyState, escapeText } = require('./layout');
const { editorField } = require('./reports');
const { money } = require('./budget');
const { ORG } = require('../org');
const auth = require('../auth');
const repo = require('../repo');

function kindBadge(kind) {
  return `<span class="badge type">${escapeText(kind)}</span>`;
}
function selectOptions(values, current) {
  return values.map((v) => `<option value="${escapeText(v)}"${String(v) === String(current) ? ' selected' : ''}>${escapeText(v)}</option>`).join('');
}

// ---- Public listing ---------------------------------------------------------
function procurementList() {
  const rows = repo.procurement.list();
  const table = rows.length
    ? `<table class="data"><thead><tr><th>Number</th><th>Type</th><th>Title</th><th>Status</th>
        <th>Closes</th><th>Bids</th></tr></thead><tbody>${rows.map((s) => html`
        <tr>
          <td><a href="/procurement/${s.id}">${s.number}</a></td>
          <td>${raw(kindBadge(s.kind))}</td>
          <td class="title-cell">${s.title}</td>
          <td>${statusBadge(s.status)}${s.awarded_vendor_name ? raw(`<div class="sub">to ${escapeText(s.awarded_vendor_name)}</div>`) : ''}</td>
          <td>${s.close_date ? raw(formatDate(s.close_date)) : ''}</td>
          <td>${s.bid_count || 0}</td>
        </tr>`).join('')}</tbody></table>`
    : emptyState('No solicitations posted.');
  const body = html`
    <div class="detail-head">
      <h1>Procurement</h1>
      <span class="head-actions"><a class="btn" href="/vendors/register">Register as a vendor</a></span>
    </div>
    <p class="muted">Open solicitations (RFPs, RFQs, invitations for bid) from the ${ORG.name}.
      Register your business to join our vendor list, then submit questions and bids on any open solicitation.</p>
    ${raw(card('Solicitations', table))}`;
  return layout({ title: 'Procurement', active: '/procurement',
    subtitle: 'Solicitations, vendors, and bids.', body });
}

// ---- Public solicitation detail ---------------------------------------------
function solicitationDetail(s, query = {}) {
  const questions = repo.procurement.questions(s.id).filter((q) => q.answer); // only answered shown publicly
  const isOpen = s.status === 'Open';
  const canBid = repo.procurement.biddable(s); // status Open AND within the posted window

  const qaList = questions.length
    ? `<ul class="comment-list">${questions.map((q) => html`
        <li><div class="comment-head"><strong>Q:</strong> ${q.question}</div>
          <p class="comment-body"><strong>A:</strong> ${q.answer}</p></li>`).join('')}</ul>`
    : emptyState('No questions answered yet.');

  const notice = query.asked === '1'
    ? '<p class="form-ok">Your question was received; answers are published here once posted.</p>'
    : (query.bid === '1' ? '<p class="form-ok">Your bid was submitted. Thank you.</p>' : '');

  const questionForm = isOpen ? `
    <h3 class="tab-h">Ask a question</h3>
    <form class="form" method="post" action="/procurement/${s.id}/questions">
      <div class="form-row">
        <label>Your name<input type="text" name="name" required maxlength="100"></label>
        <label>Email (not published)<input type="email" name="email" maxlength="200"></label>
      </div>
      <input type="text" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
      <label>Question<textarea name="question" rows="3" required maxlength="2000"></textarea></label>
      <button type="submit" class="btn">Submit question</button>
    </form>` : '';

  const bidForm = canBid ? raw(card('Submit a bid', `
    <form class="form" method="post" action="/procurement/${s.id}/bids">
      <div class="form-row">
        <label>Vendor / company<input type="text" name="vendor_name" required maxlength="140"></label>
        <label>Email<input type="email" name="email" maxlength="200"></label>
        <label>Bid amount ($)<input type="number" step="0.01" name="amount"></label>
      </div>
      <input type="text" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
      <label>Notes / summary<textarea name="note" rows="3" maxlength="4000"></textarea></label>
      <p class="muted">Bid amounts are not shown publicly. Ensure your submission meets the requirements above before the close date.</p>
      <button type="submit" class="btn primary">Submit bid</button>
    </form>`)) : '';

  const awardCard = s.status === 'Awarded' ? raw(card('Award', `
    <p>Awarded to <strong>${escapeText(s.awarded_vendor_name || '—')}</strong>${s.award_amount != null ? ` for ${money(s.award_amount)}` : ''}.
    ${s.file_number ? `Contract file: <a href="/legislation/${encodeURIComponent(s.file_number)}">${escapeText(s.file_number)}</a>.` : ''}</p>`)) : '';

  const body = html`
    <p class="crumbs"><a href="/procurement">Procurement</a> / ${s.number}</p>
    <div class="detail-head">
      <h1>${s.title} ${raw(kindBadge(s.kind))} ${statusBadge(s.status)}</h1>
    </div>
    ${raw(notice)}
    ${raw(card('Details', html`
      <dl class="meta record-header">
        <dt>Number</dt><dd>${s.number}</dd>
        <dt>Type</dt><dd>${s.kind}</dd>
        <dt>Status</dt><dd>${statusBadge(s.status)}</dd>
        <dt>Opens</dt><dd>${s.open_date ? raw(formatDate(s.open_date)) : '—'}</dd>
        <dt>Closes</dt><dd>${s.close_date ? raw(formatDate(s.close_date)) : '—'}</dd>
      </dl>
      ${s.body_html ? raw(`<div class="doc-body">${s.body_html}</div>`) : ''}`))}
    ${awardCard}
    ${bidForm}
    ${raw(card('Questions & answers', qaList + questionForm))}`;
  return layout({ title: s.number, active: '/procurement', body });
}

// ---- Vendor registration (public) -------------------------------------------
function vendorRegister(query = {}) {
  const done = query.registered === '1';
  const form = done
    ? '<p class="form-ok">Thank you — your vendor registration has been received.</p>'
    : `
    <p class="muted">Register your business to appear in the ${escapeText(ORG.name)} vendor list.</p>
    <form class="form" method="post" action="/vendors/register">
      <div class="form-row">
        <label>Business name<input type="text" name="name" required maxlength="140"></label>
        <label>Contact name<input type="text" name="contact_name" maxlength="100"></label>
      </div>
      <div class="form-row">
        <label>Email<input type="email" name="email" maxlength="200"></label>
        <label>Phone<input type="text" name="phone" maxlength="40"></label>
      </div>
      <input type="text" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
      <label>Categories / goods &amp; services<input type="text" name="categories" maxlength="300"
        placeholder="Construction, IT services, office supplies…"></label>
      <button type="submit" class="btn primary">Register</button>
    </form>`;
  const body = html`
    <p class="crumbs"><a href="/procurement">Procurement</a> / Vendor registration</p>
    <h1>Vendor registration</h1>
    ${raw(card('Register', form))}`;
  return layout({ title: 'Vendor registration', active: '/procurement', body });
}

// ---- Clerk: solicitation list + create --------------------------------------
function procurementAdmin() {
  const rows = repo.procurement.list({ includeAll: true });
  const table = rows.length
    ? `<table class="data compact"><thead><tr><th>Number</th><th>Type</th><th>Title</th><th>Status</th>
        <th>Bids</th><th></th></tr></thead><tbody>${rows.map((s) => html`
        <tr>
          <td><a href="/admin/procurement/${s.id}">${s.number}</a></td>
          <td>${s.kind}</td><td class="title-cell">${s.title}</td>
          <td>${statusBadge(s.status)}</td><td>${s.bid_count || 0}</td>
          <td><a class="btn-link" href="/procurement/${s.id}">public</a></td>
        </tr>`).join('')}</tbody></table>`
    : emptyState('No solicitations yet.');
  const budgetOpts = repo.budget.lineOptions()
    .map((o) => `<option value="${o.value}">${escapeText(o.label)}</option>`).join('');
  const createForm = html`
    <form class="form" method="post" action="/admin/procurement" data-wp-form>
      <div class="form-row">
        <label>Type<select name="kind">${raw(selectOptions(repo.SOLICITATION_KINDS, 'RFP'))}</select></label>
        <label>Status<select name="status">${raw(selectOptions(repo.SOLICITATION_STATUSES, 'Draft'))}</select></label>
      </div>
      <label>Title<input type="text" name="title" required placeholder="Bridge rehabilitation — engineering services"></label>
      <div class="form-row">
        <label>Opens<input type="date" name="open_date" value="${todayISO()}"></label>
        <label>Closes<input type="date" name="close_date"></label>
        <label>Budget line<select name="budget_line_id"><option value="">— none —</option>${raw(budgetOpts)}</select></label>
      </div>
      ${raw(editorField('body_html', '', { label: 'Scope / requirements', rows: 10 }))}
      <button type="submit" class="btn primary">Create solicitation</button>
    </form>
    <script src="/assets/editor.js" defer></script>`;
  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Procurement</p>
    <div class="detail-head"><h1>Procurement</h1>
      <span class="head-actions"><a class="btn" href="/admin/vendors">Vendor registry</a></span></div>
    ${raw(card('Solicitations', table))}
    ${raw(card('New solicitation', createForm))}`;
  return layout({ title: 'Procurement', active: '/admin', body });
}

// ---- Clerk: manage one solicitation (edit, Q&A, bids, award) -----------------
function solicitationManage(s) {
  const budgetOpts = repo.budget.lineOptions()
    .map((o) => `<option value="${o.value}"${s.budget_line_id === o.value ? ' selected' : ''}>${escapeText(o.label)}</option>`).join('');
  const editForm = html`
    <form class="form" method="post" action="/admin/procurement/${s.id}" data-wp-form>
      <div class="form-row">
        <label>Type<select name="kind">${raw(selectOptions(repo.SOLICITATION_KINDS, s.kind))}</select></label>
        <label>Status<select name="status">${raw(selectOptions(repo.SOLICITATION_STATUSES, s.status))}</select></label>
      </div>
      <label>Title<input type="text" name="title" required value="${escapeText(s.title)}"></label>
      <div class="form-row">
        <label>Opens<input type="date" name="open_date" value="${escapeText(s.open_date || '')}"></label>
        <label>Closes<input type="date" name="close_date" value="${escapeText(s.close_date || '')}"></label>
        <label>Budget line<select name="budget_line_id"><option value="">— none —</option>${raw(budgetOpts)}</select></label>
      </div>
      ${raw(editorField('body_html', s.body_html || '', { label: 'Scope / requirements', rows: 10 }))}
      <button type="submit" class="btn primary">Save</button>
    </form>
    <script src="/assets/editor.js" defer></script>`;

  const questions = repo.procurement.questions(s.id);
  const qList = questions.length
    ? `<ul class="comment-list">${questions.map((q) => html`
        <li><div class="comment-head"><strong>${q.name}</strong>${q.email ? raw(` <span class="muted">${escapeText(q.email)}</span>`) : ''} · ${raw(formatDate(q.created_at))}</div>
          <p class="comment-body">${q.question}</p>
          <form class="form inline-form" method="post" action="/admin/procurement/${s.id}/questions/${q.id}/answer">
            <label>Answer (published)<input type="text" name="answer" value="${escapeText(q.answer || '')}" placeholder="Public answer"></label>
            <button type="submit" class="btn-link">${q.answer ? 'Update' : 'Answer'}</button>
          </form></li>`).join('')}</ul>`
    : emptyState('No questions.');

  const bids = repo.procurement.bids(s.id);
  const bidRows = bids.length
    ? `<table class="data compact"><thead><tr><th>Vendor</th><th>Email</th><th class="num">Amount</th><th>Notes</th><th></th></tr></thead>
       <tbody>${bids.map((b) => html`<tr>
         <td>${b.vendor_name}</td><td class="muted">${b.email || ''}</td>
         <td class="num">${b.amount != null ? raw(money(b.amount)) : ''}</td>
         <td>${b.note || ''}</td>
         <td><form method="post" action="/admin/procurement/${s.id}/award" class="inline">
           <input type="hidden" name="bid_id" value="${b.id}">
           <label class="check-label"><input type="checkbox" name="make_contract" value="1"> +contract</label>
           <button type="submit" class="btn-link">Award →</button></form></td></tr>`).join('')}</tbody></table>`
    : emptyState('No bids received.');

  const vendorOpts = repo.vendors.all()
    .map((v) => `<option value="${v.id}">${escapeText(v.name)}</option>`).join('');
  const awardForm = `
    <form class="form inline-form" method="post" action="/admin/procurement/${s.id}/award">
      <div class="form-row">
        <label>Award to vendor<select name="vendor_id"><option value="">— select —</option>${vendorOpts}</select></label>
        <label>Amount ($)<input type="number" step="0.01" name="amount" value="${s.award_amount != null ? s.award_amount : ''}"></label>
        <label class="check-label"><input type="checkbox" name="make_contract" value="1"> Create a Contract file &amp; budget commitment</label>
      </div>
      <button type="submit" class="btn primary">Record award</button>
    </form>`;
  const awardState = s.status === 'Awarded'
    ? `<p class="form-ok">Awarded to ${escapeText(s.awarded_vendor_name || '—')}${s.award_amount != null ? ' for ' + money(s.award_amount) : ''}.
       ${s.file_number ? `Contract file <a href="/legislation/${encodeURIComponent(s.file_number)}">${escapeText(s.file_number)}</a>.` : ''}</p>` : '';

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / <a href="/admin/procurement">Procurement</a> / ${s.number}</p>
    <div class="detail-head"><h1>${s.number} — ${s.title} ${statusBadge(s.status)}</h1>
      <span class="head-actions"><a class="btn" href="/procurement/${s.id}">View public</a></span></div>
    ${raw(card('Edit solicitation', editForm))}
    ${raw(card(`Questions (${questions.length})`, qList))}
    ${raw(card(`Bids received (${bids.length})`, bidRows))}
    ${raw(card('Award', awardState + awardForm))}`;
  return layout({ title: s.number, active: '/admin', body });
}

// ---- Clerk: vendor registry -------------------------------------------------
function vendorsAdmin() {
  const rows = repo.vendors.all();
  const table = rows.length
    ? `<table class="data compact"><thead><tr><th>Vendor</th><th>Contact</th><th>Email</th><th>Categories</th><th>Status</th><th></th></tr></thead>
       <tbody>${rows.map((v) => html`<tr>
         <td>${v.name}</td><td>${v.contact_name || ''}</td><td class="muted">${v.email || ''}</td>
         <td>${v.categories || ''}</td><td>${statusBadge(v.status)}</td>
         <td><form method="post" action="/admin/vendors/${v.id}/status" class="inline">
           <input type="hidden" name="status" value="${v.status === 'Suspended' ? 'Registered' : 'Suspended'}">
           <button type="submit" class="btn-link">${v.status === 'Suspended' ? 'Reinstate' : 'Suspend'}</button></form></td>
         </tr>`).join('')}</tbody></table>`
    : emptyState('No registered vendors.');
  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / <a href="/admin/procurement">Procurement</a> / Vendors</p>
    <h1>Vendor registry (${rows.length})</h1>
    ${raw(card('Registered vendors', table))}`;
  return layout({ title: 'Vendors', active: '/admin', body });
}

module.exports = {
  procurementList, solicitationDetail, vendorRegister,
  procurementAdmin, solicitationManage, vendorsAdmin,
};
