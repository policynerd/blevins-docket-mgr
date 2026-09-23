import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// The legislative record.
//
// The shape here follows what a proposal actually is in LEOS, which is not one
// document but a package of independently drafted parts — cover page,
// explanatory memorandum, legal act, financial statement, annexes — each with
// its own edit history, each separately renderable, merged into a single PDF
// only at export. Modelling them as one blob would make it impossible to say
// who changed the memorandum without touching the act, which is precisely the
// question an audit of a legislative record has to answer.

export const docTypeEnum = pgEnum('doc_type', [
  'COVER_PAGE',
  'EXPL_MEMORANDUM',
  'LEGAL_ACT',
  'FINANCIAL_STATEMENT',
  'ANNEX',
]);

export const collaboratorRoleEnum = pgEnum('collaborator_role', [
  'OWNER',
  'CONTRIBUTOR',
  'REVIEWER',
]);

export const contributionStatusEnum = pgEnum('contribution_status', [
  'SENT',
  'IN_PROGRESS',
  'SUBMITTED',
  'MERGED',
  'REJECTED',
]);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    organization: text('organization'),
    /**
     * The Entra object id, recorded the first time someone signs in.
     *
     * Sign-in matches on this before it matches on address, because an address
     * is not an identity: people marry, change names, and get their mailbox
     * renamed, and when that happens the authorship on every version they ever
     * wrote must not silently detach and reattach to whoever inherits the old
     * address. The oid never changes for the life of the account.
     *
     * Null until first sign-in, so a roster can be seeded ahead of anyone
     * having logged in.
     */
    entraOid: text('entra_oid'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
    uniqueIndex('users_entra_oid_key').on(t.entraOid),
  ],
);

export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Human-facing reference, e.g. PROP_ACT-2026-014. */
    ref: text('ref').notNull(),
    title: text('title').notNull(),
    /** The template this was created from, e.g. SJ-019. */
    templateId: text('template_id').notNull(),
    language: text('language').notNull().default('EN'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('proposals_ref_key').on(t.ref)],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    docType: docTypeEnum('doc_type').notNull(),
    title: text('title').notNull(),
    /** Ordering within the proposal; annexes are reorderable. */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_proposal_idx').on(t.proposalId, t.position)],
);

/**
 * An immutable content snapshot.
 *
 * Rows here are never updated — a save writes a new version. That is what
 * makes the history of an instrument answerable after the fact: "what did
 * Article 4 say when the Board voted on it" has to resolve to bytes, not to a
 * mutable row that has since moved on.
 *
 * `contentHash` is a digest of `xml`, stored so a published version can be
 * shown to be byte-identical to what was approved. Without it the archive can
 * only assert its own integrity; with it, the assertion is checkable.
 */
export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    // Versions are labelled v<major>.<minor>.<patch>. Today every save bumps
    // `minor` and nothing bumps `major` — LEOS raises major at a milestone,
    // and we do not yet. The columns exist so that becoming true later is a
    // behaviour change rather than a migration; until then this comment is
    // the contract, and it says minor-only.
    major: integer('major').notNull().default(0),
    minor: integer('minor').notNull().default(1),
    patch: integer('patch').notNull().default(0),
    xml: text('xml').notNull(),
    contentHash: text('content_hash').notNull(),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_versions_number_key').on(t.documentId, t.major, t.minor, t.patch),
    index('document_versions_document_idx').on(t.documentId, t.createdAt),
  ],
);

export const collaborators = pgTable(
  'collaborators',
  {
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: collaboratorRoleEnum('role').notNull().default('CONTRIBUTOR'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.userId] })],
);

/**
 * A frozen snapshot of every document in a proposal at one moment — the unit
 * that gets sent out for contribution and the unit a reader is given.
 */
export const milestones = pgTable(
  'milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('milestones_proposal_idx').on(t.proposalId, t.createdAt)],
);

/**
 * Which exact version of each document the milestone froze. Pinning versions
 * rather than copying content is what lets a milestone be cheap and still be
 * exact.
 */
export const milestoneDocuments = pgTable(
  'milestone_documents',
  {
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => milestones.id, { onDelete: 'cascade' }),
    // Deliberately no cascade, on either reference.
    //
    // Cascading from `documents` would be a back door around the restrict on
    // `versionId`: deleting a document would erase its milestone_documents
    // rows first, and the document->versions cascade would then be free to
    // delete the very bytes a milestone had frozen. The protection has to sit
    // on both edges or it sits on neither.
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => documentVersions.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.milestoneId, t.documentId] })],
);

/**
 * A copy of a milestone sent to someone outside the drafting team so they can
 * propose changes, which are later merged back into the live text.
 *
 * The contribution edits its own copy, never the live document. That is the
 * whole point: an external contributor cannot alter the record, only propose
 * against a fixed snapshot of it, and the merge back is a deliberate act by
 * someone who holds the pen.
 */
export const contributions = pgTable(
  'contributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => milestones.id, { onDelete: 'cascade' }),
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id),
    status: contributionStatusEnum('status').notNull().default('SENT'),
    sentBy: uuid('sent_by')
      .notNull()
      .references(() => users.id),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
  },
  (t) => [index('contributions_milestone_idx').on(t.milestoneId)],
);

/**
 * The contributor's working copy.
 *
 * A contribution is a copy of a milestone that someone outside the drafting
 * team edits. Their edits land here, one row per document, and never touch the
 * live text: the whole point of sending a copy is that an external reviewer
 * cannot alter the record, only propose against a fixed snapshot of it.
 *
 * `xml` starts as the bytes the milestone froze and diverges as they work.
 * Merging is a separate, deliberate act by someone who holds the pen, and it
 * goes through the ordinary save path, so a merged change is an ordinary
 * version with an ordinary author — the person who accepted it.
 */
