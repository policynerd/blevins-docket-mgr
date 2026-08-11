import { createHash, randomBytes } from 'node:crypto';

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/**
 * Microsoft Entra ID sign-in, authorization-code flow with PKCE.
 *
 * We ask Entra for one thing — an ID token proving who is at the keyboard —
 * and then forget about it. No access token is requested, nothing is called on
 * the caller's behalf, and no Entra token is stored: the ID token is verified
 * once and exchanged for our own session. Holding a Graph token we never use
 * would be a credential to steal for no benefit.
 */

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Must match a redirect URI registered on the app registration, exactly. */
  redirectUri: string;
}

/**
 * Read the configuration, or null if this deployment has no Entra wired up.
 *
 * The names are ENTRA_*, matching the application this replaces. Both run on
 * the same Fly app against the same app registration, so reusing the names
 * means one set of secrets rather than two copies of the same three values
 * drifting apart — and it means a rollback to the old application still has
 * working sign-in, which a renamed secret would quietly have broken.
 *
 * AZURE_* is accepted as an alias because that is what most Microsoft
 * documentation calls these.
 */
export function entraConfig(env: NodeJS.ProcessEnv = process.env): EntraConfig | null {
  const tenantId = env['ENTRA_TENANT_ID'] ?? env['AZURE_TENANT_ID'];
  const clientId = env['ENTRA_CLIENT_ID'] ?? env['AZURE_CLIENT_ID'];
  const clientSecret = env['ENTRA_CLIENT_SECRET'] ?? env['AZURE_CLIENT_SECRET'];
  const base = env['APP_BASE_URL'];
  if (!tenantId || !clientId || !clientSecret || !base) return null;
  return {
    tenantId,
    clientId,
    clientSecret,
    redirectUri: new URL('/api/auth/callback', base).toString(),
  };
}

const authority = (tenantId: string) => `https://login.microsoftonline.com/${tenantId}`;

export const issuerFor = (tenantId: string) => `${authority(tenantId)}/v2.0`;
export const authorizeEndpoint = (tenantId: string) =>
  `${authority(tenantId)}/oauth2/v2.0/authorize`;
export const tokenEndpoint = (tenantId: string) => `${authority(tenantId)}/oauth2/v2.0/token`;
export const jwksUri = (tenantId: string) => `${authority(tenantId)}/discovery/v2.0/keys`;
export const logoutEndpoint = (tenantId: string) => `${authority(tenantId)}/oauth2/v2.0/logout`;

/** PKCE S256: the verifier is the secret, the challenge is what we show Entra. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizeUrl(
  config: EntraConfig,
  args: { state: string; nonce: string; challenge: string },
): string {
  const url = new URL(authorizeEndpoint(config.tenantId));
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    response_mode: 'query',
    // Identity only. `offline_access` is omitted on purpose: a refresh token
    // is a long-lived credential, and our session already has its own expiry.
    scope: 'openid profile email',
    state: args.state,
    nonce: args.nonce,
    code_challenge: args.challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export interface TokenResponse {
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Redeem the authorization code. Confidential client: secret *and* PKCE. */
export async function exchangeCode(
  config: EntraConfig,
  args: { code: string; verifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(tokenEndpoint(config.tenantId), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: config.redirectUri,
      code_verifier: args.verifier,
    }).toString(),
  });

  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.id_token) {
    // `error_description` from Entra embeds correlation ids and the app
    // registration's own configuration. Useful in a log, not in a response.
    throw new EntraError(body.error ?? `token endpoint returned ${res.status}`);
  }
  return body.id_token;
}

export class EntraError extends Error {}

/** Claims we require, beyond what a signature proves. */
export interface Identity {
  /** Entra object id — stable across renames, unlike an address. */
  oid: string;
  email: string;
  name: string;
}

let cachedKeys: { tenantId: string; keys: JWTVerifyGetKey } | null = null;

/**
 * The tenant's signing keys.
 *
 * `createRemoteJWKSet` caches and refreshes on an unknown `kid`, so key
 * rollover is handled without a restart. Cached per tenant because building a
 * fresh set on every sign-in would refetch the JWKS on every sign-in.
 */
function keysFor(tenantId: string): JWTVerifyGetKey {
  if (cachedKeys?.tenantId !== tenantId) {
    cachedKeys = { tenantId, keys: createRemoteJWKSet(new URL(jwksUri(tenantId))) };
  }
  return cachedKeys.keys;
}

/**
 * Verify an ID token and pull out who it says signed in.
 *
 * The checks that are not optional:
 *
 *   - `RS256` only, pinned. Accepting whatever the token's header asks for is
 *     the alg-confusion hole; `none` and HMAC-with-the-public-key both walk
 *     straight through a verifier that trusts that field.
 *   - `iss` and `aud`, enforced by jose.
 *   - `tid` equal to our tenant. This is the one that matters most and the one
 *     most often left out: if the app registration is ever switched to
 *     multi-tenant — a single dropdown in the portal — then without this check
 *     a validly signed token from *any* Microsoft tenant on earth is accepted,
 *     and anyone with a free account can mint one. The check costs a line and
 *     removes the possibility.
 *   - `nonce` equal to the one we generated. Without it a token captured from
 *     another sign-in can be replayed into ours.
 */
export async function verifyIdToken(
  token: string,
  config: EntraConfig,
  expectedNonce: string,
  keys: JWTVerifyGetKey = keysFor(config.tenantId),
): Promise<Identity> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: issuerFor(config.tenantId),
      audience: config.clientId,
      clockTolerance: 60,
    }));
  } catch (err) {
    throw new EntraError(`ID token rejected: ${(err as Error).message}`);
  }

  if (payload['tid'] !== config.tenantId) {
    throw new EntraError('ID token is from another tenant');
  }
  if (typeof payload['nonce'] !== 'string' || payload['nonce'] !== expectedNonce) {
    throw new EntraError('ID token nonce does not match this sign-in');
  }

  const oid = payload['oid'];
  if (typeof oid !== 'string' || oid.length === 0) {
    throw new EntraError('ID token carries no object id');
  }

  // `email` is only present when the account has one set; `preferred_username`
  // is the UPN and is what Entra populates for work accounts.
  const email = [payload['email'], payload['preferred_username']].find(
    (v): v is string => typeof v === 'string' && v.includes('@'),
  );
  if (!email) throw new EntraError('ID token carries no email address');

  const name = typeof payload['name'] === 'string' ? payload['name'] : email;
  return { oid, email: email.toLowerCase(), name };
}

/** Where to send a browser to end the Entra session too, not just ours. */
export function logoutUrl(config: EntraConfig, postLogoutRedirect: string): string {
  const url = new URL(logoutEndpoint(config.tenantId));
  url.search = new URLSearchParams({ post_logout_redirect_uri: postLogoutRedirect }).toString();
  return url.toString();
}
