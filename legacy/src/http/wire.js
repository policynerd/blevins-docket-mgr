'use strict';

const { sendHtml, sendJson, redirect } = require('../util');
const { forbidden } = require('../views/layout');
const pages = require('../views/pages');
const auth = require('../auth');
const repo = require('../repo');
const schema = require('../schema-extra');

let mounted = false;

function mount(routes) {
  if (mounted || !routes) return;
  mounted = true;
  schema.apply();
  require('../assent');
  require('../spend');
  require('../custody');
  require('../instrument');
  require('../views/legislation-install').install();
  const kind = require('../procedure-kind');
  kind.install();
  require('../live-decorate').install();

  const liveViews = require('../views/live');
  const skins = require('../views/chamber-skins');
  liveViews.publicLive = skins.pickPublicLive;

  const spend = require('../spend');
  const spendView = require('../views/spend');
  const custody = require('../custody');
  const instrument = require('../instrument');
  const live = require('../live');

  function route(method, pattern, handler) {
    routes.push({ method, pattern, handler });
  }

  const origPub = repo.meetings.publishAgenda.bind(repo.meetings);
  repo.meetings.publishAgenda = function publishAgendaWired(meetingId) {
    const out = origPub(meetingId);
    try { custody.freezeAgenda(meetingId, { reason: 'agenda published' }); }
    catch (e) { console.error('custody.freezeAgenda', e.message); }
    return out;
  };

  route('GET', /^\/spend\/?$/, (req, res, ctx) => {
    if (!auth.hasRole(ctx.user, 'staff')) return sendHtml(res, forbidden(), 403);
    sendHtml(res, spendView.listPage(ctx.user, { error: ctx.query.error }));
  });
  route('POST', /^\/spend\/?$/, (req, res, ctx) => {
    if (!auth.hasRole(ctx.user, 'staff')) return sendHtml(res, forbidden(), 403);
    try {
      const row = spend.create(ctx.body, ctx.user);
      redirect(res, '/spend/' + row.id);
    } catch (e) {
      sendHtml(res, spendView.listPage(ctx.user, { error: e.message }), 400);
    }
  });
  route('GET', /^\/spend\/(\d+)$/, (req, res, ctx) => {
    if (!auth.hasRole(ctx.user, 'staff')) return sendHtml(res, forbidden(), 403);
    const row = spend.get(Number(ctx.params[0]));
    if (!row) return sendHtml(res, pages.notFound(), 404);
    sendHtml(res, spendView.detailPage(row, ctx.user));
  });
  route('POST', /^\/spend\/(\d+)\/submit$/, (req, res, ctx) => {
    actSpend(res, ctx, Number(ctx.params[0]), (id) => spend.submit(id, ctx.user));
  });
  route('POST', /^\/spend\/(\d+)\/decide$/, (req, res, ctx) => {
    actSpend(res, ctx, Number(ctx.params[0]), (id) => spend.decide(id, {
      status: ctx.body.status, note: ctx.body.note,
    }, ctx.user));
  });
  route('POST', /^\/spend\/(\d+)\/post$/, (req, res, ctx) => {
    actSpend(res, ctx, Number(ctx.params[0]), (id) => spend.post(id, ctx.user));
  });
  route('POST', /^\/spend\/(\d+)\/void$/, (req, res, ctx) => {
    actSpend(res, ctx, Number(ctx.params[0]), (id) => spend.voidRequest(id, ctx.user));
  });

  function actSpend(res, ctx, id, fn) {
    if (!auth.hasRole(ctx.user, 'staff')) return sendHtml(res, forbidden(), 403);
    const row = spend.get(id);
    if (!row) return sendHtml(res, pages.notFound(), 404);
    try { fn(id); redirect(res, '/spend/' + id); }
    catch (e) { sendHtml(res, spendView.detailPage(spend.get(id), ctx.user, { error: e.message }), 400); }
  }

  route('GET', /^\/admin\/legislation\/([^/]+)\/instrument$/, (req, res, ctx) => {
    const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
    if (!m) return sendHtml(res, pages.notFound(), 404);
    sendHtml(res, spendView.instrumentPage(m, { saved: ctx.query.saved === '1' }));
  });
  route('POST', /^\/admin\/legislation\/([^/]+)\/instrument$/, (req, res, ctx) => {
    const m = repo.matters.getByFileNumber(decodeURIComponent(ctx.params[0]));
    if (!m) return sendHtml(res, pages.notFound(), 404);
    instrument.save(m.id, {
      citations: ctx.body.citations,
      recitals: ctx.body.recitals,
      formula: ctx.body.enacting_formula,
    });
    redirect(res, `/admin/legislation/${encodeURIComponent(m.file_number)}/instrument?saved=1`);
  });

  route('POST', /^\/admin\/matters\/(\d+)\/assent$/, (req, res, ctx) => {
    const id = Number(ctx.params[0]);
    const m = repo.matters.get(id);
    if (!m) return sendHtml(res, pages.notFound(), 404);
    try {
      require('../assent').assent(id, {
        actorId: ctx.user && ctx.user.id,
        actorName: ctx.user && ctx.user.name,
      });
    } catch (e) {
      if (e.code !== 'NOT_PASSED' && e.code !== 'ASSENTED') throw e;
    }
    redirect(res, `/legislation/${encodeURIComponent(m.file_number)}`);
  });

  route('GET', /^\/member\/live\/(\d+)$/, (req, res, ctx) => {
    const mt = repo.meetings.get(Number(ctx.params[0]));
    if (!mt) return sendHtml(res, pages.notFound(), 404);
    sendHtml(res, skins.memberLive(mt, ctx.user));
  });
  route('GET', /^\/desk\/?$/, (req, res, ctx) => {
    if (!ctx.user) return redirect(res, '/login?next=/desk');
    sendHtml(res, skins.deskPage(ctx.user));
  });
  route('POST', /^\/admin\/agenda-items\/(\d+)\/receive$/, (req, res, ctx) => {
    const item = repo.meetings.getItem(Number(ctx.params[0]));
    if (!item) return sendJson(res, { error: 'Not found' }, 404);
    try { kind.receive(item.id, { disposition: ctx.body && ctx.body.disposition }); }
    catch (e) { return sendJson(res, { error: e.message }, 409); }
    live.pushUpdate(item.meeting_id);
    sendJson(res, { ok: true });
  });
  route('POST', /^\/admin\/agenda-items\/(\d+)\/voice$/, (req, res, ctx) => {
    const item = repo.meetings.getItem(Number(ctx.params[0]));
    if (!item) return sendJson(res, { error: 'Not found' }, 404);
    try { kind.voice(item.id, { result: ctx.body && ctx.body.result }); }
    catch (e) { return sendJson(res, { error: e.message }, 409); }
    live.pushUpdate(item.meeting_id);
    sendJson(res, { ok: true });
  });

  route('POST', /^\/member\/agenda-items\/(\d+)\/move$/, (req, res, ctx) => {
    floor(req, res, ctx, 'move');
  });
  route('POST', /^\/member\/agenda-items\/(\d+)\/second$/, (req, res, ctx) => {
    floor(req, res, ctx, 'second');
  });

  function floor(req, res, ctx, act) {
    const item = repo.meetings.getItem(Number(ctx.params[0]));
    if (!item) return sendJson(res, { error: 'Not found' }, 404);
    if (!ctx.user || !ctx.user.person_id) return sendJson(res, { error: 'No member identity' }, 403);
    if (!repo.bodies.isSeated(item.body_id, ctx.user.person_id)) {
      return sendJson(res, { error: 'Not on this body' }, 403);
    }
    try {
      kind.assertCanMove(item);
      if (act === 'move') {
        if ((item.vote_status || 'pending') === 'open') {
          return sendJson(res, { error: 'The question is already before the body.' }, 409);
        }
        if (item.mover_id) return sendJson(res, { error: 'Already moved.' }, 409);
        repo.meetings.setMotion(item.id, {
          mover_id: ctx.user.person_id,
          seconder_id: item.seconder_id,
          motion_text: item.motion_text || 'I move the recommendation.',
        });
      } else {
        if (!item.mover_id) return sendJson(res, { error: 'Nothing is pending a second.' }, 409);
        if (Number(item.mover_id) === Number(ctx.user.person_id)) {
          return sendJson(res, { error: 'The mover cannot second their own motion.' }, 409);
        }
        if (item.seconder_id) return sendJson(res, { error: 'Already seconded.' }, 409);
        repo.meetings.setMotion(item.id, {
          mover_id: item.mover_id,
          seconder_id: ctx.user.person_id,
          motion_text: item.motion_text,
        });
      }
    } catch (e) {
      return sendJson(res, { error: e.message }, 400);
    }
    live.pushUpdate(item.meeting_id);
    sendJson(res, { ok: true });
  }
}

module.exports = { mount };
