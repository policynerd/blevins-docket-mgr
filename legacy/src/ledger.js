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
function buildEntry({ previousEntryHash = GENESIS, payload, key, sequence }) {
  if (!CHOICES.includes(payload.choice)) {
    throw new Error(`Not a vote: ${payload.choice}`);
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
 * Reduce a chain to who currently stands where.
 *
 * A member may vote more than once while the roll is open; the last event for
 * that member wins and the superseded ones stay in the ledger. This is the
 * only place that decision is made, so the live tally, the closing tally and
 * the minutes cannot disagree about it.
 */
function currentChoices(entries) {
  const superseded = new Set();
  for (const e of entries) {
    if (e.supersedes_event_id) superseded.add(e.supersedes_event_id);
  }
  const byPerson = new Map();
  for (const e of entries) {
    if (superseded.has(e.event_id)) continue;
    const prior = byPerson.get(e.person_id);
    if (!prior || e.event_sequence > prior.event_sequence) byPerson.set(e.person_id, e);
  }
  return byPerson;
}

module.exports = {
  GENESIS, CHOICES,
  canonical, payloadHash, entryHash, sign, buildEntry, verifyChain, currentChoices,
};
