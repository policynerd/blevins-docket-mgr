import { connect } from '@blevins/db';

import { buildServer } from './server.ts';

const { db } = connect();
const app = buildServer(db);
const port = Number(process.env['PORT'] ?? 3200);
await app.listen({ port, host: '127.0.0.1' });
console.log(`api listening on ${port}`);
