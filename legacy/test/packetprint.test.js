'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const packet = require('../src/packetprint');

const meeting = {
  body_name: 'Board of Governors',
  meeting_date: '2026-09-24',
  meeting_time: '10:00',
  location: 'A 150',
  status: 'Scheduled',
};

test('packet cover is a dedicated board-book cover, not a contents list', () => {
  const html = packet.cover(meeting, 'September 24, 2026 · 10:00 AM', {
    itemCount: 12,
    tabCount: 7,
    documentCount: 19,
  });
  assert.match(html, /AGENDA PACKET/);
  assert.match(html, /Agenda items/);
  assert.match(html, /Material tabs/);
  assert.match(html, /Packet documents/);
  assert.doesNotMatch(html, /<table class="contents">/);
});

test('packet contents have stable tab, agenda, item and packet-page columns', () => {
  const html = packet.contents(meeting, [{
    tab: 3,
    agendaNumber: '5.A.',
    fileNumber: '260901',
    title: 'Approve a contract',
    section: 'New Business',
    page: 17,
  }]);
  assert.match(html, /<th class="tab">Tab<\/th>/);
  assert.match(html, /<th class="agenda">Agenda<\/th>/);
  assert.match(html, /Item \/ material/);
  assert.match(html, /<th class="page">Page<\/th>/);
  assert.match(html, />17<\/td>/);
  assert.match(html, /260901/);
});

test('packet dividers and separator sheets preserve navigational identity', () => {
  const divider = packet.divider({
    tab: 4,
    agendaNumber: '6.B.',
    title: '260902 — Acquisition authorization',
    section: 'New Business',
  });
  assert.match(divider, /TAB 4/);
  assert.match(divider, /AGENDA ITEM 6\.B\./);
  assert.match(divider, /Supporting material for this agenda item follows/);

  const separator = packet.separator({ kind: 'Attachment', name: 'Staff report.pdf' });
  assert.match(separator, /ATTACHMENT/);
  assert.match(separator, /Staff report\.pdf/);
});
