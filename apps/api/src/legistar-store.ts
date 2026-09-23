import { createHash } from 'node:crypto';

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  actionCertifications,
  agendaItems,
  agendaVersions,
  bodyMemberships,
  documentVersions,
  documents,
  fileActions,
  governanceBodies,
  governanceTerms,
  legislativeFiles,
  meetingEvents,
  meetings,
  people,
  proposals,
  publications,
  type Db,
} from '@blevins/db';

import { Conflict, NotFound } from './service.ts';
import { ACTIONS, BODIES, FILE_STATUSES, VOTE_CHOICES, actionText, applyAction, type FileAction } from './legistar.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const parseJson = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

async function ensureFileRow(db: Db, proposalId: string) {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!proposal) throw new NotFound(`No file ${proposalId}`);
  await db.insert(legislativeFiles).values({ proposalId }).onConflictDoNothing();
}

export const catalog = () => ({
  bodies: [...BODIES],
  statuses: [...FILE_STATUSES],
  actions: [...ACTIONS],
  voteChoices: [...VOTE_CHOICES],
});

export async function listFiles(db: Db) {
  const rows = await db.select({ proposal: proposals, file: legislativeFiles })
    .from(proposals).leftJoin(legislativeFiles, eq(legislativeFiles.proposalId, proposals.id))
    .orderBy(desc(proposals.updatedAt));
  return rows.map(({ proposal, file }) => ({
    id: proposal.id, ref: proposal.ref, title: proposal.title, templateId: proposal.templateId,
    status: file?.status ?? 'Draft', inControl: file?.inControl ?? 'Clerk of the Board',
    sponsors: file?.sponsors ?? null, agendaDate: file?.agendaDate ?? null,
    enactmentNumber: file?.enactmentNumber ?? null, finalActionAt: file?.finalActionAt ?? null,
    updatedAt: file?.updatedAt ?? proposal.updatedAt,
  }));
}

export async function getFile(db: Db, id: string) {
  await ensureFileRow(db, id);
  const [row] = await db.select({ proposal: proposals, file: legislativeFiles })
    .from(proposals).innerJoin(legislativeFiles, eq(legislativeFiles.proposalId, proposals.id))
    .where(eq(proposals.id, id));
  if (!row) throw new NotFound(`No file ${id}`);
  return { id: row.proposal.id, ref: row.proposal.ref, title: row.proposal.title, templateId: row.proposal.templateId,
    ...row.file, proposalId: undefined };
}

export async function updateFileMeta(db: Db, id: string, input: { sponsors?: string; agendaDate?: string | null }) {
  await ensureFileRow(db, id);
  const [row] = await db.update(legislativeFiles).set({
    ...(input.sponsors !== undefined ? { sponsors: input.sponsors } : {}),
    ...(input.agendaDate !== undefined ? { agendaDate: input.agendaDate ? new Date(input.agendaDate) : null } : {}),
    updatedAt: new Date(),
  }).where(eq(legislativeFiles.proposalId, id)).returning();
  return { ...(await getFile(db, id)), ...row };
}

export async function listHistory(db: Db, id: string) {
  const rows = await db.select({ action: fileActions, certification: actionCertifications })
    .from(fileActions).leftJoin(actionCertifications, eq(actionCertifications.actionId, fileActions.id))
    .where(eq(fileActions.proposalId, id)).orderBy(desc(fileActions.actionAt));
  return rows.map(({ action, certification }) => ({
    ...action,
    votes: parseJson<{ memberName: string; vote: string }[]>(action.votes, []),
    certifiedAt: certification?.certifiedAt ?? null,
    certifiedBy: certification?.certifiedBy ?? null,
  }));
}

