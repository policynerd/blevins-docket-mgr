import { SESSION_COOKIE, mintSession, sessionSecret } from '../src/session.ts';

/**
 * Test sign-in.
 *
 * The tests hold a real session cookie signed with the real key rather than
 * short-circuiting authentication with a test-only bypass. If they took a
 * shortcut, the thing the rest of the suite exercises would be the shortcut,
 * and every assertion about who may do what would be evidence about code that
 * does not run in production.
 *
 * Set at import time because buildServer reads the key when it is called.
 */
process.env['SESSION_SECRET'] ??= 'test-session-secret-at-least-32-characters-long';

export const testSecret = () => sessionSecret(process.env);

/** Headers for a request made by a signed-in user. */
export function signedIn(userId: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${mintSession(testSecret(), userId)}` };
}
