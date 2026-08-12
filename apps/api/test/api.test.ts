import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { sql } from 'drizzle-orm';
import { connect, type Db } from '@blevins/db';
import {
  documentVersions,
  documents,
  milestoneDocuments,
  milestones,
  proposals,
  users,
} from '@blevins/db';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../src/server.ts';
import { signedIn } from './helpers.ts';
import { shutdown } from '@blevins/pdf';

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;
let userId: string;

before(async () => {
  ({ db, close } = connect());
  app = await buildServer(db);
  await app.ready();
});

after(async () => {
  await app.close();
  await shutdown();
  await close();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE ${users}, ${proposals}, ${documents}, ${documentVersions}, ${milestones}, ${milestoneDocuments} RESTART IDENTITY CASCADE`,
  );
  const [user] = await db
    .insert(users)
    .values({ email: 'clerk@blevinsholdings.com', name: 'Clerk' })
    .returning();
  userId = user!.id;
});

const asClerk = () => signedIn(userId);

async function newProposal(title = 'An Ordinance Amending the Administrative Code') {
  const res = await app.inject({
    method: 'POST',
    url: '/proposals',
    headers: asClerk(),
    payload: { templateId: 'ORD-STD', title },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

test('creating a proposal instantiates every part of the template at once', async () => {
  const proposal = await newProposal();

  assert.deepEqual(
    proposal.documents.map((d: { docType: string }) => d.docType),
    ['COVER_PAGE', 'EXPL_MEMORANDUM', 'LEGAL_ACT', 'FINANCIAL_STATEMENT'],
  );
  // Each part starts with content, not empty — a proposal whose parts have to
  // be filled in before they exist cannot be edited in parallel.
  for (const doc of proposal.documents) {
    assert.equal(doc.version.label, 'v0.1.0', `${doc.docType} did not start at v0.1.0`);
  }
});

test('file numbers are sequential, not random', async () => {
  const first = await newProposal('First');
  const second = await newProposal('Second');
  const year = new Date().getFullYear();

  assert.equal(first.ref, `ORD-STD-${year}-0001`);
  assert.equal(second.ref, `ORD-STD-${year}-0002`);
});

test('saving a document adds a version and leaves the previous bytes alone', async () => {
  const proposal = await newProposal();
  const act = proposal.documents.find((d: { docType: string }) => d.docType === 'LEGAL_ACT');

  const before = await app.inject({ method: 'GET', url: `/documents/${act.id}` });
  const original = before.json().version;

  const edited = original.xml.replace('[Short title]', 'Delegation of Authority');
  const saved = await app.inject({
    method: 'PUT',
    url: `/documents/${act.id}`,
    headers: asClerk(),
    payload: { xml: edited, note: 'Titled' },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().label, 'v0.2.0');

  // The old version is still retrievable, byte for byte.
  const history = await app.inject({ method: 'GET', url: `/documents/${act.id}/versions` });
  const labels = history.json().map((v: { label: string }) => v.label);
  assert.deepEqual(labels, ['v0.2.0', 'v0.1.0'], 'the earlier version was not kept');
  assert.equal(
    history.json().find((v: { label: string }) => v.label === 'v0.1.0').contentHash,
    original.contentHash,
    'the stored digest of the first version changed when a second was written',
  );
});

test('content that cannot be parsed back is refused rather than stored', async () => {
  const proposal = await newProposal();
  const act = proposal.documents.find((d: { docType: string }) => d.docType === 'LEGAL_ACT');

  const res = await app.inject({
    method: 'PUT',
    url: `/documents/${act.id}`,
    headers: asClerk(),
    payload: { xml: '<akomaNtoso><nonsense/></akomaNtoso>' },
  });

  // Discovering unreadable content at export time means discovering it when
  // somebody is trying to publish.
  assert.equal(res.statusCode, 409, res.body);
  const history = await app.inject({ method: 'GET', url: `/documents/${act.id}/versions` });
  assert.equal(history.json().length, 1, 'the rejected content was stored anyway');
});

test('a milestone freezes what was there and survives later drafting', async () => {
  const proposal = await newProposal();
  const act = proposal.documents.find((d: { docType: string }) => d.docType === 'LEGAL_ACT');
  const original = (await app.inject({ method: 'GET', url: `/documents/${act.id}` })).json().version
    .xml;

  const created = await app.inject({
    method: 'POST',
    url: `/proposals/${proposal.id}/milestones`,
    headers: asClerk(),
    payload: { label: 'Sent to the Board' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const milestoneId = created.json().id;

  await app.inject({
    method: 'PUT',
    url: `/documents/${act.id}`,
    headers: asClerk(),
    payload: { xml: original.replace('[Text]', 'Substantially rewritten afterwards') },
  });

  const frozen = (
    await app.inject({ method: 'GET', url: `/milestones/${milestoneId}/documents` })
  ).json();

  // Exactly one row per document. Resolving the milestone through anything
  // other than the pinned version id — the document's history, say — brings
  // back every version, and a spot check on the first row would then pass or
  // fail on row ordering rather than on whether the snapshot held.
  assert.equal(
    frozen.length,
    proposal.documents.length,
    `a milestone of ${proposal.documents.length} documents resolved to ${frozen.length} rows`,
  );

  const acts = frozen.filter((d: { docType: string }) => d.docType === 'LEGAL_ACT');
  assert.equal(acts.length, 1, 'the milestone holds more than one version of the same document');
  assert.equal(acts[0].xml, original, 'the milestone followed the document forward in time');
  assert.ok(
    !frozen.some((d: { xml: string }) => d.xml.includes('Substantially rewritten')),
    'an edit made after the milestone appears inside it',
  );
});

test('writes require an identified user; reads of public record do not', async () => {
  const proposal = await newProposal();

  const anonymous = await app.inject({
    method: 'POST',
    url: '/proposals',
    payload: { templateId: 'ORD-STD', title: 'Unsigned' },
  });
  assert.equal(anonymous.statusCode, 401, 'an unidentified caller created a proposal');

  // The build this replaced authenticated on this header alone. It must now
  // carry no weight whatsoever: if it still did, everything below it in the
  // stack would be reachable by anyone who can open a socket.
  const header = await app.inject({
    method: 'POST',
    url: `/proposals/${proposal.id}/milestones`,
    headers: { 'x-user-id': userId },
    payload: { label: 'Header' },
  });
  assert.equal(header.statusCode, 401, 'the x-user-id header still authenticates');

  const forged = await app.inject({
    method: 'POST',
    url: `/proposals/${proposal.id}/milestones`,
    headers: signedIn('00000000-0000-0000-0000-000000000000'),
    payload: { label: 'Forged' },
  });
  assert.equal(forged.statusCode, 401, 'a session naming an unknown user was accepted');

  const read = await app.inject({ method: 'GET', url: `/proposals/${proposal.id}` });
  assert.equal(read.statusCode, 200, 'reading the record required credentials');
});

test('the whole proposal exports as one PDF', async () => {
  const proposal = await newProposal();
  const res = await app.inject({ method: 'GET', url: `/proposals/${proposal.id}/export.pdf` });

  assert.equal(res.statusCode, 200, res.body.slice(0, 200));
  assert.equal(res.headers['content-type'], 'application/pdf');
  const bytes = res.rawPayload;
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'not a PDF');

  // Four parts, each laid out on its own and concatenated, so the merged file
  // has at least one page per part. Counted with a real parser: a merged PDF
  // stores its objects compressed, so grepping the bytes for /Type /Page finds
  // nothing and would pass or fail for reasons unrelated to the document.
  const { PDFDocument } = await import('pdf-lib');
  const pageCount = (await PDFDocument.load(bytes)).getPageCount();
  assert.ok(pageCount >= 4, `expected at least one page per document, got ${pageCount}`);
});

test('a missing proposal is a 404, not a 500', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/proposals/00000000-0000-0000-0000-000000000000',
  });
  assert.equal(res.statusCode, 404);
});

test('a malformed request is a 400, not an internal error', async () => {
  const res = await app.inject({ method: 'GET', url: '/proposals/not-a-uuid' });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error, /invalid request/i);
});

test('the guidance proof is not public, though the export itself is', async () => {
  const proposal = await newProposal();

  // The record is public.
  const plain = await app.inject({ method: 'GET', url: `/proposals/${proposal.id}/export.pdf` });
  assert.equal(plain.statusCode, 200);

  // The drafting instructions are not.
  const anon = await app.inject({
    method: 'GET',
    url: `/proposals/${proposal.id}/export.pdf?guidance=true`,
  });
  assert.equal(anon.statusCode, 401, 'an anonymous caller was handed the guidance proof');

  const asDrafter = await app.inject({
    method: 'GET',
    url: `/proposals/${proposal.id}/export.pdf?guidance=true`,
    headers: asClerk(),
  });
  assert.equal(asDrafter.statusCode, 200, asDrafter.body.slice(0, 120));
});

test('guidance=false does not turn guidance on', async () => {
  const proposal = await newProposal();
  // z.coerce.boolean() follows JS truthiness, so the string "false" would
  // coerce to true — an opt-out that silently opts in.
  const res = await app.inject({
    method: 'GET',
    url: `/proposals/${proposal.id}/export.pdf?guidance=false`,
  });
  assert.equal(res.statusCode, 200, 'guidance=false was treated as a request for guidance');
});
