'use strict';

const { html, raw } = require('../util');
const { layout, card, escapeText } = require('./layout');
const { ORG, orgEmail } = require('../org');

function loginPage({ next = '', error = '' } = {}) {
  const body = html`
    <div class="auth-wrap">
      ${raw(card('Sign In', html`
        ${error ? raw(`<p class="form-error">${escapeText(error)}</p>`) : ''}
        <form class="form" method="post" action="/login">
          <input type="hidden" name="next" value="${next}">
          <label>Email
            <input type="email" name="email" required autofocus placeholder="${escapeText(orgEmail('you'))}">
          </label>
          <label>Password
            <input type="password" name="password" required placeholder="••••••••">
          </label>
          <div class="form-actions">
            <button type="submit" class="btn primary">Sign in</button>
          </div>
        </form>
        <div class="auth-hint">
          <strong>Demo accounts</strong>
          <ul>
            <li><b>Clerk:</b> ${escapeText(orgEmail('clerk'))} / clerk1234</li>
            <li><b>Board member:</b> any member email (e.g. ${escapeText(orgEmail('mortiz'))}) / member1234</li>
          </ul>
        </div>`))}
    </div>`;
  return layout({ title: 'Sign In', active: '', body });
}

module.exports = { loginPage };