export async function recordAction(db: Db, input: {
  proposalId: string; meetingId?: string; action: FileAction; actingBody: string; sentTo?: string;
  result?: string; actionNote?: string; userId: string; votes?: { memberName: string; vote: string }[];
}) {
  await ensureFileRow(db, input.proposalId);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(legislativeFiles).where(eq(legislativeFiles.proposalId, input.proposalId));
    const transition = applyAction(input.action, input.sentTo);
    const now = new Date();
    await tx.update(legislativeFiles).set({
      status: transition.status, ...(transition.inControl ? { inControl: transition.inControl } : {}),
      ...(transition.final ? { finalActionAt: now } : {}), updatedAt: now,
    }).where(eq(legislativeFiles.proposalId, input.proposalId));
    const [action] = await tx.insert(fileActions).values({
      proposalId: input.proposalId, meetingId: input.meetingId ?? null, actingBody: input.actingBody,
      action: input.action, sentTo: input.sentTo ?? null, result: input.result ?? null,
      actionNote: input.actionNote ?? null, actionText: actionText(input.action, input.actingBody, input.sentTo),
      statusBefore: before?.status ?? 'Draft', statusAfter: transition.status,
      votes: JSON.stringify(input.votes ?? []), actorId: input.userId,
    }).returning();
    if (input.meetingId) await tx.insert(meetingEvents).values({
      meetingId: input.meetingId, eventType: 'ACTION_RECORDED',
      detail: JSON.stringify({ actionId: action!.id, proposalId: input.proposalId, action: input.action }),
      actorId: input.userId,
    });
    return { ...action!, votes: input.votes ?? [] };
  });
}

export async function certifyAction(db: Db, actionId: string, userId: string, note?: string) {
  const [action] = await db.select().from(fileActions).where(eq(fileActions.id, actionId));
  if (!action) throw new NotFound(`No action ${actionId}`);
  const [row] = await db.insert(actionCertifications).values({ actionId, certifiedBy: userId, note: note ?? null })
    .onConflictDoNothing().returning();
  if (!row) throw new Conflict('This action has already been certified.');
  if (action.meetingId) await db.insert(meetingEvents).values({
    meetingId: action.meetingId, eventType: 'ACTION_CERTIFIED',
    detail: JSON.stringify({ actionId }), actorId: userId,
  });
  return row;
}

async function latestAgenda(db: Db, meetingId: string) {
  const [row] = await db.select().from(agendaVersions).where(eq(agendaVersions.meetingId, meetingId))
    .orderBy(desc(agendaVersions.version)).limit(1);
  return row;
}

async function agendaDetail(db: Db, versionId: string) {
  const [version] = await db.select().from(agendaVersions).where(eq(agendaVersions.id, versionId));
  if (!version) throw new NotFound(`No agenda version ${versionId}`);
  const items = await db.select({
    id: agendaItems.id, position: agendaItems.position, heading: agendaItems.heading,
    proposalId: agendaItems.proposalId, recommendedAction: agendaItems.recommendedAction,
    ref: proposals.ref, title: proposals.title, status: legislativeFiles.status,
  }).from(agendaItems)
    .leftJoin(proposals, eq(proposals.id, agendaItems.proposalId))
    .leftJoin(legislativeFiles, eq(legislativeFiles.proposalId, agendaItems.proposalId))
    .where(eq(agendaItems.agendaVersionId, versionId)).orderBy(asc(agendaItems.position));
  return { ...version, items };
}

export async function listMeetings(db: Db) {
  const rows = await db.select().from(meetings).orderBy(desc(meetings.meetingAt));
  return Promise.all(rows.map(async (m) => {
    const agenda = await latestAgenda(db, m.id);
    return { ...m, agendaStatus: agenda?.status === 'PUBLISHED' ? 'Final' : 'Draft', agendaVersion: agenda?.version ?? 0 };
  }));
}

export async function createMeeting(db: Db, input: { body: string; meetingAt: string; location?: string; notes?: string; userId: string }) {
  return db.transaction(async (tx) => {
    const [meeting] = await tx.insert(meetings).values({
      body: input.body, meetingAt: new Date(input.meetingAt), location: input.location ?? null,
      notes: input.notes ?? null, createdBy: input.userId,
    }).returning();
    await tx.insert(agendaVersions).values({ meetingId: meeting!.id, version: 1, status: 'DRAFT', createdBy: input.userId });
    await tx.insert(meetingEvents).values({ meetingId: meeting!.id, eventType: 'MEETING_CREATED', detail: '{}', actorId: input.userId });
    return { ...meeting!, agendaStatus: 'Draft', agendaVersion: 1 };
  });
}

export async function getMeeting(db: Db, id: string) {
  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, id));
  if (!meeting) throw new NotFound(`No meeting ${id}`);
  const agenda = await latestAgenda(db, id);
  const events = await db.select().from(meetingEvents).where(eq(meetingEvents.meetingId, id)).orderBy(asc(meetingEvents.occurredAt));
  const pubs = await db.select().from(publications).where(eq(publications.meetingId, id)).orderBy(desc(publications.publishedAt));
  return {
    ...meeting,
    agendaStatus: agenda?.status === 'PUBLISHED' ? 'Final' : 'Draft',
    agendaVersion: agenda?.version ?? 0,
    items: agenda ? (await agendaDetail(db, agenda.id)).items : [],
    events: events.map((e) => ({ ...e, detail: parseJson(e.detail, {}) })),
    publications: pubs.map((p) => ({ ...p, manifest: parseJson(p.manifest, {}) })),
  };
}

