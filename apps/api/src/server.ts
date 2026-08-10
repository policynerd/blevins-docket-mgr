import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { users, type Db } from '@blevins/db';
import { z } from 'zod';

import { TEMPLATES } from './templates.ts';
import {
  Conflict,
  NotFound,
  createMilestone,
  createProposal,
  documentHistory,
  exportProposal,
  getProposal,
  latestVersion,
  listMilestones,
  milestoneContents,
  documentHtml,
  editElement,
  saveDocument,
  versionLabel,
} from './service.ts';
import { documents, proposals } from '@blevins/db';

/**
 * Identify the caller.
 *
 * This is a placeholder, and deliberately a thin one: it maps an `x-user-id`
 * header to an existing row and rejects anything else. It is NOT a security
 * boundary — anyone who can reach the port can claim any id. Real
 * authentication (session or OIDC, with the identity signed) has to land
 * before this is exposed beyond a trusted network.
 *
 * It refuses to create users on the fly on purpose. Auto-provisioning from an
 * unauthenticated header would let a typo mint an account that then appears in
 * collaborator lists and authorship of versions, which is a mess to unpick
 * from a legislative record.
 */
async function requireUser(db: Db, req: FastifyRequest) {
  const id = req.headers['x-user-id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw Object.assign(new Error('Missing x-user-id'), { statusCode: 401 });
  }
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) throw Object.assign(new Error('Unknown user'), { statusCode: 401 });
  return user;
}

const CreateProposal = z.object({
  templateId: z.string().min(1),
  title: z.string().min(1),
  ref: z.string().min(1).optional(),
});

const SaveDocument = z.object({
  xml: z.string().min(1),
  note: z.string().optional(),
});

const CreateMilestone = z.object({ label: z.string().min(1) });

export function buildServer(db: Db): FastifyInstance {
  const app = Fastify({
    logger: process.env['API_LOG'] === '1' ? { level: 'info' } : false,
    // A legislative instrument can legitimately be large.
    bodyLimit: 20 * 1024 * 1024,
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    // A malformed uuid or an empty title is the caller's mistake. Left to fall
    // through, Zod's error carries no statusCode and is reported as an
    // internal failure — which tells the caller nothing and makes a bad
    // request look like a broken server.
    if (err instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof NotFound) return reply.code(404).send({ error: err.message });
    if (err instanceof Conflict) return reply.code(409).send({ error: err.message });

    const status = (err as { statusCode?: number })?.statusCode ?? 500;
    // An unexpected failure says nothing about itself to the caller. Internal
    // messages leak schema and file paths, and this endpoint serves a public
    // record; the detail belongs in the log, not the response body.
    const message =
      status === 500 ? 'Internal error' : ((err as { message?: string })?.message ?? 'Error');
    if (status === 500) app.log.error(err);
    return reply.code(status).send({ error: message });
  });

  app.get('/health', async () => ({ ok: true }));

  /** The template picker's tree. */
  app.get('/templates', async () =>
    TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      path: t.path,
      documents: t.documents.map((d) => ({ docType: d.docType, title: d.title })),
    })),
  );

  app.get('/proposals', async () => db.select().from(proposals).orderBy(proposals.createdAt));

  app.post('/proposals', async (req, reply) => {
    const user = await requireUser(db, req);
    const body = CreateProposal.parse(req.body);
    const proposal = await createProposal(db, { ...body, userId: user.id });
    return reply.code(201).send(await getProposal(db, proposal.id));
  });

  app.get('/proposals/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getProposal(db, id);
  });

  app.get('/proposals/:id/export.pdf', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Not z.coerce.boolean(): it follows JavaScript truthiness, so the string
    // "false" coerces to true and the opt-out silently opts in.
    const { guidance } = z
      .object({ guidance: z.enum(['true', '1', 'false', '0']).optional() })
      .parse(req.query);
    const wantsGuidance = guidance === 'true' || guidance === '1';

    // The export itself is public — it is the record. The guidance proof is
    // not: it carries instructions written to whoever holds the pen, which the
    // ordinary export deliberately hides. Handing that to an anonymous caller
    // would publish exactly what the stylesheet exists to withhold.
    if (wantsGuidance) await requireUser(db, req);

    const pdf = await exportProposal(db, id, { guidance: wantsGuidance });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${id}.pdf"`)
      .send(Buffer.from(pdf));
  });

  app.get('/documents/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    if (!doc) throw new NotFound(`No document ${id}`);
    const version = await latestVersion(db, id);
    if (!version) throw new NotFound(`Document ${id} has no content`);
    return {
      ...doc,
      version: {
        id: version.id,
        label: versionLabel(version),
        xml: version.xml,
        contentHash: version.contentHash,
        createdAt: version.createdAt,
      },
    };
  });

  app.put('/documents/:id', async (req) => {
    const user = await requireUser(db, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = SaveDocument.parse(req.body);
    const saved = await saveDocument(db, { documentId: id, ...body, userId: user.id });
    return { id: saved.id, label: versionLabel(saved), contentHash: saved.contentHash };
  });

  app.get('/documents/:id/html', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return documentHtml(db, id);
  });

  app.patch('/documents/:id/elements/:elementId', async (req) => {
    const user = await requireUser(db, req);
    const { id, elementId } = z
      .object({ id: z.string().uuid(), elementId: z.string().min(1).max(64) })
      .parse(req.params);
    const { value } = z.object({ value: z.string() }).parse(req.body);
    const saved = await editElement(db, { documentId: id, elementId, value, userId: user.id });
    return { id: saved.id, label: versionLabel(saved), contentHash: saved.contentHash };
  });

  app.get('/documents/:id/versions', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return (await documentHistory(db, id)).map((v) => ({ ...v, label: versionLabel(v) }));
  });

  app.get('/proposals/:id/milestones', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return listMilestones(db, id);
  });

  app.post('/proposals/:id/milestones', async (req, reply) => {
    const user = await requireUser(db, req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { label } = CreateMilestone.parse(req.body);
    const milestone = await createMilestone(db, { proposalId: id, label, userId: user.id });
    return reply.code(201).send(milestone);
  });

  app.get('/milestones/:id/documents', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return milestoneContents(db, id);
  });

  return app;
}
