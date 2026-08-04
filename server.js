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
const policiesView = require('./src/views/policies');
const budgetView = require('./src/views/budget');
const usersView = require('./src/views/users');
const legal = require('./src/views/legal');
const sso = require('./src/sso');
const importer = require('./src/import');
const pdfGen = require('./src/pdf');
const org = require('./src/org');
const backup = require('./src/backup');
const upload = require('./src/upload');
const notify = require('./src/notify');
const smtp = require('./src/smtp');
const alerts = require('./src/alerts');
const approvalsView = require('./src/views/approvals');
const proposalsView = require('./src/views/proposals');
const procurementView = require('./src/views/procurement');
const consentsView = require('./src/views/consents');
const esign = require('./src/esign');
const announcement = require('./src/announcement');
const draftingView = require('./src/views/drafting');
const amendEngine = require('./src/amend');
const docTemplates = require('./src/doc-templates');
const { sameOrigin } = require('./src/security');
const { setUser, forbidden } = require('./src/views/layout');
const { sanitizeHtml } = require('./src/sanitize');
const {
  sendHtml, sendJson, redirect, sendText, baseUrl, parseBody, parseQuery, asArray,
} = require('./src/util');

init();
// Apply any saved in-app branding overrides on top of env/defaults.
org.refresh();
// One-time initial site announcement (a clerk edits or clears it live after).
announcement.seedIfAbsent({
  text: `Notice: The ${org.ORG.primaryBody} meeting has been moved to 11:30 a.m., pending the ${org.ORG.chairTitle}'s emergency root canal surgery.`,
  level: 'warning',
});

// Sample data is only seeded for explicit demo instances; production starts
// empty and is populated through the admin tools.
if (process.env.ENABLE_DEMO_SEED === 'true' && repo.stats().people === 0) {
  try { require('./src/seed').run(); } catch (e) { console.error('Seed failed:', e.message); }
}
// Seed login accounts: the ADMIN_* bootstrap admin (always, if configured) and
// demo logins (only when ENABLE_DEMO_SEED=true). Throws are logged, not fatal.
try { auth.ensureSeedAccounts(); } catch (e) { console.error('Account seed failed:', e.message); }
// Ensure the configured ADMIN_EMAIL is a global admin (promotes existing accounts).
try { auth.ensureAdminRole(); } catch (e) { console.error('Admin role check failed:', e.message); }
// Daily on-volume database backups (VACUUM INTO), pruned to the newest 7.
backup.schedule();
// Email delivery loop (inert unless SMTP_* env vars are configured).
notify.schedule();
// Saved-search alerts + daily digest (also inert without SMTP).
alerts.schedule();

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

// --- Adobe Acrobat Sign webhook (public, CSRF-exempt) -----------------------
// Adobe verifies the endpoint by sending X-AdobeSign-ClientId (on GET
// registration and every POST delivery); we must echo it back. Agreement
// events then trigger a re-sync of the consent's signer statuses.
function adobeSignWebhook(req, res, ctx) {
  const sent = req.headers['x-adobesign-clientid'] || '';
  const expected = esign.webhookClientId();
  if (sent) res.setHeader('X-AdobeSign-ClientId', sent); // required handshake echo
  if (expected && sent && sent !== expected) return sendJson(res, { error: 'client id mismatch' }, 403);
  if (req.method === 'POST') {
    try {
      const evt = ctx.body || {};
      const agreementId = (evt.agreement && evt.agreement.id) || evt.agreementId
        || (evt.resource && evt.resource.id) || null;
      if (agreementId && esign.isConfigured()) {
        const c = repo.consents.getByAgreement(agreementId);
        if (c) {
          esign.agreementMembers(agreementId)
            .then((members) => repo.consents.syncFromMembers(c.id, members))
            .catch((e) => console.error('esign webhook sync failed:', e.message));
        }
      }
    } catch (e) { console.error('adobe webhook parse failed:', e.message); }
  }
  sendJson(res, { ok: true });
}
route('GET', /^\/webhooks\/adobe-sign$/, adobeSignWebhook);
route('POST', /^\/webhooks\/adobe-sign$/, adobeSignWebhook);

// --- Auth -------------------------------------------------------------------
function safeNext(next) {
  return (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) ? next : null;
}
route('GET', /^\/login$/, (req, res, ctx) => {
  if (ctx.user) return redirect(res, auth.hasRole(ctx.user, 'clerk') ? '/admin' : '/member');
  sendHtml(res, authView.loginPage({ next: safeNext(ctx.query.next) || '' }));
});
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : '') || req.socket.remoteAddress || '';
}
route('POST', /^\/login$/, (req, res, ctx) => {
  const { email, password, next } = ctx.body;
  const ip = clientIp(req);
  if (auth.loginThrottled(ip, email)) {
    return sendHtml(res, authView.loginPage({
      next: safeNext(next) || '', error: 'Too many failed attempts. Try again in a few minutes.',
    }), 429);
  }
  const sid = auth.login(email, password);
  if (!sid) {
    auth.recordLoginFailure(ip, email);
    return sendHtml(res, authView.loginPage({ next: safeNext(next) || '', error: 'Invalid email or password.' }), 401);
  }
  auth.clearLoginFailures(ip, email);
  auth.setSessionCookie(res, sid);
  const user = auth.findUserByEmail(email);
  redirect(res, safeNext(next) || (auth.hasRole(user, 'clerk') ? '/admin' : '/member'));
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
    redirect(res, safeNext(saved.next) || (auth.hasRole(result.user, 'clerk') ? '/admin' : '/member'));
  } catch (e) {
    console.error('SSO callback error:', e);
    sendHtml(res, authView.loginPage({ error: 'Single sign-on failed to verify your identity.' }), 502);
  }
});

// Public portal --------------------------------------------------------------
route('GET', /^\/$/, (req, res) => sendHtml(res, pages.dashboard()));
route('GET', /^\/docket\/?$/, (req, res) => sendHtml(res, pages.docket()));
route('GET', /^\/legislation\/?$/, (req, res, ctx) => sendHtml(res, pages.legislationList(ctx.query, ctx.user)));
// Save the current legislation search as a named alert (signed-in users).
route('POST', /^\/legislation\/save-search$/, (req, res, ctx) => {
  if (!ctx.user) return redirect(res, '/login?next=%2Flegislation');
  const name = String(ctx.body.name || '').trim().slice(0, 80);
  if (name) {
    const keep = ['q', 'type', 'status', 'body_id', 'sponsor_id', 'topic', 'from', 'to'];
    const filters = {};
    for (const k of keep) if (ctx.body[k]) filters[k] = String(ctx.body[k]);
    repo.savedSearches.add(ctx.user.id, name, filters);
  }
  redirect(res, '/watching');
});
route('POST', /^\/watching\/searches\/(\d+)\/delete$/, (req, res, ctx) => {
  if (!ctx.user) return redirect(res, '/login?next=%2Fwatching');
  repo.savedSearches.remove(Number(ctx.params[0]), ctx.user.id);
  redirect(res, '/watching');
});
// Daily digest opt-in/out.
route('POST', /^\/watching\/digest$/, (req, res, ctx) => {
  if (!ctx.user) return redirect(res, '/login?next=%2Fwatching');
  repo.users.setDigest(ctx.user.id, ctx.body.digest === '1');
  redirect(res, '/watching');
});

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

// Per-file activity feed (RSS) — must be registered before the greedy route.
route('GET', /^\/legislation\/(.+)\.rss$/, (req, res, ctx) => {
  const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
  if (!m) return sendJson(res, { error: 'Not found' }, 404);
  const events = [
    ...repo.matters.history(m.id).map((h) => ({
      date: h.action_date,
      title: `${h.action}${h.result ? ' — ' + h.result : ''}`,
      description: h.notes || undefined,
    })),
    ...repo.matters.versions(m.id).map((v) => ({
      date: v.created_at,
      title: `Text revised (version ${v.version} archived)`,
    })),
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 50);
  sendText(res, feeds.matterRss(m, events, baseUrl(req)), 'application/rss+xml; charset=utf-8');
});

// Watch / unwatch a file (signed-in users).
route('POST', /^\/legislation\/(.+)\/watch$/, (req, res, ctx) => {
  const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const back = `/legislation/${encodeURIComponent(m.file_number)}`;
  if (!ctx.user) return redirect(res, '/login?next=' + encodeURIComponent(back));
  repo.watches.toggle(ctx.user.id, m.id);
  redirect(res, back);
});
route('GET', /^\/watching\/?$/, (req, res, ctx) => {
  if (!ctx.user) return redirect(res, '/login?next=%2Fwatching');
  sendHtml(res, member.watchingPage(ctx.user));
});

