import { and, eq } from 'drizzle-orm';
import {
  contributionDocuments,
  contributions,
  documentVersions,
  documents,
  milestoneDocuments,
  milestones,
  users,
  type Db,
} from '@blevins/db';
import { parse, serialize, setElementText, type DocType } from '@blevins/akn';

import { Conflict, NotFound, contentHash, saveDocument } from './service.ts';

/**
 * Send a copy of a milestone to someone for comment.
 *
 * The copy is taken from what the milestone froze, not from the live text, so
 * two people sent the same milestone are working from identical bytes however
 * much drafting has happened since.
 */
export async function sendForContribution(
  db: Db,
  input: { milestoneId: string; targetEmail: string; userId: string },
) {
  const [milestone] = await db
    .select()
    .from(milestones)
    .where(eq(milestones.id, input.milestoneId));
  if (!milestone) throw new NotFound(`No milestone ${input.milestoneId}`);

  // The recipient must already exist. Minting an account from an email typed
  // into a form would put a name into the record that nobody has verified.
  const [target] = await db.select().from(users).where(eq(users.email, input.targetEmail));
  if (!target) throw new Conflict(`No user with the address ${input.targetEmail}`);

  const frozen = await db
    .select({
      documentId: milestoneDocuments.documentId,
      versionId: milestoneDocuments.versionId,
      xml: documentVersions.xml,
    })
    .from(milestoneDocuments)
    .innerJoin(documentVersions, eq(documentVersions.id, milestoneDocuments.versionId))
    .where(eq(milestoneDocuments.milestoneId, input.milestoneId));

  return db.transaction(async (tx) => {
    const [contribution] = await tx
      .insert(contributions)
      .values({ milestoneId: input.milestoneId, targetUserId: target.id, sentBy: input.userId })
      .returning();

    for (const part of frozen) {
      await tx.insert(contributionDocuments).values({
        contributionId: contribution!.id,
        documentId: part.documentId,
        baseVersionId: part.versionId,
        xml: part.xml,
      });
    }
    return contribution!;
  });
}

/** Everything the contributor is working on, with what they started from. */
export async function contributionContents(db: Db, contributionId: string) {
  const rows = await db
    .select({
      documentId: contributionDocuments.documentId,
      title: documents.title,
      docType: documents.docType,
      position: documents.position,
      xml: contributionDocuments.xml,
      baseXml: documentVersions.xml,
      updatedAt: contributionDocuments.updatedAt,
    })
    .from(contributionDocuments)
    .innerJoin(documents, eq(documents.id, contributionDocuments.documentId))
    .innerJoin(documentVersions, eq(documentVersions.id, contributionDocuments.baseVersionId))
    .where(eq(contributionDocuments.contributionId, contributionId))
    .orderBy(documents.position);
  if (rows.length === 0) throw new NotFound(`No contribution ${contributionId}`);
  return rows.map((r) => ({ ...r, changed: r.xml !== r.baseXml }));
}

/**
 * The contributor edits their own copy.
 *
 * Structurally the same edit the drafter makes, applied to a different set of
 * bytes. It writes no version: a proposal is not amended because someone
 * outside the team typed into a copy of it.
 */
export async function editContribution(
  db: Db,
  input: {
    contributionId: string;
    documentId: string;
    elementId: string;
    value: string;
    userId: string;
  },
) {
  const [contribution] = await db
    .select()
    .from(contributions)
    .where(eq(contributions.id, input.contributionId));
  if (!contribution) throw new NotFound(`No contribution ${input.contributionId}`);
  if (contribution.targetUserId !== input.userId) {
    throw Object.assign(new Error('This contribution belongs to someone else'), {
      statusCode: 403,
    });
  }
  if (contribution.status === 'MERGED' || contribution.status === 'REJECTED') {
    throw new Conflict(`This contribution is ${contribution.status.toLowerCase()} and is closed`);
  }

  const [row] = await db
    .select({ xml: contributionDocuments.xml, docType: documents.docType })
    .from(contributionDocuments)
    .innerJoin(documents, eq(documents.id, contributionDocuments.documentId))
    .where(
      and(
        eq(contributionDocuments.contributionId, input.contributionId),
        eq(contributionDocuments.documentId, input.documentId),
      ),
    );
  if (!row) throw new NotFound(`Document ${input.documentId} is not part of this contribution`);

  let updated: string;
  try {
    updated = serialize(
      setElementText(parse(row.xml, row.docType as DocType), input.elementId, input.value),
    );
  } catch (err) {
    throw new Conflict((err as Error).message);
  }

  await db
    .update(contributionDocuments)
    .set({ xml: updated, updatedAt: new Date() })
    .where(
      and(
        eq(contributionDocuments.contributionId, input.contributionId),
        eq(contributionDocuments.documentId, input.documentId),
      ),
    );
  await db
    .update(contributions)
    .set({ status: 'IN_PROGRESS' })
    .where(eq(contributions.id, input.contributionId));

  return { contentHash: contentHash(updated) };
}

/** The contributor hands it back. */
export async function submitContribution(db: Db, contributionId: string, userId: string) {
  const [contribution] = await db
    .select()
    .from(contributions)
    .where(eq(contributions.id, contributionId));
  if (!contribution) throw new NotFound(`No contribution ${contributionId}`);
  if (contribution.targetUserId !== userId) {
    throw Object.assign(new Error('This contribution belongs to someone else'), {
      statusCode: 403,
    });
  }
  const [row] = await db
    .update(contributions)
    .set({ status: 'SUBMITTED', submittedAt: new Date() })
    .where(eq(contributions.id, contributionId))
    .returning();
  return row!;
}

/**
 * Merge the proposed changes into the live text.
 *
 * Only documents the contributor actually changed are touched, and each goes
 * through the ordinary save path — so a merged change is an ordinary version
 * whose author is the person who accepted it, not the person who proposed it.
 * The record should say who put the words into the instrument.
 *
 * This does not attempt a three-way merge. The contributor's copy wins for the
 * documents they edited, which is safe while a milestone is circulated to one
 * reviewer at a time and would not be if it were circulated to several.
 */
export async function mergeContribution(db: Db, contributionId: string, userId: string) {
  const [contribution] = await db
    .select()
    .from(contributions)
    .where(eq(contributions.id, contributionId));
  if (!contribution) throw new NotFound(`No contribution ${contributionId}`);
  if (contribution.status === 'MERGED') throw new Conflict('This contribution is already merged');

  const parts = await contributionContents(db, contributionId);
  const merged: string[] = [];
  for (const part of parts) {
    if (!part.changed) continue;
    await saveDocument(db, {
      documentId: part.documentId,
      xml: part.xml,
      note: `Merged from contribution ${contributionId.slice(0, 8)}`,
      userId,
    });
    merged.push(part.title);
  }

  await db
    .update(contributions)
    .set({ status: 'MERGED', mergedAt: new Date() })
    .where(eq(contributions.id, contributionId));

  return { merged, count: merged.length };
}

export async function listContributions(db: Db, milestoneId: string) {
  return db
    .select({
      id: contributions.id,
      status: contributions.status,
      sentAt: contributions.sentAt,
      submittedAt: contributions.submittedAt,
      mergedAt: contributions.mergedAt,
      targetName: users.name,
      targetEmail: users.email,
    })
    .from(contributions)
    .innerJoin(users, eq(users.id, contributions.targetUserId))
    .where(eq(contributions.milestoneId, milestoneId));
}
