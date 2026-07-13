'use strict';

// Citizen proposals (Decidim-style): submit an idea, gather endorsements,
// and past the threshold it surfaces for clerk review. Accepting a proposal
// creates a legislative file linked back to it.
const { html, raw, formatDate } = require('../util');
const { layout, card, statusBadge, emptyState, escapeText } = require('./layout');
const repo = require('../repo');
const { ORG } = require('../org');

function endorseBar(count, threshold) {
  const pct = Math.min(100, Math.round((count / threshold) * 100));
  return `<div class="budget-bar endorse-bar" title="${count} of ${threshold} endorsements">
    <span style="width:${pct}%" class="${count >= threshold ? 'over' : ''}"></span></div>`;
}

function proposalCardRow(p, threshold) {
  const reached = p.endorsements >= threshold;
  return html`
    <li>
      <div class="comment-head">
        <a href="/proposals/${p.id}"><strong>${p.title}</strong></a>
        ${statusBadge(p.status)}
        ${reached && p.status === 'Open' ? raw('<span class="badge st-passed">Threshold reached</span>') : ''}
        ${p.file_number ? raw(`→ <a href="/legislation/${encodeURIComponent(p.file_number)}">${escapeText(p.file_number)}</a>`) : ''}
        <span class="muted">· by ${p.name} · ${raw(formatDate(p.created_at))}</span>
      </div>
      <div class="endorse-line"><strong>${p.endorsements}</strong> endorsement${p.endorsements === 1 ? '' : 's'}
        ${raw(endorseBar(p.endorsements, threshold))}</div>
    </li>`;
}

function proposalsList(query = {}) {
  const threshold = repo.proposals.threshold();
  const open = repo.proposals.list('Open');
  const decided = repo.proposals.list().filter((p) => p.status !== 'Open').slice(0, 20);

  const submitted = query.submitted === '1'
    ? raw('<p class="form-ok">Thank you — your proposal is published below. Share it to gather endorsements!</p>') : '';

  const submitForm = `
    <p class="muted">Have an idea for the ${escapeText(ORG.name)}? Propose it here. Proposals that gather
      <strong>${threshold} endorsements</strong> are formally reviewed by the ${escapeText(ORG.clerkOffice)}
      for introduction as a legislative file.</p>
    <form class="form" method="post" action="/proposals">
      <div class="form-row">
        <label>Your name<input type="text" name="name" required maxlength="100"></label>
        <label>Email (not published)<input type="email" name="email" maxlength="200"></label>
      </div>
      <label>Proposal title<input type="text" name="title" required maxlength="140"
        placeholder="Plant shade trees along Elm Street"></label>
      <input type="text" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
      <label>What are you proposing, and why?<textarea name="body" rows="5" required maxlength="6000"></textarea></label>
      <button type="submit" class="btn primary">Submit proposal</button>
    </form>`;

  const openList = open.length
    ? `<ul class="comment-list">${open.map((p) => proposalCardRow(p, threshold)).join('')}</ul>`
    : emptyState('No open proposals — be the first.');
  const decidedList = decided.length
    ? `<ul class="comment-list">${decided.map((p) => proposalCardRow(p, threshold)).join('')}</ul>`
    : emptyState('No decided proposals yet.');

  const body = html`
    <h1>Citizen proposals</h1>
    ${submitted}
    ${raw(card('Propose an idea', submitForm))}
    ${raw(card(`Open proposals (${open.length})`, openList))}
    ${raw(card('Recently decided', decidedList))}`;
  return layout({ title: 'Proposals', active: '/proposals',
    subtitle: 'Ideas from the public, endorsed by the public.', body });
}

function proposalDetail(p, query = {}) {
  const threshold = repo.proposals.threshold();
  const reached = p.endorsements >= threshold;
  const notice = query.endorsed === '1'
    ? '<p class="form-ok">Thank you — your endorsement is counted.</p>'
    : (query.endorsed === '0' ? '<p class="form-warn">You have already endorsed this proposal.</p>' : '');

  const endorseForm = p.status === 'Open' ? `
    <h3 class="tab-h">Endorse this proposal</h3>
    <form class="form inline-form" method="post" action="/proposals/${p.id}/endorse">
      <div class="form-row">
        <label>Your name<input type="text" name="name" required maxlength="100"></label>
        <label>Email (for one-endorsement-per-person; not published)
          <input type="email" name="email" required maxlength="200"></label>
      </div>
      <input type="text" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit" class="btn primary">Endorse</button>
    </form>` : '';

  const body = html`
    <p class="crumbs"><a href="/proposals">Proposals</a> / #${p.id}</p>
    <h1>${p.title} ${statusBadge(p.status)}</h1>
    <p class="muted">Proposed by ${p.name} · ${raw(formatDate(p.created_at))}
      ${p.file_number ? raw(` · introduced as <a href="/legislation/${encodeURIComponent(p.file_number)}">${escapeText(p.file_number)}</a>`) : ''}</p>
    ${raw(notice)}
    ${raw(card('Proposal', `<p class="comment-body">${escapeText(p.body)}</p>`))}
    ${raw(card(`Endorsements — ${p.endorsements} of ${threshold} needed`,
    endorseBar(p.endorsements, threshold)
      + (reached ? `<p class="form-ok">Threshold reached — this proposal is in front of the ${escapeText(ORG.clerkOffice)}.</p>` : '')
      + endorseForm))}`;
  return layout({ title: p.title, active: '/proposals', body });
}

// Clerk review queue.
function proposalsAdmin() {
  const threshold = repo.proposals.threshold();
  const open = repo.proposals.list('Open');
  const rows = open.length
    ? `<ul class="comment-list">${open.map((p) => html`
        <li>
          <div class="comment-head">
            <a href="/proposals/${p.id}"><strong>${p.title}</strong></a>
            <strong>${p.endorsements}</strong> endorsements
            ${p.endorsements >= threshold ? raw('<span class="badge st-passed">Threshold reached</span>') : ''}
            <span class="muted">· ${p.name}${p.email ? ' · ' + p.email : ''} · ${raw(formatDate(p.created_at))}</span>
          </div>
          <p class="comment-body">${p.body.length > 400 ? p.body.slice(0, 400) + '…' : p.body}</p>
          <div class="form-actions">
            <form method="post" action="/admin/proposals/${p.id}/decide" class="inline">
              <input type="hidden" name="decision" value="accept">
              <button type="submit" class="btn primary">Accept → create file</button>
            </form>
            <form method="post" action="/admin/proposals/${p.id}/decide" class="inline">
              <input type="hidden" name="decision" value="decline">
              <button type="submit" class="btn">Decline</button>
            </form>
          </div>
        </li>`).join('')}</ul>`
    : emptyState('No open proposals.');
  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Proposals</p>
    <h1>Citizen proposals</h1>
    <p class="muted">Sorted by endorsements (threshold: ${threshold}). Accepting creates a Draft legislative
      file from the proposal text, linked back to the proposal; the proposer is notified either way when
      email is configured.</p>
    ${raw(card(`Open (${open.length})`, rows))}`;
  return layout({ title: 'Proposals', active: '/admin', body });
}

module.exports = { proposalsList, proposalDetail, proposalsAdmin };
