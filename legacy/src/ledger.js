'use strict';

// The vote ledger: append-only, hash-chained, server-signed.
//
// Why this exists at all. Until now a member changing their vote ran
// `DELETE FROM votes WHERE agenda_item_id = ? AND person_id = ?` and inserted
// the new one, so the previous vote left no trace. For an ordinary application
// that is fine. For the authoritative record of how a governing body voted it
// is not: "did anyone change their vote after seeing the tally" is a question
// the record has to be able to answer, and a row that was overwritten cannot
// answer anything.
//
// So nothing is ever updated or deleted. A changed vote is a new event that
// names the one it supersedes, and the ledger keeps both.
//
// Tamper evidence comes from the chain, not from the signature. Each entry
// hashes the previous entry's hash together with its own payload, so altering
// any historical row invalidates every entry after it — and that holds even
// against someone with direct write access to the database, who cannot
// recompute the chain without also rewriting every later row. The signature
// adds "and this server wrote it", which is a weaker and separate claim.

const crypto = require('node:crypto');

/** The hash a chain starts from, so the first entry is not a special case. */
const GENESIS = '0'.repeat(64);

/** Choices a member may record. */
const CHOICES = ['Yea', 'Nay', 'Present', 'Abstain', 'Recused'];

/**
 * Everything that happens in a session, in one vocabulary.
 *
 * All of it goes in one chain per meeting rather than one per item, and that
 * is the whole point: ROLL_CLOSED is *in* the sequence, so a vote recorded
 * after it is provably after it by position. Chaining per item would leave
 * that resting on a timestamp column the server writes — and a record whose
 * ordering depends on trusting the server that wrote it is not evidence of
 * much.
 */
const EVENT_TYPES = [
  'SESSION_STARTED',
  'MEMBER_CHECKED_IN',
  'AGENDA_ITEM_CALLED',
  'MOTION_CREATED',
  'MOTION_AMENDED',
  'ROLL_OPENED',
  'VOTE_CAST',
  'VOTE_CHANGED',
  'ROLL_CLOSED',
  'RESULT_COMPUTED',
  'RESULT_ANNOUNCED',
  'RESULT_CERTIFIED',
  'RESULT_PUBLISHED',
  'CORRECTION_REQUESTED',
  'CORRECTION_APPROVED',
];

/**
 * Where a recorded vote came from.
 *
 * A vote the clerk typed from the spoken roll is a different fact from one a
 * governor pressed at their seat, and the record must never blur them. Both
 * are legitimate; only one of them is the member's own act.
 */
const SOURCES = ['MEMBER_TERMINAL', 'CLERK_ENTRY', 'IMPORT'];

/** Events after which the roll is no longer open. */
const CLOSING_EVENTS = new Set(['ROLL_CLOSED']);

/**
 * Serialize a payload so the same facts always hash to the same bytes.
 *
 * Keys are sorted and the output is compact. Without this, two encoders that
 * disagree about key order or spacing produce different hashes for identical
 * votes, and the chain breaks for a reason that has nothing to do with
 * tampering — which is worse than no chain, because it cries wolf.
 */