// --- Citizen proposals (Decidim-style) --------------------------------------
route('GET', /^\/proposals\/?$/, (req, res, ctx) => sendHtml(res, proposalsView.proposalsList(ctx.query)));
route('GET', /^\/proposals\/(\d+)$/, (req, res, ctx) => {
  const p = repo.proposals.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, proposalsView.proposalDetail(p, ctx.query));
});
route('POST', /^\/proposals$/, (req, res, ctx) => {
  if (ctx.body.website) return redirect(res, '/proposals?submitted=1'); // honeypot
  const title = String(ctx.body.title || '').trim().slice(0, 140);
  const bodyText = String(ctx.body.body || '').trim().slice(0, 6000);
  const name = String(ctx.body.name || '').trim().slice(0, 100);
  if (!title || !bodyText || !name) return redirect(res, '/proposals');
  if (publicFormThrottled(clientIp(req))) {
    return sendHtml(res, '<h1>429 — Too many submissions. Please try again later.</h1>', 429);
  }
  repo.proposals.add({ title, body: bodyText, name, email: String(ctx.body.email || '').trim().slice(0, 200) || null });
  redirect(res, '/proposals?submitted=1');
});
route('POST', /^\/proposals\/(\d+)\/endorse$/, (req, res, ctx) => {
  const p = repo.proposals.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  const back = `/proposals/${p.id}`;
  if (ctx.body.website) return redirect(res, back + '?endorsed=1'); // honeypot
  const name = String(ctx.body.name || '').trim().slice(0, 100);
  const email = String(ctx.body.email || '').trim().slice(0, 200);
  if (!name || !email) return redirect(res, back);
  if (publicFormThrottled(clientIp(req))) {
    return sendHtml(res, '<h1>429 — Too many submissions. Please try again later.</h1>', 429);
  }
  const ok = repo.proposals.endorse(p.id, name, email);
  redirect(res, back + (ok ? '?endorsed=1' : '?endorsed=0'));
});

// Accountability (public implementation tracker).
route('GET', /^\/accountability\/?$/, (req, res) => sendHtml(res, pages.accountabilityPage()));

// --- Procurement / vendor portal (public) -----------------------------------
route('GET', /^\/procurement\/?$/, (req, res) => sendHtml(res, procurementView.procurementList()));
route('GET', /^\/vendors\/register\/?$/, (req, res, ctx) => sendHtml(res, procurementView.vendorRegister(ctx.query)));
route('POST', /^\/vendors\/register$/, (req, res, ctx) => {
  if (ctx.body.website) return redirect(res, '/vendors/register?registered=1'); // honeypot
  const name = String(ctx.body.name || '').trim().slice(0, 140);
  if (!name) return redirect(res, '/vendors/register');
  if (publicFormThrottled(clientIp(req))) {
    return sendHtml(res, '<h1>429 — Too many submissions. Please try again later.</h1>', 429);
  }
  repo.vendors.register({
    name,
    contact_name: String(ctx.body.contact_name || '').trim().slice(0, 100) || null,
    email: String(ctx.body.email || '').trim().slice(0, 200) || null,
    phone: String(ctx.body.phone || '').trim().slice(0, 40) || null,
    categories: String(ctx.body.categories || '').trim().slice(0, 300) || null,
  });
  redirect(res, '/vendors/register?registered=1');
});
route('GET', /^\/procurement\/(\d+)$/, (req, res, ctx) => {
  const s = repo.procurement.get(Number(ctx.params[0]));
  if (!s || s.status === 'Draft') return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, procurementView.solicitationDetail(s, ctx.query));
});
route('POST', /^\/procurement\/(\d+)\/questions$/, (req, res, ctx) => {
  const s = repo.procurement.get(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  const back = `/procurement/${s.id}`;
  if (ctx.body.website) return redirect(res, back + '?asked=1');
  const name = String(ctx.body.name || '').trim().slice(0, 100);
  const question = String(ctx.body.question || '').trim().slice(0, 2000);
  if (s.status !== 'Open' || !name || !question) return redirect(res, back);
  if (publicFormThrottled(clientIp(req))) {
    return sendHtml(res, '<h1>429 — Too many submissions. Please try again later.</h1>', 429);
  }
  repo.procurement.addQuestion({
    solicitation_id: s.id, name, question,
    email: String(ctx.body.email || '').trim().slice(0, 200) || null,
  });
  redirect(res, back + '?asked=1');
});
route('POST', /^\/procurement\/(\d+)\/bids$/, (req, res, ctx) => {
  const s = repo.procurement.get(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  const back = `/procurement/${s.id}`;
  if (ctx.body.website) return redirect(res, back + '?bid=1');
  const vendor = String(ctx.body.vendor_name || '').trim().slice(0, 140);
  if (!repo.procurement.biddable(s) || !vendor) return redirect(res, back);
  if (publicFormThrottled(clientIp(req))) {
    return sendHtml(res, '<h1>429 — Too many submissions. Please try again later.</h1>', 429);
  }
  repo.procurement.addBid({
    solicitation_id: s.id, vendor_name: vendor,
    email: String(ctx.body.email || '').trim().slice(0, 200) || null,
    amount: ctx.body.amount, note: String(ctx.body.note || '').trim().slice(0, 4000) || null,
  });
  redirect(res, back + '?bid=1');
});

// Comparative print ("changes to existing law") — before the greedy route.
route('GET', /^\/legislation\/(.+)\/changes$/, (req, res, ctx) => {
  const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
  if (!m || !m.amends_policy_id) return sendHtml(res, pages.notFound(), 404);
  const policy = repo.policies.get(m.amends_policy_id);
  if (!policy) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.matterChangesPage(m, policy));
});

// Related-file links (clerk).
route('POST', /^\/admin\/matters\/(\d+)\/relations$/, (req, res, ctx) => {
  const m = repo.matters.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.related_id) {
    repo.matters.addRelation(m.id, Number(ctx.body.related_id), ctx.body.relation);
  }
  redirect(res, `/admin/matters/${m.id}/edit`);
});
route('POST', /^\/admin\/relations\/(\d+)\/delete$/, (req, res, ctx) => {
  const r = repo.matters.getRelation(Number(ctx.params[0]));
  if (!r) return sendHtml(res, pages.notFound(), 404);
  repo.matters.removeRelation(r.id);
  redirect(res, `/admin/matters/${r.matter_id}/edit`);
});

// Amendment comparison — must be registered before the greedy matter route.
route('GET', /^\/legislation\/(.+)\/compare$/, (req, res, ctx) => {
  const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.matterComparePage(m, ctx.query));
});
// Archived text version — must be registered before the greedy matter route.
route('GET', /^\/legislation\/(.+)\/v\/(\d+)$/, (req, res, ctx) => {
  const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const ver = repo.matters.getVersion(m.id, Number(ctx.params[1]));
  if (!ver) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.matterVersionPage(m, ver));
});
route('GET', /^\/legislation\/(.+)$/, (req, res, ctx) => {
  const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.matterDetail(m, ctx.query, ctx.user));
});

// Shared per-IP throttle for anonymous public forms (comments, speaker
// sign-ups, applications): 5 accepted submissions per 10 minutes.
const publicFormHits = new Map(); // ip -> { count, first }
function publicFormThrottled(ip) {
  const now = Date.now();
  const rec = publicFormHits.get(ip) || { count: 0, first: now };
  if (now - rec.first > 10 * 60 * 1000) { rec.count = 0; rec.first = now; }
  if (rec.count >= 5) return true;
  rec.count += 1;
  publicFormHits.set(ip, rec);
  if (publicFormHits.size > 10000) publicFormHits.clear();
  return false;
}

// Public comment submission (eComment) — throttled per IP, honeypot-filtered,
// and held for clerk review before publication.
route('POST', /^\/legislation\/(.+)\/comments$/, (req, res, ctx) => {
  const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const back = `/legislation/${encodeURIComponent(m.file_number)}`;
  // Honeypot field filled = bot; pretend success without storing anything.
  if (ctx.body.website) return redirect(res, back + '?commented=1');
  const name = String(ctx.body.name || '').trim().slice(0, 100);
  const body = String(ctx.body.body || '').trim().slice(0, 4000);
  if (!name || !body) return redirect(res, back);
  if (publicFormThrottled(clientIp(req))) {
    return sendHtml(res, '<h1>429 — Too many submissions. Please try again later.</h1>', 429);
  }
  repo.comments.add({
    matter_id: m.id, name, body,
    email: String(ctx.body.email || '').trim().slice(0, 200) || null,
    position: ctx.body.position,
  });
  redirect(res, back + '?commented=1');
});

