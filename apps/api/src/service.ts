import { createHash } from 'node:crypto';

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  documentVersions,
  documents,
  milestoneDocuments,
  milestones,
  proposals,
  type Db,
} from '@blevins/db';
import {
  parse,
  serialize,
  setElementAlign,
  setElementText,
  toHtml,
  type Align,
  type DocType,
} from '@blevins/akn';
import { mergePdfs, renderPdf } from '@blevins/pdf';

import { findTemplate } from './templates.ts';
import { runningHead, type MeetingContext } from './letterhead.ts';
import { pdfCacheGet, pdfCacheSet } from './pdf-cache.ts';

export const contentHash = (xml: string) => createHash('sha256').update(xml).digest('hex');

export class NotFound extends Error {}
export class Conflict extends Error {}

export async function createProposal(
  db: Db,
  input: { templateId: string; title: string; ref?: string; userId: string },
) {
  const template = findTemplate(input.templateId);
  if (!template) throw new NotFound(`No template ${input.templateId}`);

  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = input.ref ?? (await nextRef(db, template.id));
    try {
      return await db.transaction(async (tx) => {
        const [proposal] = await tx
          .insert(proposals)
          .values({
            ref,
            title: input.title,
            templateId: template.id,
            createdBy: input.userId,
          })
          .returning();

        for (const [position, part] of template.documents.entries()) {
          const [doc] = await tx
            .insert(documents)
            .values({
              proposalId: proposal!.id,
              docType: part.docType,
              title: part.title,
              position,
            })
            .returning();

          await tx.insert(documentVersions).values({
            documentId: doc!.id,
            major: 0,
            minor: 1,
            patch: 0,
            xml: part.xml,
            contentHash: contentHash(part.xml),
            note: 'Created from template',
            createdBy: input.userId,
          });
        }

        return proposal!;
      });
    } catch (err) {
      const isRefCollision =
        input.ref === undefined && /proposals_ref_key|duplicate key/i.test(String(err));
      if (!isRefCollision || attempt === 3) throw err;
    }
  }
  throw new Conflict('Could not allocate a file number; too many concurrent creations.');
}

async function nextRef(db: Db, templateId: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `${templateId}-${year}-`;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(proposals)
    .where(sql`${proposals.ref} LIKE ${prefix + '%'}`);
  return prefix + String((row?.n ?? 0) + 1).padStart(4, '0');
}

export async function latestVersion(db: Db, documentId: string) {
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(
      desc(documentVersions.major),
      desc(documentVersions.minor),
      desc(documentVersions.patch),
    )
    .limit(1);
  return row;
}

export async function getProposal(db: Db, id: string) {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, id));
  if (!proposal) throw new NotFound(`No proposal ${id}`);

  const parts = await db
    .select()
    .from(documents)
    .where(eq(documents.proposalId, id))
    .orderBy(asc(documents.position));

  return {
    ...proposal,
    documents: await Promise.all(
      parts.map(async (d) => {
        const v = await latestVersion(db, d.id);
        return {
          ...d,
          version: v ? { id: v.id, label: versionLabel(v), updatedAt: v.createdAt } : null,
        };
      }),
    ),
  };
}

export const versionLabel = (v: { major: number; minor: number; patch: number }) =>
  `v${v.major}.${v.minor}.${v.patch}`;

export async function saveDocument(
  db: Db,
  input: { documentId: string; xml: string; note?: string; userId: string },
) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, input.documentId));
  if (!doc) throw new NotFound(`No document ${input.documentId}`);

  try {
    parse(input.xml, doc.docType as DocType);
  } catch (err) {
    throw new Conflict(`Refusing to store unreadable content: ${(err as Error).message}`);
  }

  const current = await latestVersion(db, doc.id);
  const [saved] = await db
    .insert(documentVersions)
    .values({
      documentId: doc.id,
      major: current?.major ?? 0,
      minor: (current?.minor ?? 0) + 1,
      patch: 0,
      xml: input.xml,
      contentHash: contentHash(input.xml),
      note: input.note ?? null,
      createdBy: input.userId,
    })
    .returning();

  await db.update(proposals).set({ updatedAt: new Date() }).where(eq(proposals.id, doc.proposalId));

  return saved!;
}

export async function createMilestone(
  db: Db,
  input: { proposalId: string; label: string; userId: string },
) {
  const parts = await db
    .select()
    .from(documents)
    .where(eq(documents.proposalId, input.proposalId))
    .orderBy(asc(documents.position));
  if (parts.length === 0) throw new NotFound(`No proposal ${input.proposalId}`);

  return db.transaction(async (tx) => {
    const [milestone] = await tx
      .insert(milestones)
      .values({ proposalId: input.proposalId, label: input.label, createdBy: input.userId })
      .returning();

    for (const doc of parts) {
      const version = await latestVersion(tx as unknown as Db, doc.id);
      if (!version) continue;
      await tx.insert(milestoneDocuments).values({
        milestoneId: milestone!.id,
        documentId: doc.id,
        versionId: version.id,
      });
    }
    return milestone!;
  });
}

