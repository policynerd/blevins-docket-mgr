'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { init } = require('./src/db');
const repo = require('./src/repo');
const pages = require('./src/views/pages');
const admin = require('./src/views/admin');
const api = require('./src/api');
const feeds = require('./src/exports');
const auth = require('./src/auth');
const live = require('./src/live');
const liveViews = require('./src/views/live');
const member = require('./src/views/member');
const orgView = require('./src/views/org');
const reportsView = require('./src/views/reports');
const minutesView = require('./src/views/minutes');
const minutesGen = require('./src/minutes');
const authView = require('./src/views/auth');
const govern = require('./src/views/govern');
const sso = require('./src/sso');
const org = require('./src/org');
const { setUser, forbidden } = require('./src/views/layout');
const { sanitizeHtml } = require('./src/sanitize');
const {
  sendHtml, sendJson, redirect, sendText, baseUrl, parseBody, parseQuery, asArray,
} = require('./src/util');

init();
// Apply any saved in-app branding overrides on top of env/defaults.
org.refresh();

// Sample data is only seeded for explicit demo instances; production starts
// empty and is populated through the admin tools.
if (process.env.ENABLE_DEMO_SEED === 'true' && repo.stats().people === 0) {
  try { require('./src/seed').run(); } catch (e) { console.error('Seed failed:', e.message); }
}
// Seed login accounts: the ADMIN_* bootstrap admin (always, if configured) and
// demo logins (only when ENABLE_DEMO_SEED=true). Throws are logged, not fatal.
try { auth.ensureSeedAccounts(); } catch (e) { console.error('Account seed failed:', e.message); }

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon' };

// --- Route table -------------------------------------------------------------
// Each route: [method, RegExp, handler(req,res,{params,query,body})]
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// --- Health check -----------------------------------------------------------
// Public, dependency-free liveness/readiness probe for container platforms and
// uptime monitors. Verifies the database responds.
route('GET', /^\/healthz$/, (req, res) => {
  try {
    repo.stats();
    sendJson(res, { status: 'ok', time: new Date().toISOString() });
  } catch (e) {
    sendJson(res, { status: 'error', error: String(e.message) }, 503);
  }
});

// --- Auth -------------------------------------------------------------------
function safeNext(next) {
  return (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) ? next : null;
}
route('GET', /^\/login$/, (req, res, ctx) => {
  if (ctx.user) return redirect(res, ctx.user.role === 'clerk' ? '/admin' : '/member');
  sendHtml(res, authView.loginPage({ next: safeNext(ctx.query.next) || '' }));
});
route('POST', /^\/login$/, (req, res, ctx) => {
  const { email, password, next } = ctx.body;
  const sid = auth.login(email, password);
  if (!sid) return sendHtml(res, authView.loginPage({ next: safeNext(next) || '', error: 'Invalid email or password.' }), 401);
  auth.setSessionCookie(res, sid);
  const user = auth.findUserByEmail(email);
  redirect(res, safeNext(next) || (user && user.role === 'clerk' ? '/admin' : '/member'));
});
route('POST', /^\/logout$/, (req, res) => {
  auth.logout(auth.sidFromReq(req));
  auth.clearSessionCookie(res);
  redirect(res, '/');
});

// --- Microsoft Entra ID SSO (OIDC authorization-code flow) ------------------
route('GET', /^\/auth\/sso\/login$/, async (req, res, ctx) => {
  if (!sso.isConfigured()) {
    return sendHtml(res, authView.loginPage({ error: 'Single sign-on is not configured on this server.' }), 503);
  }
  try {
    const { state, nonce } = sso.rememberState(safeNext(ctx.query.next));
    const url = await sso.authorizeUrl({ baseUrl: baseUrl(req), state, nonce });
    redirect(res, url, 302);
  } catch (e) {
    console.error('SSO login error:', e);
    sendHtml(res, authView.loginPage({ error: 'Could not start single sign-on. Try again.' }), 502);
  }
});

