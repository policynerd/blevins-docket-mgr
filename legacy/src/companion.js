'use strict';

/**
 * The legislative drafting suite is a separate Fly app.
 * This docket manager keeps meetings, minutes, money, live session,
 * and the public portal. Authoring lives at DRAFTING_APP_URL.
 */
function draftingUrl() {
  return String(process.env.DRAFTING_APP_URL || 'https://blevins-drafting.fly.dev').replace(/\/$/, '');
}

function banner(matter) {
  const url = draftingUrl();
  const title = matter && matter.title ? encodeURIComponent(matter.title) : '';
  return `
    <div class="saved-banner" role="note">
      <strong>Drafting moved.</strong>
      The official text editor, templates, versions, and packet PDF now live in the
      legislative drafting suite.
      <a class="btn primary" href="${url}/proposals/new" style="margin-left:.75rem">Open drafting suite</a>
      <a class="btn" href="${url}/" style="margin-left:.4rem">All files</a>
      ${title ? `<span class="muted"> File: ${escapeAttr(matter.file_number || '')}</span>` : ''}
    </div>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

module.exports = { draftingUrl, banner };
