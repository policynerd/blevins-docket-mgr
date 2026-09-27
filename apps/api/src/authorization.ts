import { and, eq } from 'drizzle-orm';
import {
  collaborators,
  contributions,
  documents,
  milestones,
  proposals,
  type Db,
} from '@blevins/db';

import { NotFound } from './service.ts';

export type ProposalPermission = 'read' | 'write' | 'manage';

export class Forbidden extends Error {
  statusCode = 403;
}

async function proposalRole(db: Db, proposalId: string, userId: string) {
  const [proposal] = await db
    .select({ id: proposals.id, createdBy: proposals.createdBy })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  if (!proposal) throw new NotFound(`No proposal ${proposalId}`);
  if (proposal.createdBy === userId) return 'OWNER' as const;

  const [collaborator] = await db
    .select({ role: collaborators.role })
    .from(collaborators)
    .where(and(eq(collaborators.proposalId, proposalId), eq(collaborators.userId, userId)));
  return collaborator?.role ?? null;
}

export async function requireProposalAccess(
  db: Db,
  proposalId: string,
  userId: string,
  permission: ProposalPermission = 'read',
) {
  const role = await proposalRole(db, proposalId, userId);
  const allowed =
    role === 'OWNER' ||
    (permission === 'read' && (role === 'CONTRIBUTOR' || role === 'REVIEWER')) ||
    (permission === 'write' && role === 'CONTRIBUTOR');
  if (!allowed) throw new Forbidden('You do not have access to this proposal');
  return role;
}

export async function listAccessibleProposals(db: Db, userId: string) {
  const owned = await db.select().from(proposals).where(eq(proposals.createdBy, userId));
  const shared = await db
    .select({ proposal: proposals })
    .from(collaborators)
    .innerJoin(proposals, eq(proposals.id, collaborators.proposalId))
    .where(eq(collaborators.userId, userId));

  const rows = new Map(owned.map((proposal) => [proposal.id, proposal]));
  for (const { proposal } of shared) rows.set(proposal.id, proposal);
  return [...rows.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function requireDocumentAccess(
  db: Db,
  documentId: string,
  userId: string,
  permission: ProposalPermission = 'read',
) {
  const [document] = await db
    .select({ proposalId: documents.proposalId })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!document) throw new NotFound(`No document ${documentId}`);
  return requireProposalAccess(db, document.proposalId, userId, permission);
}

export async function requireMilestoneAccess(
  db: Db,
  milestoneId: string,
  userId: string,
  permission: ProposalPermission = 'read',
) {
  const [milestone] = await db
    .select({ proposalId: milestones.proposalId })
    .from(milestones)
    .where(eq(milestones.id, milestoneId));
  if (!milestone) throw new NotFound(`No milestone ${milestoneId}`);
  return requireProposalAccess(db, milestone.proposalId, userId, permission);
}

export async function requireContributionAccess(
  db: Db,
  contributionId: string,
  userId: string,
  action: 'read' | 'edit' | 'merge',
) {
  const [contribution] = await db
    .select({
      targetUserId: contributions.targetUserId,
      proposalId: milestones.proposalId,
    })
    .from(contributions)
    .innerJoin(milestones, eq(milestones.id, contributions.milestoneId))
    .where(eq(contributions.id, contributionId));
  if (!contribution) throw new NotFound(`No contribution ${contributionId}`);

  if (action === 'edit') {
    if (contribution.targetUserId !== userId) {
      throw new Forbidden('This contribution belongs to someone else');
    }
    return;
  }

  if (action === 'merge') {
    await requireProposalAccess(db, contribution.proposalId, userId, 'write');
    return;
  }

  if (contribution.targetUserId === userId) return;
  await requireProposalAccess(db, contribution.proposalId, userId, 'read');
}
