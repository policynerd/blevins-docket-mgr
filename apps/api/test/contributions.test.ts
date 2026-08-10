import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { sql } from 'drizzle-orm';
import {
  connect,
  contributionDocuments,
  contributions,
  documentVersions,
  documents,
  milestoneDocuments,
  milestones,
  proposals,
  users,
  type Db,
} from '@blevins/db';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../src/server.ts';
import { shutdown } from '@blevins/pdf';

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;
let clerk: string;
let outsider: string;

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
  await db.execute(
    sql`TRUNCATE ${users}, ${proposals}, ${documents}, ${documentVersions}, ${milestones}, ${milestoneDocuments}, ${contributions}, ${contributionDocuments} RESTART IDENTITY CASCADE`,
  );
  const rows = await db
    .insert(users)
    .values([
      { email: 'clerk@blevinsholdings.com', name: 'Clerk' },
      { email: 'counsel@example.com', name: 'Outside Counsel' },
    ])
    .returning();
  clerk = rows[0]!.id;
  outsider = rows[1]!.id;
});

const as = (id: string) => ({ 'x-user-id': id });

/** A proposal with a milestone taken, ready to circulate. */
async function circulated() {
  const proposal = (
    await app.inject({
      method: 'POST',
      url: '/proposals',
      headers: as(clerk),
      payload: { templateId: 'ORD-STD', title: 'An Ordinance' },
    })
  ).json();
  const milestone = (
    await app.inject({
      method: 'POST',
      url: `/proposals/${proposal.id}/milestones`,
      headers: as(clerk),
      payload: { label: 'For comment' },
    })
  ).json();
  const sent = await app.inject({
    method: 'POST',
    url: `/milestones/${milestone.id}/contributions`,
    headers: as(clerk),
    payload: { targetEmail: 'counsel@example.com' },
  });
  assert.equal(sent.statusCode, 201, sent.body);
  return { proposal, milestone, contribution: sent.json() };
}

test('a contribution copies what the milestone froze, one row per document', async () => {
  const { proposal, contribution } = await circulated();
  const parts = (
    await app.inject({ method: 'GET', url: `/contributions/${contribution.id}/documents` })
  ).json();

  assert.equal(parts.length, proposal.documents.length);
  assert.ok(
    parts.every((p: { changed: boolean }) => !p.changed),
    'a freshly sent contribution already reports changes',
  );
});

test('editing a contribution changes the copy and leaves the live document alone', async () => {
  const { proposal, contribution } = await circulated();
  const act = proposal.documents.find((d: { docType: string }) => d.docType === 'LEGAL_ACT');
  const before = (await app.inject({ method: 'GET', url: `/documents/${act.id}` })).json();
  const elementId = /xml:id="([^"]+)"[^>]*>\[Text\]/.exec(before.version.xml)?.[1];
  assert.ok(elementId, 'could not find the element to edit');

  const edited = await app.inject({
    method: 'PATCH',
    url: `/contributions/${contribution.id}/documents/${act.id}/elements/${elementId}`,
    headers: as(outsider),
    payload: { value: 'Counsel proposes this wording.' },
  });
  assert.equal(edited.statusCode, 200, edited.body);

  // The live document is untouched: an outside reviewer cannot alter the
  // record, only propose against a copy of it.
  const after = (await app.inject({ method: 'GET', url: `/documents/${act.id}` })).json();
  assert.equal(after.version.label, before.version.label, 'the live document gained a version');
  assert.ok(!after.version.xml.includes('Counsel proposes'), 'the edit reached the live document');

  const parts = (
    await app.inject({ method: 'GET', url: `/contributions/${contribution.id}/documents` })
  ).json();
  const changed = parts.filter((p: { changed: boolean }) => p.changed);
  assert.equal(changed.length, 1, 'exactly the edited document should report a change');
  assert.ok(changed[0].xml.includes('Counsel proposes'));
});