async function writableAgenda(db: Db, meetingId: string, userId: string, reason?: string) {
  const latest = await latestAgenda(db, meetingId);
  if (!latest) {
    const [created] = await db.insert(agendaVersions).values({ meetingId, version: 1, status: 'DRAFT', createdBy: userId }).returning();
    return created!;
  }
  if (latest.status !== 'PUBLISHED') return latest;
  const [created] = await db.insert(agendaVersions).values({
    meetingId, version: latest.version + 1, status: 'DRAFT', reason: reason ?? 'Amendment after publication',
    supersedesId: latest.id, createdBy: userId,
  }).returning();
  const oldItems = await db.select().from(agendaItems).where(eq(agendaItems.agendaVersionId, latest.id)).orderBy(asc(agendaItems.position));
  if (oldItems.length) await db.insert(agendaItems).values(oldItems.map((i) => ({
    agendaVersionId: created!.id, proposalId: i.proposalId, heading: i.heading, position: i.position, recommendedAction: i.recommendedAction,
  })));
  return created!;
}

export async function generateAgenda(db: Db, meetingId: string, userId: string, reason?: string) {
  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!meeting) throw new NotFound(`No meeting ${meetingId}`);
  const agenda = await writableAgenda(db, meetingId, userId, reason);
  const candidates = await db.select({ id: proposals.id }).from(proposals)
    .innerJoin(legislativeFiles, eq(legislativeFiles.proposalId, proposals.id))
    .where(and(eq(legislativeFiles.inControl, meeting.body), sql`${legislativeFiles.status} NOT IN ('Adopted','Failed','Withdrawn','Filed','Abandoned')`));
  const existing = await db.select({ proposalId: agendaItems.proposalId }).from(agendaItems).where(eq(agendaItems.agendaVersionId, agenda.id));
  const have = new Set(existing.map((x) => x.proposalId));
  const additions = candidates.filter((c) => !have.has(c.id));
  if (additions.length) {
    const start = existing.length;
    await db.insert(agendaItems).values(additions.map((c, i) => ({ agendaVersionId: agenda.id, proposalId: c.id, position: start + i + 1 })));
  }
  await db.insert(meetingEvents).values({ meetingId, eventType: 'AGENDA_GENERATED', detail: JSON.stringify({ agendaVersion: agenda.version }), actorId: userId });
  return getMeeting(db, meetingId);
}

export async function addAgendaItem(db: Db, meetingId: string, input: { proposalId?: string; heading?: string; recommendedAction?: string }, userId: string) {
  const agenda = await writableAgenda(db, meetingId, userId);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(agendaItems).where(eq(agendaItems.agendaVersionId, agenda.id));
  const [item] = await db.insert(agendaItems).values({
    agendaVersionId: agenda.id, proposalId: input.proposalId ?? null, heading: input.heading ?? null,
    recommendedAction: input.recommendedAction ?? null, position: (n ?? 0) + 1,
  }).returning();
  return item;
}

export async function publishAgenda(db: Db, meetingId: string, userId: string, reason?: string) {
  const agenda = await latestAgenda(db, meetingId);
  if (!agenda) throw new Conflict('Generate an agenda before publication.');
  if (agenda.status === 'PUBLISHED') throw new Conflict('This agenda version is already published. Create an amended draft instead.');
  const detail = await agendaDetail(db, agenda.id);
  if (!detail.items.length) throw new Conflict('An empty agenda cannot be published.');
  const manifest = {
    meetingId, agendaVersionId: agenda.id, version: agenda.version,
    items: detail.items.map((i) => ({ id: i.id, position: i.position, proposalId: i.proposalId, ref: i.ref, title: i.title })),
  };
  const manifestJson = JSON.stringify(manifest);
  return db.transaction(async (tx) => {
    await tx.update(agendaVersions).set({ status: 'PUBLISHED', publishedAt: new Date(), reason: reason ?? agenda.reason })
      .where(eq(agendaVersions.id, agenda.id));
    const [previous] = await tx.select().from(publications).where(and(eq(publications.meetingId, meetingId), eq(publications.kind, 'AGENDA')))
      .orderBy(desc(publications.version)).limit(1);
    const [pub] = await tx.insert(publications).values({
      kind: 'AGENDA', meetingId, agendaVersionId: agenda.id, version: agenda.version,
      manifest: manifestJson, contentHash: digest(manifestJson), reason: reason ?? agenda.reason,
      supersedesId: previous?.id ?? null, publishedBy: userId,
    }).returning();
    await tx.insert(meetingEvents).values({
      meetingId, eventType: 'AGENDA_PUBLISHED',
      detail: JSON.stringify({ publicationId: pub!.id, agendaVersion: agenda.version, hash: pub!.contentHash }),
      actorId: userId,
    });
    return pub!;
  });
}

