'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'live.js'), 'utf8');
const a11y = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'live-a11y.js'), 'utf8');

test('live meeting page exposes semantic regions without changing presentation', () => {
  assert.match(view, /aria-labelledby="live-active-heading"/);
  assert.match(view, /id="live-active-heading"/);
  assert.match(view, /aria-labelledby="live-agenda-heading"/);
  assert.match(view, /data-live-announcer role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(view, /\/assets\/live\.js[\s\S]*\/assets\/live-a11y\.js/);
});

test('live accessibility layer adds state, grouping, announcements, and focus recovery', () => {
  assert.match(a11y, /aria-current/);
  assert.match(a11y, /aria-pressed/);
  assert.match(a11y, /Record vote for/);
  assert.match(a11y, /Cast your vote/);
  assert.match(a11y, /Live connection interrupted/);
  assert.match(a11y, /restoreFocus/);
  assert.match(a11y, /role', 'alert'/);
});

test('live accessibility layer does not alter visual classes or inline styles', () => {
  assert.doesNotMatch(a11y, /\.style\b|style\s*=|className\s*=|classList\.(?:add|remove|toggle)\s*\(/);
});
