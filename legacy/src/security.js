'use strict';

const { escapeHtml } = require('./util');

function safeUrl(value, { allowRelative = true } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (allowRelative && (raw.startsWith('/') || raw.startsWith('#'))) {
    if (raw.startsWith('//')) return null;
    return raw;
  }
  try {
    const url = new URL(raw);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? raw : null;
  } catch {
    return null;
  }
}

function hrefAttr(value) {
  const url = safeUrl(value);
  return url ? escapeHtml(url) : null;
}

function linkTo(url, label, attrs = '') {
  const href = hrefAttr(url);
  if (!href) return escapeHtml(label);
  const extra = attrs ? ' ' + attrs.trim() : '';
  return `<a href="${href}"${extra}>${escapeHtml(label)}</a>`;
}

function expectedOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : null;
}

function requestOrigin(req) {
  return req.headers.origin || req.headers.referer || null;
}

function sameOrigin(req) {
  const source = requestOrigin(req);
  const expected = expectedOrigin(req);
  if (!source || !expected) return process.env.NODE_ENV !== 'production';
  try {
    return new URL(source).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

module.exports = { safeUrl, hrefAttr, linkTo, sameOrigin };
