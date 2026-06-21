'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { init } = require('./src/db');
const repo = require('./src/repo');
const pages = require('./src/views/pages');
const admin = require('./src/views/admin');
const api = require('./src/api');
const {
  sendHtml, sendJson, redirect, parseBody, parseQuery, asArray,
} = require('./src/util');

init();

// Auto-seed an empty database on first run so the app is never blank.
if (repo.stats().people === 0) {
  try { require('./src/seed').run(); } catch (e) { console.error('Seed failed:', e.message); }
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon' };

// --- Route table -------------------------------------------------------------
// Each route: [method, RegExp, handler(req,res,{params,query,body})]
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// Public portal --------------------------------------------------------------
route('GET', /^\/$/, (req, res) => sendHtml(res, pages.dashboard()));
route('GET', /^\/legislation\/?$/, (req, res, ctx) => sendHtml(res, pages.legislationList(ctx.query)));
route('GET', /^\/legislation\/(.+)$/, (req, res, ctx) => {
  const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.matterDetail(m));
});
route('GET', /^\/calendar\/?$/, (req, res) => sendHtml(res, pages.calendar()));
route('GET', /^\/meetings\/(\d+)$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.meetingDetail(mt));
});
route('GET', /^\/people\/?$/, (req, res) => sendHtml(res, pages.peopleList()));
route('GET', /^\/people\/(\d+)$/, (req, res, ctx) => {
  const p = repo.people.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.personDetail(p));
});
route('GET', /^\/bodies\/?$/, (req, res) => sendHtml(res, pages.bodiesList()));
route('GET', /^\/bodies\/(\d+)$/, (req, res, ctx) => {
  const b = repo.bodies.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.bodyDetail(b));
});

// Admin ----------------------------------------------------------------------
route('GET', /^\/admin\/?$/, (req, res) => sendHtml(res, admin.adminHome()));

route('GET', /^\/admin\/matters\/new$/, (req, res) => sendHtml(res, admin.matterForm(null)));
route('POST', /^\/admin\/matters$/, (req, res, ctx) => {
  const b = ctx.body;
  if (!b.title || !b.type) return sendHtml(res, admin.matterForm(null), 400);
  const fileNumber = repo.matters.nextFileNumber(b.type);
  const id = repo.matters.insert({
    file_number: fileNumber, type: b.type, title: b.title,
    status: b.status || 'Draft', body_id: b.body_id || null,
    intro_date: b.intro_date || null, summary: b.summary || null, full_text: b.full_text || null,
  });
  applySponsors(id, b.sponsor_id);
  redirect(res, `/legislation/${encodeURIComponent(fileNumber)}`);
});

route('GET', /^\/admin\/matters\/(\d+)\/edit$/, (req, res, ctx) => {
  const m = repo.matters.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, admin.matterForm(m));
});
route('POST', /^\/admin\/matters\/(\d+)$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const m = repo.matters.get(id);
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  repo.matters.update(id, {
    type: b.type, title: b.title, status: b.status, body_id: b.body_id || null,
    intro_date: b.intro_date || null, final_date: b.final_date || null,
    summary: b.summary || null, full_text: b.full_text || null,
  });
  repo.matters.clearSponsors(id);
  applySponsors(id, b.sponsor_id);
  redirect(res, `/legislation/${encodeURIComponent(m.file_number)}`);
});

route('POST', /^\/admin\/matters\/(\d+)\/actions$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const m = repo.matters.get(id);
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  repo.matters.addHistory({
    matter_id: id, action_date: b.action_date, body_id: b.body_id || null,
    action: b.action, result: b.result || null, notes: b.notes || null,
  });
  if (b.new_status) repo.matters.setStatus(id, b.new_status);
  redirect(res, `/admin/matters/${id}/edit`);
});

route('POST', /^\/admin\/matters\/(\d+)\/attachments$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const m = repo.matters.get(id);
  if (!m) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.name) {
    repo.matters.addAttachment({ matter_id: id, name: ctx.body.name, url: ctx.body.url, note: ctx.body.note });
  }
  redirect(res, `/admin/matters/${id}/edit`);
});

route('GET', /^\/admin\/meetings\/new$/, (req, res) => sendHtml(res, admin.meetingForm()));
route('POST', /^\/admin\/meetings$/, (req, res, ctx) => {
  const b = ctx.body;
  if (!b.body_id || !b.meeting_date) return sendHtml(res, admin.meetingForm(), 400);
  const id = repo.meetings.insert({
    body_id: Number(b.body_id), meeting_date: b.meeting_date, meeting_time: b.meeting_time,
    location: b.location, status: b.status || 'Scheduled',
    agenda_url: b.agenda_url, video_url: b.video_url,
  });
  redirect(res, `/admin/meetings/${id}/agenda`);
});

