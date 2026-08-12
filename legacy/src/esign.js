'use strict';

// Adobe Acrobat Sign adapter — sends a document for signature and reports back
// each participant's status. No SDK: plain REST v6 over Node's global fetch.
// Everything is a no-op until ADOBE_SIGN_* is configured, so the written-consent
// flow runs (with in-app signing) whether or not a provider is wired up.
//
// Flow: OAuth refresh → upload a transient document → create an agreement with
// one parallel signer per director → later, read members to sync statuses, and
// fetch the combined (executed) PDF once complete.
//
// Config (set as Fly secrets, never in code):
//   ADOBE_SIGN_BASE_URI       e.g. https://api.na1.adobesign.com
//   ADOBE_SIGN_CLIENT_ID
//   ADOBE_SIGN_CLIENT_SECRET
//   ADOBE_SIGN_REFRESH_TOKEN
//   ADOBE_SIGN_WEBHOOK_CLIENT_ID  (optional; defaults to client id for the handshake)

const { db } = require('./db');

const PROVIDER = 'adobe';
// Requested OAuth scopes (adjustable from the admin form to match your Adobe
// API application). Account-level so a clerk-admin can send org agreements.
const DEFAULT_SCOPES = 'agreement_send:account agreement_read:account agreement_write:account webhook_write:account';

// In-app configuration lives in the settings table under "adobe.*" (set via the
// admin Connect flow); environment variables are the fallback.
function fromSettings() {
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'adobe.%'").all();
    const s = {};
    for (const r of rows) s[r.key.slice(6)] = r.value;
    return s;
  } catch (_) { return {}; }
}
function putSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run('adobe.' + key, value == null ? '' : String(value));
}
function delSetting(key) { db.prepare('DELETE FROM settings WHERE key = ?').run('adobe.' + key); }

function config(env = process.env) {
  const s = fromSettings();
  return {
    baseUri: String(s.base_uri || env.ADOBE_SIGN_BASE_URI || '').replace(/\/+$/, ''),
    region: s.region || env.ADOBE_SIGN_REGION || '',
    clientId: s.client_id || env.ADOBE_SIGN_CLIENT_ID || '',
    clientSecret: s.client_secret || env.ADOBE_SIGN_CLIENT_SECRET || '',
    refreshToken: s.refresh_token || env.ADOBE_SIGN_REFRESH_TOKEN || '',
    scopes: s.scopes || DEFAULT_SCOPES,
    webhookClientId: s.webhook_client_id || env.ADOBE_SIGN_WEBHOOK_CLIENT_ID || s.client_id || env.ADOBE_SIGN_CLIENT_ID || '',
  };
}

function isConfigured(env = process.env) {
  const c = config(env);
  return !!(c.baseUri && c.clientId && c.clientSecret && c.refreshToken);
}

// The client id Adobe echoes during the webhook intent-verification handshake
// and stamps on every delivery; the endpoint must echo it back.
function webhookClientId(env = process.env) {
  return config(env).webhookClientId;
}

// --- Access token (refresh grant, cached until shortly before expiry) --------
let _token = { value: '', exp: 0 };

async function accessToken(env = process.env) {
  const c = config(env);
  const now = Date.now();
  if (_token.value && now < _token.exp - 60000) return _token.value;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
  });
  const res = await fetch(c.baseUri + '/oauth/v2/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Adobe Sign token refresh failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const json = await res.json();
  _token = { value: json.access_token, exp: now + (Number(json.expires_in) || 3600) * 1000 };
  return _token.value;
}

function authHeaders(token) { return { Authorization: 'Bearer ' + token }; }

