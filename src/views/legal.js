'use strict';

const { html, raw } = require('../util');
const { layout, card, escapeText } = require('./layout');
const { ORG } = require('../org');

const updated = 'Last updated: ' + new Date().toISOString().slice(0, 10);

function section(h, body) {
  return `<h2 class="section-title">${escapeText(h)}</h2>${body}`;
}

function termsPage() {
  const org = escapeText(ORG.name);
  const body = html`${raw(card('Terms &amp; Conditions', `
    <p class="muted">${updated}</p>
    <p>These terms govern your use of the ${org} legislative information website (the "Site").
       By accessing the Site you agree to these terms.</p>
    ${section('Use of the Site', `<p>The Site is provided to give the public access to legislative records —
       ordinances, resolutions, meeting agendas, minutes, votes, and policies. You may view, print, and
       download this information for personal, non-commercial, or governmental use.</p>`)}
    ${section('Accuracy of information', `<p>The official record is maintained by the ${escapeText(ORG.clerkOffice)}.
       While we strive to keep the Site accurate and current, the published material may contain errors or omissions
       and does not constitute the certified official record. In case of any discrepancy, the certified record on
       file with the ${escapeText(ORG.clerkOffice)} controls.</p>`)}
    ${section('Accounts &amp; access', `<p>Access to staff and member features requires authorized sign-in.
       You are responsible for activity under your account and must not share credentials or attempt to access
       areas you are not authorized to use.</p>`)}
    ${section('Acceptable use', `<p>You agree not to disrupt the Site, attempt to gain unauthorized access,
       scrape it in a manner that degrades service, or use it to violate any law.</p>`)}
    ${section('No warranty', `<p>The Site is provided "as is" without warranties of any kind. ${org} is not liable
       for any loss arising from use of, or inability to use, the Site.</p>`)}
    ${section('Changes', `<p>${org} may update these terms at any time; continued use constitutes acceptance.</p>`)}
    <p class="muted"><em>This is a general template and not legal advice. Have it reviewed by counsel before relying on it.</em></p>`))}`;
  return layout({ title: 'Terms & Conditions', active: '', body });
}

function privacyPage() {
  const org = escapeText(ORG.name);
  const body = html`${raw(card('Privacy Notice', `
    <p class="muted">${updated}</p>
    <p>This notice explains how the ${org} legislative information website handles information.</p>
    ${section('Information we collect', `<ul>
       <li><strong>Public records:</strong> the legislative content published here (members, sponsors, votes, etc.)
       is public record by its nature.</li>
       <li><strong>Account information:</strong> for staff and members who sign in, we receive your name and email
       from your organization's single sign-on (Microsoft Entra ID) to identify your account and role.</li>
       <li><strong>Technical data:</strong> basic request information needed to operate the Site securely.</li>
     </ul>`)}
    ${section('How we use it', `<p>To publish the legislative record, authenticate authorized users, maintain
       security, and operate the Site. We do not sell personal information.</p>`)}
    ${section('Single sign-on', `<p>Sign-in is handled by Microsoft Entra ID. We receive only the identity claims
       needed to match your account (such as your name and email); we do not receive your password.</p>`)}
    ${section('Cookies', `<p>We use a single session cookie to keep you signed in. It is not used for advertising
       or cross-site tracking.</p>`)}
    ${section('Data retention', `<p>Legislative records are retained as part of the public record in accordance with
       applicable records-retention policy. Session data expires automatically.</p>`)}
    ${section('Contact', `<p>Questions about this notice may be directed to the ${escapeText(ORG.clerkOffice)}.</p>`)}
    <p class="muted"><em>This is a general template and not legal advice. Have it reviewed by counsel before relying on it.</em></p>`))}`;
  return layout({ title: 'Privacy Notice', active: '', body });
}

module.exports = { termsPage, privacyPage };