// Request to speak at an upcoming meeting.
route('POST', /^\/meetings\/(\d+)\/speak$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  const back = `/meetings/${mt.id}`;
  if (!pages.acceptsSpeakers(mt)) return redirect(res, back); // meeting concluded/cancelled
  if (ctx.body.website) return redirect(res, back + '?speak=1'); // honeypot
  const name = String(ctx.body.name || '').trim().slice(0, 100);
  if (!name) return redirect(res, back);
  if (publicFormThrottled(clientIp(req))) {
    return sendHtml(res, '<h1>429 — Too many submissions. Please try again later.</h1>', 429);
  }
  const itemId = ctx.body.agenda_item_id ? Number(ctx.body.agenda_item_id) : null;
  const item = itemId ? repo.meetings.getItem(itemId) : null;
  repo.speakers.add({
    meeting_id: mt.id,
    agenda_item_id: item && item.meeting_id === mt.id ? item.id : null,
    name,
    email: String(ctx.body.email || '').trim().slice(0, 200) || null,
    position: ctx.body.position,
  });
  redirect(res, back + '?speak=1');
});
// Per-item video timestamp (clerk): deep link into the meeting recording.
route('POST', /^\/admin\/agenda-items\/(\d+)\/video$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendHtml(res, pages.notFound(), 404);
  const ts = String(ctx.body.video_ts || '').trim().replace(/^▶\s*/, '');
  if (ts === '' || /^(\d+:)?[0-5]?\d:[0-5]\d$|^\d+$/.test(ts)) {
    repo.meetings.setItemVideoTs(item.id, ts || null);
  }
  redirect(res, `/admin/meetings/${item.meeting_id}/agenda`);
});

