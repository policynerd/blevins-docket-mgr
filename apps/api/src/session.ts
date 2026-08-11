import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed, self-contained session tokens.
 *
 * A token is `<base64url payload>.<base64url hmac>`. The payload carries the
 * user id and an absolute expiry; the HMAC covers the payload, so neither can
 * be changed without the key.
 *
 * The expiry lives *inside* the signed payload rather than relying on the
 * cookie's Max-Age. A cookie's lifetime is enforced by the browser, which is
 * the one party in this exchange with an interest in ignoring it — a saved
 * cookie replayed after its Max-Age is a perfectly ordinary HTTP request. Only
 * the signed `exp` actually ends a session.
 *
 * This is deliberately not JWT. Nothing here needs to be read by another
 * party, and a format with a caller-supplied `alg` field is a liability when
 * the only algorithm we will ever accept is this one.
 */

/** How long a sign-in lasts. Long enough for a working day, short enough that a lifted cookie expires. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** The temporary cookie that carries PKCE state between /login and /callback. */
export const LOGIN_TTL_MS = 10 * 60 * 1000;

export const SESSION_COOKIE = 'bog_session';
export const LOGIN_COOKIE = 'bog_login';

const b64 = (b: Buffer) => b.toString('base64url');

/**
 * The signing key.
 *
 * Refuses a short one. A 16-character secret typed by hand is guessable, and a
 * session forgery here is not a leak of one account but the ability to act as
 * any governor on the record — so the weak case fails at startup rather than
 * quietly accepting a key that cannot carry the weight.
 */
export function sessionSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env['SESSION_SECRET'];
  if (!raw || raw.length < 32) {
    throw new Error(
      'SESSION_SECRET must be set to at least 32 characters. Generate one with `openssl rand -base64 32`.',
    );
  }
  return Buffer.from(raw, 'utf8');
}

function sign(key: Buffer, payload: string): string {
  return b64(createHmac('sha256', key).update(payload).digest());
}

/** Compare two signatures without leaking where they first differ. */
function sameSignature(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // length oracle if it escaped. A different length is simply not a match.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface SessionClaims {
  /** The local users.id this session speaks for. */
  uid: string;
  /** Absolute expiry, epoch milliseconds. */
  exp: number;
}

export function mintSession(key: Buffer, uid: string, now = Date.now()): string {
  return mintToken(key, { uid, exp: now + SESSION_TTL_MS });
}

export function mintToken<T extends { exp: number }>(key: Buffer, claims: T): string {
  const payload = b64(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${payload}.${sign(key, payload)}`;
}

/**
 * Read a token back, or null.
 *
 * Every failure returns null rather than throwing a distinguishable error.
 * The caller has exactly one correct response to a bad token — refuse — and
 * telling an attacker whether their forgery failed on the signature or on the
 * expiry hands them a way to work out which half to keep guessing at.
 */
export function readToken<T extends { exp: number }>(
  key: Buffer,
  token: string | undefined,
  now = Date.now(),
): T | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!sameSignature(signature, sign(key, payload))) return null;

  let claims: T;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
  if (typeof claims?.exp !== 'number' || claims.exp <= now) return null;
  return claims;
}

export const readSession = (key: Buffer, token: string | undefined, now = Date.now()) =>
  readToken<SessionClaims>(key, token, now);

/** State carried across the redirect to Entra and back. */
export interface LoginClaims {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

export const newSecretValue = () => randomBytes(32).toString('base64url');

/**
 * Where to send someone after they sign in.
 *
 * Only a path on this site. A `returnTo` is attacker-supplied — it arrives in
 * the query string of a link anyone can send — and echoing it into a redirect
 * without this check turns the sign-in page into an open redirect, which is
 * the standard way a phishing link is made to look like it came from us.
 *
 * `//evil.example` and `/\evil.example` are both protocol-relative to a
 * browser, so a leading slash alone is not enough.
 */
export function safeReturnTo(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}
