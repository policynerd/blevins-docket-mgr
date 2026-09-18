'use strict';

const { html, raw, formatDate } = require('../util');
const { layout, card, emptyState, escapeText } = require('./layout');
const { ORG, FIELDS } = require('../org');
const { selectOptions } = require('./govern-core');

function brandingPage({ saved = false } = {}) {
  const field = (key, label, hint, type = 'text') => {
    const f = FIELDS[key];
    const placeholder = f ? (process.env[f.env] || f.def) : '';
    const val = ORG[key] == null ? '' : ORG[key];
    const input = type === 'color'
      ? `<input type="color" name="${key}" value="${escapeText(val || placeholder || '#15569e')}">`
      : `<input type="${type}" name="${key}" value="${escapeText(val)}" placeholder="${escapeText(placeholder)}">`;
    return `<label>${escapeText(label)}${hint ? ` <span class="muted">(${escapeText(hint)})</span>` : ''}${input}</label>`;
  };

  const form = html`
    <form class="form" method="post" action="/admin/branding">
      <fieldset><legend>Identity</legend>
        ${raw(field('name', 'Organization name'))}
        ${raw(field('tagline', 'Tagline'))}
        <div class="form-row">
          ${raw(field('logoUrl', 'Seal / logo', 'https://… or /brand/seal.png'))}
          ${raw(field('logoLightUrl', 'Reversed seal', 'for the dark sidebar — /brand/seal-light.png'))}
        </div>
        ${raw(field('logoLockupUrl', 'Horizontal lockup', 'optional — replaces the seal and name in the sidebar'))}
        <div class="form-row">
          ${raw(field('primaryColor', 'Primary color', '', 'color'))}
          ${raw(field('seal', 'Seal glyph', 'fallback when no artwork is set'))}
        </div>
        <div class="form-row">
          ${raw(field('faviconUrl', 'Favicon', 'tab icon; defaults to the seal'))}
        </div>
      </fieldset>
      <fieldset><legend>Bodies &amp; roles</legend>
        <div class="form-row">
          ${raw(field('primaryBody', 'Primary body'))}
          ${raw(field('primaryBodyType', 'Primary body type'))}
        </div>
        ${raw(field('membersLabel', 'Members label', 'nav + listing'))}
        <div class="form-row">
          ${raw(field('chairTitle', 'Chair title'))}
          ${raw(field('viceChairTitle', 'Vice-chair title'))}
        </div>
        <div class="form-row">
          ${raw(field('memberTitle', 'Member title'))}
          ${raw(field('clerkTitle', 'Clerk title'))}
        </div>
        ${raw(field('clerkOffice', 'Clerk office'))}
      </fieldset>
      <fieldset><legend>Operations</legend>
        <div class="form-row">
          ${raw(field('meetingLocation', 'Default meeting location'))}
          ${raw(field('emailDomain', 'Email domain'))}
        </div>
      </fieldset>
      <div class="form-actions">
        <button type="submit" class="btn primary">Save branding</button>
      </div>
      <p class="muted">Leave a field blank to fall back to its environment value or built-in default.</p>
    </form>`;

  const body = html`
    ${saved ? raw('<p class="form-ok">Branding saved.</p>') : ''}
    ${raw(card('Edit branding', form))}`;
  return layout({
    title: 'Branding & identity',
    subtitle: 'The name, mark and colours the application and its documents are issued under.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Branding' }],
    active: '/admin',
    body,
  });
}