// Speaker queue moderation (clerk).
route('POST', /^\/admin\/speakers\/(\d+)\/status$/, (req, res, ctx) => {
  const s = repo.speakers.get(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  repo.speakers.setStatus(s.id, ctx.body.status);
  if (ctx.body.status === 'Approved') notify.speakerApproved(s.id);
  redirect(res, `/admin/meetings/${s.meeting_id}/agenda`);
});
route('GET', /^\/calendar\/?$/, (req, res, ctx) => sendHtml(res, pages.calendar(ctx.query)));
route('GET', /^\/meetings\/(\d+)$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.meetingDetail(mt, ctx.query));
});
route('GET', /^\/meetings\/(\d+)\/packet$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.agendaPacket(mt));
});
route('GET', /^\/meetings\/(\d+)\/packet\.pdf$/, async (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  try {
    const bytes = await pdfGen.generatePacket(mt);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="packet-meeting-${mt.id}.pdf"`,
    });
    res.end(Buffer.from(bytes));
  } catch (e) {
    console.error('PDF generation error:', e);
    sendHtml(res, '<h1>500 — PDF generation failed</h1><p>' +
      String(e.message).replace(/</g, '&lt;') + '</p>', 500);
  }
});
route('GET', /^\/meetings\/(\d+)\/minutes$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, minutesView.minutesView(mt));
});
route('GET', /^\/topics\/?$/, (req, res) => sendHtml(res, pages.topicsList()));

// Legal (public) -------------------------------------------------------------
route('GET', /^\/terms\/?$/, (req, res) => sendHtml(res, legal.termsPage()));
route('GET', /^\/privacy\/?$/, (req, res) => sendHtml(res, legal.privacyPage()));

// Budget (public read; clerk manages via /admin routes below) ----------------
route('GET', /^\/budget\/?$/, (req, res, ctx) => sendHtml(res, budgetView.budgetList(ctx.user)));
route('GET', /^\/budget\/compare\/?$/, (req, res, ctx) => sendHtml(res, budgetView.budgetComparePage(ctx.query)));
route('GET', /^\/budget\/appropriations\/?$/, (req, res) => sendHtml(res, budgetView.appropriationReport()));
route('GET', /^\/budget\/accounts\/?$/, (req, res, ctx) => sendHtml(res, budgetView.tasRegister(ctx.query, ctx.user)));
route('GET', /^\/budget\/accounts\.csv$/, (req, res, ctx) => {
  sendText(res, feeds.tasCsv(repo.tas.all({ q: ctx.query.q || '' })),
    'text/csv; charset=utf-8', { filename: 'tas-register.csv' });
});
route('GET', /^\/budget\/appropriations\/(.+)$/, (req, res, ctx) => {
  const code = decodeURIComponent(ctx.params[0]);
  const detail = repo.budget.appropriationDetail(code);
  // Show the account page when a budget line uses the code OR it is catalogued.
  if (!detail.lines.length && !repo.tas.byTas(code)) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, budgetView.appropriationDetailPage(detail));
});
route('GET', /^\/budget\/(\d+)\/dashboard$/, (req, res, ctx) => {
  const b = repo.budget.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, budgetView.budgetDashboard(b));
});
route('GET', /^\/budget\/(\d+)\.csv$/, (req, res, ctx) => {
  const b = repo.budget.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  sendText(res, feeds.budgetCsv(b, repo.budget.lines(b.id)), 'text/csv; charset=utf-8',
    { filename: `budget-${b.fiscal_year.replace(/[^A-Za-z0-9-]+/g, '')}.csv` });
});
route('GET', /^\/budget\/lines\/(\d+)$/, (req, res, ctx) => {
  const line = repo.budget.lineFull(Number(ctx.params[0]));
  if (!line) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, budgetView.budgetLinePage(line, ctx.user));
});
route('GET', /^\/budget\/(\d+)$/, (req, res, ctx) => {
  const b = repo.budget.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, budgetView.budgetDetail(b, ctx.user));
});

// Policies (public reads published; drafts visible to clerk only) -----------
route('GET', /^\/policies\/?$/, (req, res, ctx) => sendHtml(res, policiesView.policiesList(ctx.user)));
route('GET', /^\/policies\/(\d+)$/, (req, res, ctx) => {
  const p = repo.policies.get(Number(ctx.params[0]));
  if (!p || (p.status === 'Draft' && !auth.hasRole(ctx.user, 'clerk'))) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, policiesView.policyDetail(p));
});
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
  sendHtml(res, pages.personDetail(p, ctx.user));
});
route('GET', /^\/bodies\/?$/, (req, res) => sendHtml(res, pages.bodiesList()));
route('GET', /^\/bodies\/(\d+)$/, (req, res, ctx) => {
  const b = repo.bodies.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.bodyDetail(b, ctx.query));
});

// Citizen application to serve on a board/commission (public form).
route('POST', /^\/bodies\/(\d+)\/apply$/, (req, res, ctx) => {
  const b = repo.bodies.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  const back = `/bodies/${b.id}?applied=1`;
  if (ctx.body.website) return redirect(res, back); // honeypot
  const name = String(ctx.body.name || '').trim().slice(0, 100);
  if (!name) return redirect(res, `/bodies/${b.id}`);
  if (publicFormThrottled(clientIp(req))) {
    return sendHtml(res, '<h1>429 — Too many submissions. Please try again later.</h1>', 429);
  }
  repo.applications.add({
    body_id: b.id, name,
    email: String(ctx.body.email || '').trim().slice(0, 200) || null,
    phone: String(ctx.body.phone || '').trim().slice(0, 40) || null,
    statement: String(ctx.body.statement || '').trim().slice(0, 4000) || null,
  });
  redirect(res, back);
});

// Application review (clerk): approving creates a membership nomination.
route('GET', /^\/admin\/applications\/?$/, (req, res) => sendHtml(res, admin.applicationsAdmin()));
route('POST', /^\/admin\/applications\/(\d+)\/decide$/, (req, res, ctx) => {
  const a = repo.applications.get(Number(ctx.params[0]));
  if (!a) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.decision === 'nominate') {
    const motionId = repo.memberMotions.nominate({
      action: 'seat', body_id: a.body_id,
      nominee_name: a.name, nominee_email: a.email,
      reason: a.statement ? `Citizen application: ${a.statement.slice(0, 400)}` : 'Citizen application',
      nominated_by: ctx.user ? ctx.user.id : null,
    });
    repo.applications.decide(a.id, { status: 'Nominated', motionId });
  } else {
    repo.applications.decide(a.id, { status: 'Declined' });
  }
  notify.applicationDecision(a.id);
  redirect(res, '/admin/applications');
});

// Admin ----------------------------------------------------------------------
route('GET', /^\/admin\/?$/, (req, res, ctx) => sendHtml(res, admin.adminHome(ctx.user)));

// Danger zone: wipe all domain data (ADMIN only; keeps users + settings).
route('POST', /^\/admin\/purge$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  repo.purgeDomainData();
  redirect(res, '/admin');
});

// Users & roles management (ADMIN only) --------------------------------------
route('GET', /^\/admin\/users\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  sendHtml(res, usersView.usersAdmin(ctx.user));
});
route('POST', /^\/admin\/users$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const b = ctx.body;
  if (b.email && !repo.users.byEmail(b.email)) {
    repo.users.create({ name: b.name, email: b.email, role: b.role });
  }
  redirect(res, '/admin/users');
});
route('POST', /^\/admin\/users\/(\d+)\/role$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const u = repo.users.get(Number(ctx.params[0]));
  if (!u) return sendHtml(res, pages.notFound(), 404);
  if (!ctx.user || ctx.user.id !== u.id) repo.users.setRole(u.id, ctx.body.role); // can't change own role
  redirect(res, '/admin/users');
});
route('POST', /^\/admin\/users\/(\d+)\/active$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const u = repo.users.get(Number(ctx.params[0]));
  if (!u) return sendHtml(res, pages.notFound(), 404);
  if (!ctx.user || ctx.user.id !== u.id) repo.users.setActive(u.id, String(ctx.body.active) === '1'); // can't disable self
  redirect(res, '/admin/users');
});

// Policies CRUD (clerk) ------------------------------------------------------
route('GET', /^\/admin\/policies\/?$/, (req, res) => sendHtml(res, policiesView.policiesAdmin()));
route('GET', /^\/admin\/policies\/new$/, (req, res) => sendHtml(res, policiesView.policyForm(null)));
route('POST', /^\/admin\/policies$/, (req, res, ctx) => {
  const b = ctx.body;
  if (!b.title) return sendHtml(res, policiesView.policyForm(null), 400);
  const id = repo.policies.insert({
    policy_number: b.policy_number || null, title: b.title, category: b.category || null,
    status: b.status || 'Draft', effective_date: b.effective_date || null,
    body_html: sanitizeHtml(b.body_html), matter_id: b.matter_id ? Number(b.matter_id) : null,
    author_id: ctx.user ? ctx.user.id : null,
  });
  redirect(res, `/policies/${id}`);
});
route('GET', /^\/admin\/policies\/(\d+)\/edit$/, (req, res, ctx) => {
  const p = repo.policies.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, policiesView.policyForm(p));
});
route('POST', /^\/admin\/policies\/(\d+)$/, (req, res, ctx) => {
  const p = repo.policies.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  if (!b.title) return sendHtml(res, policiesView.policyForm(p), 400);
  repo.policies.update(p.id, {
    policy_number: b.policy_number || null, title: b.title, category: b.category || null,
    status: b.status || 'Draft', effective_date: b.effective_date || null,
    body_html: sanitizeHtml(b.body_html), matter_id: b.matter_id ? Number(b.matter_id) : null,
  });
  redirect(res, `/policies/${p.id}`);
});
route('POST', /^\/admin\/policies\/(\d+)\/delete$/, (req, res, ctx) => {
  const p = repo.policies.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  repo.policies.remove(p.id);
  redirect(res, '/admin/policies');
});

// Edit a person / board member profile (clerk) -------------------------------
route('GET', /^\/admin\/people\/(\d+)\/edit$/, (req, res, ctx) => {
  const p = repo.people.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, admin.personForm(p));
});
route('POST', /^\/admin\/people\/(\d+)$/, (req, res, ctx) => {
  const p = repo.people.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  if (!b.full_name) return sendHtml(res, admin.personForm(p), 400);
  repo.people.update(p.id, {
    full_name: b.full_name, title: b.title || null, district: b.district || null,
    party: b.party || null, email: b.email || null, phone: b.phone || null,
    website: b.website || null, bio: b.bio || null, active: b.active ? 1 : 0,
  });
  redirect(res, `/people/${p.id}`);
});

// Governor offices & staff (clerk) -------------------------------------------
route('POST', /^\/admin\/people\/(\d+)\/office$/, (req, res, ctx) => {
  const p = repo.people.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  repo.people.setOffice(p.id, ctx.body.office_name);
  redirect(res, `/people/${p.id}`);
});
route('POST', /^\/admin\/people\/(\d+)\/staff$/, (req, res, ctx) => {
  const p = repo.people.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.name) {
    repo.people.addStaff({
      person_id: p.id, name: ctx.body.name, title: ctx.body.title,
      email: ctx.body.email, phone: ctx.body.phone,
    });
  }
  redirect(res, `/people/${p.id}`);
});
route('POST', /^\/admin\/office-staff\/(\d+)$/, (req, res, ctx) => {
  const s = repo.people.getStaff(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.name) {
    repo.people.updateStaff(s.id, {
      name: ctx.body.name, title: ctx.body.title, email: ctx.body.email, phone: ctx.body.phone,
    });
  }
  redirect(res, `/people/${s.person_id}`);
});
route('POST', /^\/admin\/office-staff\/(\d+)\/delete$/, (req, res, ctx) => {
  const s = repo.people.getStaff(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  repo.people.removeStaff(s.id);
  redirect(res, `/people/${s.person_id}`);
});

// Budget management (clerk) --------------------------------------------------
route('POST', /^\/admin\/budget$/, (req, res, ctx) => {
  const b = ctx.body;
  if (!b.fiscal_year) return redirect(res, '/budget');
  const id = repo.budget.create({ fiscal_year: b.fiscal_year, status: b.status, notes: b.notes });
  redirect(res, `/budget/${id}`);
});
route('POST', /^\/admin\/budget\/(\d+)$/, (req, res, ctx) => {
  const b = repo.budget.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  const f = ctx.body;
  if (f.fiscal_year) {
    repo.budget.update(b.id, {
      fiscal_year: f.fiscal_year, status: f.status, notes: f.notes,
      adopted_matter_id: f.adopted_matter_id ? Number(f.adopted_matter_id) : null,
    });
  }
  redirect(res, `/budget/${b.id}`);
});
route('POST', /^\/admin\/budget\/(\d+)\/delete$/, (req, res, ctx) => {
  const b = repo.budget.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  repo.budget.remove(b.id);
  redirect(res, '/budget');
});
route('POST', /^\/admin\/budget\/(\d+)\/lines$/, (req, res, ctx) => {
  const b = repo.budget.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.name) {
    repo.budget.addLine({
      budget_id: b.id, category: ctx.body.category, name: ctx.body.name,
      kind: ctx.body.kind, amount: ctx.body.amount,
      appropriation_code: ctx.body.appropriation_code, project_code: ctx.body.project_code,
    });
  }
  redirect(res, `/budget/${b.id}`);
});
route('POST', /^\/admin\/budget-lines\/(\d+)$/, (req, res, ctx) => {
  const l = repo.budget.getLine(Number(ctx.params[0]));
  if (!l) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.name) {
    repo.budget.updateLine(l.id, {
      category: ctx.body.category, name: ctx.body.name, kind: ctx.body.kind, amount: ctx.body.amount,
      appropriation_code: ctx.body.appropriation_code, project_code: ctx.body.project_code,
    });
  }
  redirect(res, `/budget/${l.budget_id}`);
});
route('POST', /^\/admin\/budget-lines\/(\d+)\/delete$/, (req, res, ctx) => {
  const l = repo.budget.getLine(Number(ctx.params[0]));
  if (!l) return sendHtml(res, pages.notFound(), 404);
  repo.budget.removeLine(l.id);
  redirect(res, `/budget/${l.budget_id}`);
});
// Amendments: signed adjustments to a line's adopted amount.
route('POST', /^\/admin\/budget-lines\/(\d+)\/amend$/, (req, res, ctx) => {
  const l = repo.budget.getLine(Number(ctx.params[0]));
  if (!l) return sendHtml(res, pages.notFound(), 404);
  const amount = Number(ctx.body.amount);
  if (Number.isFinite(amount) && amount !== 0) {
    repo.budget.addAmendment({
      budget_line_id: l.id, amount,
      matter_id: ctx.body.matter_id ? Number(ctx.body.matter_id) : null,
      note: ctx.body.note, author_id: ctx.user ? ctx.user.id : null,
    });
  }
  redirect(res, `/budget/lines/${l.id}`);
});
// Actuals ledger entries.
route('POST', /^\/admin\/budget-lines\/(\d+)\/tx$/, (req, res, ctx) => {
  const l = repo.budget.getLine(Number(ctx.params[0]));
  if (!l) return sendHtml(res, pages.notFound(), 404);
  const amount = Number(ctx.body.amount);
  if (Number.isFinite(amount) && /^\d{4}-\d{2}-\d{2}$/.test(ctx.body.tx_date || '')) {
    repo.budget.addTransaction({
      budget_line_id: l.id, tx_date: ctx.body.tx_date,
      description: ctx.body.description, amount,
    });
  }
  redirect(res, `/budget/lines/${l.id}`);
});
route('POST', /^\/admin\/budget-tx\/(\d+)\/delete$/, (req, res, ctx) => {
  const t = repo.budget.getTransaction(Number(ctx.params[0]));
  if (!t) return sendHtml(res, pages.notFound(), 404);
  repo.budget.removeTransaction(t.id);
  redirect(res, `/budget/lines/${t.budget_line_id}`);
});
// Bulk CSV loads for a budget (lines, then transactions from accounting).
route('POST', /^\/admin\/budget\/(\d+)\/import-lines$/, (req, res, ctx) => {
  const b = repo.budget.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  importer.importBudgetLines(b.id, ctx.body.csv || '');
  redirect(res, `/budget/${b.id}`);
});
route('POST', /^\/admin\/budget\/(\d+)\/import-tx$/, (req, res, ctx) => {
  const b = repo.budget.get(Number(ctx.params[0]));
  if (!b) return sendHtml(res, pages.notFound(), 404);
  importer.importBudgetTransactions(b.id, ctx.body.csv || '');
  redirect(res, `/budget/${b.id}`);
});
// TAS register import (chart-of-accounts source of truth).
route('POST', /^\/admin\/budget\/accounts\/import$/, (req, res, ctx) => {
  importer.importTasRegister(ctx.body.csv || '');
  redirect(res, '/budget/accounts');
});

// Roster import (CSV bulk "data populate" / direct-seat bootstrap) — ADMIN.
route('GET', /^\/admin\/import\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  sendHtml(res, govern.importPage());
});
route('POST', /^\/admin\/import$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const result = importer.importRoster(ctx.body.csv || '');
  sendHtml(res, govern.importPage({ result }));
});
// Legislative file (matter) import — historical record migration. ADMIN.
route('GET', /^\/admin\/import\/matters\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  sendHtml(res, govern.mattersImportPage());
});
route('POST', /^\/admin\/import\/matters$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const result = importer.importMatters(ctx.body.csv || '');
  sendHtml(res, govern.mattersImportPage({ result }));
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
route('POST', /^\/admin\/org\/import$/, (req, res, ctx) => {
  importer.importOrgUnits(ctx.body.csv || '');
  redirect(res, '/admin/org');
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
    seats: b.seats ? Number(b.seats) : null,
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
    seats: f.seats ? Number(f.seats) : null,
  });
  redirect(res, `/bodies/${b.id}`);
});
// Membership term dates (staff+ via /govern gate).
route('POST', /^\/govern\/members\/(\d+)\/term$/, (req, res, ctx) => {
  const m = repo.bodies.memberById(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const ok = (d) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (ok(ctx.body.start_date) && ok(ctx.body.end_date)) {
    repo.bodies.setMemberTerm(m.id, { start_date: ctx.body.start_date, end_date: ctx.body.end_date });
  }
  redirect(res, '/govern/members');
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
route('GET', /^\/admin\/branding\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  sendHtml(res, govern.brandingPage({ saved: ctx.query.saved === '1' }));
});
route('POST', /^\/admin\/branding$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  org.update(ctx.body);
  redirect(res, '/admin/branding?saved=1');
});

// Site announcement banner (clerk) -------------------------------------------
route('GET', /^\/admin\/announcement\/?$/, (req, res, ctx) =>
  sendHtml(res, govern.announcementPage({ saved: ctx.query.saved === '1' })));
route('POST', /^\/admin\/announcement$/, (req, res, ctx) => {
  announcement.set({ text: ctx.body.text, level: ctx.body.level, active: ctx.body.active === '1' });
  redirect(res, '/admin/announcement?saved=1');
});

// Integrations — Adobe Acrobat Sign OAuth connect flow (clerk) ----------------
function adobeRedirectUri(req) {
  const base = (process.env.APP_BASE_URL || '').replace(/\/+$/, '')
    || `${(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()}://${req.headers.host}`;
  return base + '/admin/integrations/adobe/callback';
}
route('GET', /^\/admin\/integrations\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  sendHtml(res, govern.integrationsPage({ status: ctx.query.status || '' }));
});
route('POST', /^\/admin\/integrations\/adobe$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  esign.saveCredentials({
    clientId: ctx.body.client_id, clientSecret: ctx.body.client_secret,
    region: ctx.body.region, scopes: ctx.body.scopes, webhookClientId: ctx.body.webhook_client_id,
  });
  redirect(res, '/admin/integrations?status=saved');
});
route('GET', /^\/admin\/integrations\/adobe\/connect$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const { db: sdb } = require('./src/db');
  const state = require('node:crypto').randomBytes(16).toString('hex');
  sdb.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('adobe.oauth_state', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(state);
  redirect(res, esign.authorizeUrl({ redirectUri: adobeRedirectUri(req), state }), 302);
});
route('GET', /^\/admin\/integrations\/adobe\/callback$/, async (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const { db: sdb } = require('./src/db');
  const row = sdb.prepare("SELECT value FROM settings WHERE key = 'adobe.oauth_state'").get();
  sdb.prepare("DELETE FROM settings WHERE key = 'adobe.oauth_state'").run();
  if (ctx.query.error || !ctx.query.code || !row || ctx.query.state !== row.value) {
    return redirect(res, '/admin/integrations?status=error');
  }
  try {
    await esign.exchangeCode({
      code: ctx.query.code, redirectUri: adobeRedirectUri(req),
      apiAccessPoint: ctx.query.api_access_point || '',
    });
    redirect(res, '/admin/integrations?status=connected');
  } catch (e) {
    console.error('adobe connect failed:', e.message);
    redirect(res, '/admin/integrations?status=error');
  }
});
route('POST', /^\/admin\/integrations\/adobe\/disconnect$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  esign.disconnect();
  redirect(res, '/admin/integrations?status=disconnected');
});

