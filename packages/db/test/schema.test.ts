import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { connect, type Db } from '../src/client.ts';
import {
  documentVersions,
  documents,
  milestoneDocuments,
  milestones,
  proposals,
  users,
} from '../src/schema.ts';

// These run against a real PostgreSQL. Constraints are the thing under test —
// a case-insensitive unique index, a composite key, a cascade — and none of
// them exist anywhere but in the database. Testing them against a fake would
// only assert that the fake agrees with itself.

let db: Db;
let close: () => Promise<void>;

before(() => {
  ({ db, close } = connect());
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE ${users}, ${proposals}, ${documents}, ${documentVersions}, ${milestones}, ${milestoneDocuments} RESTART IDENTITY CASCADE`,
  );
});

const hash = (xml: string) => createHash('sha256').update(xml).digest('hex');

async function seedUser(email = 'clerk@blevinsholdings.com') {
  const [row] = await db.insert(users).values({ email, name: 'Clerk' }).returning();
  return row!;
}

async function seedProposal(userId: string) {
  const [row] = await db
    .insert(proposals)
    .values({
      ref: 'PROP_ACT-2026-001',
      title: 'A Delegation of Authority',
      templateId: 'SJ-019',
      createdBy: userId,
    })
    .returning();
  return row!;
}

async function seedDocument(proposalId: string) {
  const [row] = await db
    .insert(documents)
    .values({ proposalId, docType: 'LEGAL_ACT', title: 'Legal Act' })
    .returning();
  return row!;
}

test('an email cannot be reused under a different casing', async () => {
  await seedUser('Clerk@BlevinsHoldings.com');
  // Two accounts differing only by case would let the same person hold two
  // identities, and a collaborator list would show both as separate people.
  await assert.rejects(
    () => seedUser('clerk@blevinsholdings.com'),
    /duplicate key|unique/i,
    'a differently-cased duplicate email was accepted',
  );
});

test('a document cannot have two versions with the same number', async () => {
  const user = await seedUser();
  const proposal = await seedProposal(user.id);
  const doc = await seedDocument(proposal.id);

  const version = { documentId: doc.id, major: 0, minor: 1, patch: 0, createdBy: user.id };
  await db.insert(documentVersions).values({ ...version, xml: '<a/>', contentHash: hash('<a/>') });

  // Version numbers are how an approval refers to what it approved. Two rows
  // sharing one number makes that reference ambiguous.
  await assert.rejects(
    () =>
      db.insert(documentVersions).values({ ...version, xml: '<b/>', contentHash: hash('<b/>') }),
    /duplicate key|unique/i,
    'a duplicate version number was accepted',
  );
});

test('deleting a proposal removes its documents and their versions', async () => {
  const user = await seedUser();
  const proposal = await seedProposal(user.id);
  const doc = await seedDocument(proposal.id);
  await db
    .insert(documentVersions)
    .values({ documentId: doc.id, xml: '<a/>', contentHash: hash('<a/>'), createdBy: user.id });

  await db.delete(proposals).where(sql`${proposals.id} = ${proposal.id}`);

  assert.equal((await db.select().from(documents)).length, 0, 'documents outlived their proposal');
  assert.equal(
    (await db.select().from(documentVersions)).length,
    0,
    'versions outlived their document',
  );
});

test('a milestone keeps pointing at the exact version it froze after later edits', async () => {
  const user = await seedUser();
  const proposal = await seedProposal(user.id);
  const doc = await seedDocument(proposal.id);

  const frozenXml = '<bill>as approved</bill>';
  const [frozen] = await db
    .insert(documentVersions)
    .values({
      documentId: doc.id,
      minor: 1,
      xml: frozenXml,
      contentHash: hash(frozenXml),
      createdBy: user.id,
    })
    .returning();

  const [milestone] = await db
    .insert(milestones)
    .values({ proposalId: proposal.id, label: 'Sent to Board', createdBy: user.id })
    .returning();
  await db
    .insert(milestoneDocuments)
    .values({ milestoneId: milestone!.id, documentId: doc.id, versionId: frozen!.id });

  // Drafting continues after the milestone is taken.
  const laterXml = '<bill>edited afterwards</bill>';
  await db.insert(documentVersions).values({
    documentId: doc.id,
    minor: 2,
    xml: laterXml,
    contentHash: hash(laterXml),
    createdBy: user.id,
  });

  const [pinned] = await db
    .select({ xml: documentVersions.xml, contentHash: documentVersions.contentHash })
    .from(milestoneDocuments)
    .innerJoin(documentVersions, sql`${documentVersions.id} = ${milestoneDocuments.versionId}`)
    .where(sql`${milestoneDocuments.milestoneId} = ${milestone!.id}`);

  assert.equal(pinned!.xml, frozenXml, 'the milestone followed the document forward in time');
  assert.equal(
    pinned!.contentHash,
    hash(frozenXml),
    'the stored digest does not match the stored bytes',
  );
});

test('a version cannot be pinned by a milestone and then deleted out from under it', async () => {
  const user = await seedUser();
  const proposal = await seedProposal(user.id);
  const doc = await seedDocument(proposal.id);
  const [version] = await db
    .insert(documentVersions)
    .values({ documentId: doc.id, xml: '<a/>', contentHash: hash('<a/>'), createdBy: user.id })
    .returning();
  const [milestone] = await db
    .insert(milestones)
    .values({ proposalId: proposal.id, label: 'M1', createdBy: user.id })
    .returning();
  await db
    .insert(milestoneDocuments)
    .values({ milestoneId: milestone!.id, documentId: doc.id, versionId: version!.id });

  // The reference from milestone_documents to document_versions carries no
  // cascade on purpose: a milestone is a record of what was circulated, and
  // deleting the bytes it points at would leave a citation to nothing.
  await assert.rejects(
    () => db.delete(documentVersions).where(sql`${documentVersions.id} = ${version!.id}`),
    /violates foreign key/i,
    'a version referenced by a milestone was deletable',
  );
});