route('GET', /^\/auth\/sso\/callback$/, async (req, res, ctx) => {
  const q = ctx.query;
  if (q.error) {
    return sendHtml(res, authView.loginPage({ error: `Sign-in was cancelled or failed (${String(q.error)}).` }), 401);
  }
  const saved = q.state ? sso.consumeState(q.state) : null;
  if (!q.code || !saved) {
    return sendHtml(res, authView.loginPage({ error: 'Sign-in session expired. Please try again.' }), 400);
  }
  try {
    const tokens = await sso.exchangeCode({ code: q.code, baseUrl: baseUrl(req) });
    const claims = await sso.verifyIdToken(tokens.id_token, { nonce: saved.nonce });
    const result = auth.ssoSignIn(sso.identityFromClaims(claims));
    if (result.error) {
      return sendHtml(res, authView.loginPage({
        error: 'Your Microsoft account is not authorized for this site. Ask the Clerk to add you.',
      }), 403);
    }
    auth.setSessionCookie(res, result.sid);
    const role = result.user ? result.user.role : 'member';
    redirect(res, safeNext(saved.next) || (role === 'clerk' ? '/admin' : '/member'));
  } catch (e) {
    console.error('SSO callback error:', e);
    sendHtml(res, authView.loginPage({ error: 'Single sign-on failed to verify your identity.' }), 502);
  }
});

// Public portal --------------------------------------------------------------
route('GET', /^\/$/, (req, res) => sendHtml(res, pages.dashboard()));
route('GET', /^\/legislation\/?$/, (req, res, ctx) => sendHtml(res, pages.legislationList(ctx.query)));

// Feeds & exports -----------------------------------------------------------
route('GET', /^\/legislation\.csv$/, (req, res, ctx) => {
  const q = ctx.query;
  const rows = repo.matters.search({
    q: q.q, type: q.type, status: q.status,
    bodyId: q.body_id ? Number(q.body_id) : undefined,
    sponsorId: q.sponsor_id ? Number(q.sponsor_id) : undefined,
    topicId: q.topic ? Number(q.topic) : undefined,
    from: q.from || undefined, to: q.to || undefined,
    sort: q.sort, dir: q.dir, limit: 1000,
  });
  sendText(res, feeds.mattersCsv(rows), 'text/csv; charset=utf-8', { filename: 'legislation.csv' });
});
route('GET', /^\/legislation\.rss$/, (req, res) => {
  const rows = repo.matters.search({ limit: 50 }).filter((m) => m.intro_date);
  sendText(res, feeds.legislationRss(rows, baseUrl(req)), 'application/rss+xml; charset=utf-8');
});
route('GET', /^\/calendar\.ics$/, (req, res) => {
  sendText(res, feeds.icalCalendar(repo.meetings.all(), baseUrl(req)), 'text/calendar; charset=utf-8',
    { filename: 'meetings.ics' });
});

route('GET', /^\/legislation\/(.+)$/, (req, res, ctx) => {
  const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.matterDetail(m));
});
route('GET', /^\/calendar\/?$/, (req, res, ctx) => sendHtml(res, pages.calendar(ctx.query)));
route('GET', /^\/meetings\/(\d+)$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.meetingDetail(mt));
});
route('GET', /^\/meetings\/(\d+)\/packet$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.agendaPacket(mt));
});
route('GET', /^\/meetings\/(\d+)\/minutes$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, minutesView.minutesView(mt));
});
route('GET', /^\/topics\/?$/, (req, res) => sendHtml(res, pages.topicsList()));
route('GET', /^\/org\/?$/, (req, res) => sendHtml(res, orgView.orgDirectory()));
route('GET', /^\/org\/(\d+)$/, (req, res, ctx) => {
  const u = repo.org.get(Number(ctx.params[0]));
  if (!u) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, orgView.orgUnitDetail(u));
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

// Danger zone: wipe all domain data (clerk only; keeps users + settings).
route('POST', /^\/admin\/purge$/, (req, res) => {
  repo.purgeDomainData();
  redirect(res, '/admin');
});

// Organization management (clerk)
route('GET', /^\/admin\/org\/?$/, (req, res) => sendHtml(res, orgView.orgAdmin()));
route('GET', /^\/admin\/org\/new$/, (req, res, ctx) => sendHtml(res,
  orgView.orgForm(null, { parentId: ctx.query.parent || '', level: ctx.query.level || 'Division' })));
route('POST', /^\/admin\/org$/, (req, res, ctx) => {
  const b = ctx.body;
  if (!b.name || !b.level) return redirect(res, '/admin/org/new');
  const id = repo.org.insert({
    parent_id: b.parent_id ? Number(b.parent_id) : null, level: b.level, name: b.name,
    leader_name: b.leader_name, leader_title: b.leader_title, leader_email: b.leader_email,
    leader_phone: b.leader_phone, description: b.description, sort_order: Number(b.sort_order) || 0,
  });
  redirect(res, `/org/${id}`);
});
route('GET', /^\/admin\/org\/(\d+)\/edit$/, (req, res, ctx) => {
  const u = repo.org.get(Number(ctx.params[0]));
  if (!u) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, orgView.orgForm(u));
});
route('POST', /^\/admin\/org\/(\d+)$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const u = repo.org.get(id);
  if (!u) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  repo.org.update(id, {
    parent_id: b.parent_id ? Number(b.parent_id) : null, level: b.level, name: b.name,
    leader_name: b.leader_name, leader_title: b.leader_title, leader_email: b.leader_email,
    leader_phone: b.leader_phone, description: b.description, sort_order: Number(b.sort_order) || 0,
  });
  redirect(res, `/org/${id}`);
});
route('POST', /^\/admin\/org\/(\d+)\/delete$/, (req, res, ctx) => {
  const u = repo.org.get(Number(ctx.params[0]));
  if (!u) return sendHtml(res, pages.notFound(), 404);
  repo.org.remove(u.id);
  redirect(res, '/admin/org');
});

