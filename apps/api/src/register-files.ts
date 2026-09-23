import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { documents, proposals, type Db } from '@blevins/db';
import { z } from 'zod';

import { NotFound, getProposal } from './service.ts';

export function registerFiles(
  app: FastifyInstance,
  db: Db,
  requireUser: (req: FastifyRequest) => Promise<unknown>,
) {
  app.get('/files', async (req) => {
    await requireUser(req);
    const rows = await db.select().from(proposals).orderBy(desc(proposals.updatedAt));
    return rows.map((p) => ({
      id: p.id,
      ref: p.ref,
      title: p.title,
      templateId: p.templateId,
      status: 'Draft',
      inControl: 'Office of the General Counsel',
      agendaDate: null,
      enactmentNumber: null,
      updatedAt: p.updatedAt,
    }));
  });

  app.get('/files/:id', async (req) => {
    await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getProposal(db, id);
  });

  app.patch('/proposals/:id', async (req) => {
    await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
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
    await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { title } = z.object({ title: z.string().min(1).max(400) }).parse(req.body);
    const [row] = await db
      .update(documents)
      .set({ title })
      .where(eq(documents.id, id))
      .returning();
    if (!row) throw new NotFound(`No document ${id}`);
    return row;
  });

  app.get('/meetings', async (req) => {
    await requireUser(req);
    return [];
  });

  app.get('/legistar/catalog', async (req) => {
    await requireUser(req);
    return {
      bodies: [
        'Office of the General Counsel',
        'Board of Governors',
        'Finance Committee',
        'Audit Committee',
      ],
      statuses: ['Draft', 'In Committee', 'Passed', 'Adopted', 'Enacted'],
      actions: ['Referred', 'Recommended for Approval', 'Passed', 'Adopted'],
      voteChoices: ['Aye', 'No', 'Abstain', 'Absent'],
    };
  });
}