// --- Transient document upload (multipart) ----------------------------------
async function uploadTransientDocument(token, name, bytes, env = process.env) {
  const c = config(env);
  const form = new FormData();
  form.append('File-Name', name);
  form.append('Mime-Type', 'application/pdf');
  form.append('File', new Blob([bytes], { type: 'application/pdf' }), name);
  const res = await fetch(c.baseUri + '/api/rest/v6/transientDocuments', {
    method: 'POST', headers: authHeaders(token), body: form, signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('Adobe Sign transient upload failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return (await res.json()).transientDocumentId;
}

// --- Agreement creation ------------------------------------------------------
// Each director is their own participant set at order 1, so they sign in
// parallel (unanimous consent, no fixed order).
async function createAgreement(token, { name, transientDocumentId, signers }, env = process.env) {
  const c = config(env);
  const participantSetsInfo = signers
    .filter((s) => s.email)
    .map((s) => ({ memberInfos: [{ email: s.email }], order: 1, role: 'SIGNER' }));
  const payload = {
    fileInfos: [{ transientDocumentId }],
    name: name,
    participantSetsInfo,
    signatureType: 'ESIGN',
    state: 'IN_PROCESS',
  };
  const res = await fetch(c.baseUri + '/api/rest/v6/agreements', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(token)),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('Adobe Sign agreement create failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return (await res.json()).id;
}

// Send a document for signature. Returns { provider, agreementId }.
async function sendForSignature({ name, pdfBytes, signers }, env = process.env) {
  if (!isConfigured(env)) throw new Error('Adobe Sign is not configured');
  const token = await accessToken(env);
  const transientDocumentId = await uploadTransientDocument(token, (name || 'Consent') + '.pdf', pdfBytes, env);
  const agreementId = await createAgreement(token, { name, transientDocumentId, signers }, env);
  return { provider: PROVIDER, agreementId };
}

// --- Status sync -------------------------------------------------------------
// Maps Adobe participant status to ours: SIGNED/COMPLETED → Signed,
// DECLINED/RECALLED → Declined, anything else → Pending.
function mapMemberStatus(adobe) {
  var s = String(adobe || '').toUpperCase();
  if (s === 'SIGNED' || s === 'COMPLETED' || s === 'APPROVED' || s === 'ACCEPTED') return 'Signed';
  if (s === 'DECLINED' || s === 'RECALLED' || s === 'EXPIRED') return 'Declined';
  return 'Pending';
}

// Returns [{ email, status }] for each signer on the agreement.
async function agreementMembers(agreementId, env = process.env) {
  if (!isConfigured(env)) throw new Error('Adobe Sign is not configured');
  const c = config(env);
  const token = await accessToken(env);
  const res = await fetch(c.baseUri + '/api/rest/v6/agreements/' + encodeURIComponent(agreementId) + '/members', {
    headers: authHeaders(token), signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Adobe Sign members fetch failed: ' + res.status);
  const json = await res.json();
  const out = [];
  (json.participantSets || []).forEach(function (ps) {
    (ps.memberInfos || []).forEach(function (m) {
      if (m.email) out.push({ email: String(m.email).toLowerCase(), status: mapMemberStatus(m.status || ps.status) });
    });
  });
  return out;
}

// The executed PDF (all pages + audit trail) once complete.
async function combinedDocument(agreementId, env = process.env) {
  if (!isConfigured(env)) throw new Error('Adobe Sign is not configured');
  const c = config(env);
  const token = await accessToken(env);
  const res = await fetch(c.baseUri + '/api/rest/v6/agreements/' + encodeURIComponent(agreementId) + '/combinedDocument', {
    headers: authHeaders(token), signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('Adobe Sign combinedDocument failed: ' + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

// --- In-app OAuth "Connect" flow --------------------------------------------
// The admin saves the API app's client id/secret + region, clicks Connect
// (authorize at Adobe), and the callback exchanges the code for a long-lived
// refresh token — no manual token juggling.

function resetToken() { _token = { value: '', exp: 0 }; }

// Persist the API-application credentials from the admin form.
function saveCredentials({ clientId, clientSecret, region, scopes, webhookClientId }) {
  if (clientId != null) putSetting('client_id', clientId.trim());
  if (clientSecret != null && clientSecret !== '') putSetting('client_secret', clientSecret.trim());
  if (region != null) {
    const r = region.trim();
    putSetting('region', r);
    if (r) putSetting('base_uri', `https://api.${r}.adobesign.com`);
  }
  putSetting('scopes', (scopes && scopes.trim()) || DEFAULT_SCOPES);
  if (webhookClientId != null) putSetting('webhook_client_id', webhookClientId.trim());
  resetToken();
}

// The authorize URL to send the admin to (region-specific host).
function authorizeUrl({ redirectUri, state }, env = process.env) {
  const c = config(env);
  const region = c.region || 'na1';
  const params = new URLSearchParams({
    redirect_uri: redirectUri, response_type: 'code', client_id: c.clientId, scope: c.scopes, state,
  });
  return `https://secure.${region}.adobesign.com/public/oauth/v2?${params.toString()}`;
}

// Exchange the authorization code for tokens. Adobe returns the correct API
// base in `apiAccessPoint`; we store it so later calls hit the right shard.
async function exchangeCode({ code, redirectUri, apiAccessPoint }, env = process.env) {
  const c = config(env);
  const base = String(apiAccessPoint || c.baseUri || `https://api.${c.region || 'na1'}.adobesign.com`).replace(/\/+$/, '');
  const body = new URLSearchParams({
    grant_type: 'authorization_code', client_id: c.clientId, client_secret: c.clientSecret,
    redirect_uri: redirectUri, code,
  });
  const res = await fetch(base + '/oauth/v2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Adobe token exchange failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const json = await res.json();
  if (!json.refresh_token) throw new Error('Adobe token exchange returned no refresh_token');
  putSetting('refresh_token', json.refresh_token);
  putSetting('base_uri', base);
  resetToken();
  return json;
}

function disconnect() { delSetting('refresh_token'); resetToken(); }

// Whether credentials are saved and whether we hold a refresh token.
function status(env = process.env) {
  const c = config(env);
  return {
    hasCredentials: !!(c.clientId && c.clientSecret),
    connected: !!c.refreshToken,
    region: c.region,
    baseUri: c.baseUri,
    scopes: c.scopes,
    webhookClientId: c.webhookClientId,
    clientId: c.clientId,
  };
}

module.exports = {
  PROVIDER, config, isConfigured, webhookClientId, accessToken,
  sendForSignature, agreementMembers, combinedDocument, mapMemberStatus,
  saveCredentials, authorizeUrl, exchangeCode, disconnect, status,
  _resetTokenCacheForTests: resetToken,
};
