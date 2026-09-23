import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { eq } from 'drizzle-orm';
import { type Db } from '@blevins/db';
import { z } from 'zod';

import { entraConfig } from './entra.ts';
import { sessionSecret } from './session.ts';
import {
  authOptions,
  devLoginGuard,
  registerAuth,
  requireUser as requireSessionUser,
  type OidcSeams,
} from './auth.ts';

import { TEMPLATES } from './templates.ts';
import { templatePreview } from './template-preview.ts';
import { registerFiles } from './register-files.ts';
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
import {
  contributionContents,
  editContribution,
  listContributions,
  mergeContribution,
  sendForContribution,
  submitContribution,
} from './contributions.ts';

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

const EditElement = z
  .object({
    value: z.string().optional(),
    align: z.enum(['start', 'end', 'center', 'justify']).optional(),
  })
  .refine((b) => b.value !== undefined || b.align !== undefined, {
    message: 'value or align is required',
  });

export function rateLimits(env: NodeJS.ProcessEnv) {
  const read = (name: string, fallback: number) => {
    const parsed = Number(env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  return {
    global: read('RATE_LIMIT_MAX', 300),
    auth: read('RATE_LIMIT_AUTH_MAX', 20),
    export: read('RATE_LIMIT_EXPORT_MAX', 10),
  };
}

export async function buildServer(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
  seams: OidcSeams = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env['API_LOG'] === '1' ? { level: 'info' } : false,
    bodyLimit: 20 * 1024 * 1024,
  });

  const secret = sessionSecret(env);
  const auth = { ...authOptions(env, entraConfig(env)), secret };
  devLoginGuard(auth, env);

  const requireUser = (req: FastifyRequest) => requireSessionUser(db, secret, req);
  const limits = rateLimits(env);

  await app.register(cookie);
  await app.register(rateLimit, {
    max: limits.global,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health',
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too many requests. Try again shortly.',
    }),
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof NotFound) return reply.code(404).send({ error: err.message });
    if (err instanceof Conflict) return reply.code(409).send({ error: err.message });

    const status = (err as { statusCode?: number })?.statusCode ?? 500;
    const message =
      status === 500 ? 'Internal error' : ((err as { message?: string })?.message ?? 'Error');
    if (status === 500) app.log.error(err);
    return reply.code(status).send({ error: message });
  });

  app.get('/health', async () => ({ ok: true }));

  registerAuth(app, db, { ...auth, rateLimitMax: limits.auth }, seams);
  registerFiles(app, db, requireUser);

  app.get('/meta', async () => ({
    signInConfigured: entraConfig(env) !== null,
    appBaseUrl: env['APP_BASE_URL'] ?? null,
    chromium: Boolean(env['CHROMIUM_PATH']),
    product: 'blevins-drafting',
    docketSync: Boolean(env['DOCKET_SYNC_URL'] && env['DOCKET_SYNC_SECRET']),
  }));

  app.get('/templates', async () =>
    TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      path: t.path,
      documents: t.documents.map((d) => ({ docType: d.docType, title: d.title })),
    })),
  );

  app.get('/templates/:id', async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const preview = templatePreview(id);
    if (!preview) throw new NotFound(`No template ${id}`);
    return preview;
  });

  app.get('/proposals', async () => db.select().from(proposals).orderBy(proposals.createdAt));

  app.post('/proposals', async (req, reply) => {
    const user = await requireUser(req);
    const body = CreateProposal.parse(req.body);
    const proposal = await createProposal(db, { ...body, userId: user.id });
    return reply.code(201).send(await getProposal(db, proposal.id));
  });

  app.get('/proposals/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getProposal(db, id);
  });

  app.get(
    '/proposals/:id/export.pdf',
    { config: { rateLimit: { max: limits.export, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { guidance } = z
        .object({ guidance: z.enum(['true', '1', 'false', '0']).optional() })
        .parse(req.query);
      const wantsGuidance = guidance === 'true' || guidance === '1';
      if (wantsGuidance) await requireUser(req);
      const pdf = await exportProposal(db, id, { guidance: wantsGuidance });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `inline; filename="${id}.pdf"`)
        .send(Buffer.from(pdf));
    },
  );

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
    const user = await requireUser(req);
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
    const user = await requireUser(req);
    const { id, elementId } = z
      .object({ id: z.string().uuid(), elementId: z.string().min(1).max(64) })
      .parse(req.params);
    const body = EditElement.parse(req.body);
    const saved = await editElement(db, {
      documentId: id,
      elementId,
      value: body.value,
      align: body.align,
      userId: user.id,
    });
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
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { label } = CreateMilestone.parse(req.body);
    const milestone = await createMilestone(db, { proposalId: id, label, userId: user.id });
    return reply.code(201).send(milestone);
  });

  app.get('/milestones/:id/contributions', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return listContributions(db, id);
  });

  app.post('/milestones/:id/contributions', async (req, reply) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { targetEmail } = z.object({ targetEmail: z.string().email() }).parse(req.body);
    const c = await sendForContribution(db, { milestoneId: id, targetEmail, userId: user.id });
    return reply.code(201).send(c);
  });

  app.get('/contributions/:id/documents', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return contributionContents(db, id);
  });

  app.patch('/contributions/:id/documents/:documentId/elements/:elementId', async (req) => {
    const user = await requireUser(req);
    const { id, documentId, elementId } = z
      .object({
        id: z.string().uuid(),
        documentId: z.string().uuid(),
        elementId: z.string().min(1).max(64),
      })
      .parse(req.params);
    const { value } = z.object({ value: z.string() }).parse(req.body);
    return editContribution(db, {
      contributionId: id,
      documentId,
      elementId,
      value,
      userId: user.id,
    });
  });

  app.post('/contributions/:id/submit', async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return submitContribution(db, id, user.id);
  });

  app.post('/contributions/:id/merge', async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return mergeContribution(db, id, user.id);
  });

  app.get('/milestones/:id/documents', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return milestoneContents(db, id);
  });

  return app;
}
