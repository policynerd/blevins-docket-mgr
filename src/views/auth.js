'use strict';

const { html, raw } = require('../util');
const { layout, card, escapeText } = require('./layout');
const { ORG, orgEmail } = require('../org');
const sso = require('../sso');

function loginPage({ next = '', error = '' } = {}) {
  const ssoBlock = sso.isConfigured() ? raw(`
    <a class="btn primary sso-btn" href="/auth/sso/login${next ? '?next=' + encodeURIComponent(next) : ''}">
      Sign in with Microsoft
    </a>
    <p class="muted sso-or">— or sign in with a local account —</p>`) : '';

  const demoBlock = process.env.ENABLE_DEMO_SEED === 'true' ? raw(`
    <div class="auth-hint">
      <strong>Demo accounts</strong>
      <ul>
        <li><b>Clerk:</b> ${escapeText(orgEmail('clerk'))} / clerk1234</li>
        <li><b>Board member:</b> any member email (e.g. ${escapeText(orgEmail('mortiz'))}) / member1234</li>
      </ul>
    </div>`) : '';

  const body = html`
    <div class="auth-wrap">
      ${raw(card('Sign In', html`
        ${error ? raw(`<p class="form-error">${escapeText(error)}</p>`) : ''}
        ${ssoBlock}
        <form class="form" method="post" action="/login">
          <input type="hidden" name="next" value="${next}">
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
        ${demoBlock}`))}
    </div>`;
  return layout({ title: 'Sign In', active: '', body });
}

module.exports = { loginPage };