function canonical(payload) {
  const ordered = {};
  for (const key of Object.keys(payload).sort()) {
    const v = payload[key];
    ordered[key] = v === undefined ? null : v;
  }
  return JSON.stringify(ordered);
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Hash of the vote's own facts. */
function payloadHash(payload) {
  return sha256(canonical(payload));
}

/**
 * Hash binding this entry to everything before it.
 *
 * Both halves are needed. Hashing only the payload would let entries be
 * reordered or removed silently; hashing only the previous hash would let a
 * vote's contents be rewritten in place.
 */
function entryHash(previousEntryHash, hashOfPayload) {
  return sha256(`${previousEntryHash}:${hashOfPayload}`);
}

/**
 * Sign an entry hash.
 *
 * HMAC rather than a public-key signature: the only party that needs to verify
 * is this application, and a keypair whose private half sits beside the
 * database it protects buys nothing over a shared secret while adding key
 * management nobody will do.
 */
function sign(hash, key) {
  return crypto.createHmac('sha256', key).update(hash, 'utf8').digest('hex');
}

/**
 * Build the next entry in a chain.
 *
 * Pure: it reads nothing and writes nothing. Every hash the ledger depends on
 * is computed here, so the guarantees can be tested without a database.
 */
function buildEntry({ previousEntryHash = GENESIS, payload, key, sequence, eventType }) {
  if (eventType && !EVENT_TYPES.includes(eventType)) {
    throw new Error(`Not a session event: ${eventType}`);
  }
  if (payload.choice !== undefined && payload.choice !== null
      && !CHOICES.includes(payload.choice)) {
    throw new Error(`Not a vote: ${payload.choice}`);
  }
  if (payload.source !== undefined && payload.source !== null
      && !SOURCES.includes(payload.source)) {
    throw new Error(`Not a vote source: ${payload.source}`);
  }
  const ph = payloadHash(payload);
  const eh = entryHash(previousEntryHash, ph);
  return {
    eventSequence: sequence,
    previousEventHash: previousEntryHash,
    payloadHash: ph,
    entryHash: eh,
    serverSignature: sign(eh, key),
  };
}

/**
 * Recompute a chain and report the first entry that does not agree with it.
 *
 * Returns `{ ok: true, length }` or `{ ok: false, brokenAt, reason }`. The
 * index matters: an auditor needs to know *where* the record stops being
 * trustworthy, not merely that it does. Everything before the break is still
 * good, which is the practical difference between "one row was edited" and
 * "discard the meeting".
 */
function verifyChain(entries, key) {
  let previous = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.previous_event_hash !== previous) {
      return { ok: false, brokenAt: i, reason: 'chain does not continue from the previous entry' };
    }
    const expectedPayload = payloadHash(e.payload);
    if (expectedPayload !== e.payload_hash) {
      return { ok: false, brokenAt: i, reason: 'entry contents do not match their recorded hash' };
    }
    const expectedEntry = entryHash(e.previous_event_hash, e.payload_hash);
    if (expectedEntry !== e.entry_hash) {
      return { ok: false, brokenAt: i, reason: 'entry hash does not match its inputs' };
    }
    if (key && e.server_signature) {
      const expectedSig = sign(e.entry_hash, key);
      // Constant-time: a verifier that returns early leaks how much of a
      // forged signature was right, one byte at a time.
      const a = Buffer.from(expectedSig, 'utf8');
      const b = Buffer.from(e.server_signature, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { ok: false, brokenAt: i, reason: 'signature does not match this server' };
      }
    }
    previous = e.entry_hash;
  }
  return { ok: true, length: entries.length };
}

/**
 * The sequence number at which the roll for an item closed, or null.
 *
 * Position in the chain, not a clock. This is what makes "after the close"
 * checkable without trusting any timestamp: the close occupies a slot, and
 * anything with a higher slot came later.
 */
function closedAtSeq(entries, agendaItemId) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.agenda_item_id !== agendaItemId) continue;
    if (e.event_type === 'ROLL_OPENED') return null;   // reopened since
    if (CLOSING_EVENTS.has(e.event_type)) return e.seq;
  }
  return null;
}

/**
 * Reduce a chain to who stands where, as of a moment.
 *
 * `asOf` is what makes a closed vote reproducible. Events received after the
 * roll closed are kept — they happened, and the ledger records what happened —
 * but they do not count, so re-deriving a tally next year yields exactly the
 * number that was read out on the day. Without the bound, a station retrying a
 * request after the gavel silently joins a settled vote.
 *
 * Superseding is resolved within the window too. A member who changed their
 * vote before the close has the later one counted; a "change" that arrived
 * after it does not retroactively withdraw the vote that did count.
 */
function currentChoices(entries, { asOf = null, throughSeq = null } = {}) {
  let inWindow = entries.filter((e) => e.event_type === 'VOTE_CAST' || e.event_type === 'VOTE_CHANGED');
  // Position first where we have it: a sequence number cannot be backdated.
  if (throughSeq != null) inWindow = inWindow.filter((e) => e.seq <= throughSeq);
  if (asOf) inWindow = inWindow.filter((e) => String(e.received_at) <= String(asOf));

  // Only supersessions that themselves landed in the window may retract
  // anything. Otherwise a late event would erase the vote it claims to
  // replace while being ineligible to replace it — losing a valid ballot.
  const superseded = new Set();
  for (const e of inWindow) {
    if (e.supersedes_event_id) superseded.add(e.supersedes_event_id);
  }
  const byPerson = new Map();
  for (const e of inWindow) {
    if (superseded.has(e.event_id)) continue;
    const prior = byPerson.get(e.person_id);
    if (!prior || e.seq > prior.seq) byPerson.set(e.person_id, e);
  }
  return byPerson;
}

/** Events the window excluded — shown, never silently dropped. */
function lateEvents(entries, { asOf = null, throughSeq = null } = {}) {
  const ballots = entries.filter(
    (e) => e.event_type === 'VOTE_CAST' || e.event_type === 'VOTE_CHANGED');
  if (throughSeq != null) return ballots.filter((e) => e.seq > throughSeq);
  if (asOf) return ballots.filter((e) => String(e.received_at) > String(asOf));
  return [];
}

module.exports = {
  GENESIS, CHOICES, EVENT_TYPES, SOURCES, closedAtSeq,
  canonical, payloadHash, entryHash, sign, buildEntry, verifyChain, currentChoices, lateEvents,
};
