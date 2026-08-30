'use strict';

// The chamber display.
//
// This board is the one surface with no operator. It renders on a screen
// bolted to a wall, nobody navigates it, and when it is wrong the room reads
// the wrong thing off it for as long as the item lasts. It also carries its
// own stylesheet as a JavaScript template literal, which is a construction
// with one sharp edge: a stray backtick inside the CSS closes the string, and
// the rest of the stylesheet is then parsed as JavaScript. That is not a
// hypothetical — it happened while writing the palette these tests now guard,
// and the failure mode is a board that renders unstyled on a wall.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'disp-test-')), 'test.db');

const { init } = require('../src/db');
init();
const repo = require('../src/repo');
const display = require('../src/views/display');

const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Body', seats: 9 });
const meetingId = repo.meetings.insert({ body_id: bodyId, meeting_date: '2026-09-01' });
const meeting = repo.meetings.get(meetingId);
const body = repo.bodies.get(bodyId);

function board() {
  return display.displayBoard(meeting, body);
}

test('the board renders', () => {
  const html = board();
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /data-roll/);
  assert.match(html, /assets\/display\.js/);
});

test('every colour on the board is a token, not a literal', () => {
  const html = board();
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  // The seal is a data URI and legitimately carries hex; the stale overlay is
  // an rgba(). Everything else that paints must come from :root.
  const withoutSeal = style.replace(/--seal:\s*url\("[^"]*"\)/, '');
  const literals = withoutSeal.match(/:\s*#[0-9a-fA-F]{3,8}\b/g) || [];

  // The only place a hex may appear is the token block itself.
  const tokenBlock = withoutSeal.slice(withoutSeal.indexOf(':root'), withoutSeal.indexOf('}'));
  const inTokens = (tokenBlock.match(/:\s*#[0-9a-fA-F]{3,8}\b/g) || []).length;
  assert.equal(literals.length, inTokens,
    'a colour is set outside the token block: ' + literals.slice(inTokens).join(', '));
});

test('the palette defines every token the stylesheet uses', () => {
  const html = board();
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const used = new Set((style.match(/var\(--[a-z-]+\)/g) || [])
    .map((v) => v.slice(4, -1)));
  // Not anchored to line start: --seal is defined inline in its own :root
  // block, on the same line as the rest of the tag. A usage is `var(--x)` with
  // no colon, so a colon is what distinguishes a definition.
  const defined = new Set((style.match(/--[a-z-]+\s*:/g) || [])
    .map((d) => d.replace(/\s*:$/, '')));
  for (const token of used) {
    assert.ok(defined.has(token), `--${token} is used but never defined`);
  }
  assert.ok(used.size >= 15, 'expected the stylesheet to be driven by tokens');
});

test('the stylesheet is not closed early by a stray backtick', () => {
  // The failure this guards: a backtick inside the CSS ends the template
  // literal, so everything after it is parsed as JavaScript and the board
  // ships with half a stylesheet — or does not parse at all.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'display.js'), 'utf8');
  for (const name of ['PALETTE', 'STYLE']) {
    const start = src.indexOf(`const ${name} = \``);
    assert.notEqual(start, -1, `${name} should be a template literal`);
    const body = src.slice(start + `const ${name} = \``.length);
    const end = body.indexOf('\n`;');
    assert.notEqual(end, -1, `${name} should be closed`);
    assert.equal(body.slice(0, end).indexOf('`'), -1,
      `${name} contains a backtick, which closes the stylesheet early`);
  }

  // And the rendered result really does carry the whole thing.
  const html = board();
  assert.match(html, /\[hidden\] \{ display: none !important; \}/,
    'the last rule of the stylesheet should reach the page');
});

test('the vote colours are never the only thing carrying a vote', () => {
  // The palette is overridable, so colour cannot be the channel. Each chip
  // carries a letter; this asserts the letters exist for every choice the
  // ledger can record.
  const client = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'assets', 'display.js'), 'utf8');
  for (const choice of repo.VOTE_VALUES) {
    assert.match(client, new RegExp(choice + ':\\s*\'[A-Z]\''),
      `${choice} has no letter on the board`);
  }
});

test('the pulse yields to a reduced-motion preference', () => {
  const html = board();
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /@keyframes vote-cast/);
});
