'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { init } = require('./src/db');
const repo = require('./src/repo');
const pages = require('./src/views/pages');
const admin = require('./src/views/admin');
const queueView = require('./src/views/queue');
const api = require('./src/api');
const feeds = require('./src/exports');
const auth = require('./src/auth');
const visibility = require('./src/visibility');
const itemReportView = require('./src/views/itemreport');
const universaldoc = require('./src/universaldoc');
const live = require('./src/live');
const liveViews = require('./src/views/live');
const displayViews = require('./src/views/display');
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
const documents = require('./src/documents');
const org = require('./src/org');
const backup = require('./src/backup');
const upload = require('./src/upload');
const notify = require('./src/notify');
const smtp = require('./src/smtp');
const alerts = require('./src/alerts');
const approvalsView = require('./src/views/approvals');
const procurementView = require('./src/views/procurement');
const consentsView = require('./src/views/consents');
const esign = require('./src/esign');
const announcement = require('./src/announcement');
const draftingView = require('./src/views/drafting');
const amendEngine = require('./src/amend');
const docTemplates = require('./src/doc-templates');
const { sameOrigin, safeUrl } = require('./src/security');
const { setUser, forbidden } = require('./src/views/layout');
const { sanitizeHtml } = require('./src/sanitize');
const {
  sendHtml, sendJson, redirect, sendText, baseUrl, parseBody, parseQuery, asArray, todayISO,
} = require('./src/util');
const kernel = require('./src/http/kernel');
const { need, clientIp } = kernel;

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
const mimetype = require('./src/mimetype');

// --- Route table -------------------------------------------------------------
// Each route: [method, RegExp, handler(req,res,{params,query,body})]
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

/**
 * Fetch a record and stop the request unless this viewer may read it.
 *
 * Returns the record, or null once it has written the response — so every call
 * site reads `const m = visible(...); if (!m) return;` and cannot accidentally
 * carry on with a record it was not allowed to have.
 *
 * 404, not 403, and the same 404 a missing record gets. A 403 would confirm
 * that the file exists and that somebody is working on it, which for a private
 * company's board is itself the disclosure we are closing.
 */
function visible(res, ctx, record, predicate) {
  if (record && predicate(ctx.user, record)) return record;
  sendHtml(res, pages.notFound(), 404);
  return null;
}

// --- Health check -----------------------------------------------------------
// Public, dependency-free liveness/readiness probe for container platforms and
// uptime monitors. Verifies the database responds.
route('GET', /^\/healthz$/, (req, res) => {
  try {
    repo.stats();
    // Which renderer the documents are actually coming out of.
    //
    // The browser falls back to the drawn documents on its own, by design, so
    // that a container without it still prints the meeting. The cost of that
    // is a failure nobody can see: the packet looks exactly as it did before,
    // and the only tell is the Producer string inside a PDF. This is where an
    // operator can read it instead.
    sendJson(res, {
      status: 'ok',
      time: new Date().toISOString(),
      render: require('./src/render').status(),
    });
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
route('GET', /^\/$/, (req, res, ctx) => sendHtml(res, pages.dashboard(ctx.user)));
route('GET', /^\/docket\/?$/, (req, res, ctx) => sendHtml(res, pages.docket(ctx.user)));
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
    publicOnly: !visibility.isInsider(ctx.user),
  });
  sendText(res, feeds.mattersCsv(rows), 'text/csv; charset=utf-8', { filename: 'legislation.csv' });
});
route('GET', /^\/legislation\.rss$/, (req, res, ctx) => {
  const rows = repo.matters
    .search({ limit: 50, publicOnly: !visibility.isInsider(ctx.user) })
    .filter((m) => m.intro_date);
  sendText(res, feeds.legislationRss(rows, baseUrl(req)), 'application/rss+xml; charset=utf-8');
});
route('GET', /^\/calendar\.ics$/, (req, res, ctx) => {
  const rows = repo.meetings.all({ publicOnly: !visibility.isInsider(ctx.user) });
  sendText(res, feeds.icalCalendar(rows, baseUrl(req)), 'text/calendar; charset=utf-8',
    { filename: 'meetings.ics' });
});

// Per-file activity feed (RSS) — must be registered before the greedy route.
route('GET', /^\/legislation\/(.+)\.rss$/, (req, res, ctx) => {
  const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
  if (!visibility.canSeeMatter(ctx.user, m)) return sendJson(res, { error: 'Not found' }, 404);
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
  const m = visible(res, ctx, repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0])),
    visibility.canSeeMatter);
  if (!m) return;
  if (!m.amends_policy_id) return sendHtml(res, pages.notFound(), 404);
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
  const m = visible(res, ctx, repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0])),
    visibility.canSeeMatter);
  if (!m) return;
  sendHtml(res, pages.matterComparePage(m, ctx.query));
});
// Archived text version — must be registered before the greedy matter route.
route('GET', /^\/legislation\/(.+)\/v\/(\d+)$/, (req, res, ctx) => {
  const m = visible(res, ctx, repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0])),
    visibility.canSeeMatter);
  if (!m) return;
  const ver = repo.matters.getVersion(m.id, Number(ctx.params[1]));
  if (!ver) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, pages.matterVersionPage(m, ver));
});
// --- Official outputs --------------------------------------------------------
// The five documents a docket produces. All are public: an ordinance, the
// redline showing what it changes, and the summary published as legal notice
// are the record, and the board letter and approval log are what a records
// request asks for. Anything not yet public is gated by the matter itself.
// `types` restricts a document to the matter types it can honestly describe.
// An ordinance is a specific instrument: it says "ORDINANCE NO.", it ordains,
// and it carries an effective-date clause. Rendering a Resolution or a Motion
// through that template produces a formal-looking document that misstates what
// the body actually adopted. The board letter and the approval log carry any
// item, because that is what they are for.
const OFFICIAL_DOCS = {
  // Describes the file rather than speaking for the body, so it carries any
  // matter type: there is no instrument here to misstate.
  'details': { fn: (m) => documents.legislationDetails(m), slug: 'details', types: null },
  'board-letter': { fn: (m) => documents.boardLetter(m), slug: 'board-letter', types: null },
  'ordinance': { fn: (m) => documents.ordinance(m), slug: 'ordinance', types: ['Ordinance'] },
  'ordinance-redline': { fn: (m) => documents.ordinance(m, { redline: true }), slug: 'ordinance-redline', types: ['Ordinance'] },
  'approval-log': { fn: (m) => documents.approvalLog(m), slug: 'approval-log', types: null },
};

