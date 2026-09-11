'use strict';

// Evidence chain for released records.
//
// Until this module existed a publication was a timestamp on a mutable row.
// An agenda could be reordered after members had relied on it; an uploaded
// file had no digest; a matter version did not record who cut it; and the
// audit log recorded HTTP requests, not changes to records. None of those
// facts is recoverable from a timestamp.
//
// A Publication is the unit that was released: kind, subject, version, actor,
// reason, and a hashed manifest of what it pointed at. A later correction
// inserts a successor that names the one it supersedes. The earlier row is
// never updated.
//
// An AgendaVersion is the ordered list of items as they stood at that
// release. Reordering the live agenda after publication does not rewrite it.
//
// record_changes is the entity-level audit. Request logging stays; this is
// what answers "who changed this field, from what, to what".

const crypto = require('node:crypto');
const fs = require('node:fs');
const { db } = require('./db');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function canonical(value) {
  if (value === undefined) return 'null';
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ordered = {};
      for (const key of Object.keys(v).sort()) ordered[key] = v[key];
      return ordered;
    }
    return v;
  });
}

function hashJson(value) {
  return sha256(canonical(value));
}

function hashBuffer(buf) {
  return sha256(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
}

function hashFile(absPath) {
  return sha256(fs.readFileSync(absPath));
}

/**
 * Compare a stored digest with the bytes on disk.
 *
 * Missing hash: the file predates custody; we cannot prove anything, so we
 * do not pretend to. Mismatch: the bytes are not the ones that were stored,
 * and serving them as the record would be a lie.
 */
function verifyHash(absPath, expected) {
  if (!expected) return { ok: true, skipped: true };
  if (!absPath || !fs.existsSync(absPath)) {
    return { ok: false, reason: 'missing', expected };
  }
  const actual = hashFile(absPath);
  if (actual === expected) return { ok: true, actual };
  return { ok: false, reason: 'mismatch', expected, actual };
}

function nextPublicationVersion(kind, subjectType, subjectId) {
  const row = db.prepare(`
    SELECT MAX(version) AS v FROM publications
    WHERE kind = ? AND subject_type = ? AND subject_id = ?`).get(kind, subjectType, subjectId);
  return (row && row.v ? row.v : 0) + 1;
}

function currentPublication(kind, subjectType, subjectId) {
  return db.prepare(`
    SELECT * FROM publications
    WHERE kind = ? AND subject_type = ? AND subject_id = ?
    ORDER BY version DESC LIMIT 1`).get(kind, subjectType, subjectId);
}

function publicationsFor(subjectType, subjectId) {
  return db.prepare(`
    SELECT * FROM publications
    WHERE subject_type = ? AND subject_id = ?
    ORDER BY id DESC`).all(subjectType, subjectId);
}

/**
 * Freeze a release. `manifest` is the list of things the release claims to
 * contain — agenda items, attachment ids and hashes, packet page counts.
 * Whatever it is, it is hashed, and that hash is what later verification
 * compares against.
 */
function publish({
  kind, subjectType, subjectId, actorId = null, actorName = null,
  reason = null, manifest, supersedesId = null,
}) {
  const previous = currentPublication(kind, subjectType, subjectId);
  const version = nextPublicationVersion(kind, subjectType, subjectId);
  const manifestJson = canonical(manifest || {});
  const manifestHash = sha256(manifestJson);
  const info = db.prepare(`
    INSERT INTO publications
      (kind, subject_type, subject_id, version, actor_id, actor_name,
       reason, supersedes_id, manifest_json, manifest_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    kind, subjectType, subjectId, version,
    actorId || null, actorName || null, reason || null,
    supersedesId != null ? supersedesId : (previous ? previous.id : null),
    manifestJson, manifestHash);
  return db.prepare('SELECT * FROM publications WHERE id = ?').get(info.lastInsertRowid);
}

function agendaSnapshot(meetingId) {
  const items = db.prepare(`
    SELECT id, matter_id, sort_order, agenda_number, section, title, action,
           item_type, requires_vote, consent_group_id, is_consent_group
    FROM agenda_items WHERE meeting_id = ? ORDER BY sort_order, id`).all(meetingId);
  return items.map((it) => ({
    id: it.id,
    matter_id: it.matter_id,
    sort_order: it.sort_order,
    agenda_number: it.agenda_number,
    section: it.section,
    title: it.title,
    action: it.action,
    item_type: it.item_type,
    requires_vote: it.requires_vote,
    consent_group_id: it.consent_group_id,
    is_consent_group: it.is_consent_group,
  }));
}

function freezeAgenda(meetingId, { actorId = null, actorName = null, reason = null, kind = 'agenda' } = {}) {
  const snapshot = agendaSnapshot(meetingId);
  const snapshotJson = canonical(snapshot);
  const snapshotHash = sha256(snapshotJson);
  const attachments = db.prepare(`
    SELECT a.id, a.matter_id, a.name, a.file_path, a.content_hash, a.size
    FROM attachments a
    JOIN agenda_items ai ON ai.matter_id = a.matter_id
    WHERE ai.meeting_id = ?
    ORDER BY a.id`).all(meetingId);
  const docs = db.prepare(`
    SELECT d.id, d.agenda_item_id, d.name, d.file_path, d.content_hash, d.size
    FROM agenda_item_docs d
    JOIN agenda_items ai ON ai.id = d.agenda_item_id
    WHERE ai.meeting_id = ?
    ORDER BY d.id`).all(meetingId);
  const publication = publish({
    kind,
    subjectType: 'meeting',
    subjectId: meetingId,
    actorId,
    actorName,
    reason,
    manifest: {
      item_count: snapshot.length,
      snapshot_hash: snapshotHash,
      attachments: attachments.map((a) => ({
        id: a.id, matter_id: a.matter_id, name: a.name,
        hash: a.content_hash, size: a.size,
      })),
      item_docs: docs.map((d) => ({
        id: d.id, agenda_item_id: d.agenda_item_id, name: d.name,
        hash: d.content_hash, size: d.size,
      })),
    },
  });
  const version = db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM agenda_versions WHERE meeting_id = ?')
    .get(meetingId).v + 1;
  const info = db.prepare(`
    INSERT INTO agenda_versions
      (meeting_id, publication_id, version, snapshot_json, snapshot_hash, created_by)
    VALUES (?,?,?,?,?,?)`).run(
    meetingId, publication.id, version, snapshotJson, snapshotHash, actorId || null);
  return {
    publication,
    agendaVersion: db.prepare('SELECT * FROM agenda_versions WHERE id = ?').get(info.lastInsertRowid),
  };
}

function agendaVersions(meetingId) {
  return db.prepare(`
    SELECT av.*, p.kind, p.actor_name, p.reason, p.created_at AS published_at
    FROM agenda_versions av
    LEFT JOIN publications p ON p.id = av.publication_id
    WHERE av.meeting_id = ?
    ORDER BY av.version DESC`).all(meetingId);
}

function getAgendaVersion(meetingId, version) {
  return db.prepare(
    'SELECT * FROM agenda_versions WHERE meeting_id = ? AND version = ?')
    .get(meetingId, version);
}

function change({
  actorId = null, actorName = null, entityType, entityId = null,
  action, field = null, before = null, after = null, reason = null,
}) {
  return db.prepare(`
    INSERT INTO record_changes
      (actor_id, actor_name, entity_type, entity_id, action, field,
       before_json, after_json, reason)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    actorId || null, actorName || null, entityType, entityId || null,
    action, field || null,
    before == null ? null : canonical(before),
    after == null ? null : canonical(after),
    reason || null).lastInsertRowid;
}

function changesFor(entityType, entityId, limit = 200) {
  return db.prepare(`
    SELECT * FROM record_changes
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY id DESC LIMIT ?`).all(entityType, entityId, limit);
}

function recentChanges(limit = 200) {
  return db.prepare('SELECT * FROM record_changes ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  sha256,
  canonical,
  hashJson,
  hashBuffer,
  hashFile,
  verifyHash,
  publish,
  currentPublication,
  publicationsFor,
  freezeAgenda,
  agendaSnapshot,
  agendaVersions,
  getAgendaVersion,
  change,
  changesFor,
  recentChanges,
};
