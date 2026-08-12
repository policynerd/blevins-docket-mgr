import { sql } from 'drizzle-orm';
import { connect, users } from '@blevins/db';

import { GOVERNORS, ORG, STAFF } from './org.ts';

/**
 * Put the Board on the roster.
 *
 * Sign-in maps a verified Entra identity onto a row here and refuses if there
 * is none, so nobody can sign in until this has run. Idempotent, and it never
 * overwrites: re-running after someone has signed in must not clear the Entra
 * binding recorded against them.
 *
 * Officers with no address are skipped rather than given a placeholder. A
 * made-up address is a row that quietly matches nobody, or worse, matches
 * whoever registers it later.
 */
async function main() {
  const { db, close } = connect();
  try {
    const roster = [...GOVERNORS, ...STAFF].filter((o) => o.email);
    const skipped = [...GOVERNORS, ...STAFF].filter((o) => !o.email);

    if (roster.length > 0) {
      await db
        .insert(users)
        .values(
          roster.map((o) => ({
            email: o.email!,
            name: o.name,
            organization: `${ORG.name} — ${ORG.body}`,
          })),
        )
        // The unique index is on lower(email), so a conflict is "already on the
        // roster" and doing nothing is right.
        .onConflictDoNothing();
    }

    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    console.log(`roster: ${n} on file, ${roster.length} known addresses`);
    if (skipped.length > 0) {
      console.log(
        `no address yet, cannot sign in: ${skipped.map((o) => `${o.name} (${o.title})`).join(', ')}`,
      );
    }
  } finally {
    await close();
  }
}

await main();