// Agenda template (admin) ----------------------------------------------------
route('GET', /^\/admin\/agenda-template\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'clerk')) return;
  sendHtml(res, admin.agendaTemplateAdmin(ctx.query.saved === '1'));
});
route('POST', /^\/admin\/agenda-template$/, (req, res, ctx) => {
  if (!need(ctx, res, 'clerk')) return;
  const lines = (ctx.body.template || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const items = lines.map((line) => {
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length === 1) return { section: '', title: parts[0], item_type: null };
    if (parts.length === 2) return { section: parts[0], title: parts[1], item_type: null };
    const rawType = parts[2];
    const item_type = repo.ITEM_TYPES.includes(rawType) ? rawType : null;
    return { section: parts[0], title: parts[1], item_type };
  });
  const { db: settingsDb } = require('./src/db');
  settingsDb.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('agenda.template', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(JSON.stringify(items));
  redirect(res, '/admin/agenda-template?saved=1');
});
route('POST', /^\/admin\/meetings\/(\d+)\/load-template$/, (req, res, ctx) => {
  if (!need(ctx, res, 'clerk')) return;
  const meetingId = Number(ctx.params[0]);
  const mt = repo.meetings.get(meetingId);
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  if (repo.meetings.items(meetingId).length > 0) return redirect(res, `/admin/meetings/${meetingId}/agenda`);
  const { db: settingsDb } = require('./src/db');
  const row = settingsDb.prepare("SELECT value FROM settings WHERE key = 'agenda.template'").get();
  if (row && row.value) {
    try {
      const items = JSON.parse(row.value);
      for (const item of items) {
        repo.meetings.addItem({
          meeting_id: meetingId, section: item.section || null,
          title: item.title, item_type: item.item_type || null,
        });
      }
    } catch (_) { /* invalid template JSON — ignore */ }
  }
  redirect(res, `/admin/meetings/${meetingId}/agenda`);
});
// Next file-number preview (JSON, for the new-matter form)
route('GET', /^\/admin\/matters\/next-number$/, (req, res, ctx) => {
  if (!need(ctx, res, 'clerk')) return;
  sendJson(res, { number: repo.matters.nextFileNumber() });
});

// Editable legal pages — Terms & Privacy (admin) -----------------------------
function blankHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&amp;|\s/g, '').length === 0;
}
route('GET', /^\/admin\/legal\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  sendHtml(res, legal.legalForm({ saved: ctx.query.saved === '1' }));
});
route('POST', /^\/admin\/legal$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  if (ctx.body.terms_html !== undefined) {
    const t = sanitizeHtml(ctx.body.terms_html);
    legal.setContent('terms', blankHtml(t) ? '' : t);
  }
  if (ctx.body.privacy_html !== undefined) {
    const p = sanitizeHtml(ctx.body.privacy_html);
    legal.setContent('privacy', blankHtml(p) ? '' : p);
  }
  redirect(res, '/admin/legal?saved=1');
});

route('GET', /^\/admin\/footer\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  sendHtml(res, legal.footerForm({ saved: ctx.query.saved === '1' }));
});
route('POST', /^\/admin\/footer$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const h = sanitizeHtml(ctx.body.footer_html || '');
  legal.setFooterHtml(blankHtml(h) ? '' : h);
  redirect(res, '/admin/footer?saved=1');
});

// Document form templates (per matter type) — clerk.
route('GET', /^\/admin\/doc-templates\/?$/, (req, res, ctx) => {
  sendHtml(res, admin.docTemplatesAdmin(ctx.query.type, { saved: ctx.query.saved === '1' }));
});
route('POST', /^\/admin\/doc-templates$/, (req, res, ctx) => {
  const type = repo.MATTER_TYPES.includes(ctx.body.type) ? ctx.body.type : null;
  if (!type) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.reset === '1') {
    docTemplates.setTemplate(type, '');
  } else {
    const h = sanitizeHtml(ctx.body.template_html || '');
    docTemplates.setTemplate(type, blankHtml(h) ? '' : h);
  }
  redirect(res, `/admin/doc-templates?type=${encodeURIComponent(type)}&saved=1`);
});

