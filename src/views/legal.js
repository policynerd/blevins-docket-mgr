'use strict';

const { html, raw } = require('../util');
const { layout, card, escapeText } = require('./layout');
const { editorField } = require('./reports');
const { ORG } = require('../org');
const { db } = require('../db');

// --- Editable content store (settings table, "legal." keys) -----------------
function getContent(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('legal.' + key);
    return row && row.value ? row.value : null;
  } catch (_) { return null; }
}
function setContent(key, valueHtml) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run('legal.' + key, valueHtml || '');
}

// --- Default templates (used until an admin customizes them) -----------------
function defaultTerms() {
  const org = escapeText(ORG.name);
  return `
    <p>These terms govern your use of the ${org} legislative information website (the "Site").
       By accessing the Site you agree to these terms.</p>
    <h2>Use of the Site</h2>
    <p>The Site is provided to give the public access to legislative records — ordinances, resolutions,
       meeting agendas, minutes, votes, and policies. You may view, print, and download this information
       for personal, non-commercial, or governmental use.</p>
    <h2>Accuracy of information</h2>
    <p>The official record is maintained by the ${escapeText(ORG.clerkOffice)}. While we strive to keep the
       Site accurate and current, the published material may contain errors or omissions and does not
       constitute the certified official record. In case of any discrepancy, the certified record on file
       with the ${escapeText(ORG.clerkOffice)} controls.</p>
    <h2>Accounts &amp; access</h2>
    <p>Access to staff and member features requires authorized sign-in. You are responsible for activity
       under your account and must not share credentials or attempt to access areas you are not authorized to use.</p>
    <h2>Acceptable use</h2>
    <p>You agree not to disrupt the Site, attempt to gain unauthorized access, scrape it in a manner that
       degrades service, or use it to violate any law.</p>
    <h2>No warranty</h2>
    <p>The Site is provided "as is" without warranties of any kind. ${org} is not liable for any loss arising
       from use of, or inability to use, the Site.</p>
    <h2>Changes</h2>
    <p>${org} may update these terms at any time; continued use constitutes acceptance.</p>
    <p><em>This is a general template and not legal advice. Have it reviewed by counsel before relying on it.</em></p>`;
}

function defaultPrivacy() {
  const org = escapeText(ORG.name);
  return `
    <p>This notice explains how the ${org} legislative information website handles information.</p>
    <h2>Information we collect</h2>
    <ul>
      <li><strong>Public records:</strong> the legislative content published here (members, sponsors, votes, etc.)
        is public record by its nature.</li>
      <li><strong>Account information:</strong> for staff and members who sign in, we receive your name and email
        from your organization's single sign-on (Microsoft Entra ID) to identify your account and role.</li>
      <li><strong>Technical data:</strong> basic request information needed to operate the Site securely.</li>
    </ul>
    <h2>How we use it</h2>
    <p>To publish the legislative record, authenticate authorized users, maintain security, and operate the Site.
       We do not sell personal information.</p>
    <h2>Single sign-on</h2>
    <p>Sign-in is handled by Microsoft Entra ID. We receive only the identity claims needed to match your account
       (such as your name and email); we do not receive your password.</p>
    <h2>Cookies</h2>
    <p>We use a single session cookie to keep you signed in. It is not used for advertising or cross-site tracking.</p>
    <h2>Data retention</h2>
    <p>Legislative records are retained as part of the public record in accordance with applicable
       records-retention policy. Session data expires automatically.</p>
    <h2>Contact</h2>
    <p>Questions about this notice may be directed to the ${escapeText(ORG.clerkOffice)}.</p>
    <p><em>This is a general template and not legal advice. Have it reviewed by counsel before relying on it.</em></p>`;
}

// --- Public pages -----------------------------------------------------------
function termsPage() {
  const body = html`${raw(card('Terms &amp; Conditions',
    `<div class="doc-body">${getContent('terms') || defaultTerms()}</div>`))}`;
  return layout({ title: 'Terms & Conditions', active: '', body });
}

function privacyPage() {
  const body = html`${raw(card('Privacy Notice',
    `<div class="doc-body">${getContent('privacy') || defaultPrivacy()}</div>`))}`;
  return layout({ title: 'Privacy Notice', active: '', body });
}

// --- Admin editor (one form, two word-processor fields) ---------------------
function legalForm({ saved = false } = {}) {
  const form = html`
    <form class="form" method="post" action="/admin/legal" data-wp-form>
      ${raw(editorField('terms_html', getContent('terms') || defaultTerms(), { label: 'Terms & Conditions', rows: 16 }))}
      ${raw(editorField('privacy_html', getContent('privacy') || defaultPrivacy(), { label: 'Privacy Notice', rows: 16 }))}
      <div class="form-actions">
        <button type="submit" class="btn primary">Save legal pages</button>
        <a class="btn-link" href="/terms">View Terms</a>
        <a class="btn-link" href="/privacy">View Privacy</a>
      </div>
      <p class="muted">Saved content replaces the built-in templates. Clear a field and save to revert to the default.</p>
    </form>
    <script src="/assets/editor.js" defer></script>`;
  const body = html`
    <p class="crumbs"><a href="/admin">Admin</a> / Legal pages</p>
    <h1>Terms &amp; Privacy</h1>
    ${saved ? raw('<p class="form-ok">Legal pages saved.</p>') : ''}
    ${raw(card('Edit legal pages', form))}`;
  return layout({ title: 'Legal pages', active: '/admin', body });
}

module.exports = { termsPage, privacyPage, legalForm, setContent };
