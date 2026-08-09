'use strict';

// Content-type detection for static files.
//
// Brand artwork is frequently uploaded without a file extension. Serving it as
// application/octet-stream is fatal rather than merely untidy: every response
// carries X-Content-Type-Options: nosniff, so the browser is forbidden from
// recovering the real type and the image silently fails to render. When the
// extension is missing or unknown, identify the format from its header bytes.

const BY_EXT = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.md': 'text/plain; charset=utf-8',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const FALLBACK = 'application/octet-stream';

// Identify a file from its leading bytes. Returns FALLBACK when unrecognized.
function sniffType(buf) {
  if (!buf || buf.length < 12) return FALLBACK;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const six = b.slice(0, 6).toString('latin1');
  if (six === 'GIF89a' || six === 'GIF87a') return 'image/gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  const head = b.slice(0, 400).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return FALLBACK;
}

// The type to serve a file as: its extension when known, else its own bytes.
function typeFor(ext, buf) {
  return BY_EXT[String(ext || '').toLowerCase()] || sniffType(buf);
}

module.exports = { BY_EXT, FALLBACK, sniffType, typeFor };