// Bodies & committees CRUD (clerk) -------------------------------------------
route('GET', /^\/admin\/bodies\/?$/, (req, res) => sendHtml(res, govern.bodiesAdmin()));
route('GET', /^\/admin\/bodies\/new$/, (req, res) => sendHtml(res, govern.bodyForm(null)));
route('POST', /^\/admin\/bodies$/, (req, res, ctx) => {
  const b = ctx.body;
  if (!b.name) return sendHtml(res, govern.bodyForm(null), 400);
  const id = repo.bodies.insert({
    name: b.name, type: b.type || null, description: b.description || null,
    meeting_location: b.meeting_location || null, meets: b.meets || null,
  });
  redirect(res, `/bodies/${id}`);
});
route('GET', /^\/admin\/bodies\/(\d+)\/edit$/, (req, res, ctx) => {
  const b = repo.bodies.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, govern.bodyForm(b));
});
route('POST', /^\/admin\/bodies\/(\d+)$/, (req, res, ctx) => {
  const b = repo.bodies.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  const f = ctx.body;
  if (!f.name) return sendHtml(res, govern.bodyForm(b), 400);
  repo.bodies.update(b.id, {
    name: f.name, type: f.type || null, description: f.description || null,
    meeting_location: f.meeting_location || null, meets: f.meets || null, active: b.active,
  });
  redirect(res, `/bodies/${b.id}`);
});
route('POST', /^\/admin\/bodies\/(\d+)\/active$/, (req, res, ctx) => {
  const b = repo.bodies.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  repo.bodies.setActive(b.id, String(ctx.body.active) === '1');
  redirect(res, '/admin/bodies');
});
route('POST', /^\/admin\/bodies\/(\d+)\/delete$/, (req, res, ctx) => {
  const b = repo.bodies.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  const refs = repo.bodies.references(b.id);
  // Refuse hard delete while meetings/matters/history reference the body.
  if (refs.meetings + refs.matters + refs.history === 0) repo.bodies.remove(b.id);
  redirect(res, '/admin/bodies');
});

// Branding / in-app identity (clerk) -----------------------------------------
route('GET', /^\/admin\/branding\/?$/, (req, res, ctx) => sendHtml(res,
  govern.brandingPage({ saved: ctx.query.saved === '1' })));
route('POST', /^\/admin\/branding$/, (req, res, ctx) => {
  org.update(ctx.body);
  redirect(res, '/admin/branding?saved=1');
});

