'use strict';

const { sendJson } = require('./util');
const repo = require('./repo');

// A small, read-only JSON API modeled on Legistar's Web API shape:
// resources for Matters, Events (meetings), Bodies, Persons and Votes.
function index(res) {
  sendJson(res, {
    name: 'Legislative Docket Manager — Web API',
    version: 'v1',
    resources: {
      matters: '/api/v1/matters',
      matter: '/api/v1/matters/{fileNumberOrId}',
      events: '/api/v1/events',
      event: '/api/v1/events/{id}',
      bodies: '/api/v1/bodies',
      body: '/api/v1/bodies/{id}',
      persons: '/api/v1/persons',
      person: '/api/v1/persons/{id}',
    },
    query_params: {
      matters: ['q', 'type', 'status', 'body_id', 'sponsor_id', 'limit'],
    },
  });
}

function matterDTO(m, deep = false) {
  const dto = {
    id: m.id,
    file_number: m.file_number,
    type: m.type,
    title: m.title,
    status: m.status,
    in_control: m.body_name || null,
    body_id: m.body_id || null,
    intro_date: m.intro_date || null,
    final_date: m.final_date || null,
    summary: m.summary || null,
    url: `/legislation/${encodeURIComponent(m.file_number)}`,
  };
  if (deep) {
    dto.sponsors = repo.matters.sponsors(m.id).map((s) => ({
      id: s.id, name: s.full_name, type: s.sponsor_type,
    }));
    dto.history = repo.matters.history(m.id).map((h) => ({
      date: h.action_date, body: h.body_name, action: h.action, result: h.result,
    }));
    dto.attachments = repo.matters.attachments(m.id).map((a) => ({
      name: a.name, url: a.url,
    }));
    dto.full_text = m.full_text || null;
  }
  return dto;
}

function matters(res, query) {
  const rows = repo.matters.search({
    q: query.q, type: query.type, status: query.status,
    bodyId: query.body_id ? Number(query.body_id) : undefined,
    sponsorId: query.sponsor_id ? Number(query.sponsor_id) : undefined,
    limit: query.limit ? Math.min(Number(query.limit), 1000) : 200,
  });
  sendJson(res, { count: rows.length, results: rows.map((m) => matterDTO(m)) });
}

function matter(res, key) {
  const m = /^\d+$/.test(key) ? repo.matters.get(Number(key)) : repo.matters.getByFileNumber(key);
  if (!m) return sendJson(res, { error: 'Matter not found' }, 404);
  sendJson(res, matterDTO(m, true));
}

function events(res) {
  const rows = repo.meetings.all().map((mt) => ({
    id: mt.id, body: mt.body_name, body_id: mt.body_id,
    date: mt.meeting_date, time: mt.meeting_time, location: mt.location,
    status: mt.status, item_count: mt.item_count,
    url: `/meetings/${mt.id}`,
  }));
  sendJson(res, { count: rows.length, results: rows });
}

function event(res, id) {
  const mt = repo.meetings.get(Number(id));
  if (!mt) return sendJson(res, { error: 'Event not found' }, 404);
  const items = repo.meetings.items(mt.id).map((it) => {
    const out = {
      agenda_number: it.agenda_number, section: it.section,
      title: it.matter_id ? it.matter_title : it.title,
      file_number: it.file_number || null,
      action: it.action, result: it.result,
    };
    if (it.matter_id) {
      out.votes = repo.votes.forItem(it.id).map((v) => ({ name: v.full_name, vote: v.vote }));
      out.tally = repo.votes.tally(it.id);
    }
    return out;
  });
  sendJson(res, {
    id: mt.id, body: mt.body_name, body_id: mt.body_id,
    date: mt.meeting_date, time: mt.meeting_time, location: mt.location,
    status: mt.status, agenda: items,
  });
}

function bodies(res) {
  const rows = repo.bodies.all().map((b) => ({
    id: b.id, name: b.name, type: b.type, description: b.description,
    members: repo.bodies.members(b.id).length, url: `/bodies/${b.id}`,
  }));
  sendJson(res, { count: rows.length, results: rows });
}

function body(res, id) {
  const b = repo.bodies.get(Number(id));
  if (!b) return sendJson(res, { error: 'Body not found' }, 404);
  sendJson(res, {
    id: b.id, name: b.name, type: b.type, description: b.description,
    meeting_location: b.meeting_location, meets: b.meets,
    members: repo.bodies.members(b.id).map((m) => ({
      id: m.person_id, name: m.full_name, role: m.role,
      district: m.district, voting: !!m.voting,
    })),
  });
}

function persons(res) {
  const rows = repo.people.all().map((p) => ({
    id: p.id, name: p.full_name, title: p.title, district: p.district,
    party: p.party, email: p.email, url: `/people/${p.id}`,
  }));
  sendJson(res, { count: rows.length, results: rows });
}

function person(res, id) {
  const p = repo.people.get(Number(id));
  if (!p) return sendJson(res, { error: 'Person not found' }, 404);
  sendJson(res, {
    id: p.id, name: p.full_name, title: p.title, district: p.district,
    party: p.party, email: p.email, phone: p.phone, website: p.website, bio: p.bio,
    memberships: repo.people.memberships(p.id).map((m) => ({
      body: m.body_name, role: m.role, voting: !!m.voting,
    })),
    sponsored: repo.people.sponsored(p.id).map((m) => ({
      file_number: m.file_number, title: m.title, status: m.status,
    })),
  });
}

module.exports = { index, matters, matter, events, event, bodies, body, persons, person };
