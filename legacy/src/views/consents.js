'use strict';

// Board actions by unanimous written consent (action without a meeting). A
// clerk drafts a resolution, circulates it to every seated director, and it is
// adopted once all sign. Signatures are recorded in-app, or routed through an
// e-signature provider (Adobe Acrobat Sign) when configured.
const { html, raw, formatDate } = require('../util');
const { layout, card, statusBadge, emptyState, escapeText } = require('./layout');
const { editorField } = require('./reports');
const repo = require('../repo');
const esign = require('../esign');

function selectOptions(values, current) {
  return values.map((v) => `<option value="${escapeText(v.value)}"${String(v.value) === String(current) ? ' selected' : ''}>${escapeText(v.label)}</option>`).join('');
}

function consentsAdmin() {
  const rows = repo.consents.list();
  const table = rows.length ? `<table class="data compact">
    <thead><tr><th>Number</th><th>Title</th><th>Body</th><th>Status</th><th>Signed</th></tr></thead>
    <tbody>${rows.map((c) => html`<tr>
      <td><a href="/admin/consents/${c.id}">${c.number}</a></td>
      <td class="title-cell">${c.title}</td>
      <td>${c.body_name || '—'}</td>
      <td>${statusBadge(c.status)}</td>
      <td>${c.signed_count}/${c.signer_count}</td>
    </tr>`).join('')}</tbody></table>`
    : emptyState('No written consents yet.');

  const bodyOpts = repo.bodies.all().map((b) => ({ value: b.id, label: b.name }));
  const createForm = html`
    <form class="form" method="post" action="/admin/consents" data-wp-form>
      <label>Title<input type="text" name="title" required placeholder="A Resolution authorizing the interim services agreement"></label>
      <label>Adopting body<select name="body_id" required><option value="">— select —</option>${raw(selectOptions(bodyOpts, ''))}</select></label>
      ${raw(editorField('body_html', '', { label: 'Resolution text', rows: 10 }))}
      <button type="submit" class="btn primary">Create draft</button>
    </form>
    <script src="/assets/editor.js" defer></script>`;

  const providerNote = esign.isConfigured()
    ? '<p class="muted">Adobe Acrobat Sign is configured — circulating a consent sends it for e-signature.</p>'
    : '<p class="muted">Signatures are recorded in-app. Configure <code>ADOBE_SIGN_*</code> to route circulation through Adobe Acrobat Sign.</p>';

  const body = html`
    ${raw(providerNote)}
    ${raw(card('Consents', table))}
    ${raw(card('New written consent', createForm))}`;
  return layout({
    title: 'Written consents',
    h1: 'Actions by unanimous written consent',
    active: '/admin',
    crumbs: [{ label: 'Clerk Workspace', href: '/admin' }, { label: 'Written consents' }],
    subtitle: 'Adopt a resolution without a meeting: circulate it to every seated director; '
      + 'it is adopted when all have signed, and a single decline sends it back to a meeting.',
    body,
  });
}

function consentDetail(consent, signers) {
  const c = consent;
  const circulating = c.status === 'Circulating';
  const viaAdobe = c.esign_provider === 'adobe';

  const signerRows = signers.length ? `<table class="data compact">
    <thead><tr><th>Director</th><th>Email</th><th>Status</th><th>Signed</th>${circulating && !viaAdobe ? '<th></th>' : ''}</tr></thead>
    <tbody>${signers.map((s) => html`<tr>
      <td>${s.name}</td>
      <td class="muted">${s.email || '—'}</td>
      <td>${statusBadge(s.status)}</td>
      <td>${s.signed_at ? raw(formatDate(s.signed_at)) : '—'}</td>
      ${circulating && !viaAdobe ? raw(`<td class="head-actions">
        ${s.status !== 'Signed' ? `<form method="post" action="/admin/consents/${c.id}/signers/${s.id}/sign" class="inline"><button class="btn-link" type="submit">Record signature</button></form>` : ''}
        ${s.status !== 'Declined' ? `<form method="post" action="/admin/consents/${c.id}/signers/${s.id}/decline" class="inline"><button class="btn-link" type="submit">Record decline</button></form>` : ''}
      </td>`) : ''}
    </tr>`).join('')}</tbody></table>`
    : emptyState('No signers — the adopting body has no seated members.');

  let actions = '';
  if (c.status === 'Draft') {
    actions = `<form method="post" action="/admin/consents/${c.id}/circulate" class="inline">
      <button class="btn primary" type="submit">Circulate for signature</button></form>
      <form method="post" action="/admin/consents/${c.id}/withdraw" class="inline"
        onsubmit="return confirm('Withdraw this consent?')"><button class="btn ghost" type="submit">Withdraw</button></form>`;
  } else if (circulating) {
    actions = viaAdobe
      ? `<form method="post" action="/admin/consents/${c.id}/sync" class="inline"><button class="btn" type="submit">Sync from Adobe Sign</button></form>`
      : '';
    actions += `<form method="post" action="/admin/consents/${c.id}/withdraw" class="inline"
      onsubmit="return confirm('Withdraw this consent?')"><button class="btn ghost" type="submit">Withdraw</button></form>`;
  }

  const outcome = c.status === 'Adopted'
    ? `<p class="form-ok">Adopted by unanimous written consent${c.adopted_at ? ' on ' + formatDate(c.adopted_at) : ''}.</p>`
    : (c.status === 'Declined' ? '<p class="form-error">Not adopted — a director declined. Refer this to a meeting for a recorded vote.</p>' : '');

  const meta = `<dl class="meta record-header">
    <dt>Number</dt><dd>${escapeText(c.number)}</dd>
    <dt>Body</dt><dd>${escapeText(c.body_name || '—')}</dd>
    <dt>Status</dt><dd>${c.status}</dd>
    <dt>Signatures</dt><dd>${c.signed_count} of ${c.signer_count}</dd>
    ${viaAdobe ? `<dt>E-signature</dt><dd>Adobe Acrobat Sign${c.esign_status ? ' · ' + escapeText(c.esign_status) : ''}</dd>` : ''}
  </dl>`;

  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / <a href="/admin/consents">Written consents</a> / ${c.number}</p>
    <div class="detail-head"><h1>${c.title} ${statusBadge(c.status)}</h1></div>
    ${raw(outcome)}
    ${raw(card('Consent', meta))}
    ${c.body_html ? raw(card('Resolution text', `<div class="doc-body">${c.body_html}</div>`)) : ''}
    ${raw(card(`Signatures (${c.signed_count}/${c.signer_count})`, signerRows))}
    ${actions ? raw(card('Actions', `<div class="head-actions">${actions}</div>`)) : ''}`;
  return layout({ title: c.number, active: '/admin', body });
}

module.exports = { consentsAdmin, consentDetail };