export async function createAgendaAmendment(db: Db, meetingId: string, userId: string, reason: string) {
  const agenda = await writableAgenda(db, meetingId, userId, reason);
  await db.insert(meetingEvents).values({ meetingId, eventType: 'AGENDA_AMENDMENT_CREATED', detail: JSON.stringify({ agendaVersion: agenda.version, reason }), actorId: userId });
  return getMeeting(db, meetingId);
}

export async function recordMeetingEvent(db: Db, meetingId: string, userId: string, eventType: string, detail: Record<string, unknown> = {}) {
  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!meeting) throw new NotFound(`No meeting ${meetingId}`);
  const [event] = await db.insert(meetingEvents).values({ meetingId, eventType, detail: JSON.stringify(detail), actorId: userId }).returning();
  const statusByEvent: Record<string,string> = { MEETING_CALLED_TO_ORDER: 'IN_PROGRESS', MEETING_ADJOURNED: 'ADJOURNED', MINUTES_ADOPTED: 'CLOSED' };
  if (statusByEvent[eventType]) await db.update(meetings).set({ status: statusByEvent[eventType], updatedAt: new Date() }).where(eq(meetings.id, meetingId));
  return event!;
}

export async function listPublications(db: Db, input: { meetingId?: string; proposalId?: string } = {}) {
  let rows = await db.select().from(publications).orderBy(desc(publications.publishedAt));
  if (input.meetingId) rows = rows.filter((r) => r.meetingId === input.meetingId);
  if (input.proposalId) rows = rows.filter((r) => r.proposalId === input.proposalId);
  return rows.map((r) => ({ ...r, manifest: parseJson(r.manifest, {}) }));
}

export async function publishFileRecord(db: Db, proposalId: string, userId: string, reason?: string) {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId));
  if (!proposal) throw new NotFound(`No file ${proposalId}`);
  const docs = await db.select().from(documents).where(eq(documents.proposalId, proposalId)).orderBy(asc(documents.position));
  const manifestDocs = [];
  for (const doc of docs) {
    const [version] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, doc.id))
      .orderBy(desc(documentVersions.major), desc(documentVersions.minor), desc(documentVersions.patch)).limit(1);
    if (version) manifestDocs.push({ documentId: doc.id, title: doc.title, versionId: version.id, contentHash: version.contentHash });
  }
  const [previous] = await db.select().from(publications).where(and(eq(publications.proposalId, proposalId), eq(publications.kind, 'FILE_RECORD')))
    .orderBy(desc(publications.version)).limit(1);
  const manifestJson = JSON.stringify({ proposalId, ref: proposal.ref, title: proposal.title, documents: manifestDocs });
  const [pub] = await db.insert(publications).values({
    kind: 'FILE_RECORD', proposalId, version: (previous?.version ?? 0) + 1, manifest: manifestJson,
    contentHash: digest(manifestJson), reason: reason ?? null, supersedesId: previous?.id ?? null, publishedBy: userId,
  }).returning();
  return pub!;
}

export async function listBodies(db: Db) {
  const bodies = await db.select().from(governanceBodies).where(eq(governanceBodies.active, 1)).orderBy(asc(governanceBodies.name));
  return Promise.all(bodies.map(async (body) => ({
    ...body,
    memberships: await db.select({ membership: bodyMemberships, person: people, term: governanceTerms })
      .from(bodyMemberships).innerJoin(people, eq(people.id, bodyMemberships.personId))
      .leftJoin(governanceTerms, eq(governanceTerms.id, bodyMemberships.termId))
      .where(eq(bodyMemberships.bodyId, body.id)).orderBy(asc(bodyMemberships.startsAt)),
  })));
}