// The notice needs the meeting it gives notice of, so it takes one rather than
// inventing a date. Without a meeting there is nothing lawful to publish.
route('GET', /^\/legislation\/([^/]+)\/doc\/summary\.pdf$/, async (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0], ctx); if (!m) return;
  // The notice is only lawful against a meeting: it tells the public when and
  // where the body will consider the ordinance. Without one there is nothing
  // to publish, so this refuses rather than issuing a notice with no hearing.
  if (m.type !== 'Ordinance') return sendHtml(res, pages.notFound(), 404);
  const meetingId = Number(ctx.query.meeting);
  const meeting = Number.isInteger(meetingId) ? repo.meetings.get(meetingId) : null;
  if (!meeting) return sendHtml(res, pages.notFound(), 404);
  // The meeting arrives as a query parameter, so it has to be checked against
  // this file's agenda placements. A notice naming a meeting where the item is
  // not set to be heard is a false statement published under statute.
  if (!repo.meetings.isOnAgenda(meeting.id, m.id)) return sendHtml(res, pages.notFound(), 404);
  try {
    const bytes = await documents.summaryForPublication(m, meeting, {
      publicUrl: ctx.query.url || null,
      authority: ctx.query.authority || null,
    });
    sendPdf(res, bytes, `${m.file_number}-summary.pdf`);
  } catch (e) {
    console.error('Document generation failed:', e);
    sendHtml(res, pages.notFound(), 500);
  }
});

route('GET', /^\/legislation\/([^/]+)\/doc\/([a-z-]+)\.pdf$/, async (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0], ctx); if (!m) return;
  const spec = OFFICIAL_DOCS[ctx.params[1]];
  if (!spec) return sendHtml(res, pages.notFound(), 404);
  if (spec.types && !spec.types.includes(m.type)) return sendHtml(res, pages.notFound(), 404);
  try {
    const bytes = await spec.fn(m);
    sendPdf(res, bytes, `${m.file_number}-${spec.slug}.pdf`);
  } catch (e) {
    console.error('Document generation failed:', e);
    sendHtml(res, pages.notFound(), 500);
  }
});

function sendPdf(res, bytes, filename) {
  const safe = String(filename).replace(/["\r\n]/g, '');
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': Buffer.byteLength(Buffer.from(bytes)),
    'Content-Disposition': `attachment; filename="${safe}"`,
  });
  res.end(Buffer.from(bytes));
}

route('GET', /^\/legislation\/(.+)$/, (req, res, ctx) => {
  const m = visible(res, ctx, repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0])),
    visibility.canSeeMatter);
  if (!m) return;
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