// Legislation text editor — body_html with versioning, prefilled from the
// type's form template when the file has no text yet.
route('GET', /^\/admin\/matters\/(\d+)\/text$/, (req, res, ctx) => {
  const m = repo.matters.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, admin.matterTextForm(m));
});
route('POST', /^\/admin\/matters\/(\d+)\/text$/, (req, res, ctx) => {
  const m = repo.matters.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const h = sanitizeHtml(ctx.body.body_html || '');
  const next = blankHtml(h) ? null : h;
  repo.matters.snapshotIfChanged(m.id, { body_html: next });
  repo.matters.setBodyHtml(m.id, next);
  redirect(res, `/legislation/${encodeURIComponent(m.file_number)}`);
});

// Public comment moderation (clerk).
route('GET', /^\/admin\/comments\/?$/, (req, res) => sendHtml(res, admin.commentsAdmin()));
route('POST', /^\/admin\/comments\/(\d+)\/status$/, (req, res, ctx) => {
  const c = repo.comments.get(Number(ctx.params[0]));
  if (!c) return sendHtml(res, pages.notFound(), 404);
  repo.comments.setStatus(c.id, ctx.body.status);
  redirect(res, '/admin/comments');
});

// Email notifications status + outbox + test send (admin).
route('GET', /^\/admin\/mail\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  sendHtml(res, admin.mailAdmin({ sent: ctx.query.sent === '1' }));
});
route('POST', /^\/admin\/mail\/test$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const to = String(ctx.body.to || '').trim();
  if (to && smtp.isConfigured()) {
    notify.queue(to, 'Test message', 'This is a test of the notification system. If you are reading this, delivery works.');
    notify.processOutbox().catch(() => {});
  }
  redirect(res, '/admin/mail?sent=1');
});

// Citizen proposal review (clerk): accept → create a Draft file from the text.
route('GET', /^\/admin\/proposals\/?$/, (req, res) => sendHtml(res, proposalsView.proposalsAdmin()));
route('POST', /^\/admin\/proposals\/(\d+)\/decide$/, (req, res, ctx) => {
  const p = repo.proposals.get(Number(ctx.params[0]));
  if (!p) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.decision === 'accept') {
    const { id, file_number } = repo.matters.insertNumbered({
      type: 'Communication', title: p.title, status: 'Draft',
      summary: `Citizen proposal by ${p.name}`, full_text: p.body,
    });
    repo.proposals.decide(p.id, { status: 'Accepted', matterId: id });
    repo.matters.addHistory({
      matter_id: id, action_date: require('./src/util').todayISO(),
      action: 'Introduced from citizen proposal', notes: `Proposal #${p.id}`,
    });
    void file_number;
  } else {
    repo.proposals.decide(p.id, { status: 'Declined' });
  }
  notify.proposalDecision(p.id);
  redirect(res, '/admin/proposals');
});
// --- Procurement management (clerk) -----------------------------------------
route('GET', /^\/admin\/procurement\/?$/, (req, res) => sendHtml(res, procurementView.procurementAdmin()));
route('GET', /^\/admin\/procurement\.csv$/, (req, res) => {
  sendText(res, feeds.solicitationsCsv(repo.procurement.list({ includeAll: true })),
    'text/csv; charset=utf-8', { filename: 'solicitations.csv' });
});
route('GET', /^\/admin\/procurement\/(\d+)\/bids\.csv$/, (req, res, ctx) => {
  const s = repo.procurement.get(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  sendText(res, feeds.bidsCsv(s, repo.procurement.bids(s.id)),
    'text/csv; charset=utf-8', { filename: `bids-${s.number}.csv` });
});
route('POST', /^\/admin\/procurement$/, (req, res, ctx) => {
  const b = ctx.body;
  if (!b.title) return redirect(res, '/admin/procurement');
  const { id } = repo.procurement.create({
    kind: b.kind, title: String(b.title).slice(0, 200), body_html: sanitizeHtml(b.body_html || ''),
    status: b.status, open_date: b.open_date || null, close_date: b.close_date || null,
    budget_line_id: b.budget_line_id ? Number(b.budget_line_id) : null,
  });
  redirect(res, `/admin/procurement/${id}`);
});
route('GET', /^\/admin\/procurement\/(\d+)$/, (req, res, ctx) => {
  const s = repo.procurement.get(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, procurementView.solicitationManage(s));
});
route('POST', /^\/admin\/procurement\/(\d+)$/, (req, res, ctx) => {
  const s = repo.procurement.get(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  repo.procurement.update(s.id, {
    kind: b.kind, title: String(b.title || s.title).slice(0, 200), body_html: sanitizeHtml(b.body_html || ''),
    status: b.status, open_date: b.open_date || null, close_date: b.close_date || null,
    budget_line_id: b.budget_line_id ? Number(b.budget_line_id) : null,
  });
  redirect(res, `/admin/procurement/${s.id}`);
});
route('POST', /^\/admin\/procurement\/(\d+)\/questions\/(\d+)\/answer$/, (req, res, ctx) => {
  const s = repo.procurement.get(Number(ctx.params[0]));
  const q = repo.procurement.getQuestion(Number(ctx.params[1]));
  if (!s || !q || q.solicitation_id !== s.id) return sendHtml(res, pages.notFound(), 404);
  repo.procurement.answerQuestion(q.id, String(ctx.body.answer || '').trim().slice(0, 4000));
  redirect(res, `/admin/procurement/${s.id}`);
});
route('POST', /^\/admin\/procurement\/(\d+)\/award$/, (req, res, ctx) => {
  const s = repo.procurement.get(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  let vendorId = ctx.body.vendor_id ? Number(ctx.body.vendor_id) : null;
  let amount = ctx.body.amount;
  // Award straight from a received bid: match/create the vendor, take its amount.
  if (ctx.body.bid_id) {
    const bid = repo.procurement.bids(s.id).find((b) => b.id === Number(ctx.body.bid_id));
    if (bid) { vendorId = repo.vendors.findOrCreate(bid.vendor_name, bid.email); amount = bid.amount; }
  }
  if (!vendorId) return redirect(res, `/admin/procurement/${s.id}`);
  // Preserve any contract already linked so re-recording an award neither
  // clears the link nor spawns a duplicate Contract.
  let matterId = s.matter_id || null;
  if (ctx.body.make_contract === '1' && !s.matter_id) {
    const vendor = repo.vendors.get(vendorId);
    const { id } = repo.matters.insertNumbered({
      type: 'Contract', title: `${s.title} — award to ${vendor ? vendor.name : 'vendor'}`,
      status: 'Draft', summary: `Contract award for solicitation ${s.number}`,
    });
    matterId = id;
    if (amount != null && amount !== '') {
      repo.matters.setFiscal(id, { fiscal_impact: amount, budget_line_id: s.budget_line_id || null });
    }
    repo.matters.addHistory({
      matter_id: id, action_date: require('./src/util').todayISO(),
      action: `Contract awarded from ${s.number}`,
    });
  }
  repo.procurement.award(s.id, { vendorId, amount, matterId });
  notify.procurementAward(s.id);
  redirect(res, `/admin/procurement/${s.id}`);
});
route('GET', /^\/admin\/vendors\/?$/, (req, res) => sendHtml(res, procurementView.vendorsAdmin()));
route('POST', /^\/admin\/vendors\/(\d+)\/status$/, (req, res, ctx) => {
  const v = repo.vendors.get(Number(ctx.params[0]));
  if (!v) return sendHtml(res, pages.notFound(), 404);
  repo.vendors.setStatus(v.id, ctx.body.status);
  redirect(res, '/admin/vendors');
});

// --- Drafting workbench (clerk): structured legislative drafting -------------
function matterOr404(res, id) {
  const m = repo.matters.get(Number(id));
  if (!m) { sendHtml(res, pages.notFound(), 404); return null; }
  return m;
}
route('GET', /^\/admin\/legislation\/(\d+)\/draft$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  sendHtml(res, draftingView.draftPage(m, { saved: ctx.query.saved === '1' }));
});
route('POST', /^\/admin\/legislation\/(\d+)\/draft$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  const text = String(ctx.body.full_text || '');
  // Archive the outgoing text as a numbered version when it actually changed.
  if (ctx.body.snapshot === '1') repo.matters.snapshotIfChanged(m.id, { full_text: text, note: 'Drafting revision' });
  repo.matters.update(m.id, Object.assign({}, m, { full_text: text }));
  redirect(res, `/admin/legislation/${m.id}/draft?saved=1`);
});
route('GET', /^\/admin\/legislation\/(\d+)\/code$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  sendHtml(res, draftingView.codePage(m, { saved: ctx.query.saved === '1' }));
});
route('POST', /^\/admin\/legislation\/(\d+)\/code$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  repo.code.addAmendment(m.id, {
    op: ctx.body.op, citation: ctx.body.citation, heading: ctx.body.heading,
    new_text: ctx.body.new_text,
  });
  redirect(res, `/admin/legislation/${m.id}/code?saved=1`);
});
route('POST', /^\/admin\/legislation\/(\d+)\/code\/(\d+)\/delete$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  const a = repo.code.amendment(Number(ctx.params[1]));
  if (a && a.matter_id === m.id && !a.applied_at) repo.code.removeAmendment(a.id);
  redirect(res, `/admin/legislation/${m.id}/code`);
});
route('GET', /^\/admin\/legislation\/(\d+)\/compare$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  const mode = ['law', 'versions', 'impact'].includes(ctx.query.mode) ? ctx.query.mode : 'law';
  sendHtml(res, draftingView.comparePage(m, mode, ctx.query));
});
// Amendment-impact text is POSTed: a full draft would overflow a GET request
// line and would otherwise be recorded in history and access logs.
route('POST', /^\/admin\/legislation\/(\d+)\/compare\/impact$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  sendHtml(res, draftingView.comparePage(m, 'impact', { proposed: ctx.body.proposed || '' }));
});
// Codify an enacted measure: apply its instructions to the Board Code.
route('POST', /^\/admin\/legislation\/(\d+)\/codify$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  amendEngine.codify(m.id, { effectiveDate: ctx.body.effective_date || null });
  redirect(res, `/admin/legislation/${m.id}/code?saved=1`);
});

