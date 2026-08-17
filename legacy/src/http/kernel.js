'use strict';

// The HTTP kernel: everything a request passes through that is not a route.
//
// Pulled out of server.js, which had grown to 2,500 lines with 256 route
// registrations and this machinery interleaved between them. Authorization in
// particular was buried at line 2,339 — a chokepoint every request crosses,
// sitting in the middle of the routing table where nobody would look for it.
//
// Nothing here decides what a page contains. It decides who may ask, what
// headers the answer carries, and where an unmatched path goes.

const fs = require('node:fs');
const path = require('node:path');

const { sendHtml, sendJson, redirect, parseBody, parseQuery } = require('../util');
const { sameOrigin } = require('../security');
const { setUser, forbidden } = require('../views/layout');
const mimetype = require('../mimetype');
const upload = require('../upload');
const auth = require('../auth');
const repo = require('../repo');
const pages = require('../views/pages');

// Baseline security headers on every response. Inline scripts/styles are part
// of the rendering approach (small per-page enhancement scripts), hence
// 'unsafe-inline'; images allow https: for externally hosted seals/photos.
function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data: https:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  if ((req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function serveStatic(req, res, pathname, publicDir) {
  const rel = pathname.replace(/^\//, '');
  const filePath = path.join(publicDir, rel);
  if (!filePath.startsWith(publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    // Brand art is often uploaded without an extension. Serving it as
    // application/octet-stream would be fatal: we send X-Content-Type-Options:
    // nosniff, so the browser is forbidden from recovering the real type and
    // the image simply does not render. Identify it from its own header bytes.
    res.writeHead(200, { 'Content-Type': mimetype.typeFor(ext, data) });
    res.end(data);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : '') || req.socket.remoteAddress || '';
}

// Which areas require which role.
//
// This is the whole of the system's authorization: three path prefixes, and
// everything outside them is public. It is written here as data rather than as
// a chain of if-statements so that the next step — per-route capabilities such
// as `vote.certify` or `agenda.publish` — has somewhere to go, and so that the
// current rules can be read in one place and tested directly.
const AREA_ROLES = [
  ['/admin', 'clerk'],
  ['/govern', 'staff'],
  ['/member', 'member'],
];

// The role an area demands, or null where anyone may look.
function roleFor(pathname) {
  for (const [prefix, role] of AREA_ROLES) {
    if (pathname.startsWith(prefix)) return role;
  }
  return null;
}

function gate(req, res, pathname, user) {
  const role = roleFor(pathname);
  if (!role) return true;
  if (auth.hasRole(user, role)) return true;
  if (!user) { redirect(res, '/login?next=' + encodeURIComponent(pathname)); return false; }
  sendHtml(res, forbidden(), 403);
  return false;
}

// Finer-grained guard for routes that need more than the path-prefix gate
// (e.g. system-admin features under the clerk-gated /admin area). Returns false
// and writes a 403 when the user lacks the role.
function need(ctx, res, role) {
  if (auth.hasRole(ctx.user, role)) return true;
  sendHtml(res, forbidden(), 403);
  return false;
}

// Build the request handler. `routes` is the live registration table; the
// caller keeps ownership of it so route modules can go on registering into it.
function createDispatcher({ routes, publicDir }) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    securityHeaders(req, res);

    // Static assets
    if (pathname === '/styles.css' || pathname.startsWith('/assets/')
        || pathname.startsWith('/brand/') || pathname === '/favicon.ico') {
      return serveStatic(req, res, pathname === '/styles.css' ? '/styles.css' : pathname, publicDir);
    }

    // CSRF guard: state-changing requests must originate from this site. All
    // mutating routes are same-origin browser forms/fetches, which always carry
    // an Origin (or Referer) header; cross-site submissions are rejected.
    // Inbound provider webhooks are server-to-server (no Origin) and are
    // authenticated by their own handshake, so they're exempt from the CSRF gate.
    if (req.method !== 'GET' && req.method !== 'HEAD'
        && !pathname.startsWith('/webhooks/') && !sameOrigin(req)) {
      return sendHtml(res, forbidden(), 403);
    }

    const query = parseQuery(url.search.replace(/^\?/, ''));
    let body = {};
    let files = [];
    if (req.method === 'POST' || req.method === 'PUT') {
      if ((req.headers['content-type'] || '').startsWith('multipart/form-data')) {
        const mp = await upload.parseMultipart(req);
        body = mp.fields;
        files = mp.files;
        if (mp.tooLarge) body.__too_large = true;
      } else {
        body = await parseBody(req);
      }
    }

    // Resolve the current user and gate protected areas. Set the user for the
    // layout synchronously here — handlers render without an intervening await.
    const user = auth.currentUser(req);
    setUser(user);

    if (!gate(req, res, pathname, user)) return;

    // Audit trail: record state-changing requests by signed-in users.
    if (req.method !== 'GET' && req.method !== 'HEAD' && user) {
      try {
        repo.audit.record({
          userId: user.id, userName: user.name,
          method: req.method, path: pathname, ip: clientIp(req),
        });
      } catch (e) { console.error('Audit record failed:', e.message); }
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = pathname.match(r.pattern);
      if (match) {
        const params = match.slice(1);
        try {
          return r.handler(req, res, { params, query, body, files, user, pathname });
        } catch (err) {
          console.error('Handler error:', err);
          if (pathname.startsWith('/api/')) return sendJson(res, { error: 'Internal error' }, 500);
          return sendHtml(res, '<h1>500 — Internal error</h1><pre>'
            + String(err.message).replace(/</g, '&lt;') + '</pre>', 500);
        }
      }
    }

    // Fallbacks
    if (pathname.startsWith('/api/')) return sendJson(res, { error: 'Not found' }, 404);
    sendHtml(res, pages.notFound(), 404);
  };
}

module.exports = {
  securityHeaders, serveStatic, clientIp, gate, need, roleFor, createDispatcher, AREA_ROLES,
};