// Give a speaker the floor: they go on the chamber display and their clock
// starts. Pushed, because the board and the wall are what this is for.
route('POST', /^\/admin\/speakers\/(\d+)\/floor$/, (req, res, ctx) => {
  const s = repo.speakers.get(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  repo.speakers.startSpeaking(s.id);
  live.pushUpdate(s.meeting_id);
  redirect(res, `/admin/meetings/${s.meeting_id}/agenda`);
});

// Speaker queue moderation (clerk).
route('POST', /^\/admin\/speakers\/(\d+)\/status$/, (req, res, ctx) => {
  const s = repo.speakers.get(Number(ctx.params[0]));
  if (!s) return sendHtml(res, pages.notFound(), 404);
  repo.speakers.setStatus(s.id, ctx.body.status);
  if (ctx.body.status === 'Approved') notify.speakerApproved(s.id);
  redirect(res, `/admin/meetings/${s.meeting_id}/agenda`);
});
route('GET', /^\/calendar\/?$/, (req, res, ctx) => sendHtml(res, pages.calendar(ctx.query, ctx.user)));
// The meetings index. /meetings/:id existed without it, so the one object this
// application is built around had no list and no way in but the calendar.
route('GET', /^\/meetings\/?$/, (req, res, ctx) => sendHtml(res, pages.meetingsIndex(ctx.user)));
route('GET', /^\/meetings\/(\d+)$/, (req, res, ctx) => {
  const mt = visible(res, ctx, repo.meetings.get(Number(ctx.params[0])), visibility.canSeeAgenda);
  if (!mt) return;
  sendHtml(res, pages.meetingDetail(mt, ctx.query, ctx.user));
});
route('GET', /^\/meetings\/(\d+)\/packet$/, (req, res, ctx) => {
  const mt = visible(res, ctx, repo.meetings.get(Number(ctx.params[0])), visibility.canSeeAgenda);
  if (!mt) return;
  sendHtml(res, pages.agendaPacket(mt));
});
route('GET', /^\/meetings\/(\d+)\/packet\.pdf$/, async (req, res, ctx) => {
  const mt = visible(res, ctx, repo.meetings.get(Number(ctx.params[0])), visibility.canSeeAgenda);
  if (!mt) return;
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
/**
 * One item, on one page.
 *
 * Gated as the agenda is — this is a part of the agenda, and a part of an
 * unpublished agenda is no more public than the whole of it. Where the item
 * carries a file, the file's own publication is checked too: a published
 * agenda that listed an unpublished measure should not become the way to read
 * it.
 */
route('GET', /^\/meetings\/(\d+)\/items\/(\d+)$/, (req, res, ctx) => {
  const mt = visible(res, ctx, repo.meetings.get(Number(ctx.params[0])), visibility.canSeeAgenda);
  if (!mt) return;
  const item = repo.meetings.getItem(Number(ctx.params[1]));
  if (!item || item.meeting_id !== mt.id) return sendHtml(res, pages.notFound(), 404);
  if (item.matter_id && !visibility.canSeeMatter(ctx.user, repo.matters.get(item.matter_id))) {
    return sendHtml(res, pages.notFound(), 404);
  }
  sendHtml(res, itemReportView.itemReport(mt, item, ctx.user));
});

route('GET', /^\/meetings\/(\d+)\/minutes$/, (req, res, ctx) => {
  const mt = visible(res, ctx, repo.meetings.get(Number(ctx.params[0])), visibility.canSeeMinutes);
  if (!mt) return;
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
  sendHtml(res, usersView.usersAdmin(ctx.user, ctx.query.link));
});
route('POST', /^\/admin\/users$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const b = ctx.body;
  if (b.email && !repo.users.byEmail(b.email)) {
    repo.users.create({
      name: b.name, email: b.email, role: b.role, person_id: b.person_id,
    });
  }
  redirect(res, '/admin/users');
});
// Say which governor a login speaks for. Without it the account signs in,
// holds the member role, and is refused at the ballot as having no member
// identity — with nothing in the interface able to repair it.
route('POST', /^\/admin\/users\/(\d+)\/person$/, (req, res, ctx) => {
  if (!need(ctx, res, 'admin')) return;
  const r = repo.users.setPerson(Number(ctx.params[0]), ctx.body.person_id);
  if (r.error === 'no_such_user') return sendHtml(res, pages.notFound(), 404);
  // The refusals are carried back rather than swallowed: a mistyped id that
  // silently linked nobody would leave the account looking configured.
  const q = r.error ? '?link=' + encodeURIComponent(r.error === 'taken' ? `taken:${r.by}` : r.error) : '';
  redirect(res, '/admin/users' + q);
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
      org_unit_id: ctx.body.org_unit_id ? Number(ctx.body.org_unit_id) : null,
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
      org_unit_id: ctx.body.org_unit_id ? Number(ctx.body.org_unit_id) : null,
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
    leader_person_id: b.leader_person_id ? Number(b.leader_person_id) : null,
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
    leader_person_id: b.leader_person_id ? Number(b.leader_person_id) : null,
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
    accent_color: accentOrNull(b.accent_color),
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
    accent_color: accentOrNull(f.accent_color),
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
  const type = repo.ALL_MATTER_TYPES.includes(ctx.body.type) ? ctx.body.type : null;
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
// Workbench URLs are keyed on the file number — the identifier shown in the UI
// and used by /legislation/:fileNumber. It is UNIQUE NOT NULL, so it resolves
// unambiguously. Accepting the internal row id as a fallback would not: file
// numbers are free-form on import, so a matter numbered "6" would shadow the
// matter whose id is 6 and a clerk could act on the wrong record.
function matterOr404(res, ref, ctx) {
  const m = repo.matters.getByFileNumber(decodeURIComponent(String(ref)));
  if (!m) { sendHtml(res, pages.notFound(), 404); return null; }
  // `ctx` is passed by the routes that are reachable without signing in; the
  // /admin callers below are already behind the clerk gate and pass nothing.
  if (ctx && !visibility.canSeeMatter(ctx.user, m)) {
    sendHtml(res, pages.notFound(), 404); return null;
  }
  return m;
}

route('GET', /^\/admin\/legislation\/([^/]+)\/draft$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  sendHtml(res, draftingView.draftPage(m, { saved: ctx.query.saved === '1' }));
});
route('POST', /^\/admin\/legislation\/([^/]+)\/draft$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  const text = String(ctx.body.full_text || '');
  // Archive the outgoing text as a numbered version when it actually changed.
  if (ctx.body.snapshot === '1') repo.matters.snapshotIfChanged(m.id, { full_text: text, note: 'Drafting revision' });
  repo.matters.update(m.id, Object.assign({}, m, { full_text: text }));
  redirect(res, `/admin/legislation/${encodeURIComponent(m.file_number)}/draft?saved=1`);
});
// Insert a drafting form into an empty draft.
// --- Board letter authoring --------------------------------------------------
route('GET', /^\/admin\/legislation\/([^/]+)\/letter$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  sendHtml(res, draftingView.letterPage(m, { saved: ctx.query.saved === '1' }));
});
// Each section saves on its own, so a half-written letter is never lost to an
// all-or-nothing submit. save() rejects a key that is not in the configured
// list rather than filing text under a section nothing will ever render.
route('POST', /^\/admin\/legislation\/([^/]+)\/letter$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  const ok = repo.letters.save(m.id, String(ctx.body.section || ''), sanitizeHtml(ctx.body.body_html || ''));
  const suffix = ok ? '?saved=1' : '?saved=0';
  redirect(res, `/admin/legislation/${encodeURIComponent(m.file_number)}/letter${suffix}`);
});

route('GET', /^\/admin\/letter-sections\/?$/, (req, res, ctx) => {
  if (!need(ctx, res, 'clerk')) return;
  sendHtml(res, draftingView.letterSectionsAdmin(ctx.query.saved === '1',
    { error: ctx.query.error || '' }));
});
route('POST', /^\/admin\/letter-sections$/, (req, res, ctx) => {
  if (!need(ctx, res, 'clerk')) return;
  // Strict: a row that fails to parse would remove a section from the form and
  // orphan everything written under it, so a bad row rejects the whole list and
  // says which line rather than reporting success over a silent loss.
  const parsed = repo.letters.parseSectionList(ctx.body.sections);
  if (!parsed.ok) {
    return redirect(res, `/admin/letter-sections?error=${encodeURIComponent(parsed.error)}`);
  }
  repo.letters.setSections(parsed.list);
  redirect(res, '/admin/letter-sections?saved=1');
});

