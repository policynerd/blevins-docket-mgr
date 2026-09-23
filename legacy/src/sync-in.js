'use strict';

const repo = require('./repo');

function authorized(req) {
  const expected = process.env.DRAFTING_SYNC_SECRET || process.env.DOCKET_SYNC_SECRET;
  if (!expected) return false;
  return String(req.headers['x-blevins-sync'] || '') === expected;
}

function upsertFile(payload) {
  const ref = String(payload.ref || '').trim();
  if (!ref) throw new Error('ref is required');
  const title = String(payload.title || ref).trim();
  const status = String(payload.status || 'Draft');
  const existing = repo.matters.getByFileNumber(ref);
  const summary = [
    payload.inControl ? `In control: ${payload.inControl}` : '',
    payload.enactmentNumber ? `Enactment: ${payload.enactmentNumber}` : '',
    payload.packetUrl ? `Packet: ${payload.packetUrl}` : '',
    'Synced from the legislative drafting suite.',
  ]
    .filter(Boolean)
    .join(' · ');
  if (existing) {
    repo.matters.update(existing.id, {
      type: existing.type || 'Action',
      title,
      status,
      body_id: existing.body_id,
      intro_date: existing.intro_date,
      final_date: payload.enactmentNumber ? new Date().toISOString().slice(0, 10) : existing.final_date,
      summary,
      full_text: existing.full_text,
    });
    return { id: existing.id, file_number: ref, updated: true };
  }
  const id = repo.matters.insert({
    file_number: ref,
    type: 'Action',
    title,
    status,
    intro_date: payload.agendaDate || null,
    summary,
  });
  return { id, file_number: ref, created: true };
}

module.exports = { authorized, upsertFile };