// Board membership workflow: Nominate -> Approve -> Seat (staff+) -------------
route('GET', /^\/govern\/members\/?$/, (req, res, ctx) => sendHtml(res, govern.membersPage(ctx.user)));
route('POST', /^\/govern\/members\/nominate$/, (req, res, ctx) => {
  if (!auth.hasRole(ctx.user, 'clerk')) return sendHtml(res, forbidden(), 403);
  const b = ctx.body;
  const bodyId = b.body_id ? Number(b.body_id) : null;
  if (!bodyId || !repo.bodies.get(bodyId)) return redirect(res, '/govern/members');
  if (b.action === 'remove') {
    repo.memberMotions.nominate({
      action: 'remove', body_id: bodyId,
      person_id: b.person_id ? Number(b.person_id) : null,
      member_id: b.member_id ? Number(b.member_id) : null,
      reason: b.reason || null, nominated_by: ctx.user.id,
    });
  } else {
    const personId = b.person_id ? Number(b.person_id) : null;
    if (!personId && !String(b.nominee_name || '').trim()) return redirect(res, '/govern/members');
    repo.memberMotions.nominate({
      action: 'seat', body_id: bodyId, person_id: personId,
      nominee_name: personId ? null : b.nominee_name, nominee_title: b.nominee_title || null,
      nominee_email: b.nominee_email || null, nominee_district: b.nominee_district || null,
      seat_role: b.seat_role || 'Member', reason: b.reason || null, nominated_by: ctx.user.id,
    });
  }
  redirect(res, '/govern/members');
});
route('POST', /^\/govern\/member-motions\/(\d+)\/approve$/, (req, res, ctx) => {
  const m = repo.memberMotions.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  // Separation of duties: the approver must differ from the nominator.
  if (m.nominated_by && ctx.user && ctx.user.id === m.nominated_by) return sendHtml(res, forbidden(), 403);
  repo.memberMotions.approve(m.id, ctx.user ? ctx.user.id : null, ctx.body.notes || null);
  redirect(res, '/govern/members');
});
route('POST', /^\/govern\/member-motions\/(\d+)\/reject$/, (req, res, ctx) => {
  const m = repo.memberMotions.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  repo.memberMotions.reject(m.id, ctx.user ? ctx.user.id : null, ctx.body.notes || null);
  redirect(res, '/govern/members');
});
route('POST', /^\/govern\/member-motions\/(\d+)\/complete$/, (req, res, ctx) => {
  if (!auth.hasRole(ctx.user, 'clerk')) return sendHtml(res, forbidden(), 403);
  const m = repo.memberMotions.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  if (m.status === 'Approved') {
    try { repo.memberMotions.complete(m.id, ctx.user.id); }
    catch (e) { console.error('Seat motion failed:', e.message); }
  }
  redirect(res, '/govern/members');
});

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
  repo.topics.setForMatter(id, parseTopics(b.topics));
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
  repo.topics.setForMatter(id, parseTopics(b.topics));
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

route('POST', /^\/admin\/matters\/(\d+)\/route$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const m = repo.matters.get(id);
  if (!m) return sendHtml(res, pages.notFound(), 404);
  repo.workflow.start(id);
  repo.matters.addHistory({
    matter_id: id, action_date: require('./src/util').todayISO(), body_id: m.body_id || null,
    action: 'Introduced to approval route',
  });
  redirect(res, `/admin/matters/${id}/edit`);
});