route('POST', /^\/admin\/legislation\/([^/]+)\/draft\/form$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  // Never overwrite work in progress — the control is only offered when empty.
  if (!String(m.full_text || '').trim()) {
    const text = ctx.body.form === 'amendatory'
      ? docTemplates.fillPlaceholders(docTemplates.amendatoryForm(), m)
      : docTemplates.draftingTemplate(m.type, m);
    if (text) repo.matters.update(m.id, Object.assign({}, m, { full_text: text }));
  }
  redirect(res, `/admin/legislation/${encodeURIComponent(m.file_number)}/draft`);
});
route('GET', /^\/admin\/legislation\/([^/]+)\/code$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  sendHtml(res, draftingView.codePage(m, { saved: ctx.query.saved === '1' }));
});
route('POST', /^\/admin\/legislation\/([^/]+)\/code$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  repo.code.addAmendment(m.id, {
    op: ctx.body.op, citation: ctx.body.citation, heading: ctx.body.heading,
    new_text: ctx.body.new_text,
  });
  redirect(res, `/admin/legislation/${encodeURIComponent(m.file_number)}/code?saved=1`);
});
route('POST', /^\/admin\/legislation\/([^/]+)\/code\/(\d+)\/delete$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  const a = repo.code.amendment(Number(ctx.params[1]));
  if (a && a.matter_id === m.id && !a.applied_at) repo.code.removeAmendment(a.id);
  redirect(res, `/admin/legislation/${encodeURIComponent(m.file_number)}/code`);
});
route('GET', /^\/admin\/legislation\/([^/]+)\/compare$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  const mode = ['law', 'versions', 'impact'].includes(ctx.query.mode) ? ctx.query.mode : 'law';
  sendHtml(res, draftingView.comparePage(m, mode, ctx.query));
});
// Amendment-impact text is POSTed: a full draft would overflow a GET request
// line and would otherwise be recorded in history and access logs.
route('POST', /^\/admin\/legislation\/([^/]+)\/compare\/impact$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  sendHtml(res, draftingView.comparePage(m, 'impact', { proposed: ctx.body.proposed || '' }));
});
// Codify an enacted measure: apply its instructions to the Board Code.
route('POST', /^\/admin\/legislation\/([^/]+)\/codify$/, (req, res, ctx) => {
  const m = matterOr404(res, ctx.params[0]); if (!m) return;
  amendEngine.codify(m.id, { effectiveDate: ctx.body.effective_date || null });
  redirect(res, `/admin/legislation/${encodeURIComponent(m.file_number)}/code?saved=1`);
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
// Seating a governor: its own form, for the same reason retiring one has its
// own. It also grants the term, which the old card did not — a seat with no
// start date is a seat the roll cannot place in time.
route('GET', /^\/govern\/members\/seat$/, (req, res, ctx) => {
  if (!auth.hasRole(ctx.user, 'clerk')) return sendHtml(res, forbidden(), 403);
  sendHtml(res, govern.seatForm(repo.bodies.all(), repo.people.all().map((p) => ({
    value: p.id, label: p.full_name,
  })), { today: todayISO(), bodyId: ctx.query.body }));
});
route('POST', /^\/govern\/members\/seat$/, (req, res, ctx) => {
  if (!auth.hasRole(ctx.user, 'clerk')) return sendHtml(res, forbidden(), 403);
  const b = ctx.body;
  const bodyId = b.body_id ? Number(b.body_id) : null;
  if (!bodyId || !repo.bodies.get(bodyId)) return redirect(res, '/govern/members');
  const personId = b.person_id ? Number(b.person_id) : null;
  // Either an existing person or a name for a new one; without one of the two
  // there is nobody to seat.
  if (!personId && !String(b.nominee_name || '').trim()) return redirect(res, '/govern/members');
  repo.memberMotions.nominate({
    action: 'seat', body_id: bodyId, person_id: personId,
    nominee_name: personId ? null : b.nominee_name,
    nominee_title: b.nominee_title || null, nominee_email: b.nominee_email || null,
    nominee_district: b.nominee_district || null,
    seat_role: govern.SEAT_ROLES.includes(b.seat_role) ? b.seat_role : 'Member',
    effective_date: b.effective_date || todayISO(),
    term_end_date: b.term_end_date || null,
    // An unchecked box posts nothing, so absence means a seat without a vote.
    seat_voting: b.seat_voting ? 1 : 0,
    reason: b.reason || null, nominated_by: ctx.user.id,
  });
  redirect(res, '/govern/members');
});

// Retiring a governor: its own form, because it is its own act. The roster
// used to carry an inline "Propose removal" box — the same interaction as
// editing a term date, for the thing that ends someone's service.
route('GET', /^\/govern\/members\/retire$/, (req, res, ctx) => {
  if (!auth.hasRole(ctx.user, 'clerk')) return sendHtml(res, forbidden(), 403);
  const member = repo.bodies.memberById(Number(ctx.query.member));
  if (!member) return sendHtml(res, pages.notFound(), 404);
  const body = repo.bodies.get(member.body_id);
  if (!body) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, govern.retireForm(member, body, { today: todayISO() }));
});
route('POST', /^\/govern\/members\/retire$/, (req, res, ctx) => {
  if (!auth.hasRole(ctx.user, 'clerk')) return sendHtml(res, forbidden(), 403);
  const member = repo.bodies.memberById(Number(ctx.body.member_id));
  if (!member) return sendHtml(res, pages.notFound(), 404);
  const cause = govern.END_CAUSES.includes(ctx.body.cause) ? ctx.body.cause : 'Retired';
  repo.memberMotions.nominate({
    action: 'remove', body_id: member.body_id, person_id: member.person_id,
    member_id: member.id, effective_date: ctx.body.effective_date || todayISO(),
    cause, reason: ctx.body.reason || null, nominated_by: ctx.user.id,
  });
  redirect(res, '/govern/members');
});
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

// What is on you, what is late, what could be scheduled, and what was
// forgotten. Every row comes from a query the data already supported; the
// application had simply never asked.
route('GET', /^\/admin\/queue\/?$/, (req, res, ctx) => {
  sendHtml(res, queueView.workQueue(ctx.user));
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
  const codifyNotice = applyEnactment(id, b.status, b.final_date);
  repo.matters.clearSponsors(id);
  applySponsors(id, b.sponsor_id);
  repo.topics.setForMatter(id, parseTopics(b.topics));
  repo.matters.setFiscal(id, {
    fiscal_impact: b.fiscal_impact, budget_line_id: b.budget_line_id ? Number(b.budget_line_id) : null,
    fiscal_recurring: b.fiscal_recurring === '1', fiscal_note: b.fiscal_note,
  });
  repo.matters.setAmendsPolicy(id, b.amends_policy_id ? Number(b.amends_policy_id) : null);
  redirect(res, `/legislation/${encodeURIComponent(m.file_number)}${codifyNotice}`);
});

route('POST', /^\/admin\/matters\/(\d+)\/actions$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const m = repo.matters.get(id);
  if (!m) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  repo.matters.addHistory({
    // The body defaults to the one the file is in control of. It was a
    // required dropdown listing every body, on a form that already knew.
    matter_id: id, action_date: b.action_date, body_id: b.body_id || m.body_id || null,
    action: b.action, result: b.result || null, notes: b.notes || null,
  });
  // The status follows from the action unless the clerk overrides it. It used
  // to be a third field they had to fill for the same event, and leaving it
  // blank left a file whose history said it had carried and whose status still
  // said Introduced.
  const status = b.new_status
    || repo.matters.statusFromAction(b.action, b.result, m.status);
  if (status && status !== m.status) {
    repo.matters.setStatus(id, status);
    const notice = applyEnactment(id, status, b.action_date);
    if (notice) return redirect(res, `/admin/matters/${id}/edit${notice}`);
  }
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
  // Returning it was a dead end. The step stayed current, so it stayed in the
  // reviewer's own inbox — the one person who has finished with it — the
  // sponsor was never told their file had come back, and nothing anywhere
  // recorded that somebody was now expected to do something. A return is a
  // handoff like any other; it just goes the other way.
  if (status === 'Returned') notify.matterReturned(step.matter_id, step.name, ctx.body.notes);
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
  // An attachment is as readable as the file it hangs off. This route had no
  // check at all, so every uploaded document was downloadable by walking the
  // integer ids — regardless of the state of the matter it belonged to.
  const owner = a.matter_id ? repo.matters.get(a.matter_id) : null;
  if (!visibility.canSeeMatter(ctx.user, owner)) return sendHtml(res, pages.notFound(), 404);
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
  sendHtml(res, admin.agendaManager(mt, ctx.query));
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

// Bulk placement from the ready-for-agenda queue. addMatters() re-checks
// eligibility against the meeting itself, so a stale or edited id list cannot
// schedule a file this body has no business hearing.
route('POST', /^\/admin\/meetings\/(\d+)\/agenda\/add-matters$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const mt = repo.meetings.get(id);
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  const ids = asArray(ctx.body && ctx.body.matter_id);
  const { added, skipped } = repo.meetings.addMatters(id, ids, {
    section: ctx.body.section || null,
    item_type: ctx.body.item_type || 'Action',
  });
  live.pushUpdate(id);
  // Report the skip count rather than swallowing it: a silent "nothing
  // happened" is how a clerk finds out at the meeting.
  const q = skipped ? `?added=${added}&skipped=${skipped}` : `?added=${added}`;
  redirect(res, `/admin/meetings/${id}/agenda${q}`);
});

// --- Packet assembly ---------------------------------------------------------
route('GET', /^\/admin\/meetings\/(\d+)\/packet$/, (req, res, ctx) => {
  const mt = repo.meetings.get(Number(ctx.params[0]));
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, admin.packetBuilder(mt));
});

