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

/**
 * A fresh element id. 17 random characters over a 62-character alphabet is
 * ~101 bits of entropy — collision risk stays negligible across every element
 * of every document this system will ever hold.
 */
export function newId(prefix = 'ec'): string {
  const bytes = randomBytes(17);
  let out = prefix;
  for (const byte of bytes) {
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/** True if `value` is well-formed as an XML id we would have issued. */
export function isValidId(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}
