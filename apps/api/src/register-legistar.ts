import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '@blevins/db';

import { NotFound } from './service.ts';
import { ACTIONS, BODIES, VOTE_CHOICES, type FileAction } from './legistar.ts';
import {
  addAgendaItem,
  catalog,
  createMeeting,
  ensureFileRow,
  ensureLegistarTables,
  generateAgenda,
  getFile,
  getMeeting,
  listFiles,
  listHistory,
  listMeetings,
  recordAction,
  setAgendaStatus,
  updateFileMeta,
} from './legistar-store.ts';

const Action = z.enum(ACTIONS);
const Body = z.enum(BODIES);
const Vote = z.enum(VOTE_CHOICES);

export async function registerLegistar(
  app: FastifyInstance,
  db: Db,
  requireUser: (req: FastifyRequest) => Promise<{ id: string }>,
): Promise<void> {
  await ensureLegistarTables(db);

  app.get('/legistar/catalog', async () => catalog());
  app.get('/files', async () => listFiles(db));

  app.get('/files/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await ensureFileRow(db, id);
    const file = await getFile(db, id);
    if (!file) throw new NotFound(`No file ${id}`);
    return file;
  });

  app.patch('/files/:id', async (req) => {
    await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        sponsors: z.string().max(2000).optional(),
        agendaDate: z.string().nullable().optional(),
      })
      .parse(req.body);
    return updateFileMeta(db, id, body);
  });

  app.get('/files/:id/history', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return listHistory(db, id);
  });

  app.post('/files/:id/actions', async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        action: Action,
        actingBody: Body,
        sentTo: Body.optional(),
        result: z.string().max(80).optional(),
        actionNote: z.string().max(4000).optional(),
        votes: z.array(z.object({ memberName: z.string().min(1).max(120), vote: Vote })).optional(),
      })
      .parse(req.body);
    return recordAction(db, {
      proposalId: id,
      action: body.action as FileAction,
      actingBody: body.actingBody,
      sentTo: body.sentTo,
      result: body.result,
      actionNote: body.actionNote,
      userId: user.id,
      votes: body.votes,
    });
  });

  app.get('/meetings', async () => listMeetings(db));

  app.post('/meetings', async (req, reply) => {
    await requireUser(req);
    const body = z
      .object({
        body: Body,
        meetingAt: z.string().min(1),
        location: z.string().max(300).optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body);
    const meeting = await createMeeting(db, body);
    return reply.code(201).send(meeting);
  });

  app.get('/meetings/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const meeting = await getMeeting(db, id);
    if (!meeting) throw new NotFound(`No meeting ${id}`);
    return meeting;
  });

  app.post('/meetings/:id/generate', async (req) => {
    await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return generateAgenda(db, id);
  });

  app.post('/meetings/:id/publish', async (req) => {
    await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.enum(['Draft', 'Final']) }).parse(req.body ?? {});
    return setAgendaStatus(db, id, status);
  });

  app.post('/meetings/:id/items', async (req) => {
    await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        proposalId: z.string().uuid().optional(),
        heading: z.string().max(300).optional(),
      })
      .parse(req.body);
    return addAgendaItem(db, id, body);
  });
}