route('GET', /^\/admin\/meetings\/(\d+)\/agenda$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, admin.agendaManager(mt));
});
route('POST', /^\/admin\/meetings\/(\d+)\/agenda$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const mt = repo.meetings.get(id);
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  repo.meetings.addItem({
    meeting_id: id, matter_id: b.matter_id ? Number(b.matter_id) : null,
    agenda_number: b.agenda_number, section: b.section, title: b.title,
  });
  redirect(res, `/admin/meetings/${id}/agenda`);
});

route('POST', /^\/admin\/agenda-items\/(\d+)\/votes$/, (req, res, ctx) => {
  const itemId = Number(ctx.params[0]);
  const item = repo.meetings.getItem(itemId);
  if (!item) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  repo.meetings.setItemResult(itemId, b.action, b.result);
  repo.votes.clearForItem(itemId);
  for (const key of Object.keys(b)) {
    const m = key.match(/^vote_(\d+)$/);
    if (m && b[key]) repo.votes.record(itemId, Number(m[1]), b[key]);
  }
  redirect(res, `/admin/meetings/${item.meeting_id}/agenda`);
});

// JSON API -------------------------------------------------------------------
route('GET', /^\/api\/v1\/?$/, (req, res) => api.index(res));
route('GET', /^\/api\/v1\/matters\/?$/, (req, res, ctx) => api.matters(res, ctx.query));
route('GET', /^\/api\/v1\/matters\/(.+)$/, (req, res, ctx) => api.matter(res, decodeURIComponent(ctx.params[0])));
route('GET', /^\/api\/v1\/events\/?$/, (req, res) => api.events(res));
route('GET', /^\/api\/v1\/events\/(\d+)$/, (req, res, ctx) => api.event(res, ctx.params[0]));
route('GET', /^\/api\/v1\/bodies\/?$/, (req, res) => api.bodies(res));
route('GET', /^\/api\/v1\/bodies\/(\d+)$/, (req, res, ctx) => api.body(res, ctx.params[0]));
route('GET', /^\/api\/v1\/persons\/?$/, (req, res) => api.persons(res));
route('GET', /^\/api\/v1\/persons\/(\d+)$/, (req, res, ctx) => api.person(res, ctx.params[0]));
route('GET', /^\/api\/v1\/people\/?$/, (req, res) => api.persons(res));
route('GET', /^\/api\/v1\/people\/(\d+)$/, (req, res, ctx) => api.person(res, ctx.params[0]));

// --- helpers ----------------------------------------------------------------
function applySponsors(matterId, sponsorIds) {
  const ids = asArray(sponsorIds).filter(Boolean);
  ids.forEach((pid, i) => {
    repo.matters.addSponsor(matterId, Number(pid), i === 0 ? 'Primary' : 'Co-Sponsor');
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname.replace(/^\//, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// --- Server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Static assets
  if (pathname === '/styles.css' || pathname.startsWith('/assets/') || pathname === '/favicon.ico') {
    return serveStatic(req, res, pathname === '/styles.css' ? '/styles.css' : pathname);
  }

  const query = parseQuery(url.search.replace(/^\?/, ''));
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    body = await parseBody(req);
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = pathname.match(r.pattern);
    if (match) {
      const params = match.slice(1);
      try {
        return r.handler(req, res, { params, query, body });
      } catch (err) {
        console.error('Handler error:', err);
        if (pathname.startsWith('/api/')) return sendJson(res, { error: 'Internal error' }, 500);
        return sendHtml(res, '<h1>500 — Internal error</h1><pre>' +
          String(err.message).replace(/</g, '&lt;') + '</pre>', 500);
      }
    }
  }

  // Fallbacks
  if (pathname.startsWith('/api/')) return sendJson(res, { error: 'Not found' }, 404);
  sendHtml(res, pages.notFound(), 404);
});

server.listen(PORT, () => {
  console.log(`Legislative Docket Manager running at http://localhost:${PORT}`);
  console.log(`  Public portal : http://localhost:${PORT}/`);
  console.log(`  Admin / clerk : http://localhost:${PORT}/admin`);
  console.log(`  JSON Web API  : http://localhost:${PORT}/api/v1`);
});

module.exports = server;