// Amend an item already on the agenda. Previously the only correction
// available was delete-and-re-add, which discarded the item's votes, its
// packet documents and its place in the running order.
route('GET', /^\/admin\/agenda-items\/(\d+)\/edit$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendHtml(res, pages.notFound(), 404);
  const meeting = repo.meetings.get(item.meeting_id);
  if (!meeting) return sendHtml(res, pages.notFound(), 404);
  sendHtml(res, admin.agendaItemPage(meeting, item));
});
route('POST', /^\/admin\/agenda-items\/(\d+)$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const item = repo.meetings.getItem(id);
  if (!item) return sendHtml(res, pages.notFound(), 404);
  const b = ctx.body;
  repo.meetings.updateItem(id, {
    section: b.section ? String(b.section).slice(0, 80) : null,
    agenda_number: b.agenda_number ? String(b.agenda_number).slice(0, 20) : null,
    title: b.title ? String(b.title).slice(0, 300) : null,
    matter_id: b.matter_id ? Number(b.matter_id) : null,
    item_type: b.item_type ? String(b.item_type).slice(0, 40) : null,
    requires_vote: !!b.requires_vote,
    notes: b.notes ? String(b.notes).slice(0, 2000) : null,
    vote_threshold: b.vote_threshold,
  });
  redirect(res, `/admin/meetings/${item.meeting_id}/agenda`);
});
route('POST', /^\/admin\/agenda-items\/(\d+)\/in-packet$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendHtml(res, pages.notFound(), 404);
  repo.meetings.setInPacket(item.id, ctx.body.value === '1');
  redirect(res, `/admin/meetings/${item.meeting_id}/packet`);
});

route('POST', /^\/admin\/agenda-items\/(\d+)\/docs$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendHtml(res, pages.notFound(), 404);
  const name = String(ctx.body.name || '').trim();
  const url = String(ctx.body.url || '').trim();
  if (name) repo.meetings.addItemDoc(item.id, { name, url: safeUrl(url) ? url : null });
  redirect(res, `/admin/meetings/${item.meeting_id}/packet`);
});

route('POST', /^\/admin\/agenda-item-docs\/(\d+)\/delete$/, (req, res, ctx) => {
  const doc = repo.meetings.getItemDoc(Number(ctx.params[0]));
  if (!doc) return sendHtml(res, pages.notFound(), 404);
  const item = repo.meetings.getItem(doc.agenda_item_id);
  repo.meetings.deleteItemDoc(doc.id);
  redirect(res, `/admin/meetings/${item ? item.meeting_id : ''}/packet`);
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
  // Through the ledger, not straight into the projection. The clerk entering a
  // roll from the minutes is recording the same fact as a member pressing a
  // button at the table, and a vote that reaches the record without an event
  // is a vote the chain cannot vouch for.
  const motionVersion = repo.motionVersions.ensure(itemId, {
    motionText: b.motion_text || null,
    moverId: b.mover_id ? Number(b.mover_id) : null,
    seconderId: b.seconder_id ? Number(b.seconder_id) : null,
    threshold: b.vote_threshold || 'majority',
    userId: ctx.user ? ctx.user.id : null,
  });
  for (const key of Object.keys(b)) {
    const m = key.match(/^vote_(\d+)$/);
    if (m && b[key]) {
      recordSingleVote(itemId, Number(m[1]), b[key], {
        motionVersionId: motionVersion ? motionVersion.id : null,
        userId: ctx.user ? ctx.user.id : null,
        stationId: 'clerk-entry',
      });
    }
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
  const r = visible(res, ctx, repo.reports.get(Number(ctx.params[0])), visibility.canSeeReport);
  if (!r) return;
  sendHtml(res, reportsView.reportView(r, ctx.user));
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
// Publication, for the three things a clerk writes and a visitor reads.
//
// Each is a POST of its own rather than a checkbox on the save form, because
// making something readable by the whole internet should be an act with its own
// button and its own confirmation, not a field somebody tabs past.
route('POST', /^\/admin\/reports\/(\d+)\/publish$/, (req, res, ctx) => {
  const r = repo.reports.get(Number(ctx.params[0]));
  if (!r) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.state === 'off') repo.reports.unpublish(r.id);
  else repo.reports.publish(r.id);
  redirect(res, `/admin/reports/${r.id}/edit`);
});

route('POST', /^\/admin\/matters\/(\d+)\/publish$/, (req, res, ctx) => {
  const m = repo.matters.get(Number(ctx.params[0]));
  if (!m) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.state === 'off') repo.matters.unpublish(m.id);
  else repo.matters.publish(m.id);
  redirect(res, `/admin/matters/${m.id}/edit`);
});

// The consent calendar: group items into one roll, or take one back off.
route('POST', /^\/admin\/meetings\/(\d+)\/consent$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const mt = repo.meetings.get(id);
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  // One ticked box posts a string, several post an array; asArray is the
  // existing helper for exactly that shape.
  repo.meetings.groupIntoConsent(id, asArray(ctx.body.item_ids));
  live.pushUpdate(id);
  redirect(res, `/admin/meetings/${id}/agenda`);
});

