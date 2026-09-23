import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '@blevins/db';

import { ACTIONS, BODIES, VOTE_CHOICES } from './legistar.ts';
import {
  addAgendaItem, catalog, certifyAction, createAgendaAmendment, createMeeting, generateAgenda,
  getFile, getMeeting, listBodies, listFiles, listHistory, listMeetings, listPublications,
  publishAgenda, publishFileRecord, recordAction, recordMeetingEvent, updateFileMeta,
} from './legistar-store.ts';

const Action=z.enum(ACTIONS); const Body=z.enum(BODIES); const Vote=z.enum(VOTE_CHOICES);

export function registerLegistar(app: FastifyInstance, db: Db, requireUser: (req: FastifyRequest)=>Promise<{id:string}>) {
  app.get('/legistar/catalog', async()=>catalog());
  app.get('/files', async()=>listFiles(db));
  app.get('/files/:id', async(req)=>getFile(db,z.object({id:z.string().uuid()}).parse(req.params).id));
  app.patch('/files/:id', async(req)=>{ await requireUser(req); const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({sponsors:z.string().max(2000).optional(),agendaDate:z.string().nullable().optional()}).parse(req.body); return updateFileMeta(db,id,body); });
  app.get('/files/:id/history', async(req)=>listHistory(db,z.object({id:z.string().uuid()}).parse(req.params).id));
  app.post('/files/:id/actions', async(req)=>{ const user=await requireUser(req); const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({action:Action,actingBody:Body,sentTo:Body.optional(),meetingId:z.string().uuid().optional(),result:z.string().max(80).optional(),
      actionNote:z.string().max(4000).optional(),votes:z.array(z.object({memberName:z.string().min(1).max(120),vote:Vote})).optional()}).parse(req.body);
    return recordAction(db,{proposalId:id,...body,userId:user.id}); });
  app.post('/actions/:id/certify', async(req)=>{ const user=await requireUser(req); const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const {note}=z.object({note:z.string().max(2000).optional()}).parse(req.body??{}); return certifyAction(db,id,user.id,note); });

  app.get('/meetings', async()=>listMeetings(db));
  app.post('/meetings', async(req,reply)=>{ const user=await requireUser(req); const body=z.object({body:Body,meetingAt:z.string().min(1),location:z.string().max(300).optional(),notes:z.string().max(2000).optional()}).parse(req.body);
    return reply.code(201).send(await createMeeting(db,{...body,userId:user.id})); });
  app.get('/meetings/:id', async(req)=>getMeeting(db,z.object({id:z.string().uuid()}).parse(req.params).id));
  app.post('/meetings/:id/generate', async(req)=>{ const user=await requireUser(req); const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const {reason}=z.object({reason:z.string().max(2000).optional()}).parse(req.body??{}); return generateAgenda(db,id,user.id,reason); });
  app.post('/meetings/:id/items', async(req)=>{ const user=await requireUser(req); const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({proposalId:z.string().uuid().optional(),heading:z.string().max(300).optional(),recommendedAction:z.string().max(2000).optional()}).parse(req.body);
    return addAgendaItem(db,id,body,user.id); });
  app.post('/meetings/:id/publish', async(req)=>{ const user=await requireUser(req); const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const {reason}=z.object({reason:z.string().max(2000).optional()}).parse(req.body??{}); await publishAgenda(db,id,user.id,reason); return getMeeting(db,id); });
  app.post('/meetings/:id/amend', async(req)=>{ const user=await requireUser(req); const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const {reason}=z.object({reason:z.string().min(1).max(2000)}).parse(req.body); return createAgendaAmendment(db,id,user.id,reason); });
  app.post('/meetings/:id/events', async(req)=>{ const user=await requireUser(req); const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const body=z.object({eventType:z.enum(['MEETING_CALLED_TO_ORDER','ROLL_CALL','MOTION','MEETING_ADJOURNED','MINUTES_ADOPTED']),detail:z.record(z.unknown()).optional()}).parse(req.body);
    return recordMeetingEvent(db,id,user.id,body.eventType,body.detail??{}); });

  app.get('/publications', async(req)=>{ const q=z.object({meetingId:z.string().uuid().optional(),proposalId:z.string().uuid().optional()}).parse(req.query); return listPublications(db,q); });
  app.post('/files/:id/publish', async(req)=>{ const user=await requireUser(req); const {id}=z.object({id:z.string().uuid()}).parse(req.params);
    const {reason}=z.object({reason:z.string().max(2000).optional()}).parse(req.body??{}); return publishFileRecord(db,id,user.id,reason); });
  app.get('/bodies', async()=>listBodies(db));
}
