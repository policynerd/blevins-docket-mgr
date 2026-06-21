'use strict';

// --- HTML escaping -----------------------------------------------------------
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Tagged template that escapes interpolated values by default.
// Use the `raw()` wrapper to inject already-safe HTML fragments.
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += renderValue(v) + strings[i + 1];
  }
  return out;
}

function renderValue(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(renderValue).join('');
  if (v && typeof v === 'object' && v.__raw === true) return v.value;
  return escapeHtml(v);
}

function raw(value) {
  return { __raw: true, value: value == null ? '' : String(value) };
}

// --- Dates -------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatDateTime(isoDate, time) {
  const datePart = formatDate(isoDate);
  return time ? `${datePart} · ${time}` : datePart;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// --- HTTP helpers ------------------------------------------------------------
function sendHtml(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location });
  res.end();
}

// Parse a urlencoded request body into a plain object (arrays for repeats).
function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const ct = (req.headers['content-type'] || '').split(';')[0].trim();
      if (ct === 'application/json') {
        try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
        return;
      }
      resolve(parseQuery(body));
    });
    req.on('error', () => resolve({}));
  });
}

function parseQuery(str) {
  const out = {};
  const params = new URLSearchParams(str || '');
  for (const [k, v] of params.entries()) {
    if (k in out) {
      if (Array.isArray(out[k])) out[k].push(v);
      else out[k] = [out[k], v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = {
  escapeHtml, html, raw, renderValue,
  formatDate, formatDateTime, todayISO, MONTHS,
  sendHtml, sendJson, redirect, parseBody, parseQuery, asArray, slugify,
};