route('POST', /^\/admin\/agenda-items\/(\d+)\/ungroup$/, (req, res, ctx) => {
  const it = repo.meetings.getItem(Number(ctx.params[0]));
  if (!it) return sendHtml(res, pages.notFound(), 404);
  repo.meetings.ungroupConsent(it.id);
  live.pushUpdate(it.meeting_id);
  redirect(res, `/admin/meetings/${it.meeting_id}/agenda`);
});

route('POST', /^\/admin\/meetings\/(\d+)\/agenda\/publish$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  const mt = repo.meetings.get(id);
  if (!mt) return sendHtml(res, pages.notFound(), 404);
  if (ctx.body.state === 'off') repo.meetings.unpublishAgenda(id);
  else repo.meetings.publishAgenda(id);
  // The wall display and the public board are gated on this, and both are
  // already-open tabs during a meeting. Push so they follow rather than
  // sitting on a stale page until the next unrelated event.
  live.pushUpdate(id);
  redirect(res, `/admin/meetings/${id}/agenda`);
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
  if (!repo.bodies.isSeated(item.body_id, ctx.user.person_id)) {
    return sendJson(res, { error: 'Not on this body' }, 403);
  }
  if (!repo.VOTE_VALUES.includes(ctx.body.vote)) return sendJson(res, { error: 'Invalid vote' }, 400);
  recordSingleVote(itemId, ctx.user.person_id, ctx.body.vote);
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true });
});

// Live voting — public read view + SSE ---------------------------------------
route('GET', /^\/live\/(\d+)$/, (req, res, ctx) => {
  const mt = visible(res, ctx, repo.meetings.get(Number(ctx.params[0])), visibility.canSeeAgenda);
  if (!mt) return;
  sendHtml(res, liveViews.publicLive(mt, ctx.user));
});
/**
 * The chamber display.
 *
 * Unauthenticated by necessity — it runs on a screen on the wall, and nobody
 * is going to sign a television in — so it is gated on the agenda being
 * published instead. That is the right hinge: putting an agenda on a screen in
 * a room full of people *is* publishing it, so the board should not be able to
 * do by projector what the site would refuse to do by URL.
 *
 * It is served on its own route rather than as a mode of /live because it is a
 * different medium — no navigation, no controls, nothing clickable, type sized
 * for the back of the room.
 */
route('GET', /^\/display\/(\d+)$/, (req, res, ctx) => {
  const mt = visible(res, ctx, repo.meetings.get(Number(ctx.params[0])), visibility.canSeeAgenda);
  if (!mt) return;
  // The body itself, not just its name off the meeting: the lockup is set in
  // the body's own accent, which lives on the body row.
  sendHtml(res, displayViews.displayBoard(mt, mt.body_id ? repo.bodies.get(mt.body_id) : null));
});
route('GET', /^\/live\/(\d+)\/stream$/, (req, res, ctx) => {
  const id = Number(ctx.params[0]);
  // The stream carries the roll, the tallies and the running result, so it is
  // the same disclosure as the board it feeds and takes the same gate. Guarding
  // only the page would leave the data a `curl` away.
  if (!visibility.canSeeAgenda(ctx.user, repo.meetings.get(id))) {
    return sendJson(res, { error: 'Not found' }, 404);
  }
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
  let r;
  try {
    r = repo.voteAdmin.reopen(Number(ctx.params[0]), { userId: ctx.user ? ctx.user.id : null });
  } catch (e) {
    // ROLL_ALREADY_OPEN, and now ON_CONSENT_CALENDAR: both are the clerk being
    // told why this is not the item to open, which is worth a sentence rather
    // than a 500.
    return sendJson(res, { error: e.message }, 409);
  }
  if (!r) return sendJson(res, { error: 'Not found' }, 404);
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true, reopened: r.reopened });
});

// Lay an item on the table, or take it back up.
route('POST', /^\/admin\/agenda-items\/(\d+)\/table$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  try {
    if (item.tabled_at) repo.voteAdmin.untable(item.id, { userId: ctx.user ? ctx.user.id : null });
    else {
      repo.voteAdmin.table(item.id, {
        reason: ctx.body && ctx.body.reason,
        userId: ctx.user ? ctx.user.id : null,
      });
    }
  } catch (e) {
    return sendJson(res, { error: e.message }, 409);
  }
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true, tabled: !item.tabled_at });
});

// Done with an item: take it off the board. Not part of the vote lifecycle —
// it records nothing and changes no result.
route('POST', /^\/admin\/agenda-items\/(\d+)\/clear$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  repo.voteAdmin.clear(item.id);
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true });
});

/**
 * Void a vote. Distinct from reopening — see repo.voteAdmin.
 */
route('POST', /^\/admin\/agenda-items\/(\d+)\/void$/, (req, res, ctx) => {
  const itemId = Number(ctx.params[0]);
  const item = repo.meetings.getItem(itemId);
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  try {
    repo.voteAdmin.void(itemId, {
      reason: ctx.body && ctx.body.reason,
      userId: ctx.user ? ctx.user.id : null,
    });
  } catch (e) {
    return sendJson(res, { error: e.message }, 400);
  }
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true });
});

