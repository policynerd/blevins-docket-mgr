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
    Action: `<p>FILE NO. {{file_number}}</p>
<h2>{{title}}</h2>
<p>RESOLVED, by the ${org}, that ____.</p>
<p>The ____ is directed to ____ and to report to the ${org} on ____.</p>`,
    Information: `<h2>{{title}}</h2>
<p><em>For information only — no action is requested of the ${org}.</em></p>
<p>____</p>`,
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

// --- Drafting forms ---------------------------------------------------------
//
// These are distinct from the HTML report templates above, and this is the
// point of them: they emit *structured drafting text* — the SECTION / (a) /
// (1) hierarchy that src/legisdoc.js parses into a provision tree.
//
// A draft begun from one of these arrives inside the drafting system already:
// it has an outline, it validates, every provision is citable, and it can be
// compared against current law. Prose typed into a rich-text box does none of
// that, so the form a drafter starts from decides whether the rest of the
// machinery is available at all.
//
// Lines before the first SECTION are kept as a preamble, which is what lets a
// resolution carry its WHEREAS clauses in the traditional form.
//
// Placeholders: {{file_number}} {{title}} {{date}} {{org}} {{body}} {{sponsor}}
// Blanks are written as ____ so an unfinished provision is visible at a glance.
function draftingDefaults() {
  const org = ORG.name;
  return {
    Action: `WHEREAS, ____; and
WHEREAS, ____; and
NOW, THEREFORE, BE IT RESOLVED by the ${org}:

SECTION 1. ____.
(a) ____
(b) ____

SECTION 2. Direction to staff.
The ____ is directed to ____ and to report to the ${org} on ____.

SECTION 3. Effective date.
This takes effect immediately upon adoption.`,
    Information: `SECTION 1. Purpose.
This item is submitted to the ${org} for information. No action is requested.

SECTION 2. Background.
____

SECTION 3. Discussion.
____`,
    Ordinance: `SECTION 1. Short title.
This ordinance may be cited as the "{{title}}".

SECTION 2. Findings.
The ${org} finds that—
(a) ____; and
(b) ____.

SECTION 3. Definitions.
In this ordinance—
(a) "____" means ____.
(b) "____" means ____.

SECTION 4. ____.
(a) In general. ____
(b) Administration. The ____ shall—
(1) ____; and
(2) ____.
(c) Reporting. Not later than ____ of each year, the ____ shall report to the ${org} on ____.

SECTION 5. Severability.
If any provision of this ordinance, or its application to any person or circumstance, is held invalid, the remainder of this ordinance and its application to other persons or circumstances are not affected.

SECTION 6. Effective date.
This ordinance takes effect thirty (30) days after adoption.`,

    Resolution: `WHEREAS, ____; and
WHEREAS, ____; and
NOW, THEREFORE, BE IT RESOLVED by the ${org}:

SECTION 1. ____.
(a) ____
(b) ____

SECTION 2. Direction to staff.
The ____ is directed to ____ and to report to the ${org} on ____.

SECTION 3. Effective date.
This resolution takes effect immediately upon adoption.`,

    Motion: `SECTION 1. Motion.
I move that the ${org} ____.`,

    Contract: `SECTION 1. Authorization.
The ${org} authorizes the ____ to execute an agreement with ____ for ____.

SECTION 2. Terms.
(a) Scope. The agreement shall provide for ____.
(b) Compensation. Compensation under the agreement may not exceed $____ over the term.
(c) Term. The agreement commences ____ and ends ____, with ____ option(s) to renew.

SECTION 3. Conditions.
(a) The agreement is subject to approval as to form.
(b) No payment may be made except from funds appropriated for that purpose.

SECTION 4. Effective date.
This authorization takes effect immediately upon adoption.`,

    Appointment: `SECTION 1. Appointment.
The ${org} appoints ____ to the ____.

SECTION 2. Term.
The term begins ____ and ends ____.

SECTION 3. Effective date.
This appointment takes effect immediately upon adoption.`,

    'Public Hearing': `SECTION 1. Notice.
NOTICE IS HEREBY GIVEN that the ${org} will hold a public hearing on {{date}} at ____ concerning ____.

SECTION 2. Subject.
The hearing concerns ____.

SECTION 3. Participation.
(a) Written comment may be submitted to the ${ORG.clerkOffice} until ____.
(b) Persons wishing to be heard may register with the clerk before the hearing.`,

    Proclamation: `WHEREAS, ____; and
WHEREAS, ____;
NOW, THEREFORE, the ${org} proclaims:

SECTION 1. Proclamation.
____ is hereby recognized as ____.`,

    Report: `SECTION 1. Purpose.
____

SECTION 2. Findings.
(a) ____
(b) ____

SECTION 3. Recommendation.
The ____ recommends that the ${org} ____.`,

    Communication: `SECTION 1. Subject.
____`,
  };
}

// An amendatory form: the pattern for a measure that changes the Board Code.
// Kept separate from the plain Ordinance form because the drafting is quite
// different — the operative provision restates the amended section, and the
// change itself is registered as an amending instruction so it can be codified
// and compared against current law.
function amendatoryForm(citation = '____') {
  const org = ORG.name;
  return `SECTION 1. Short title.
This ordinance may be cited as the "{{title}}".

SECTION 2. Amendment of section ${citation} of the ${org} Code.
Section ${citation} of the ${org} Code is amended to read as follows:
(a) ____
(b) ____

SECTION 3. Conforming amendments.
Section ____ of the ${org} Code is amended by striking "____" and inserting "____".

SECTION 4. Effective date.
This ordinance takes effect ____.`;
}

// The drafting form for a type, with placeholders filled for a concrete file.
function draftingTemplate(type, matter = {}) {
  const saved = (() => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('drafttpl.' + type);
      return row && row.value ? row.value : null;
    } catch (_) { return null; }
  })();
  const tpl = saved || draftingDefaults()[type];
  if (!tpl) return null;
  return fillPlaceholders(tpl, matter);
}

// Plain-text substitution — this text is parsed, not rendered as HTML, so the
// values must not be escaped here or the drafter sees &amp; in their document.
function fillPlaceholders(tpl, matter = {}) {
  const sub = {
    file_number: matter.file_number || '____',
    title: matter.title || '____',
    date: formatDate(matter.intro_date || todayISO()),
    org: ORG.name,
    body: matter.body_name || ORG.primaryBody,
    sponsor: matter.sponsor_name || '____',
  };
  return String(tpl).replace(/\{\{\s*(file_number|title|date|org|body|sponsor)\s*\}\}/g,
    (_, k) => sub[k]);
}

function setDraftingTemplate(type, value) {
  if (value) {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run('drafttpl.' + type, value);
  } else {
    db.prepare('DELETE FROM settings WHERE key = ?').run('drafttpl.' + type);
  }
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

module.exports = {
  getTemplate, setTemplate, applyTemplate, isCustomized, defaults,
  draftingDefaults, draftingTemplate, setDraftingTemplate, amendatoryForm, fillPlaceholders,
};
