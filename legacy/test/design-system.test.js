'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'assets', 'institutional.css'),
  'utf8',
);

test('institutional UI typography is Arial with Times New Roman for records', () => {
  assert.match(css, /--font-ui:Arial,Helvetica,sans-serif;/);
  assert.match(css, /--font-document:"Times New Roman",Times,serif;/);
  assert.doesNotMatch(css, /Mercury/i);
  assert.doesNotMatch(css, /FT Sterling/i);
  assert.doesNotMatch(css, /Georgia/i);
});

test('application headings are Arial and record surfaces are Times New Roman', () => {
  assert.match(css, /\.page-head h1,[\s\S]*?font-family:var\(--font-ui\)!important;/);
  assert.match(css, /\.ld-doc,[\s\S]*?font-family:var\(--font-document\)!important;/);
  assert.match(css, /\.ls-block textarea[\s\S]*?font-family:var\(--font-document\)!important;/);
});

test('all command button variants use the neutral InfoPath control system', () => {
  assert.match(css, /\.btn\.primary,[\s\S]*?\.banner-search button,[\s\S]*?\.util-logout button[\s\S]*?background:linear-gradient\(to bottom,var\(--ip-btn-top\)/);
  assert.doesNotMatch(css, /\.btn\.primary[^}]*background:\s*var\(--bh-navy\)/);
  assert.doesNotMatch(css, /\.btn-primary[^}]*background:\s*var\(--bh-navy\)/);
});

test('data tables use pale Office-style headers rather than the legacy dark gradient', () => {
  assert.match(css, /table\.data thead th,[\s\S]*?var\(--ip-blue-200\)/);
  assert.doesNotMatch(css, /table\.data thead th[^}]*var\(--blv-navy-mid\)/);
});

test('dashboard metrics are a dense contiguous strip rather than floating cards', () => {
  assert.match(css, /\.stat-grid \{[\s\S]*?gap:0!important;/);
  assert.match(css, /\.stat \{[\s\S]*?border:0!important;/);
  assert.match(css, /\.stat \{[\s\S]*?box-shadow:none!important;/);
});