route('POST', /^\/admin\/workflow-steps\/(\d+)\/act$/, (req, res, ctx) => {
  const step = repo.workflow.get(Number(ctx.params[0]));
  if (!step) return sendHtml(res, pages.notFound(), 404);
  const status = ['Approved', 'Returned', 'Skipped'].includes(ctx.body.status) ? ctx.body.status : 'Approved';
  repo.workflow.act(step.id, { status, userId: ctx.user ? ctx.user.id : null, notes: ctx.body.notes });
  repo.matters.addHistory({
    matter_id: step.matter_id, action_date: require('./src/util').todayISO(),
    action: `${step.name}: ${status}`,
    result: status === 'Approved' ? 'Pass' : (status === 'Returned' ? 'Fail' : null),
    notes: ctx.body.notes || null,
  });
  redirect(res, `/admin/matters/${step.matter_id}/edit`);
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

route('POST', /^\/admin\/meetings\/(\d+)\/agenda\/reorder$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const mt = repo.meetings.get(id);
  if (!mt) return sendJson(res, { error: 'Meeting not found' }, 404);
  const order = asArray(ctx.body && ctx.body.order).map(Number).filter((n) => !Number.isNaN(n));
  const moved = repo.meetings.reorderItems(id, order);
  sendJson(res, { ok: true, moved });
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

// Reports / word processor (clerk) -------------------------------------------
route('GET', /^\/reports\/(\d+)$/, (req, res, ctx) => {
  const r = repo.reports.get(Number(ctx.params[0]));
  if (!r) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, reportsView.reportView(r));
});
route('GET', /^\/admin\/matters\/(\d+)\/reports\/new$/, (req, res, ctx) => {
  const m = repo.matters.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, reportsView.reportForm(null, m));
});
route('POST', /^\/admin\/matters\/(\d+)\/reports$/, (req, res, ctx) => {
  const m = repo.matters.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  if (!b.title) return redirect(res, `/admin/matters/${m.id}/reports/new`);
  repo.reports.insert({
    matter_id: m.id, title: b.title, kind: b.kind,
    body_html: sanitizeHtml(b.body_html), author_id: ctx.user ? ctx.user.id : null,
  });
  redirect(res, `/legislation/${encodeURIComponent(m.file_number)}`);
});
route('GET', /^\/admin\/reports\/(\d+)\/edit$/, (req, res, ctx) => {
  const r = repo.reports.get(Number(ctx.params[0]));
  if (!r) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, reportsView.reportForm(r, null));
});
route('POST', /^\/admin\/reports\/(\d+)$/, (req, res, ctx) => {
  const r = repo.reports.get(Number(ctx.params[0]));
  if (!r) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  repo.reports.update(r.id, { title: b.title, kind: b.kind, body_html: sanitizeHtml(b.body_html) });
  redirect(res, `/reports/${r.id}`);
});

// Member portal --------------------------------------------------------------
route('GET', /^\/member\/?$/, (req, res, ctx) => sendHtml(res, member.memberHome(ctx.user)));
route('GET', /^\/member\/files\/new$/, (req, res, ctx) => sendHtml(res, member.memberFileForm(ctx.user)));
route('POST', /^\/member\/files$/, (req, res, ctx) => {
  const b = ctx.body;
  if (!b.title || !b.type) return redirect(res, '/member/files/new');
  const fileNumber = repo.matters.nextFileNumber(b.type);
  const id = repo.matters.insert({
    file_number: fileNumber, type: b.type, title: b.title, status: 'Draft',
    summary: b.summary || null,
  });
  repo.matters.setBodyHtml(id, sanitizeHtml(b.body_html));
  if (ctx.user && ctx.user.person_id) repo.matters.addSponsor(id, ctx.user.person_id, 'Primary');
  redirect(res, `/legislation/${encodeURIComponent(fileNumber)}`);
});
route('POST', /^\/member\/agenda-items\/(\d+)\/cast$/, (req, res, ctx) => {
  const itemId = Number(ctx.params[0]);
  const item = repo.meetings.getItem(itemId);
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  if (!ctx.user || !ctx.user.person_id) return sendJson(res, { error: 'No member identity' }, 403);
  if ((item.vote_status || 'pending') !== 'open') return sendJson(res, { error: 'Voting is not open' }, 409);
  const roster = new Set(repo.bodies.members(item.body_id).map((m) => m.person_id));
  if (!roster.has(ctx.user.person_id)) return sendJson(res, { error: 'Not on this body' }, 403);
  if (!repo.VOTE_VALUES.includes(ctx.body.vote)) return sendJson(res, { error: 'Invalid vote' }, 400);
  recordSingleVote(itemId, ctx.user.person_id, ctx.body.vote);
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true });
});

// Live voting — public read view + SSE ---------------------------------------
route('GET', /^\/live\/(\d+)$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, liveViews.publicLive(mt, ctx.user));
});
route('GET', /^\/live\/(\d+)\/stream$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  if (!repo.meetings.get(id)) return sendJson(res, { error: 'Not found' }, 404);
  live.subscribe(id, req, res);
  live.sendInitial(id, res);
});

