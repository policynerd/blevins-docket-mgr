'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const layout = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'layout-base.js'), 'utf8');
const wrap = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'layout.js'), 'utf8');
const pages = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'pages.js'), 'utf8');
const budget = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'budget.js'), 'utf8');
const legal = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'legal.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'a11y.css'), 'utf8');

test('every page has a skip link into a labelled main landmark', () => {
  assert.match(layout, /class="skip-link" href="#main-content"/);
  assert.match(layout, /<main id="main-content"/);
  assert.match(css, /\.skip-link:focus/);
});

test('the accessibility statement is a public route with controls', () => {
  assert.match(server, /\/accessibility/);
  assert.match(legal, /function accessibilityPage/);
  assert.match(legal, /WCAG 2\.2/);
  assert.match(legal, /data-a11y-prefs/);
});

test('calendar ships a month grid and a list, neither icon-only', () => {
  assert.match(pages, /class="cal-month"/);
  assert.match(pages, /role="grid"/);
  assert.match(pages, /Subscribe to the iCal feed|Subscribe \(iCal\)/);
  assert.doesNotMatch(pages, /📅 Subscribe/);
});

test('budget meters expose a percent in text, not only a coloured bar', () => {
  assert.match(budget, /role="progressbar"/);
  assert.match(budget, /budget-meter-label/);
  assert.match(budget, /class="budget-chart"/);
  assert.doesNotMatch(budget, /📊 Dashboard/);
});

test('chrome links the statement and loads the preference layer', () => {
  assert.match(layout, /href="\/accessibility"/);
  assert.match(wrap, /\/assets\/a11y\.css/);
  assert.match(wrap, /\/assets\/a11y-prefs\.js/);
});
