'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeUrl, linkTo, sameOrigin } = require('../src/security');

test('safeUrl rejects executable and protocol-relative URLs', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,hi'), null);
  assert.equal(safeUrl('//evil.example/path'), null);
});

test('safeUrl accepts intended URL forms', () => {
  assert.equal(safeUrl('/meetings/1'), '/meetings/1');
  assert.equal(safeUrl('#agenda'), '#agenda');
  assert.equal(safeUrl('https://example.test/doc.pdf'), 'https://example.test/doc.pdf');
  assert.equal(safeUrl('mailto:clerk@example.test'), 'mailto:clerk@example.test');
});

test('linkTo escapes labels and href attributes', () => {
  assert.equal(
    linkTo('https://example.test/?q="><x>', '<Doc>'),
    '<a href="https://example.test/?q=&quot;&gt;&lt;x&gt;">&lt;Doc&gt;</a>'
  );
});

test('sameOrigin accepts matching forwarded origin', () => {
  assert.equal(sameOrigin({
    headers: {
      origin: 'https://beg-docket-manager.fly.dev',
      host: 'internal',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'beg-docket-manager.fly.dev',
    },
  }), true);
});

test('sameOrigin rejects cross-site origin', () => {
  assert.equal(sameOrigin({
    headers: {
      origin: 'https://attacker.example',
      host: 'beg-docket-manager.fly.dev',
      'x-forwarded-proto': 'https',
    },
  }), false);
});
