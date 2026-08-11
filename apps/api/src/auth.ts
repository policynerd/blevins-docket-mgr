import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import { users, type Db } from '@blevins/db';
import { z } from 'zod';

import {
  EntraError,
  authorizeUrl,
  exchangeCode,
  logoutUrl,
  pkcePair,
  verifyIdToken,
  type EntraConfig,
  type Identity,
} from './entra.ts';
import {
  LOGIN_COOKIE,
  LOGIN_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  mintSession,
  mintToken,
  newSecretValue,
  readSession,
  readToken,
  safeReturnTo,
  type LoginClaims,
} from './session.ts';

export interface AuthOptions {
  /** HMAC key for our own session and login cookies. */
  secret: Buffer;
  /** Null when this deployment has no Entra configured; sign-in then 503s. */
  entra: EntraConfig | null;
  /** Where the browser lands after sign-out. */
  appBaseUrl: string;
  /** Set Secure on cookies. Off only so a plain-http localhost can hold a session. */
  secureCookies: boolean;
  /** See devLoginGuard. */
  allowDevLogin: boolean;
  /** Requests per minute per IP across the sign-in routes. */
  rateLimitMax?: number;
}

export function authOptions(
  env: NodeJS.ProcessEnv,
  entra: EntraConfig | null,
): Omit<AuthOptions, 'secret'> {
  const production = env['NODE_ENV'] === 'production';
  return {
    entra,
    // Canonicalised, and this is load-bearing rather than tidiness.
    //
    // It ends up as `post_logout_redirect_uri`, which Entra matches against the
    // registered redirect URIs *as a string*. The Azure portal stores a bare
    // origin with a trailing slash — `https://host/` — and WHATWG URL
    // serialisation produces exactly that form whether or not the configured
    // value has one. Without this, whether sign-out works comes down to
    // whether whoever set APP_BASE_URL happened to type a final slash, and the
    // failure is nasty: sign-in works perfectly and only sign-out breaks, so
    // nothing points at this variable.
    //
    // Throws on a malformed value, at startup, like the signing key does.
    appBaseUrl: new URL(env['APP_BASE_URL'] ?? 'http://127.0.0.1:3100').toString(),
    secureCookies: env['INSECURE_COOKIES'] !== '1' && production,
    allowDevLogin: env['ALLOW_DEV_LOGIN'] === '1',
  };
}

/**
 * Refuse to run with the development sign-in enabled in production.
 *
 * `/auth/dev-login` mints a session for any user on the roster with no
 * credential at all. That is fine on a laptop and catastrophic on the
 * internet, and the gap between those two is one environment variable that
 * somebody could copy into a Fly config while chasing an unrelated bug.
 *
 * So it is not a warning in a log that scrolls past. The process refuses to
 * start, because a guarantee that depends on someone reading the logs is not a
 * guarantee.
 */
export function devLoginGuard(opts: { allowDevLogin: boolean }, env: NodeJS.ProcessEnv): void {
  if (opts.allowDevLogin && env['NODE_ENV'] === 'production') {
    throw new Error(
      'ALLOW_DEV_LOGIN is set while NODE_ENV=production. Development sign-in bypasses Entra entirely; refusing to start.',
    );
  }
}

export class Unauthorized extends Error {
  statusCode = 401;
}
export class Forbidden extends Error {
  statusCode = 403;
}

/**
 * Identify the caller from the session cookie.
 *
 * This replaces the `x-user-id` header the earlier build ran on. That header
 * is deliberately not accepted as a fallback: a fallback is the whole hole,
 * since anyone who can reach the port can send a header, and an authentication
 * system with an unauthenticated bypass is an unauthenticated system with
 * extra steps.
 */
export async function requireUser(db: Db, secret: Buffer, req: FastifyRequest) {
  const claims = readSession(secret, req.cookies?.[SESSION_COOKIE]);
  if (!claims) throw new Unauthorized('Not signed in');

  const [user] = await db.select().from(users).where(eq(users.id, claims.uid));
  // A session outlives the row it names if someone is taken off the roster
  // mid-session. Removal from the roster has to end access now, not in twelve
  // hours, so the row is checked on every request rather than trusted from the
  // cookie.
  if (!user) throw new Unauthorized('Not signed in');
  return user;
}

/**
 * Map a verified Entra identity onto a row on the roster.
 *
 * It will not create one. Auto-provisioning would mean that anyone in the
 * tenant — every employee, every guest account someone invited to a SharePoint
 * folder — becomes an author on the legislative record the first time they
 * open the URL. Membership of this Board is decided by the Board, not by
 * having a mailbox.
 */
