import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sql } from 'drizzle-orm';
import { connect, users, type Db } from '@blevins/db';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../src/server.ts';
import { devLoginGuard, resolveUser } from '../src/auth.ts';
import {
  EntraError,
  authorizeUrl,
  exchangeCode,
  pkcePair,
  verifyIdToken,
  type EntraConfig,
} from '../src/entra.ts';
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  mintSession,
  mintToken,
  readSession,
  readToken,
  safeReturnTo,
  sessionSecret,
} from '../src/session.ts';
import { signedIn, testSecret } from './helpers.ts';
import { shutdown } from '@blevins/pdf';

/* ------------------------------------------------------------- session ---- */

describe('session tokens', () => {
  const key = Buffer.from('a'.repeat(32), 'utf8');
  const other = Buffer.from('b'.repeat(32), 'utf8');
  const uid = '11111111-1111-1111-1111-111111111111';

  test('a token round-trips the user it was minted for', () => {
    assert.equal(readSession(key, mintSession(key, uid))?.uid, uid);
  });

  test('a token signed with another key is refused', () => {
    assert.equal(readSession(key, mintSession(other, uid)), null);
  });

  test('the payload cannot be edited without the key', () => {
    const token = mintSession(key, uid);
    const [payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    claims.uid = '22222222-2222-2222-2222-222222222222';
    const swapped = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;

    assert.equal(readSession(key, swapped), null, 'a rewritten user id was accepted');
  });

  test('an expired token is refused however well signed', () => {
    // Correctly signed, genuinely ours, simply over. This is the check a
    // client-side Max-Age cannot make.
    const expired = mintToken(key, { uid, exp: Date.now() - 1 });
    assert.equal(readSession(key, expired), null);
  });

  test('malformed input is refused rather than thrown at the caller', () => {
    for (const bad of ['', 'nodot', '.', '.sig', 'a.b', Buffer.from('{}').toString('base64url')]) {
      assert.equal(readSession(key, bad), null, `accepted ${JSON.stringify(bad)}`);
    }
    assert.equal(readSession(key, undefined), null);
  });

  test('a weak signing key is refused at startup', () => {
    assert.throws(() => sessionSecret({ SESSION_SECRET: 'short' }), /at least 32/);
    assert.throws(() => sessionSecret({}), /SESSION_SECRET/);
    assert.doesNotThrow(() => sessionSecret({ SESSION_SECRET: 'x'.repeat(32) }));
  });
});

describe('returnTo', () => {
  test('only same-site paths survive', () => {
    assert.equal(safeReturnTo('/proposals/7'), '/proposals/7');
    assert.equal(safeReturnTo('/'), '/');
  });

  test('an off-site redirect is discarded', () => {
    // `//host` and `/\host` are protocol-relative: a browser treats both as
    // another origin, so "starts with a slash" is not the test.
    for (const hostile of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '',
      undefined,
      42,
    ]) {
      assert.equal(safeReturnTo(hostile), '/', `followed ${String(hostile)}`);
    }
  });
});

/* --------------------------------------------------------------- entra ---- */