function importPage({ result = null } = {}) {
  const example = `name,email,login_role,committee,committee_role
Benjamin Blevins,benjamin.blevins@blevinsholdings.com,clerk,,
Jane Smith,jane.smith@blevinsholdings.com,staff,Board of Governors,Chair
Jane Smith,jane.smith@blevinsholdings.com,,Committee on Appropriations and Budget,Member
John Doe,john.doe@blevinsholdings.com,member,Committee on Enterprise Operations,Member`;

  let summary = '';
  if (result) {
    const errs = result.errors.length
      ? `<div class="form-error"><strong>${result.errors.length} issue(s) (these rows were skipped):</strong>
         <ul>${result.errors.map((e) => `<li>${escapeText(e)}</li>`).join('')}</ul></div>`
      : '';
    summary = `<div class="import-result">
      ${result.errors.length ? '' : '<p class="form-ok">Import complete.</p>'}
      <ul class="import-stats">
        <li>Rows processed: <strong>${result.rows}</strong></li>
        <li>People created: <strong>${result.peopleCreated}</strong></li>
        <li>Committee seats added: <strong>${result.seats}</strong></li>
        <li>Committees created: <strong>${result.committeesCreated}</strong></li>
        <li>Logins created: <strong>${result.usersCreated}</strong>, updated: <strong>${result.usersUpdated}</strong></li>
      </ul>${errs}
    </div>`;
  }

  const form = html`
    <form class="form" method="post" action="/admin/import">
      <p class="muted">Bulk-create members, seat them on committees, and provision logins.
        Seating here is <strong>direct</strong> (it skips Nominate→Approve→Seat), so use it for initial setup.</p>
      <label>Choose a CSV file
        <input type="file" id="csvfile" accept=".csv,text/csv">
      </label>
      <label>CSV data (filled from the file above, or paste/edit directly)
        <textarea id="csvtext" name="csv" rows="10" required placeholder="${escapeText(example)}"></textarea>
      </label>
      <div class="form-actions"><button type="submit" class="btn primary">Import</button></div>
    </form>
    <details class="import-help">
      <summary>CSV format &amp; example</summary>
      <p>A header row, then one row <em>per person per committee</em> (repeat a person to place them on several). Columns:</p>
      <ul>
        <li><code>name</code> — full name</li>
        <li><code>email</code> — email (used for the SSO login match and contact)</li>
        <li><code>login_role</code> — blank for no login, or <code>member</code> / <code>staff</code> / <code>clerk</code></li>
        <li><code>committee</code> — committee/body to place them on (created if it doesn't exist)</li>
        <li><code>committee_role</code> — Chair / Vice Chair / Member (default Member)</li>
      </ul>
      <pre class="import-example">${escapeText(example)}</pre>
    </details>`;

  const body = html`
    ${result ? raw(summary) : ''}
    ${raw(card('Bulk import', form))}
    <script src="/assets/csv-fill.js" defer></script>`;
  return layout({
    title: 'Import roster (CSV)',
    subtitle: 'Load people in bulk from a spreadsheet.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Import roster' }],
    actions: '<a class="btn" href="/admin/import/matters">Import legislative files instead</a>',
    active: '/admin',
    body,
  });
}

function mattersImportPage({ result = null } = {}) {
  const example = `file_number,type,title,status,body,intro_date,final_date,summary,sponsors,topics
,Ordinance,Trash collection schedule update,Enacted,Board of Governors,2026-03-04,2026-04-01,Updates residential pickup days.,Jane Smith;John Doe,Public Works;Sanitation
,Resolution,FY27 budget adoption,Passed,Board of Governors,2026-05-12,,Adopts the FY27 operating budget.,Jane Smith,Budget
260601,Motion,Adopt meeting calendar,Draft,,,,,,`;

  let summary = '';
  if (result) {
    const errs = result.errors.length
      ? `<div class="form-error"><strong>${result.errors.length} row(s) skipped:</strong>
         <ul>${result.errors.map((e) => `<li>${escapeText(e)}</li>`).join('')}</ul></div>`
      : '';
    const warns = (result.warnings || []).length
      ? `<div class="form-warn"><strong>${result.warnings.length} warning(s):</strong>
         <ul>${result.warnings.map((e) => `<li>${escapeText(e)}</li>`).join('')}</ul></div>`
      : '';
    summary = `<div class="import-result">
      ${result.errors.length ? '' : '<p class="form-ok">Import complete.</p>'}
      <ul class="import-stats">
        <li>Rows processed: <strong>${result.rows}</strong></li>
        <li>Files created: <strong>${result.created}</strong></li>
        <li>Sponsors linked: <strong>${result.sponsorsLinked}</strong></li>
        <li>History entries added: <strong>${result.historyAdded}</strong></li>
      </ul>${errs}${warns}
    </div>`;
  }

  const form = html`
    <form class="form" method="post" action="/admin/import/matters">
      <p class="muted">Bulk-create legislative files (matters) from a spreadsheet export.</p>
      <label>Choose a CSV file
        <input type="file" id="csvfile" accept=".csv,text/csv">
      </label>
      <label>CSV data
        <textarea id="csvtext" name="csv" rows="10" required placeholder="${escapeText(example)}"></textarea>
      </label>
      <div class="form-actions"><button type="submit" class="btn primary">Import files</button></div>
    </form>`;

  const body = html`
    ${result ? raw(summary) : ''}
    ${raw(card('Bulk import', form))}
    <script src="/assets/csv-fill.js" defer></script>`;
  return layout({
    title: 'Import legislative files (CSV)',
    subtitle: 'Load measures in bulk from a spreadsheet.',
    crumbs: [
      { href: '/admin', label: 'Clerk Workspace' },
      { href: '/admin/import', label: 'Import' },
      { label: 'Legislative files' },
    ],
    active: '/admin',
    body,
  });
}