export const contributionDocuments = pgTable(
  'contribution_documents',
  {
    contributionId: uuid('contribution_id')
      .notNull()
      .references(() => contributions.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** What the milestone froze, for showing what the contributor started from. */
    baseVersionId: uuid('base_version_id')
      .notNull()
      .references(() => documentVersions.id, { onDelete: 'restrict' }),
    xml: text('xml').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.contributionId, t.documentId] })],
);


/* -------------------------------------------------------------------------- */
/* Legislative information system record model                               */
/* -------------------------------------------------------------------------- */

export const legislativeFiles = pgTable(
  'legislative_files',
  {
    proposalId: uuid('proposal_id')
      .primaryKey()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('Draft'),
    inControl: text('in_control').notNull().default('Clerk of the Board'),
    sponsors: text('sponsors'),
    agendaDate: timestamp('agenda_date', { withTimezone: true }),
    enactmentNumber: text('enactment_number'),
    finalActionAt: timestamp('final_action_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('legislative_files_status_idx').on(t.status),
    index('legislative_files_control_idx').on(t.inControl),
  ],
);

export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    body: text('body').notNull(),
    meetingAt: timestamp('meeting_at', { withTimezone: true }).notNull(),
    location: text('location'),
    notes: text('notes'),
    status: text('status').notNull().default('SCHEDULED'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('meetings_when_idx').on(t.meetingAt), index('meetings_body_idx').on(t.body)],
);

export const agendaVersions = pgTable(
  'agenda_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('DRAFT'),
    reason: text('reason'),
    supersedesId: uuid('supersedes_id'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('agenda_versions_meeting_version_key').on(t.meetingId, t.version),
    index('agenda_versions_meeting_idx').on(t.meetingId, t.createdAt),
  ],
);

export const agendaItems = pgTable(
  'agenda_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agendaVersionId: uuid('agenda_version_id')
      .notNull()
      .references(() => agendaVersions.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id').references(() => proposals.id, { onDelete: 'restrict' }),
    heading: text('heading'),
    position: integer('position').notNull().default(0),
    recommendedAction: text('recommended_action'),
  },
  (t) => [index('agenda_items_version_idx').on(t.agendaVersionId, t.position)],
);

export const fileActions = pgTable(
  'file_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    meetingId: uuid('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    actionAt: timestamp('action_at', { withTimezone: true }).notNull().defaultNow(),
    actingBody: text('acting_body').notNull(),
    action: text('action').notNull(),
    sentTo: text('sent_to'),
    result: text('result'),
    actionNote: text('action_note'),
    actionText: text('action_text'),
    statusBefore: text('status_before'),
    statusAfter: text('status_after'),
    votes: text('votes').notNull().default('[]'),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    index('file_actions_proposal_idx').on(t.proposalId, t.actionAt),
    index('file_actions_meeting_idx').on(t.meetingId, t.actionAt),
  ],
);

export const actionCertifications = pgTable(
  'action_certifications',
  {
    actionId: uuid('action_id')
      .primaryKey()
      .references(() => fileActions.id, { onDelete: 'restrict' }),
    certifiedBy: uuid('certified_by')
      .notNull()
      .references(() => users.id),
    certifiedAt: timestamp('certified_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
  },
);

export const meetingEvents = pgTable(
  'meeting_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    detail: text('detail').notNull().default('{}'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => [index('meeting_events_meeting_idx').on(t.meetingId, t.occurredAt)],
);

export const publications = pgTable(
  'publications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    meetingId: uuid('meeting_id').references(() => meetings.id, { onDelete: 'restrict' }),
    proposalId: uuid('proposal_id').references(() => proposals.id, { onDelete: 'restrict' }),
    agendaVersionId: uuid('agenda_version_id').references(() => agendaVersions.id, {
      onDelete: 'restrict',
    }),
    version: integer('version').notNull(),
    manifest: text('manifest').notNull(),
    contentHash: text('content_hash').notNull(),
    reason: text('reason'),
    supersedesId: uuid('supersedes_id'),
    publishedBy: uuid('published_by')
      .notNull()
      .references(() => users.id),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('publications_meeting_idx').on(t.meetingId, t.publishedAt),
    index('publications_proposal_idx').on(t.proposalId, t.publishedAt),
  ],
);

export const governanceTerms = pgTable(
  'governance_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    isCurrent: integer('is_current').notNull().default(0),
  },
  (t) => [uniqueIndex('governance_terms_name_key').on(t.name)],
);

export const governanceBodies = pgTable(
  'governance_bodies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    bodyType: text('body_type').notNull().default('COMMITTEE'),
    parentId: uuid('parent_id'),
    authority: text('authority'),
    quorumRule: text('quorum_rule'),
    voteThreshold: text('vote_threshold'),
    active: integer('active').notNull().default(1),
  },
  (t) => [uniqueIndex('governance_bodies_name_key').on(t.name)],
);

export const people = pgTable(
  'people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email'),
    biography: text('biography'),
    active: integer('active').notNull().default(1),
  },
  (t) => [index('people_name_idx').on(t.name)],
);

export const bodyMemberships = pgTable(
  'body_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bodyId: uuid('body_id')
      .notNull()
      .references(() => governanceBodies.id, { onDelete: 'restrict' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'restrict' }),
    termId: uuid('term_id').references(() => governanceTerms.id, { onDelete: 'restrict' }),
    title: text('title').notNull().default('Member'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
  },
  (t) => [
    index('body_memberships_body_idx').on(t.bodyId, t.startsAt),
    index('body_memberships_person_idx').on(t.personId, t.startsAt),
  ],
);
