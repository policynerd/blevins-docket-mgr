import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Apply pending migrations.
 *
 * Deliberately not `drizzle-kit migrate`. drizzle-kit is a development tool and
 * a large dependency tree; requiring it in the deployed image to bring a
 * database up to date means shipping a build toolchain to production so it can
 * read four SQL files. The programmatic migrator does the same work from
 * `drizzle-orm`, which is already a runtime dependency.
 *
 * Runs as a release step, before the new version takes traffic, and on a single
 * connection: the migrator takes a lock, but a pool would leave idle
 * connections open and hold the release command from exiting.
 */
const url = process.env['DATABASE_URL'];
if (!url) {
  throw new Error('DATABASE_URL is not set; refusing to guess a database to migrate.');
}

const client = postgres(url, { max: 1 });
try {
  await migrate(drizzle(client), {
    migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'),
  });
  console.log('migrations applied');
} finally {
  await client.end();
}