// --- The Board Code (public) -------------------------------------------------
route('GET', /^\/code\/?$/, (req, res) => sendHtml(res, draftingView.codeIndex()));
route('GET', /^\/code\/(.+)$/, (req, res, ctx) => {
  const s = repo.code.byCitation(decodeURIComponent(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, draftingView.codeSection(s));
});

// --- Written consents (clerk): board action without a meeting ----------------
route('GET', /^\/admin\/consents\/?$/, (req, res) => sendHtml(res, consentsView.consentsAdmin()));
route('POST', /^\/admin\/consents$/, (req, res, ctx) => {
  const b = ctx.body;
  if (!b.title || !b.body_id) return redirect(res, '/admin/consents');
  const { id } = repo.consents.create({
    title: String(b.title).slice(0, 200),
    body_html: sanitizeHtml(b.body_html || ''),
    body_id: Number(b.body_id) || null,
  });
  redirect(res, `/admin/consents/${id}`);
});
route('GET', /^\/admin\/consents\/(\d+)$/, (req, res, ctx) => {
  const c = repo.consents.get(Number(ctx.params[0]));
  if (!c) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, consentsView.consentDetail(c, repo.consents.signers(c.id)));
});
// Circulate: send for e-signature via the provider when configured, otherwise
// leave Circulating for in-app signing.
route('POST', /^\/admin\/consents\/(\d+)\/circulate$/, async (req, res, ctx) => {
  const c = repo.consents.get(Number(ctx.params[0]));
  if (!c) return sendHtml(res, pages.notFound(), 404);
  if (c.status !== 'Draft') return redirect(res, `/admin/consents/${c.id}`);
  const signers = repo.consents.signers(c.id);
  repo.consents.setStatus(c.id, 'Circulating');
  if (esign.isConfigured()) {
    try {
      const pdfBytes = await pdfGen.generateConsent(c, signers);
      const sent = await esign.sendForSignature({ name: `${c.number} — ${c.title}`, pdfBytes, signers });
      repo.consents.setEsign(c.id, { provider: sent.provider, agreementId: sent.agreementId, status: 'OUT_FOR_SIGNATURE' });
    } catch (e) {
      console.error('esign send failed:', e.message); // fall back to in-app signing
    }
  }
  redirect(res, `/admin/consents/${c.id}`);
});
route('POST', /^\/admin\/consents\/(\d+)\/signers\/(\d+)\/sign$/, (req, res, ctx) => {
  const c = repo.consents.get(Number(ctx.params[0]));
  if (!c) return sendHtml(res, pages.notFound(), 404);
  if (c.status === 'Circulating') repo.consents.setSignerStatus(Number(ctx.params[1]), 'Signed');
  redirect(res, `/admin/consents/${c.id}`);
});
route('POST', /^\/admin\/consents\/(\d+)\/signers\/(\d+)\/decline$/, (req, res, ctx) => {
  const c = repo.consents.get(Number(ctx.params[0]));
  if (!c) return sendHtml(res, pages.notFound(), 404);
  if (c.status === 'Circulating') repo.consents.setSignerStatus(Number(ctx.params[1]), 'Declined');
  redirect(res, `/admin/consents/${c.id}`);
});
route('POST', /^\/admin\/consents\/(\d+)\/sync$/, async (req, res, ctx) => {
  const c = repo.consents.get(Number(ctx.params[0]));
  if (!c) return sendHtml(res, pages.notFound(), 404);
  if (c.esign_agreement_id && esign.isConfigured()) {
    try { repo.consents.syncFromMembers(c.id, await esign.agreementMembers(c.esign_agreement_id)); }
    catch (e) { console.error('esign sync failed:', e.message); }
  }
  redirect(res, `/admin/consents/${c.id}`);
});
route('POST', /^\/admin\/consents\/(\d+)\/withdraw$/, (req, res, ctx) => {
  const c = repo.consents.get(Number(ctx.params[0]));
  if (!c) return sendHtml(res, pages.notFound(), 404);
  if (c.status === 'Draft' || c.status === 'Circulating') repo.consents.setStatus(c.id, 'Withdrawn');
  redirect(res, `/admin/consents/${c.id}`);
});

// Implementation progress update (clerk).
route('POST', /^\/admin\/matters\/(\d+)\/implementation$/, (req, res, ctx) => {
  const m = repo.matters.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  repo.implementation.add(m.id, ctx.body.progress, ctx.body.note);
  redirect(res, `/admin/matters/${m.id}/edit`);
});

// Audit log viewer (admin).
route('GET', /^\/admin\/audit\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  sendHtml(res, admin.auditAdmin());
});

// Database backup download (admin): a fresh consistent copy via VACUUM INTO.
route('GET', /^\/admin\/backup$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  try {
    const file = backup.runBackup();
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error('Backup download failed:', e);
    sendHtml(res, '<h1>Backup failed</h1>', 500);
  }
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
  const { id, file_number: fileNumber } = repo.matters.insertNumbered({
    type: b.type, title: b.title,
    status: b.status || 'Draft', body_id: b.body_id || null,
    intro_date: b.intro_date || null, summary: b.summary || null, full_text: b.full_text || null,
  });
  applySponsors(id, b.sponsor_id);
  repo.topics.setForMatter(id, parseTopics(b.topics));
  repo.matters.setFiscal(id, {
    fiscal_impact: b.fiscal_impact, budget_line_id: b.budget_line_id ? Number(b.budget_line_id) : null,
    fiscal_recurring: b.fiscal_recurring === '1', fiscal_note: b.fiscal_note,
  });
  repo.matters.setAmendsPolicy(id, b.amends_policy_id ? Number(b.amends_policy_id) : null);
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
  // Archive the outgoing text as a numbered version when the edit changes it.
  repo.matters.snapshotIfChanged(id, { full_text: b.full_text || null });
  repo.matters.update(id, {
    type: b.type, title: b.title, status: b.status, body_id: b.body_id || null,
    intro_date: b.intro_date || null, final_date: b.final_date || null,
    summary: b.summary || null, full_text: b.full_text || null,
  });
  repo.matters.clearSponsors(id);
  applySponsors(id, b.sponsor_id);
  repo.topics.setForMatter(id, parseTopics(b.topics));
  repo.matters.setFiscal(id, {
    fiscal_impact: b.fiscal_impact, budget_line_id: b.budget_line_id ? Number(b.budget_line_id) : null,
    fiscal_recurring: b.fiscal_recurring === '1', fiscal_note: b.fiscal_note,
  });
  repo.matters.setAmendsPolicy(id, b.amends_policy_id ? Number(b.amends_policy_id) : null);
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
  // One assignee select per template step, in order; blank = any clerk.
  const assigneeIds = asArray(ctx.body.assignee_id).map((v) => (v ? Number(v) : null));
  repo.workflow.start(id, assigneeIds);
  repo.matters.addHistory({
    matter_id: id, action_date: require('./src/util').todayISO(), body_id: m.body_id || null,
    action: 'Introduced to approval route',
  });
  const first = repo.workflow.current(id);
  if (first) notify.approvalRouted(first.id);
  redirect(res, `/admin/matters/${id}/edit`);
});

// Who may act on a routed step: the user it's routed to, any clerk when the
// step is unassigned, and admins (override).
function canActOnStep(user, step) {
  if (!user) return false;
  if (auth.hasRole(user, 'admin')) return true;
  if (step.assignee_id) return step.assignee_id === user.id;
  return auth.hasRole(user, 'clerk');
}

