import { randomBytes } from 'node:crypto';

// Element identifiers.
//
// Every structural element in an AKN document carries an id, and those ids are
// the anchor for everything built on top of the text: a comment pinned to a
// recital, a cross-reference to an article, an amending instruction targeting a
// subsection, a track-changes entry. They therefore have to survive editing —
// an id that is derived from position ("article 3") breaks the moment an
// article is inserted above it, silently repointing every reference.
//
// So ids are opaque and random, assigned once at creation and never recomputed.
// The `ec` prefix follows LEOS's own convention and keeps ids valid as XML
// NCNames, which may not begin with a digit.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const ID_LENGTH = 17;

/**
 * The largest multiple of the alphabet size that fits in a byte: 62 × 4 = 248.
 * Bytes at or above it are discarded rather than folded in.
 *
 * Taking `byte % 62` directly would be biased, because 256 is not a multiple of
 * 62: residues 0–7 arise from five source bytes each while 8–61 arise from only
 * four, so the first eight characters of the alphabet turn up ~25% more often.
 * That quietly costs entropy, and entropy is the whole argument for these ids
 * being collision-free. Rejection sampling keeps every character equally
 * likely; it costs an occasional extra byte and nothing else.
 */
const UNBIASED_LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

/**
 * A fresh element id. 17 characters drawn uniformly from a 62-character
 * alphabet is ~101 bits of entropy — collision risk stays negligible across
 * every element of every document this system will ever hold.
 */
export function newId(prefix = 'ec'): string {
  let out = prefix;
  while (out.length < prefix.length + ID_LENGTH) {
    // Over-draw so the common case needs a single call into the CSPRNG even
    // after a few bytes are rejected.
    for (const byte of randomBytes(ID_LENGTH)) {
      if (byte >= UNBIASED_LIMIT) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === prefix.length + ID_LENGTH) break;
    }
  }
  return out;
}

/** True if `value` is well-formed as an XML id we would have issued. */
export function isValidId(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}