function announcementPage({ saved = false } = {}) {
  const announcement = require('../announcement');
  const a = announcement.get();
  const levelOpts = announcement.LEVELS.map((lv) =>
    `<option value="${lv}"${a.level === lv ? ' selected' : ''}>${escapeText(lv[0].toUpperCase() + lv.slice(1))}</option>`).join('');
  const preview = a.text
    ? `<div class="announce announce-${escapeText(a.level)}"><span class="announce-ic">📢</span><span class="announce-text">${escapeText(a.text)}</span></div>`
    : emptyState('No announcement is currently showing.');

  const form = html`
    <form class="form" method="post" action="/admin/announcement">
      <label>Message<textarea name="text" rows="3" maxlength="500" placeholder="e.g. The Board meeting has been moved to 11:30 a.m.">${escapeText(a.text)}</textarea></label>
      <div class="form-row">
        <label>Level<select name="level">${raw(levelOpts)}</select></label>
        <label class="check-label"><input type="checkbox" name="active" value="1"${a.active ? ' checked' : ''}> Show the banner site-wide</label>
      </div>
      <button type="submit" class="btn primary">Save announcement</button>
    </form>
    <p class="muted">Clear the message or uncheck the box to take the banner down.</p>`;

  const body = html`
    ${saved ? raw('<p class="saved-banner">Announcement saved.</p>') : ''}
    ${raw(card('Current banner', preview))}
    ${raw(card('Edit', form))}`;
  return layout({
    title: 'Site announcement banner',
    subtitle: 'A notice shown on every page, above the content.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Announcement' }],
    active: '/admin',
    body,
  });
}

function integrationsPage({ status: flash = '' } = {}) {
  const esign = require('../esign');
  const s = esign.status();
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const redirectUri = (base || '(your app URL)') + '/admin/integrations/adobe/callback';
  const REGIONS = ['na1', 'na2', 'na3', 'eu1', 'eu2', 'au1', 'jp1', 'in1', 'sg1'];
  const regionOpts = REGIONS.map((r) => `<option value="${r}"${s.region === r ? ' selected' : ''}>${r}</option>`).join('');

  const flashMsg = flash === 'connected' ? '<p class="saved-banner">Connected to Adobe Acrobat Sign.</p>'
    : (flash === 'saved' ? '<p class="saved-banner">Credentials saved.</p>'
      : (flash === 'disconnected' ? '<p class="saved-banner">Disconnected.</p>'
        : (flash === 'error' ? '<p class="form-error">Could not connect — check the credentials, redirect URI, and scopes, then try again.</p>' : '')));

  const statusLine = s.connected
    ? `<p class="form-ok">Connected to Adobe Acrobat Sign (region ${escapeText(s.region || 'na1')}).</p>`
    : (s.hasCredentials
      ? '<p class="muted">Credentials saved. Click <strong>Connect</strong> below to authorize with Adobe.</p>'
      : '<p class="muted">Not configured. Enter your Adobe API application credentials, save, then connect.</p>');

  const connectBtn = s.hasCredentials
    ? `<a class="btn primary" href="/admin/integrations/adobe/connect">${s.connected ? 'Reconnect' : 'Connect to Adobe'}</a>`
    : '<button class="btn primary" disabled title="Save credentials first">Connect to Adobe</button>';
  const disconnectBtn = s.connected
    ? `<form method="post" action="/admin/integrations/adobe/disconnect" class="inline" onsubmit="return confirm('Disconnect Adobe Acrobat Sign?')"><button class="btn ghost" type="submit">Disconnect</button></form>`
    : '';

  const form = html`
    <form class="form" method="post" action="/admin/integrations/adobe">
      <div class="form-row">
        <label>Client ID<input type="text" name="client_id" value="${escapeText(s.clientId || '')}" autocomplete="off"></label>
        <label>Client Secret<input type="password" name="client_secret" placeholder="${s.hasCredentials ? '(leave blank to keep)' : ''}" autocomplete="off"></label>
      </div>
      <div class="form-row">
        <label>Region<select name="region">${raw(regionOpts)}</select></label>
        <label>Webhook client ID <span class="muted">(optional)</span><input type="text" name="webhook_client_id" value="${escapeText(s.webhookClientId === s.clientId ? '' : (s.webhookClientId || ''))}" autocomplete="off"></label>
      </div>
      <label>Scopes<input type="text" name="scopes" value="${escapeText(s.scopes || '')}"></label>
      <button type="submit" class="btn">Save credentials</button>
    </form>`;

  const setup = `<ol class="setup-list">
    <li>In Adobe Acrobat Sign create an API application.</li>
    <li>Add this Redirect URI: <code>${escapeText(redirectUri)}</code></li>
    <li>Save credentials, then Connect.</li>
    <li>Webhook: <code>${escapeText((base || '(your app URL)') + '/webhooks/adobe-sign')}</code></li>
  </ol>`;

  const body = html`
    ${raw(flashMsg)}
    ${raw(card('Status', statusLine + `<div class="head-actions" style="margin-top:10px">${connectBtn} ${disconnectBtn}</div>`))}
    ${raw(card('Setup', setup))}
    ${raw(card('API application credentials', form))}`;
  return layout({
    title: 'Adobe Acrobat Sign',
    subtitle: 'Electronic signature for written consents and executed instruments.',
    crumbs: [{ href: '/admin', label: 'Clerk Workspace' }, { label: 'Integrations' }],
    active: '/admin',
    body,
  });
}

module.exports = {
  brandingPage, importPage, mattersImportPage, announcementPage, integrationsPage,
};
