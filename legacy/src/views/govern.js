'use strict';

const { html, raw, formatDate } = require('../util');
const { layout, card, emptyState, escapeText } = require('./layout');
const { ORG, FIELDS, EDITABLE } = require('../org');
const auth = require('../auth');
const repo = require('../repo');

function badge(status) {
  const cls = 'st-' + String(status || '').toLowerCase().replace(/[^a-z]+/g, '-');
  return `<span class="badge ${cls}">${escapeText(status)}</span>`;
}

function selectOptions(values, current, { includeBlank } = {}) {
  let out = includeBlank ? `<option value="">${escapeText(includeBlank)}</option>` : '';
  for (const v of values) {
    const value = typeof v === 'object' ? v.value : v;
    const label = typeof v === 'object' ? v.label : v;
    out += `<option value="${escapeText(value)}"${String(value) === String(current) ? ' selected' : ''}>${escapeText(label)}</option>`;
  }
  return out;
}

function primaryBody() {
  const all = repo.bodies.all();
  return all.find((b) => b.name === ORG.primaryBody)
    || all.find((b) => b.type === ORG.primaryBodyType)
    || all[0] || null;
}

function isSitting(m) {
  if (m.onRoll) return true;
  if (m.reason === 'holds the seat without a vote') return true;
  if (m.reason === 'term has not begun') return false;
  if (m.end_date) return false;
  return true;
}
