'use strict';

// Microsoft Entra ID (Azure AD) single sign-on via the OpenID Connect
// authorization-code flow. No external dependencies: uses global fetch
// (Node >= 18) and node:crypto for id_token signature verification.
//
// Configure via environment:
//   ENTRA_TENANT_ID      tenant GUID or domain (or 'organizations'/'common')
//   ENTRA_CLIENT_ID      app registration (client) id
//   ENTRA_CLIENT_SECRET  client secret
//   ENTRA_REDIRECT_URI   optional; defaults to <baseUrl>/auth/sso/callback
//   SSO_AUTO_PROVISION_ROLE  optional role for first-time SSO users (see auth.js)

const crypto = require('node:crypto');

const TENANT = process.env.ENTRA_TENANT_ID || '';
const CLIENT_ID = process.env.ENTRA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET || '';
const SCOPE = 'openid profile email';

function isConfigured() {
  return Boolean(TENANT && CLIENT_ID && CLIENT_SECRET);
}

function redirectUri(baseUrl) {
  return process.env.ENTRA_REDIRECT_URI || `${baseUrl}/auth/sso/callback`;
}

// --- Short-lived login state (state -> { nonce, next }) ---------------------
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function rememberState(next) {
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  pending.set(state, { nonce, next: next || '', created: Date.now() });
  return { state, nonce };
}

function consumeState(state) {
  const s = pending.get(state);
  if (!s) return null;
  pending.delete(state);
  if (Date.now() - s.created > STATE_TTL_MS) return null;
  return s;
}

// --- OIDC discovery + JWKS (cached) -----------------------------------------
let discoveryCache = null;
let discoveryAt = 0;
const jwksCache = new Map(); // kid -> JWK
let jwksAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function discovery() {
  if (discoveryCache && Date.now() - discoveryAt < CACHE_TTL_MS) return discoveryCache;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(TENANT)}/v2.0/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  discoveryCache = await res.json();
  discoveryAt = Date.now();
  return discoveryCache;
}

async function getSigningKey(kid) {
  if (jwksCache.has(kid) && Date.now() - jwksAt < CACHE_TTL_MS) return jwksCache.get(kid);
  const conf = await discovery();
  const res = await fetch(conf.jwks_uri);
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const { keys } = await res.json();
  jwksCache.clear();
  for (const k of keys || []) jwksCache.set(k.kid, k);
  jwksAt = Date.now();
  return jwksCache.get(kid);
}

// --- Authorize URL ----------------------------------------------------------
async function authorizeUrl({ baseUrl, state, nonce }) {
  const conf = await discovery();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(baseUrl),
    response_mode: 'query',
    scope: SCOPE,
    state,
    nonce,
  });
  return `${conf.authorization_endpoint}?${params.toString()}`;
}

// --- Code exchange ----------------------------------------------------------
async function exchangeCode({ code, baseUrl }) {
  const conf = await discovery();
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(baseUrl),
    scope: SCOPE,
  });
  const res = await fetch(conf.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${json.error_description || json.error || ''}`);
  return json;
}

function b64urlToBuf(s) {
  return Buffer.from(s, 'base64url');
}
function b64urlToJson(s) {
  return JSON.parse(b64urlToBuf(s).toString('utf8'));
}

// Verify an id_token's signature (RS256 against Entra JWKS) and core claims.
// Returns the decoded payload (claims) on success; throws otherwise.
async function verifyIdToken(idToken, { nonce } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const [h, p, s] = parts;
  const header = b64urlToJson(h);
  if (header.alg !== 'RS256') throw new Error(`Unexpected token alg: ${header.alg}`);
  const jwk = await getSigningKey(header.kid);
  if (!jwk) throw new Error('No matching signing key');
  const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pubKey, b64urlToBuf(s));
  if (!ok) throw new Error('id_token signature verification failed');

  const claims = b64urlToJson(p);
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now > claims.exp + 60) throw new Error('id_token expired');
  if (claims.nbf && now < claims.nbf - 60) throw new Error('id_token not yet valid');
  if (claims.aud !== CLIENT_ID) throw new Error('id_token audience mismatch');
  const conf = await discovery();
  // For a concrete tenant the discovery issuer is exact; 'common'/'organizations'
  // leave a {tenantid} template, in which case we only assert the host.
  if (conf.issuer && !conf.issuer.includes('{tenantid}')) {
    if (claims.iss !== conf.issuer) throw new Error('id_token issuer mismatch');
  } else if (!String(claims.iss || '').startsWith('https://login.microsoftonline.com/')) {
    throw new Error('id_token issuer mismatch');
  }
  if (nonce && claims.nonce !== nonce) throw new Error('id_token nonce mismatch');
  return claims;
}

// Map verified claims to the identity fields auth.ssoSignIn expects.
function identityFromClaims(claims) {
  return {
    subject: claims.oid || claims.sub,
    email: (claims.email || claims.preferred_username || claims.upn || '').toLowerCase() || null,
    name: claims.name || claims.preferred_username || null,
  };
}

module.exports = {
  isConfigured, redirectUri, rememberState, consumeState,
  authorizeUrl, exchangeCode, verifyIdToken, identityFromClaims,
};
