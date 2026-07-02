'use strict';

// Per-type document templates ("forms") for legislative files — the boilerplate
// a drafter starts from for an ordinance, resolution, contract, etc. Stored in
// the settings table under doctpl.<Type>; built-in defaults below are used
// until a clerk customizes one. Placeholders substituted when a template is
// applied to a concrete file: {{file_number}} {{title}} {{date}} {{org}}.
const { db } = require('./db');
const { ORG } = require('./org');
const { formatDate, todayISO, escapeHtml } = require('./util');

function defaults() {
  const org = ORG.name;
  return {
    Ordinance: `<p>ORDINANCE NO. {{file_number}}</p>
<h2>{{title}}</h2>
<p>BE IT ORDAINED by the ${org}:</p>
<h3>Section 1. Findings.</h3>
<p>The ${org} finds that…</p>
<h3>Section 2. Amendment.</h3>
<p>…</p>
<h3>Section 3. Severability.</h3>
<p>If any provision of this ordinance is held invalid, the remainder continues in effect.</p>
<h3>Section 4. Effective date.</h3>
<p>This ordinance takes effect thirty (30) days after adoption.</p>`,
    Resolution: `<p>RESOLUTION NO. {{file_number}}</p>
<h2>{{title}}</h2>
<p>WHEREAS, …; and</p>
<p>WHEREAS, …; and</p>
<p>NOW, THEREFORE, BE IT RESOLVED by the ${org} that:</p>
<p><b>Section 1.</b> …</p>
<p><b>Section 2.</b> This resolution takes effect immediately upon adoption.</p>`,
    Motion: `<h2>{{title}}</h2>
<p>I move that the ${org} …</p>`,
    Contract: `<p>CONTRACT AUTHORIZATION — FILE NO. {{file_number}}</p>
<h2>{{title}}</h2>
<h3>Parties</h3>
<p>${org} and …</p>
<h3>Scope of services</h3>
<p>…</p>
<h3>Compensation</h3>
<p>Not to exceed $… over the term of the agreement.</p>
<h3>Term</h3>
<p>Commencing … and ending …, with … option(s) to renew.</p>
<h3>Authorization</h3>
<p>The … is authorized to execute the agreement on behalf of the ${org}, subject to approval as to form.</p>`,
    Proclamation: `<p>PROCLAMATION — {{date}}</p>
<h2>{{title}}</h2>
<p>WHEREAS, …; and</p>
<p>WHEREAS, …;</p>
<p>NOW, THEREFORE, the ${org} proclaims …</p>`,
    Appointment: `<h2>{{title}}</h2>
<p>The ${org} hereby appoints … to the … for a term beginning … and ending ….</p>`,
    'Public Hearing': `<h2>{{title}}</h2>
<p>NOTICE IS HEREBY GIVEN that the ${org} will hold a public hearing on {{date}} concerning …</p>`,
    Report: `<h2>{{title}}</h2>
<h3>Purpose</h3><p>…</p>
<h3>Findings</h3><p>…</p>
<h3>Recommendation</h3><p>…</p>`,
    Communication: `<h2>{{title}}</h2>
<p>…</p>`,
  };
}

// The template for a type: the clerk-customized one when saved, else the
// built-in default, else null. An empty saved value means "reverted".
function getTemplate(type) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('doctpl.' + type);
    if (row && row.value) return row.value;
  } catch (_) { /* fall through to defaults */ }
  return defaults()[type] || null;
}

function isCustomized(type) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('doctpl.' + type);
  return !!(row && row.value);
}

function setTemplate(type, valueHtml) {
  if (valueHtml) {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run('doctpl.' + type, valueHtml);
  } else {
    db.prepare('DELETE FROM settings WHERE key = ?').run('doctpl.' + type);
  }
}

// Fill a template's placeholders for a concrete matter. Unknown values render
// as a blank to fill in.
function applyTemplate(type, matter = {}) {
  const tpl = getTemplate(type);
  if (!tpl) return null;
  const sub = {
    file_number: escapeHtml(matter.file_number || '____'),
    title: escapeHtml(matter.title || '____'),
    date: escapeHtml(formatDate(matter.intro_date || todayISO())),
    org: escapeHtml(ORG.name),
  };
  return tpl.replace(/\{\{\s*(file_number|title|date|org)\s*\}\}/g, (_, k) => sub[k]);
}

module.exports = { getTemplate, setTemplate, applyTemplate, isCustomized, defaults };
