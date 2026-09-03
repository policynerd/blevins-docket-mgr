'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'assets', 'institutional.css'),
  'utf8',
);

test('module navigation keeps an Office-style breathing strip above the tabs', () => {
  assert.match(css, /\.mod-bar \{[\s\S]*?min-height:40px;/);
  assert.match(css, /\.mod-bar \{[\s\S]*?padding:6px 14px 0!important;/);
  assert.match(css, /\.mod-bar \{[\s\S]*?align-items:flex-end;/);
});
