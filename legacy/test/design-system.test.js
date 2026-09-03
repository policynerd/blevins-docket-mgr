'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'assets', 'institutional.css'),
  'utf8',
);

test('institutional UI uses only Arial and Times New Roman families', () => {
  assert.match(css, /--font-ui:Arial,Helvetica,sans-serif;/);
  assert.match(css, /--font-document:"Times New Roman",Times,serif;/);
  assert.doesNotMatch(css, /Mercury/i);
  assert.doesNotMatch(css, /FT Sterling/i);
  assert.doesNotMatch(css, /Georgia/i);
});

test('application headings resolve to Arial while record surfaces resolve to Times', () => {
  assert.match(css, /\.page-head h1,[\s\S]*?font-family:var\(--font-ui\) !important;/);
  assert.match(css, /\.ld-doc,[\s\S]*?font-family:var\(--font-document\) !important;/);
  assert.match(css, /\.ls-block textarea \{[\s\S]*?font-family:var\(--font-document\) !important;/);
});

test('legacy table and button gradients are explicitly neutralized', () => {
  assert.match(css, /table\.data thead th,[\s\S]*?background-image:none !important;/);
  assert.match(css, /\.btn,[\s\S]*?background-image:none !important;/);
});

test('dashboard metrics are rendered as one flat institutional strip', () => {
  assert.match(css, /\.stat-grid \{[\s\S]*?gap:0 !important;/);
  assert.match(css, /\.stat \{[\s\S]*?border-top:/);
  assert.match(css, /\.stat \{[\s\S]*?box-shadow:none !important;/);
});