export async function resolveUser(db: Db, identity: Identity) {
  const [byOid] = await db
    .select()
    .from(users)
    .where(and(eq(users.entraOid, identity.oid), isNotNull(users.entraOid)));
  if (byOid) {
    await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, byOid.id));
    return byOid;
  }

  const [byEmail] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${identity.email}`);
  if (!byEmail) {
    throw new Forbidden(
      `${identity.email} is not on the roster for this Board. Ask the Clerk to be added.`,
    );
  }
  if (byEmail.entraOid && byEmail.entraOid !== identity.oid) {
    // The address matches a roster entry already bound to a different Entra
    // account. That is a recycled mailbox, not the same person, and silently
    // rebinding would hand one person's authorship to another.
    throw new Forbidden(
      `${identity.email} is already bound to a different account. Ask the Clerk to reconcile it.`,
    );
  }

  const [claimed] = await db
    .update(users)
    .set({ entraOid: identity.oid, lastSeenAt: new Date() })
    .where(eq(users.id, byEmail.id))
    .returning();
  return claimed!;
}

/**
 * The two places this module talks to Microsoft.
 *
 * Injected so the callback can be tested against a token endpoint that would
 * *succeed*. Testing it against the real endpoint only ever proves the request
 * failed, which every rejection path also produces — so a broken check and a
 * working one look identical, and the test passes either way.
 *
 * Not reachable from configuration: nothing in the environment can set these,
 * and production always gets the real tenant.
 */
export interface OidcSeams {
  fetchImpl?: typeof fetch;
  keys?: JWTVerifyGetKey;
}

export function registerAuth(
  app: FastifyInstance,
  db: Db,
  opts: AuthOptions,
  seams: OidcSeams = {},
): void {
  const cookieBase = {
    httpOnly: true,
    secure: opts.secureCookies,
    // Lax, not Strict. The callback from login.microsoftonline.com is a
    // cross-site top-level navigation; under Strict the browser withholds the
    // login cookie on exactly that request and every sign-in fails. Lax still
    // withholds it from cross-site POSTs, which is what CSRF needs.
    sameSite: 'lax' as const,
    path: '/',
  };

  /**
   * The sign-in routes are the credential surface, so they get a tighter
   * ceiling than the rest of the API rather than sharing its budget.
   */
  const limited = opts.rateLimitMax
    ? { config: { rateLimit: { max: opts.rateLimitMax, timeWindow: '1 minute' } } }
    : {};

  const setSession = (reply: FastifyReply, uid: string) =>
    reply.setCookie(SESSION_COOKIE, mintSession(opts.secret, uid), {
      ...cookieBase,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

  app.get('/auth/login', limited, async (req, reply) => {
    if (!opts.entra) {
      return reply.code(503).send({ error: 'Sign-in is not configured on this deployment.' });
    }
    const { returnTo } = z.object({ returnTo: z.string().optional() }).parse(req.query);
    const { verifier, challenge } = pkcePair();
    const state = newSecretValue();
    const nonce = newSecretValue();

    const claims: LoginClaims = {
      state,
      nonce,
      verifier,
      returnTo: safeReturnTo(returnTo),
      exp: Date.now() + LOGIN_TTL_MS,
    };
    reply.setCookie(LOGIN_COOKIE, mintToken(opts.secret, claims), {
      ...cookieBase,
      maxAge: Math.floor(LOGIN_TTL_MS / 1000),
    });
    return reply.redirect(authorizeUrl(opts.entra, { state, nonce, challenge }), 302);
  });

  app.get('/auth/callback', limited, async (req, reply) => {
    if (!opts.entra) {
      return reply.code(503).send({ error: 'Sign-in is not configured on this deployment.' });
    }
    const query = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      })
      .parse(req.query);

    if (query.error) {
      req.log.warn({ err: query.error_description }, 'entra returned an error');
      throw new Unauthorized('Sign-in was refused.');
    }

    const pending = readToken<LoginClaims>(opts.secret, req.cookies?.[LOGIN_COOKIE]);
    reply.clearCookie(LOGIN_COOKIE, cookieBase);
    if (!pending) throw new Unauthorized('Sign-in expired. Try again.');
    // The state check is what ties this callback to a sign-in *we* started.
    // Without it an attacker can complete a flow with their own code and land
    // the victim in the attacker's session.
    if (!query.state || query.state !== pending.state) {
      throw new Unauthorized('Sign-in state did not match. Try again.');
    }
    if (!query.code) throw new Unauthorized('Sign-in returned no authorization code.');

    let identity: Identity;
    try {
      const idToken = await exchangeCode(
        opts.entra,
        { code: query.code, verifier: pending.verifier },
        seams.fetchImpl ?? fetch,
      );
      identity = await verifyIdToken(idToken, opts.entra, pending.nonce, seams.keys);
    } catch (err) {
      // The detail names the tenant, the app registration and the failing
      // claim. That belongs in the log; the browser gets the fact of failure.
      req.log.warn({ err }, 'entra sign-in failed');
      if (err instanceof EntraError) throw new Unauthorized('Could not verify that sign-in.');
      throw err;
    }

    const user = await resolveUser(db, identity);
    setSession(reply, user.id);
    return reply.redirect(pending.returnTo, 302);
  });

  /**
   * Sign in without Entra, for local development only.
   *
   * Gated by ALLOW_DEV_LOGIN, which devLoginGuard refuses to let run in
   * production. It still will not create a user: the roster is the roster.
   */
  app.post('/auth/dev-login', limited, async (req, reply) => {
    if (!opts.allowDevLogin) return reply.code(404).send({ error: 'Not found' });
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    if (!user) throw new Forbidden(`${email} is not on the roster for this Board.`);
    setSession(reply, user.id);
    return { id: user.id, email: user.email, name: user.name };
  });

  app.get('/auth/me', limited, async (req) => {
    const user = await requireUser(db, opts.secret, req);
    return { id: user.id, email: user.email, name: user.name, organization: user.organization };
  });

  app.post('/auth/logout', limited, async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, cookieBase);
    // Clearing our cookie ends our session but leaves the browser signed in to
    // Entra, so the next visit signs straight back in without a prompt. On a
    // shared machine that is not a sign-out. The caller is told where to send
    // the browser to end it properly.
    return {
      ok: true,
      ...(opts.entra ? { entraLogoutUrl: logoutUrl(opts.entra, opts.appBaseUrl) } : {}),
    };
  });
}