/**
 * The result lifecycle, one route per act.
 *
 * Separate endpoints rather than a status field the clerk sets, because these
 * are four different things a different person may do at a different moment,
 * and each one is an event in the session chain.
 */
for (const [step, fn] of [['announce', 'announce'], ['certify', 'certify'], ['publish', 'publish']]) {
  route('POST', new RegExp(`^\\/admin\\/agenda-items\\/(\\d+)\\/${step}$`), (req, res, ctx) => {
    const itemId = Number(ctx.params[0]);
    const item = repo.meetings.getItem(itemId);
    if (!item) return sendJson(res, { error: 'Not found' }, 404);
    try {
      const updated = repo.voteAdmin[fn](itemId, { userId: ctx.user ? ctx.user.id : null });
      if (!updated) return sendJson(res, { error: 'Not available yet' }, 409);
    } catch (e) {
      return sendJson(res, { error: e.message }, 409);
    }
    live.pushUpdate(item.meeting_id);
    sendJson(res, { ok: true });
  });
}

route('POST', /^\/admin\/agenda-items\/(\d+)\/close$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  // Eligibility-aware: a recused member is present but out of the denominator.
  // The previous arithmetic divided the full seat count for `majority_full`, so
  // recusing counted against the motion exactly as a No vote would.
  // Stamp the close first: the tally is defined as of that instant, so it has
  // to exist before the outcome is computed against it.
  const outcome = repo.voteAdmin.closeRoll(item.id, { userId: ctx.user ? ctx.user.id : null });
  const result = outcome.result;
  const tallyNote = `${outcome.yea}-${outcome.nay}, ${outcome.basis}`
    + (outcome.recused ? `, ${outcome.recused} recused` : '');
  // Reflect the outcome on the matter's legislative history.
  if (item.matter_id) {
    repo.matters.addHistory({
      matter_id: item.matter_id, action_date: require('./src/util').todayISO(),
      body_id: item.body_id, action: 'Vote taken in live session', result,
      notes: tallyNote,
      meeting_id: item.meeting_id, agenda_item_id: item.id,
    });
  }
  // Every file on a consent calendar gets its own history entry, naming the
  // calendar. A file adopted with eleven others still has to be able to answer
  // "when was this decided, and by what vote" from its own page — and it has
  // to say that the vote was taken on the calendar rather than on it alone,
  // because those are different facts about how the board considered it.
  if (item.is_consent_group) {
    for (const member of repo.meetings.consentMembers(item.id)) {
      if (!member.matter_id) continue;
      repo.matters.addHistory({
        matter_id: member.matter_id, action_date: require('./src/util').todayISO(),
        body_id: item.body_id, action: 'Adopted on the consent calendar', result,
        notes: `${tallyNote} — taken on ${item.agenda_number || 'the consent calendar'}`,
        meeting_id: item.meeting_id, agenda_item_id: item.id,
      });
    }
  }
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true, result, tally: outcome });
});
// Stating the motion as it stands.
//
// The item's own fields are what every screen reads, and the motion version is
// what the ballots bind to; both are written here so they cannot drift. This
// is not an amendment — see /amend below — so the repo refuses it if it would
// reword a question already before the body or already decided.
route('POST', /^\/admin\/agenda-items\/(\d+)\/motion$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  const b = ctx.body;
  const motion = {
    mover_id: b.mover_id ? Number(b.mover_id) : null,
    seconder_id: b.seconder_id ? Number(b.seconder_id) : null,
    motion_text: b.motion_text || null,
    vote_threshold: b.vote_threshold || undefined,
  };
  try {
    repo.motionVersions.ensure(item.id, {
      motionText: motion.motion_text,
      moverId: motion.mover_id,
      seconderId: motion.seconder_id,
      threshold: motion.vote_threshold,
      userId: ctx.user ? ctx.user.id : null,
    });
  } catch (e) {
    return sendJson(res, { error: e.message }, 409);
  }
  repo.meetings.setMotion(item.id, motion);
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true });
});

// Putting a new question on the same item.
//
// An amendment, a substitute, or a procedural motion taken during
// consideration. Each is its own version with its own roll and its own result,
// so the record carries the sequence — moved, amended, adopted as amended —
// rather than only whatever the motion text said last.
route('POST', /^\/admin\/agenda-items\/(\d+)\/amend$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  const b = ctx.body;
  const text = String(b.motion_text || '').trim();
  if (!text) return sendJson(res, { error: 'A motion needs its text.' }, 400);
  let version;
  try {
    version = repo.motionVersions.amend(item.id, {
      motionText: text,
      moverId: b.mover_id ? Number(b.mover_id) : null,
      seconderId: b.seconder_id ? Number(b.seconder_id) : null,
      threshold: b.vote_threshold || undefined,
      kind: b.kind || 'amendment',
      userId: ctx.user ? ctx.user.id : null,
    });
  } catch (e) {
    return sendJson(res, { error: e.message }, 409);
  }
  // The item shows the question now before the body. Its own result is left
  // alone: the vote on the amendment stands, and the item's disposition is
  // settled by whichever roll turns out to be the last.
  repo.meetings.setMotion(item.id, {
    mover_id: version.mover_id,
    seconder_id: version.seconder_id,
    motion_text: version.motion_text,
    vote_threshold: version.threshold,
  });
  // A question put is a question before the body, and the console offers the
  // cast buttons for it immediately. Without opening the roll here the ledger
  // would take ballots on a roll it has no record of opening — votes hanging
  // off a version whose consideration never began.
  try {
    repo.voteAdmin.openRoll(item.id, { userId: ctx.user ? ctx.user.id : null });
  } catch (e) {
    return sendJson(res, { error: e.message }, 409);
  }
  live.pushUpdate(item.meeting_id);
  sendJson(res, { ok: true, seq: version.seq, kind: version.kind });
});
route('POST', /^\/admin\/agenda-items\/(\d+)\/cast$/, (req, res, ctx) => {
  const item = repo.meetings.getItem(Number(ctx.params[0]));
  if (!item) return sendJson(res, { error: 'Not found' }, 404);
  if (!repo.VOTE_VALUES.includes(ctx.body.vote)) return sendJson(res, { error: 'Invalid vote' }, 400);
  // The roll is built from the body's seated members, so a ballot for anyone
  // else is counted by nothing and appears in no roster — but it still seals an
  // entry into the ledger, which is the authoritative account. This answered
  // `ok` for it, so the clerk had no way to know the vote had gone nowhere.
  //
  // Reachable without a crafted request: leave the console open across a
  // roster change and the chips on the page name people who are no longer
  // seated. That is exactly the moment the clerk needs to be told.
  //
  // The member route has refused this all along; this is the same refusal.
  // Note it does not also require the roll to be open — unlike a member
  // casting their own vote, a clerk recording a ballot after the close is a
  // real thing that happens, and `late()` exists to account for it.
  const personId = Number(ctx.body.person_id);
  if (!repo.bodies.isSeated(item.body_id, personId)) {
    return sendJson(res, { error: 'Not on this body' }, 409);
  }
  recordSingleVote(item.id, personId, ctx.body.vote);
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
  // Attendance decides quorum and who is in the denominator, so the console
  // and the wall board are wrong until they hear about it. Every other
  // mutating route on this path pushes; this one did not, so marking a member
  // absent left both screens showing the old count until some unrelated event
  // happened to refresh them.
  live.pushUpdate(id);
  redirect(res, `/admin/meetings/${id}/minutes`);
});