describe('ID token verification', () => {
  const config: EntraConfig = {
    tenantId: '83ff87c7-db98-4775-939b-a58a5eb0f051',
    clientId: 'fdf8499c-7535-4112-aa06-149d5be2c722',
    clientSecret: 'not-used-for-verification',
    redirectUri: 'https://example.test/api/auth/callback',
  };
  const nonce = 'the-nonce';

  /** Everything a genuine Entra token would carry; override one thing per test. */
  interface TokenParts {
    claims?: Record<string, unknown>;
    issuer?: string;
    audience?: string;
    expires?: string | number;
    key?: CryptoKey;
  }

  let sign: (parts?: TokenParts) => Promise<string>;
  let keys: JWTVerifyGetKey;
  let strangerKey: CryptoKey;

  before(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    jwk.alg = 'RS256';
    keys = createLocalJWKSet({ keys: [jwk] });
    strangerKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;

    sign = (parts = {}) =>
      new SignJWT({
        tid: config.tenantId,
        nonce,
        oid: 'aaaaaaaa-0000-0000-0000-000000000001',
        preferred_username: 'Benjamin.Blevins@blevinsholdings.com',
        name: 'Benjamin Blevins',
        ...parts.claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(parts.issuer ?? `https://login.microsoftonline.com/${config.tenantId}/v2.0`)
        .setAudience(parts.audience ?? config.clientId)
        .setIssuedAt()
        .setExpirationTime(parts.expires ?? '5m')
        .sign(parts.key ?? (privateKey as CryptoKey));
  });

  test('a well-formed token yields the identity, lower-cased', async () => {
    const identity = await verifyIdToken(await sign(), config, nonce, keys);
    assert.deepEqual(identity, {
      oid: 'aaaaaaaa-0000-0000-0000-000000000001',
      email: 'benjamin.blevins@blevinsholdings.com',
      name: 'Benjamin Blevins',
    });
  });

  test('a token from another tenant is refused', async () => {
    // The one that matters. Flip the app registration to multi-tenant — one
    // dropdown in the portal — and without this check any Microsoft account in
    // the world presents a validly signed token.
    const foreign = await sign({ claims: { tid: '00000000-1111-2222-3333-444444444444' } });
    await assert.rejects(
      () => verifyIdToken(foreign, config, nonce, keys),
      (e: Error) => e instanceof EntraError && /another tenant/.test(e.message),
    );
  });

  test('a token minted for a different sign-in is refused', async () => {
    const replayed = await sign({ claims: { nonce: 'someone-elses' } });
    await assert.rejects(() => verifyIdToken(replayed, config, nonce, keys), /nonce/);

    const missing = await sign({ claims: { nonce: undefined } });
    await assert.rejects(() => verifyIdToken(missing, config, nonce, keys), /nonce/);
  });

  test('a token for another application is refused', async () => {
    // Same signing key, same tenant, same nonce — only `aud` differs, so this
    // can only pass or fail on the audience check.
    const wrongAudience = await sign({ audience: 'some-other-client-id' });
    await assert.rejects(() => verifyIdToken(wrongAudience, config, nonce, keys), EntraError);
  });

  test('a token from an issuer imitating the tenant is refused', async () => {
    const wrongIssuer = await sign({ issuer: 'https://login.microsoftonline.com/other/v2.0' });
    await assert.rejects(() => verifyIdToken(wrongIssuer, config, nonce, keys), EntraError);
  });

  test('a token signed by someone else is refused', async () => {
    // Correct issuer, audience, tenant and nonce, and it even claims our `kid`.
    // Only the signature is wrong, which is the entire point of checking it.
    const forged = await sign({ key: strangerKey });
    await assert.rejects(() => verifyIdToken(forged, config, nonce, keys), EntraError);
  });

  test('an expired token is refused', async () => {
    const stale = await sign({ expires: Math.floor(Date.now() / 1000) - 3600 });
    await assert.rejects(() => verifyIdToken(stale, config, nonce, keys), EntraError);
  });

  test('a token carrying no address is refused rather than half-identified', async () => {
    const anonymous = await sign({ claims: { preferred_username: undefined, email: undefined } });
    await assert.rejects(() => verifyIdToken(anonymous, config, nonce, keys), /no email/);
  });

  test('a token carrying no object id is refused', async () => {
    const noOid = await sign({ claims: { oid: undefined } });
    await assert.rejects(() => verifyIdToken(noOid, config, nonce, keys), /object id/);
  });
});

describe('the authorization request', () => {
  const config: EntraConfig = {
    tenantId: 'tenant',
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://example.test/api/auth/callback',
  };

  test('PKCE sends the hash and keeps the verifier', () => {
    const { verifier, challenge } = pkcePair();
    assert.notEqual(verifier, challenge, 'the verifier was sent in the clear');
    const url = new URL(authorizeUrl(config, { state: 's', nonce: 'n', challenge }));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), challenge);
    assert.ok(!url.search.includes(verifier), 'the verifier leaked into the redirect');
  });

  test('no long-lived credential is requested', () => {
    const url = new URL(authorizeUrl(config, { state: 's', nonce: 'n', challenge: 'c' }));
    const scope = url.searchParams.get('scope') ?? '';
    assert.ok(!scope.includes('offline_access'), 'asked for a refresh token it does not use');
    assert.equal(url.searchParams.get('response_type'), 'code');
  });

  test('the code exchange presents both the secret and the verifier', async () => {
    let sent: URLSearchParams | null = null;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = new URLSearchParams(String(init.body));
      return new Response(JSON.stringify({ id_token: 'a.b.c' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const token = await exchangeCode(config, { code: 'the-code', verifier: 'the-verifier' }, fake);
    assert.equal(token, 'a.b.c');
    assert.equal(sent!.get('client_secret'), 'secret');
    assert.equal(sent!.get('code_verifier'), 'the-verifier');
    assert.equal(sent!.get('grant_type'), 'authorization_code');
  });

  test('a refused exchange does not surface Entra internals', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'AADSTS70008: correlation 1234 tenant contoso.onmicrosoft.com',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    await assert.rejects(
      () => exchangeCode(config, { code: 'c', verifier: 'v' }, fake),
      (e: Error) => e instanceof EntraError && !/AADSTS|correlation|onmicrosoft/.test(e.message),
    );
  });
});

describe('the development sign-in', () => {
  test('production refuses to start with it enabled', () => {
    assert.throws(
      () => devLoginGuard({ allowDevLogin: true }, { NODE_ENV: 'production' }),
      /refusing to start/,
    );
  });

  test('it is allowed anywhere else, and absence is always fine', () => {
    assert.doesNotThrow(() => devLoginGuard({ allowDevLogin: true }, { NODE_ENV: 'development' }));
    assert.doesNotThrow(() => devLoginGuard({ allowDevLogin: false }, { NODE_ENV: 'production' }));
  });
});

/* ---------------------------------------------------------------- roster ---- */

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;

before(async () => {
  ({ db, close } = connect());
  app = buildServer(db);
  await app.ready();
});

after(async () => {
  await app.close();
  await shutdown();
  await close();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${users} RESTART IDENTITY CASCADE`);
});

const identity = (over: Partial<{ oid: string; email: string; name: string }> = {}) => ({
  oid: 'oid-1',
  email: 'benjamin.blevins@blevinsholdings.com',
  name: 'Benjamin Blevins',
  ...over,
});

describe('mapping an Entra identity onto the roster', () => {
  test('someone not on the roster is refused, not created', async () => {
    await assert.rejects(
      () => resolveUser(db, identity({ email: 'stranger@example.com' })),
      /roster/,
    );
    const rows = await db.select().from(users);
    assert.equal(rows.length, 0, 'a user row was created for an unrostered sign-in');
  });

  test('first sign-in binds the object id to the roster entry', async () => {
    await db.insert(users).values({ email: 'Benjamin.Blevins@blevinsholdings.com', name: 'BB' });
    const user = await resolveUser(db, identity());
    assert.equal(user.entraOid, 'oid-1');
    assert.ok(user.lastSeenAt, 'the sign-in was not recorded');
  });

  test('a renamed mailbox still resolves to the same person', async () => {
    await db.insert(users).values({ email: 'old.name@blevinsholdings.com', name: 'BB' });
    const first = await resolveUser(db, identity({ email: 'old.name@blevinsholdings.com' }));

    // Entra sends a new address; the object id is what has not changed.
    const second = await resolveUser(db, identity({ email: 'new.name@blevinsholdings.com' }));
    assert.equal(second.id, first.id, 'a rename detached the authorship history');
  });

  test('a recycled address is refused rather than silently rebound', async () => {
    await db
      .insert(users)
      .values({ email: 'seat@blevinsholdings.com', name: 'First Holder', entraOid: 'oid-1' });
    await assert.rejects(
      () => resolveUser(db, identity({ oid: 'oid-2', email: 'seat@blevinsholdings.com' })),
      /different account/,
    );
  });

  test('an unbound roster entry is matched case-insensitively', async () => {
    await db.insert(users).values({ email: 'MiXeD.CaSe@blevinsholdings.com', name: 'Mixed' });
    const user = await resolveUser(db, identity({ email: 'mixed.case@blevinsholdings.com' }));
    assert.equal(user.name, 'Mixed');
  });
});

describe('the sign-in routes', () => {
  test('sign-in is unavailable rather than broken when Entra is unconfigured', async () => {
    // The test server has no AZURE_* set, which is the deployment we must not
    // silently let people past.
    const res = await app.inject({ method: 'GET', url: '/auth/login' });
    assert.equal(res.statusCode, 503, res.body);
  });

  test('the development sign-in is invisible unless switched on', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/dev-login',
      payload: { email: 'clerk@blevinsholdings.com' },
    });
    assert.equal(res.statusCode, 404, 'dev sign-in answered on a server that did not enable it');
  });

  test('who-am-I needs a session and reports the roster entry', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/auth/me' });
    assert.equal(anonymous.statusCode, 401);

    const [user] = await db
      .insert(users)
      .values({ email: 'clerk@blevinsholdings.com', name: 'Brian Caldwell' })
      .returning();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: signedIn(user!.id),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().name, 'Brian Caldwell');
  });

  test('signing out clears the cookie', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'clerk@blevinsholdings.com', name: 'Clerk' })
      .returning();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: signedIn(user!.id),
    });
    assert.equal(res.statusCode, 200);
    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE);
    assert.ok(cleared, 'no cookie instruction was sent');
    assert.equal(cleared!.value, '', 'the session cookie was left in place');
  });

  test('removal from the roster ends a live session immediately', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'former@blevinsholdings.com', name: 'Former' })
      .returning();
    const cookie = signedIn(user!.id);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/auth/me', headers: cookie })).statusCode,
      200,
    );

    await db.execute(sql`TRUNCATE ${users} RESTART IDENTITY CASCADE`);

    // The cookie is still perfectly valid and unexpired. Access has to end
    // anyway — otherwise removing someone takes effect up to twelve hours late.
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: cookie });
    assert.equal(after.statusCode, 401, 'a removed user kept working access');
  });
});

/* ----------------------------------------------------- the full round trip ---- */

/**
 * The callback, driven against a token endpoint that would succeed.
 *
 * This is the only way the rejection paths mean anything. Pointed at the real
 * Microsoft endpoint, every one of these tests passes whether the check under
 * test is present or not, because the request fails regardless — so the test
 * would be measuring the absence of a network, not the presence of a check.
 */
describe('the sign-in round trip', () => {
  const TENANT = '83ff87c7-db98-4775-939b-a58a5eb0f051';
  const CLIENT = 'fdf8499c-7535-4112-aa06-149d5be2c722';

  let entraApp: FastifyInstance;
  let issueToken: (nonce: string, over?: Record<string, unknown>) => Promise<string>;
  /** What the stubbed token endpoint will hand back next. */
  let nextIdToken: string;
  let seated: string;

  before(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-key';
    jwk.alg = 'RS256';

    issueToken = (nonce, over = {}) =>
      new SignJWT({
        tid: TENANT,
        nonce,
        oid: 'oid-chair',
        preferred_username: 'benjamin.blevins@blevinsholdings.com',
        name: 'Benjamin Blevins',
        ...over,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
        .setAudience(CLIENT)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey as CryptoKey);

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id_token: nextIdToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    entraApp = buildServer(
      db,
      {
        ...process.env,
        AZURE_TENANT_ID: TENANT,
        AZURE_CLIENT_ID: CLIENT,
        AZURE_CLIENT_SECRET: 'stubbed-for-tests',
        APP_BASE_URL: 'https://board.example.test',
      },
      { fetchImpl, keys: createLocalJWKSet({ keys: [jwk] }) },
    );
    await entraApp.ready();
  });

  after(async () => {
    await entraApp.close();
  });

  beforeEach(async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'benjamin.blevins@blevinsholdings.com', name: 'Benjamin Blevins' })
      .returning();
    seated = user!.id;
  });

  /** Start a sign-in and keep what the browser would keep. */
  async function beginSignIn(returnTo = '/proposals') {
    const res = await entraApp.inject({
      method: 'GET',
      url: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    });
    assert.equal(res.statusCode, 302, res.body);
    const redirect = new URL(res.headers.location as string);
    const loginCookie = res.cookies.find((c) => c.name === LOGIN_COOKIE);
    assert.ok(loginCookie, 'no login cookie was set');
    return {
      state: redirect.searchParams.get('state')!,
      nonce: redirect.searchParams.get('nonce')!,
      redirect,
      cookie: { cookie: `${LOGIN_COOKIE}=${loginCookie!.value}` },
    };
  }

  test('a complete sign-in seats the caller and returns them where they started', async () => {
    const { state, nonce, cookie } = await beginSignIn('/proposals');
    nextIdToken = await issueToken(nonce);

    const res = await entraApp.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${state}`,
      headers: cookie,
    });

    assert.equal(res.statusCode, 302, res.body);
    assert.equal(res.headers.location, '/proposals');
    const session = res.cookies.find((c) => c.name === SESSION_COOKIE);
    assert.ok(session?.value, 'no session cookie was issued');
    assert.equal(readSession(testSecret(), session!.value)?.uid, seated);

    // And the login cookie is spent, so the code cannot be replayed against it.
    const spent = res.cookies.find((c) => c.name === LOGIN_COOKIE);
    assert.equal(spent?.value, '', 'the pending sign-in cookie was left usable');
  });

  test('the sign-in cookie is not readable by scripts and is confined to this site', async () => {
    const res = await entraApp.inject({ method: 'GET', url: '/auth/login' });
    const c = res.cookies.find((x) => x.name === LOGIN_COOKIE)!;
    assert.equal(c.httpOnly, true, 'the login cookie was exposed to document.cookie');
    assert.equal(String(c.sameSite).toLowerCase(), 'lax');
  });

  test('a mismatched state is refused even though the token would be accepted', async () => {
    const { nonce, cookie } = await beginSignIn();
    nextIdToken = await issueToken(nonce);

    const res = await entraApp.inject({
      method: 'GET',
      url: '/auth/callback?code=the-code&state=not-the-one-we-issued',
      headers: cookie,
    });

    assert.equal(res.statusCode, 401, res.body);
    assert.equal(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '', '');
  });

  test('a callback with no pending sign-in is refused', async () => {
    nextIdToken = await issueToken('whatever');
    const res = await entraApp.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' });
    assert.equal(res.statusCode, 401, 'a callback out of nowhere completed a sign-in');
  });

  test('an expired pending sign-in is refused', async () => {
    const stale = mintToken(testSecret(), {
      state: 'st',
      nonce: 'no',
      verifier: 'v',
      returnTo: '/',
      exp: Date.now() - 1,
    });
    nextIdToken = await issueToken('no');
    const res = await entraApp.inject({
      method: 'GET',
      url: '/auth/callback?code=x&state=st',
      headers: { cookie: `${LOGIN_COOKIE}=${stale}` },
    });
    assert.equal(res.statusCode, 401, 'a stale sign-in was completed');
  });

  test('a token bound to a different sign-in is refused at the callback', async () => {
    const { state, cookie } = await beginSignIn();
    // Signed by the right key for the right tenant and audience, but minted
    // against another sign-in's nonce — a captured token, replayed.
    nextIdToken = await issueToken('a-nonce-from-somewhere-else');

    const res = await entraApp.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${state}`,
      headers: cookie,
    });
    assert.equal(res.statusCode, 401, 'a replayed token completed a sign-in');
  });

  test('someone outside the roster is refused with an explanation, and no row appears', async () => {
    const { state, nonce, cookie } = await beginSignIn();
    nextIdToken = await issueToken(nonce, {
      oid: 'oid-stranger',
      preferred_username: 'stranger@blevinsholdings.com',
    });

    const res = await entraApp.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${state}`,
      headers: cookie,
    });

    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.json().error, /roster/);
    const rows = await db.select().from(users);
    assert.equal(rows.length, 1, 'an unrostered sign-in created an account');
  });

  test('an off-site returnTo cannot be smuggled through the round trip', async () => {
    const { state, nonce, cookie } = await beginSignIn('//evil.example/steal');
    nextIdToken = await issueToken(nonce);

    const res = await entraApp.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${state}`,
      headers: cookie,
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/', 'the sign-in redirected off-site');
  });

  test('the redirect to Microsoft carries the registered callback and no secret', async () => {
    const { redirect } = await beginSignIn();
    assert.equal(redirect.origin, 'https://login.microsoftonline.com');
    assert.equal(redirect.pathname, `/${TENANT}/oauth2/v2.0/authorize`);
    assert.equal(
      redirect.searchParams.get('redirect_uri'),
      'https://board.example.test/api/auth/callback',
    );
    assert.ok(
      !redirect.search.includes('stubbed-for-tests'),
      'the client secret was put in a URL the browser follows',
    );
  });
});
