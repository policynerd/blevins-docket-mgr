import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.ts';

export type Db = ReturnType<typeof connect>['db'];

/**
 * Open a connection pool.
 *
 * Returns the closer alongside the handle rather than hiding it in a module
 * singleton: tests and one-shot scripts have to be able to shut the pool down,
 * and a process that cannot close its own connections hangs on exit instead of
 * finishing.
 */
export function connect(url = process.env['DATABASE_URL']) {
  if (!url) {
    throw new Error('DATABASE_URL is not set; refusing to guess a database to connect to.');
  }
  const client = postgres(url, { max: 10 });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}