function actOnStep(req, res, ctx, { backTo }) {
  const step = repo.workflow.get(Number(ctx.params[0]));
  if (!step) return sendHtml(res, pages.notFound(), 404);
  if (!canActOnStep(ctx.user, step)) return sendHtml(res, forbidden(), 403);
  const status = ['Approved', 'Returned', 'Skipped'].includes(ctx.body.status) ? ctx.body.status : 'Approved';
  repo.workflow.act(step.id, { status, userId: ctx.user ? ctx.user.id : null, notes: ctx.body.notes });
  repo.matters.addHistory({
    matter_id: step.matter_id, action_date: require('./src/util').todayISO(),
    action: `${step.name}: ${status}`,
    result: status === 'Approved' ? 'Pass' : (status === 'Returned' ? 'Fail' : null),
    notes: ctx.body.notes || null,
  });
  // Advancing hands the file to the next step's assignee — let them know.
  if (status === 'Approved' || status === 'Skipped') {
    const next = repo.workflow.current(step.matter_id);
    if (next) notify.approvalRouted(next.id);
  }
  redirect(res, backTo === 'inbox' ? '/approvals' : `/admin/matters/${step.matter_id}/edit`);
}

route('POST', /^\/admin\/workflow-steps\/(\d+)\/act$/, (req, res, ctx) => actOnStep(req, res, ctx, { backTo: 'admin' }));

// Approvals inbox — steps routed to the signed-in user (member+; assignees
// may be staff or members who cannot reach the clerk-gated /admin area).
route('GET', /^\/approvals\/?$/, (req, res, ctx) => {
  if (!ctx.user) return redirect(res, '/login?next=%2Fapprovals');
  if (!need(ctx, res, 'member')) return;
  sendHtml(res, approvalsView.approvalsPage(ctx.user));
});
route('POST', /^\/approvals\/steps\/(\d+)\/act$/, (req, res, ctx) => {
  if (!ctx.user) return redirect(res, '/login?next=%2Fapprovals');
  actOnStep(req, res, ctx, { backTo: 'inbox' });
});

route('POST', /^\/admin\/matters\/(\d+)\/attachments$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const m = repo.matters.get(id);
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const file = (ctx.files || []).find((f) => f.field === 'file' && f.filename);
  if (file) {
    const saved = upload.saveUpload(`matter-${id}`, file);
    if (!saved.error) {
      repo.matters.addAttachment({
        matter_id: id, name: ctx.body.name || saved.name, note: ctx.body.note,
        file_path: saved.rel, size: saved.size, content_type: saved.contentType,
      });
    }
  } else if (ctx.body.name) {
    repo.matters.addAttachment({ matter_id: id, name: ctx.body.name, url: ctx.body.url, note: ctx.body.note });
  }
  redirect(res, `/admin/matters/${id}/edit`);
});
route('POST', /^\/admin\/attachments\/(\d+)\/delete$/, (req, res, ctx) => {
  const a = repo.matters.getAttachment(Number(ctx.params[0]));
  if (!a) return sendHtml(res, pages.notFound(), 404);
  if (a.file_path) upload.removeUpload(a.file_path);
  repo.matters.removeAttachment(a.id);
  redirect(res, `/admin/matters/${a.matter_id}/edit`);
});

// Public download of uploaded attachment files (attachments are public record).
route('GET', /^\/files\/(\d+)$/, (req, res, ctx) => {
  const a = repo.matters.getAttachment(Number(ctx.params[0]));
  if (!a || !a.file_path) return sendHtml(res, pages.notFound(), 404);
  const abs = upload.uploadPath(a.file_path);
  if (!abs) return sendHtml(res, pages.notFound(), 404);
  const inline = /^(application\/pdf|image\/|text\/plain)/.test(a.content_type || '');
  const ext = path.extname(a.file_path);
  let fname = String(a.name || 'file').replace(/["\r\n]/g, '');
  if (ext && !fname.toLowerCase().endsWith(ext.toLowerCase())) fname += ext;
  res.writeHead(200, {
    'Content-Type': a.content_type || 'application/octet-stream',
    'Content-Length': fs.statSync(abs).size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fname}"`,
  });
  fs.createReadStream(abs).pipe(res);
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
route('GET', /^\/admin\/meetings\/(\d+)\/edit$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, admin.meetingForm(mt));
});
route('POST', /^\/admin\/meetings\/(\d+)$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  if (!b.body_id || !b.meeting_date) return sendHtml(res, admin.meetingForm(mt), 400);
  repo.meetings.update(mt.id, {
    body_id: Number(b.body_id), meeting_date: b.meeting_date, meeting_time: b.meeting_time,
    location: b.location, status: b.status, agenda_url: b.agenda_url, video_url: b.video_url, notes: b.notes,
  });
  redirect(res, `/admin/meetings/${mt.id}/agenda`);
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
  const matterId = b.matter_id ? Number(b.matter_id) : null;
  repo.meetings.addItem({
    meeting_id: id, matter_id: matterId,
    agenda_number: b.agenda_number, section: b.section, title: b.title,
    item_type: b.item_type || null,
    requires_vote: b.requires_vote === '1' ? 1 : undefined,
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

route('POST', /^\/admin\/agenda-items\/(\d+)\/toggle-vote$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendHtml(res, pages.notFound(), 404);
  repo.meetings.setRequiresVote(item.id, item.requires_vote ? 0 : 1);
  redirect(res, `/admin/meetings/${item.meeting_id}/agenda`);
});

route('POST', /^\/admin\/agenda-items\/(\d+)\/votes$/, (req, res, ctx) => {
  const itemId = Number(ctx.params[0]);
  const item = repo.meetings.getItem(itemId);
  if (!item) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  repo.meetings.setItemResult(itemId, b.action, b.result);
  repo.meetings.setMotion(itemId, {
    mover_id: b.mover_id ? Number(b.mover_id) : null,
    seconder_id: b.seconder_id ? Number(b.seconder_id) : null,
    motion_text: b.motion_text || null,
    vote_threshold: b.vote_threshold || 'majority',
  });
  repo.votes.clearForItem(itemId);
  for (const key of Object.keys(b)) {
    const m = key.match(/^vote_(\d+)$/);
    if (m && b[key]) repo.votes.record(itemId, Number(m[1]), b[key]);
  }
  redirect(res, `/admin/meetings/${item.meeting_id}/agenda`);
});
route('POST', /^\/admin\/agenda-items\/(\d+)\/delete$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendHtml(res, pages.notFound(), 404);
  repo.meetings.removeItem(item.id);
  live.pushUpdate(item.meeting_id);
  redirect(res, `/admin/meetings/${item.meeting_id}/agenda`);
});

// Reports / word processor (clerk) -------------------------------------------
route('GET', /^\/reports\/(\d+)$/, (req, res, ctx) => {
  const r = repo.reports.get(Number(ctx.params[0]));
  if (!r) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, reportsView.reportView(r));
});
route('POST', /^\/admin\/matters\/(\d+)\/reports\/draft$/, (req, res, ctx) => {
  const m = repo.matters.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const template = [
    '<h2>Background</h2><p></p>',
    '<h2>Analysis</h2><p></p>',
    '<h2>Fiscal Impact</h2><p>None anticipated.</p>',
    '<h2>Recommendation</h2><p></p>',
  ].join('\n');
  const id = repo.reports.insert({
    matter_id: m.id,
    title: `Staff Report — ${m.file_number}`,
    kind: 'Staff Report',
    body_html: template,
    author_id: ctx.user ? ctx.user.id : null,
  });
  redirect(res, `/admin/reports/${id}/edit`);
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
  const { id, file_number: fileNumber } = repo.matters.insertNumbered({
    type: b.type, title: b.title, status: 'Draft',
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
  const threshold = item.vote_threshold || 'majority';
  const yea = t.Yea || 0;
  const nay = t.Nay || 0;
  let passes;
  if (threshold === 'two_thirds') {
    const cast = yea + nay;
    passes = cast > 0 && yea / cast >= 2 / 3;
  } else if (threshold === 'majority_full') {
    const seatCount = repo.bodies.members(item.body_id).length;
    passes = yea > Math.floor(seatCount / 2);
  } else {
    passes = yea > nay;
  }
  const result = passes ? 'Pass' : 'Fail';
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
    vote_threshold: b.vote_threshold || undefined,
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

// Finer-grained guard for routes that need more than the path-prefix gate
// (e.g. system-admin features under the clerk-gated /admin area). Returns false
// and writes a 403 when the user lacks the role.
function need(ctx, res, role) {
  if (auth.hasRole(ctx.user, role)) return true;
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

// --- Server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  securityHeaders(req, res);

  // Static assets
  if (pathname === '/styles.css' || pathname.startsWith('/assets/') || pathname === '/favicon.ico') {
    return serveStatic(req, res, pathname === '/styles.css' ? '/styles.css' : pathname);
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
        return sendHtml(res, '<h1>500 — Internal error</h1><pre>' +
          String(err.message).replace(/</g, '&lt;') + '</pre>', 500);
      }
    }
  }

  // Fallbacks
  if (pathname.startsWith('/api/')) return sendJson(res, { error: 'Not found' }, 404);
  sendHtml(res, pages.notFound(), 404);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Legislative Docket Manager running at http://localhost:${PORT}`);
  console.log(`  Public portal : http://localhost:${PORT}/`);
  console.log(`  Admin / clerk : http://localhost:${PORT}/admin`);
  console.log(`  JSON Web API  : http://localhost:${PORT}/api/v1`);
});

module.exports = server;