test('only the addressee can edit their contribution', async () => {
  const { proposal, contribution } = await circulated();
  const act = proposal.documents.find((d: { docType: string }) => d.docType === 'LEGAL_ACT');
  const xml = (await app.inject({ method: 'GET', url: `/documents/${act.id}` })).json().version.xml;
  const elementId = /xml:id="([^"]+)"[^>]*>\[Text\]/.exec(xml)?.[1]!;

  // The clerk sent it, but it was addressed to counsel. A copy sent to one
  // person is not a document anyone with the link may rewrite.
  const res = await app.inject({
    method: 'PATCH',
    url: `/contributions/${contribution.id}/documents/${act.id}/elements/${elementId}`,
    headers: as(clerk),
    payload: { value: 'Not mine to write.' },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test('merging brings the changes across, attributed to whoever accepted them', async () => {
  const { proposal, contribution } = await circulated();
  const act = proposal.documents.find((d: { docType: string }) => d.docType === 'LEGAL_ACT');
  const xml = (await app.inject({ method: 'GET', url: `/documents/${act.id}` })).json().version.xml;
  const elementId = /xml:id="([^"]+)"[^>]*>\[Text\]/.exec(xml)?.[1]!;

  await app.inject({
    method: 'PATCH',
    url: `/contributions/${contribution.id}/documents/${act.id}/elements/${elementId}`,
    headers: as(outsider),
    payload: { value: 'Counsel proposes this wording.' },
  });
  await app.inject({
    method: 'POST',
    url: `/contributions/${contribution.id}/submit`,
    headers: as(outsider),
  });

  const merged = await app.inject({
    method: 'POST',
    url: `/contributions/${contribution.id}/merge`,
    headers: as(clerk),
  });
  assert.equal(merged.statusCode, 200, merged.body);
  assert.equal(merged.json().count, 1, 'only the changed document should be written');

  const after = (await app.inject({ method: 'GET', url: `/documents/${act.id}` })).json();
  assert.ok(after.version.xml.includes('Counsel proposes'), 'the merge did not reach the document');
  assert.equal(after.version.label, 'v0.2.0', 'the merge did not write an ordinary version');

  // Authorship is the clerk's: the record should say who put the words into
  // the instrument, not who suggested them.
  const history = (
    await app.inject({ method: 'GET', url: `/documents/${act.id}/versions` })
  ).json();
  assert.equal(history[0].createdBy, clerk, 'the merged version is attributed to the contributor');
});

test('an unchanged document is not rewritten by a merge', async () => {
  const { proposal, contribution } = await circulated();
  const letter = proposal.documents.find(
    (d: { docType: string }) => d.docType === 'EXPL_MEMORANDUM',
  );
  const before = (await app.inject({ method: 'GET', url: `/documents/${letter.id}` })).json();

  const merged = await app.inject({
    method: 'POST',
    url: `/contributions/${contribution.id}/merge`,
    headers: as(clerk),
  });
  assert.equal(merged.json().count, 0, 'a merge with no edits still wrote versions');

  const after = (await app.inject({ method: 'GET', url: `/documents/${letter.id}` })).json();
  assert.equal(
    after.version.label,
    before.version.label,
    'an untouched document gained a version from a merge',
  );
});

test('a merged contribution is closed to further editing', async () => {
  const { proposal, contribution } = await circulated();
  const act = proposal.documents.find((d: { docType: string }) => d.docType === 'LEGAL_ACT');
  const xml = (await app.inject({ method: 'GET', url: `/documents/${act.id}` })).json().version.xml;
  const elementId = /xml:id="([^"]+)"[^>]*>\[Text\]/.exec(xml)?.[1]!;

  await app.inject({
    method: 'POST',
    url: `/contributions/${contribution.id}/merge`,
    headers: as(clerk),
  });

  const late = await app.inject({
    method: 'PATCH',
    url: `/contributions/${contribution.id}/documents/${act.id}/elements/${elementId}`,
    headers: as(outsider),
    payload: { value: 'Too late.' },
  });
  assert.equal(late.statusCode, 409, 'a merged contribution accepted a further edit');
});

test('a milestone can only be sent to someone the system already knows', async () => {
  const { milestone } = await circulated();
  const res = await app.inject({
    method: 'POST',
    url: `/milestones/${milestone.id}/contributions`,
    headers: as(clerk),
    payload: { targetEmail: 'stranger@example.com' },
  });
  // Minting an account from an address typed into a form would put a name in
  // the record that nobody has verified.
  assert.equal(res.statusCode, 409, res.body);
});
