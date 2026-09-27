import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { documents, proposals, type Db } from '@blevins/db';
import { z } from 'zod';

import { NotFound, getProposal } from './service.ts';
import { requireDocumentAccess, requireProposalAccess } from './authorization.ts';

export function registerFiles(
  app: FastifyInstance,
  db: Db,
  requireUser: (req: FastifyRequest) => Promise<{ id: string }>,
) {
  app.patch('/proposals/:id', async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await requireProposalAccess(db, id, user.id, 'write');
    const { title } = z.object({ title: z.string().min(1).max(400) }).parse(req.body);
    const [row] = await db
      .update(proposals)
      .set({ title, updatedAt: new Date() })
      .where(eq(proposals.id, id))
      .returning();
    if (!row) throw new NotFound(`No proposal ${id}`);
    return getProposal(db, id);
  });

  app.patch('/documents/:id', async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await requireDocumentAccess(db, id, user.id, 'write');
    const { title } = z.object({ title: z.string().min(1).max(400) }).parse(req.body);
    const [row] = await db
      .update(documents)
      .set({ title })
      .where(eq(documents.id, id))
      .returning();
    if (!row) throw new NotFound(`No document ${id}`);
    return row;
  });

}