export async function exportProposal(
  db: Db,
  proposalId: string,
  opts: { guidance?: boolean; meeting?: MeetingContext } = {},
): Promise<Uint8Array> {
  const proposal = await getProposal(db, proposalId);
  const versions = await Promise.all(proposal.documents.map((d) => latestVersion(db, d.id)));
  const key = [
    proposalId,
    opts.guidance ? 'g1' : 'g0',
    opts.meeting?.date ?? '',
    ...versions.map((v) => v?.contentHash ?? 'empty'),
  ].join(':');
  const hit = pdfCacheGet(key);
  if (hit) return hit;

  const LETTERHEAD: readonly string[] = ['COVER_PAGE', 'EXPL_MEMORANDUM'];
  const sheetsFor = (docType: string) => [
    'tokens.css',
    'act.css',
    'align.css',
    ...(LETTERHEAD.includes(docType) ? ['masthead.css'] : []),
    ...(opts.guidance ? ['guidance.css'] : []),
  ];

  const parts: Uint8Array[] = [];
  for (const doc of proposal.documents) {
    const version = await latestVersion(db, doc.id);
    if (!version) continue;
    parts.push(
      await renderPdf({
        body: toHtml(parse(version.xml, doc.docType as DocType)),
        title: `${proposal.ref} — ${doc.title}`,
        stylesheets: sheetsFor(doc.docType),
        ...(LETTERHEAD.includes(doc.docType) ? { runningHead: runningHead(opts.meeting) } : {}),
      }),
    );
  }

  if (parts.length === 0) throw new NotFound(`Proposal ${proposalId} has nothing to export`);
  const bytes = await mergePdfs(parts);
  pdfCacheSet(key, bytes);
  return bytes;
}

export async function milestoneContents(db: Db, milestoneId: string) {
  return db
    .select({
      documentId: milestoneDocuments.documentId,
      title: documents.title,
      docType: documents.docType,
      position: documents.position,
      xml: documentVersions.xml,
      contentHash: documentVersions.contentHash,
      major: documentVersions.major,
      minor: documentVersions.minor,
      patch: documentVersions.patch,
    })
    .from(milestoneDocuments)
    .innerJoin(documentVersions, eq(documentVersions.id, milestoneDocuments.versionId))
    .innerJoin(documents, eq(documents.id, milestoneDocuments.documentId))
    .where(eq(milestoneDocuments.milestoneId, milestoneId))
    .orderBy(asc(documents.position));
}

export async function listMilestones(db: Db, proposalId: string) {
  return db
    .select()
    .from(milestones)
    .where(eq(milestones.proposalId, proposalId))
    .orderBy(desc(milestones.createdAt));
}

export async function documentHistory(db: Db, documentId: string) {
  return db
    .select({
      id: documentVersions.id,
      major: documentVersions.major,
      minor: documentVersions.minor,
      patch: documentVersions.patch,
      note: documentVersions.note,
      contentHash: documentVersions.contentHash,
      createdAt: documentVersions.createdAt,
      createdBy: documentVersions.createdBy,
    })
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId)))
    .orderBy(desc(documentVersions.createdAt));
}

export async function editElement(
  db: Db,
  input: {
    documentId: string;
    elementId: string;
    value?: string;
    align?: Align;
    userId: string;
  },
) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, input.documentId));
  if (!doc) throw new NotFound(`No document ${input.documentId}`);
  const current = await latestVersion(db, doc.id);
  if (!current) throw new NotFound(`Document ${input.documentId} has no content`);

  let updated: string;
  try {
    let tree = parse(current.xml, doc.docType as DocType);
    if (input.value !== undefined) tree = setElementText(tree, input.elementId, input.value);
    if (input.align !== undefined) tree = setElementAlign(tree, input.elementId, input.align);
    updated = serialize(tree);
  } catch (err) {
    throw new Conflict((err as Error).message);
  }

  return saveDocument(db, {
    documentId: doc.id,
    xml: updated,
    note: `Edited ${input.elementId}`,
    userId: input.userId,
  });
}

export async function documentHtml(db: Db, documentId: string) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) throw new NotFound(`No document ${documentId}`);
  const version = await latestVersion(db, documentId);
  if (!version) throw new NotFound(`Document ${documentId} has no content`);
  return {
    document: doc,
    version: { id: version.id, label: versionLabel(version), contentHash: version.contentHash },
    html: toHtml(parse(version.xml, doc.docType as DocType)),
  };
}
