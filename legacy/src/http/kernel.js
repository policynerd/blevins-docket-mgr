'use strict';

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
    res.writeHead(200, { 'Content-Type': mimetype.typeFor(ext, data) });
    res.end(data);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : '') || req.socket.remoteAddress || '';
}

const AREA_ROLES = [
  ['/admin', 'clerk'],
  ['/govern', 'staff'],
  ['/spend', 'staff'],
  ['/member', 'member'],
];

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

function need(ctx, res, role) {
  if (auth.hasRole(ctx.user, role)) return true;
  sendHtml(res, forbidden(), 403);
  return false;
}

function createDispatcher({ routes, publicDir }) {
  require('./wire').mount(routes);
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    securityHeaders(req, res);
    if (pathname === '/styles.css' || pathname.startsWith('/assets/')
        || pathname.startsWith('/brand/') || pathname === '/favicon.ico') {
      return serveStatic(req, res, pathname === '/styles.css' ? '/styles.css' : pathname, publicDir);
    }
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
    const user = auth.currentUser(req);
    setUser(user);
    if (!gate(req, res, pathname, user)) return;
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
    if (pathname.startsWith('/api/')) return sendJson(res, { error: 'Not found' }, 404);
    sendHtml(res, pages.notFound(), 404);
  };
}

module.exports = {
  securityHeaders, serveStatic, clientIp, gate, need, roleFor, createDispatcher, AREA_ROLES,
};