// JSON API -------------------------------------------------------------------
route('GET', /^\/api\/v1\/?$/, (req, res) => api.index(res));
// One file as a Universal Document. Registered before the greedy matter route
// below, which would otherwise swallow the /document suffix as part of the
// file number.
route('GET', /^\/api\/v1\/matters\/(.+)\/document$/, (req, res, ctx) => {
  // The same resolution the rest of /api/v1 uses: file number first, row id as
  // the fallback. See api.resolveMatter.
  const m = api.resolveMatter(decodeURIComponent(ctx.params[0]));
  // The same gate the file itself has. A reader who may not see it gets
  // nothing rather than a husk with the body removed, which would confirm the
  // file exists and describe its shape.
  if (!visibility.canSeeMatter(ctx.user, m)) return sendJson(res, { error: 'Matter not found' }, 404);
  sendJson(res, universaldoc.forMatter(m));
});

route('GET', /^\/api\/v1\/matters\/?$/, (req, res, ctx) => api.matters(res, ctx.query, ctx.user));
route('GET', /^\/api\/v1\/matters\/(.+)$/, (req, res, ctx) => api.matter(res, decodeURIComponent(ctx.params[0]), ctx.user));
route('GET', /^\/api\/v1\/events\/?$/, (req, res, ctx) => api.events(res, ctx.user));
route('GET', /^\/api\/v1\/events\/(\d+)$/, (req, res, ctx) => api.event(res, ctx.params[0], ctx.user));
route('GET', /^\/api\/v1\/bodies\/?$/, (req, res) => api.bodies(res));
route('GET', /^\/api\/v1\/bodies\/(\d+)$/, (req, res, ctx) => api.body(res, ctx.params[0]));
route('GET', /^\/api\/v1\/persons\/?$/, (req, res) => api.persons(res));
route('GET', /^\/api\/v1\/persons\/(\d+)$/, (req, res, ctx) => api.person(res, ctx.params[0]));
route('GET', /^\/api\/v1\/people\/?$/, (req, res) => api.persons(res));
route('GET', /^\/api\/v1\/people\/(\d+)$/, (req, res, ctx) => api.person(res, ctx.params[0]));

// --- helpers ----------------------------------------------------------------
// A body's accent, or nothing. The colour input always posts a value, so the
// Board's own slate is stored as "no accent chosen" rather than as a colour
// this body picked — otherwise every body ever saved would look deliberate.
function accentOrNull(v) {
  const hex = String(v || '').trim();
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  return hex.toLowerCase() === '#353d4f' ? null : hex;
}

function parseTopics(str) {
  return String(str || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25);
}

/**
 * Record a vote.
 *
 * The append to the ledger is the record; the row in `votes` is a projection
 * of it kept so the existing tally, minutes and export readers work unchanged.
 * Order matters — the ledger is written first, so a crash between the two
 * leaves the authoritative account complete and only the derived view stale,
 * rather than the other way round.
 */
function recordSingleVote(itemId, personId, vote, opts = {}) {
  if (!personId) return;
  repo.voteLedger.append(itemId, personId, vote, opts);
  repo.votes.clearPersonForItem(itemId, personId);
  repo.votes.record(itemId, personId, vote);
}

// Closes the codification loop: reaching an enacting status applies the
// measure's amending instructions to the Board Code straight away, rather than
// leaving the Code to drift until someone remembers a separate step.
//
// Returns a query suffix naming any instructions that were refused. The status
// has already been saved by this point, so a failure that only reached the log
// would leave an enacted measure silently out of step with the Code.
function applyEnactment(matterId, newStatus, effectiveDate) {
  const res = amendEngine.onStatusChange(matterId, newStatus, effectiveDate);
  if (!res || !res.errors.length) return '';
  console.error('codify:', res.errors.join('; '));
  return '?codify_failed=' + encodeURIComponent(res.errors.slice(0, 3).join(' · ').slice(0, 300));
}

function applySponsors(matterId, sponsorIds) {
  const ids = asArray(sponsorIds).filter(Boolean);
  ids.forEach((pid, i) => {
    repo.matters.addSponsor(matterId, Number(pid), i === 0 ? 'Primary' : 'Co-Sponsor');
  });
}

// --- Server -----------------------------------------------------------------
// Dispatch, authorization, CSRF, security headers and static serving live in
// src/http/kernel.js. This file registers routes; the kernel decides who gets
// to reach them.
const server = http.createServer(kernel.createDispatcher({ routes, publicDir: PUBLIC_DIR }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Legislative Docket Manager running at http://localhost:${PORT}`);
  console.log(`  Public portal : http://localhost:${PORT}/`);
  console.log(`  Admin / clerk : http://localhost:${PORT}/admin`);
  console.log(`  JSON Web API  : http://localhost:${PORT}/api/v1`);
});

module.exports = server;
