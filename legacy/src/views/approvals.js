'use strict';

// Approvals inbox: the review steps routed to the signed-in user (plus any
// unassigned steps, for clerks), with act buttons inline.
const { html, raw } = require('../util');
const { layout, card, emptyState, escapeText } = require('./layout');
const auth = require('../auth');
const repo = require('../repo');

function approvalsPage(user) {
  const actsAsClerk = auth.hasRole(user, 'clerk');
  const items = repo.workflow.inboxFor(user.id, actsAsClerk);

  const rows = items.length
    ? `<ul class="comment-list">${items.map((s) => html`
        <li>
          <div class="comment-head">
            <strong>${s.seq}. ${s.name}</strong>
            ${s.status === 'Returned' ? raw('<span class="badge st-failed">Returned</span>') : ''}
            — <a href="/legislation/${encodeURIComponent(s.file_number)}">${s.file_number}</a>
            <span class="muted">${s.matter_title}</span>
            <span class="muted">· ${s.assignee_name ? 'routed to you' : 'unassigned'}</span>
          </div>
          <form class="form inline-form" method="post" action="/approvals/steps/${s.id}/act">
            <label>Notes<input type="text" name="notes" placeholder="Optional decision note"></label>
            <div class="form-actions">
              <button type="submit" name="status" value="Approved" class="btn primary">Approve &amp; advance</button>
              <button type="submit" name="status" value="Returned" class="btn">Return for revision</button>
            </div>
          </form>
        </li>`).join('')}</ul>`
    : emptyState('Nothing is waiting on you. 🎉');

  const body = html`${raw(card(`Waiting on you (${items.length})`, rows))}`;
  return layout({
    title: 'Approvals',
    active: '/approvals',
    subtitle: `Review steps routed to you${actsAsClerk ? ' (and unassigned steps, since you are a clerk)' : ''}. `
      + 'Approving advances the file to the next step of its route; returning sends it back for revision.',
    body,
  });
}

module.exports = { approvalsPage };