// Live voting — clerk console + controls -------------------------------------
route('GET', /^\/admin\/meetings\/(\d+)\/live$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, liveViews.clerkConsole(mt, ctx.user));
});
route('POST', /^\/admin\/agenda-items\/(\d+)\/open$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  // Only one item open at a time per meeting.
  for (const it of repo.meetings.items(item.meeting_id)) {
    if (it.vote_status === 'open') repo.meetings.setVoteStatus(it.id, 'pending');
  }
  repo.meetings.setVoteStatus(item.id, 'open');
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true });
});
route('POST', /^\/admin\/agenda-items\/(\d+)\/close$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  const t = repo.votes.tally(item.id);
  const result = t.Yea > t.Nay ? 'Pass' : 'Fail';
  repo.meetings.setItemResult(item.id, item.action || (item.motion_text ? 'Motion' : 'Vote taken'), result);
  repo.meetings.setVoteStatus(item.id, 'closed');
  // Reflect the outcome on the matter's legislative history.
  if (item.matter_id) {
    repo.matters.addHistory({
      matter_id: item.matter_id, action_date: require('./src/util').todayISO(),
      body_id: item.body_id, action: 'Vote taken in live session', result,
      meeting_id: item.meeting_id,
    });
  }
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true, result });
});
route('POST', /^\/admin\/agenda-items\/(\d+)\/motion$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  const b = ctx.body;
  repo.meetings.setMotion(item.id, {
    mover_id: b.mover_id ? Number(b.mover_id) : null,
    seconder_id: b.seconder_id ? Number(b.seconder_id) : null,
    motion_text: b.motion_text || null,
  });
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true });
});
route('POST', /^\/admin\/agenda-items\/(\d+)\/cast$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  if (!repo.VOTE_VALUES.includes(ctx.body.vote)) return sendJson(res, { error: 'Invalid vote' }, 400);
  recordSingleVote(item.id, Number(ctx.body.person_id), ctx.body.vote);
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true });
});

// Minutes & attendance (clerk) -----------------------------------------------
route('GET', /^\/admin\/meetings\/(\d+)\/minutes$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, minutesView.minutesEditor(mt));
});
route('POST', /^\/admin\/meetings\/(\d+)\/minutes\/generate$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  if (!repo.meetings.get(id)) return sendHtml(res, pages.notFound(), 404);
  repo.meetings.setMinutes(id, minutesGen.generate(id), 'draft');
  redirect(res, `/admin/meetings/${id}/minutes`);
});
route('POST', /^\/admin\/meetings\/(\d+)\/minutes$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  if (!repo.meetings.get(id)) return sendHtml(res, pages.notFound(), 404);
  const status = ctx.body.status === 'published' ? 'published' : 'draft';
  repo.meetings.setMinutes(id, sanitizeHtml(ctx.body.minutes_html), status);
  redirect(res, status === 'published' ? `/meetings/${id}/minutes` : `/admin/meetings/${id}/minutes`);
});
route('POST', /^\/admin\/meetings\/(\d+)\/attendance$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  if (!repo.meetings.get(id)) return sendHtml(res, pages.notFound(), 404);
  const rows = [];
  for (const key of Object.keys(ctx.body)) {
    const m = key.match(/^att_(\d+)$/);
    if (m && ctx.body[key]) rows.push({ person_id: Number(m[1]), status: ctx.body[key] });
  }
  repo.meetings.setAttendance(id, rows);
  redirect(res, `/admin/meetings/${id}/minutes`);
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
// Centralized access control. Returns false (and writes a response) when the
// request should be blocked. /admin requires clerk; /member requires member+.
function gate(req, res, pathname, user) {
  let need = null;
  if (pathname.startsWith('/admin')) need = 'clerk';
  else if (pathname.startsWith('/govern')) need = 'staff';
  else if (pathname.startsWith('/member')) need = 'member';
  if (!need) return true;
  if (auth.hasRole(user, need)) return true;
  if (!user) { redirect(res, '/login?next=' + encodeURIComponent(pathname)); return false; }
  sendHtml(res, forbidden(), 403);
  return false;
}

function parseTopics(str) {
  return String(str || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25);
}

function recordSingleVote(itemId, personId, vote) {
  if (!personId) return;
  repo.votes.clearPersonForItem(itemId, personId);
  repo.votes.record(itemId, personId, vote);
}

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

  // Resolve the current user and gate protected areas. Set the user for the
  // layout synchronously here — handlers render without an intervening await.
  const user = auth.currentUser(req);
  setUser(user);

  if (!gate(req, res, pathname, user)) return;

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = pathname.match(r.pattern);
    if (match) {
      const params = match.slice(1);
      try {
        return r.handler(req, res, { params, query, body, user, pathname });
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
