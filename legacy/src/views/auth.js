'use strict';


const { authLayout, escapeText } = require('./layout');
const { ORG, orgEmail } = require('../org');
const sso = require('../sso');

function loginPage({ next = '', error = '' } = {}) {
  const nextParam = next ? '?next=' + encodeURIComponent(next) : '';

  // Microsoft's branding guidelines allow a light or dark scheme only — not an
  // arbitrary brand colour — and the logo must not be altered. The accompanying
  // "work or school account" wording is theirs too: it is what tells a director
  // whether this button is the one meant for them.
  const ssoBlock = sso.isConfigured() ? `
    <a class="ms-btn" href="/auth/sso/login${nextParam}">
      <svg class="ms-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" width="21" height="21" aria-hidden="true">
        <rect x="0" y="0" width="10" height="10" fill="#f25022"/>
        <rect x="11" y="0" width="10" height="10" fill="#7fba00"/>
        <rect x="0" y="11" width="10" height="10" fill="#00a4ef"/>
        <rect x="11" y="11" width="10" height="10" fill="#ffb900"/>
      </svg>
      <span>Sign in with Microsoft</span>
    </a>
    <p class="sso-help">Use your ${escapeText(ORG.name)} work or school account.</p>` : '';

  const loginForm = `
    <form class="form local-form" method="post" action="/login">
      <input type="hidden" name="next" value="${escapeText(next)}">
      <label>Email
        <input type="email" name="email" required autofocus placeholder="${escapeText(orgEmail('you'))}">
      </label>
      <label>Password
        <input type="password" name="password" required placeholder="••••••••">
      </label>
      <div class="form-actions">
        <button type="submit" class="btn primary btn-block">Sign in</button>
      </div>
    </form>`;

  // With SSO configured, the local form is a secondary option behind a
  // disclosure. Without it, the form IS the login — show it plainly, no
  // pointless collapsible or orphaned divider.
  const localBlock = sso.isConfigured()
    ? `<div class="auth-or"><span>or</span></div>
       <details class="local-login"><summary>Sign in with a ${escapeText(ORG.name)} account</summary>${loginForm}</details>`
    : loginForm;

  const demoBlock = process.env.ENABLE_DEMO_SEED === 'true' ? `
    <div class="auth-hint">
      <strong>Demo accounts</strong>
      <ul>
        <li><b>Clerk:</b> ${escapeText(orgEmail('clerk'))} / clerk1234</li>
        <li><b>Member:</b> ${escapeText(orgEmail('mortiz'))} / member1234</li>
      </ul>
    </div>` : '';

  const body = `
    <div class="auth-card">
      <h1 class="auth-title">Sign in</h1>
      <p class="auth-access-note">For ${escapeText(ORG.membersLabel.toLowerCase())} and staff. The public record is open to everyone — <a href="/">browse without signing in</a>.</p>
      ${error ? `<p class="form-error">${escapeText(error)}</p>` : ''}
      ${ssoBlock}
      ${localBlock}
      ${demoBlock}
    </div>`;

  return authLayout('Sign In', body);
}

module.exports = { loginPage };
