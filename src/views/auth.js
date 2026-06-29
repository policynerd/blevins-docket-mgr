'use strict';

const { html, raw } = require('../util');
const { authLayout, escapeText } = require('./layout');
const { ORG, orgEmail } = require('../org');
const sso = require('../sso');

function loginPage({ next = '', error = '' } = {}) {
  const nextParam = next ? '?next=' + encodeURIComponent(next) : '';

  const ssoBlock = sso.isConfigured() ? `
    <a class="btn primary sso-btn" href="/auth/sso/login${nextParam}">
      <svg class="sso-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" width="20" height="20" aria-hidden="true">
        <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
        <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
        <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
        <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
      </svg>
      Sign in with Microsoft
    </a>` : '';

  const localBlock = `
    <details class="local-login"${sso.isConfigured() ? '' : ' open'}>
      <summary>${sso.isConfigured() ? 'Or use a local account' : 'Sign in with a local account'}</summary>
      <form class="form local-form" method="post" action="/login">
        <input type="hidden" name="next" value="${escapeText(next)}">
        <label>Email
          <input type="email" name="email" required placeholder="${escapeText(orgEmail('you'))}">
        </label>
        <label>Password
          <input type="password" name="password" required placeholder="••••••••">
        </label>
        <div class="form-actions">
          <button type="submit" class="btn primary">Sign in</button>
        </div>
      </form>
    </details>`;

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
      ${error ? `<p class="form-error">${escapeText(error)}</p>` : ''}
      <p class="auth-access-note">Staff &amp; member access only. Public records are available <a href="/">without signing in</a>.</p>
      ${ssoBlock}
      ${localBlock}
      ${demoBlock}
    </div>`;

  return authLayout('Sign In', body);
}

module.exports = { loginPage };
