CREATE TABLE "legislative_files" (
  "proposal_id" uuid PRIMARY KEY NOT NULL REFERENCES "proposals"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'Draft' NOT NULL,
  "in_control" text DEFAULT 'Clerk of the Board' NOT NULL,
  "sponsors" text,
  "agenda_date" timestamp with time zone,
  "enactment_number" text,
  "final_action_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "legislative_files_status_idx" ON "legislative_files" ("status");
--> statement-breakpoint
CREATE INDEX "legislative_files_control_idx" ON "legislative_files" ("in_control");
--> statement-breakpoint
CREATE TABLE "meetings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "body" text NOT NULL,
  "meeting_at" timestamp with time zone NOT NULL,
  "location" text,
  "notes" text,
  "status" text DEFAULT 'SCHEDULED' NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "meetings_when_idx" ON "meetings" ("meeting_at");
--> statement-breakpoint
CREATE INDEX "meetings_body_idx" ON "meetings" ("body");
--> statement-breakpoint
CREATE TABLE "agenda_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "meeting_id" uuid NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "reason" text,
  "supersedes_id" uuid,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agenda_versions_meeting_version_key" ON "agenda_versions" ("meeting_id","version");
--> statement-breakpoint
CREATE INDEX "agenda_versions_meeting_idx" ON "agenda_versions" ("meeting_id","created_at");
--> statement-breakpoint
CREATE TABLE "agenda_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agenda_version_id" uuid NOT NULL REFERENCES "agenda_versions"("id") ON DELETE CASCADE,
  "proposal_id" uuid REFERENCES "proposals"("id") ON DELETE RESTRICT,
  "heading" text,
  "position" integer DEFAULT 0 NOT NULL,
  "recommended_action" text
);
--> statement-breakpoint
CREATE INDEX "agenda_items_version_idx" ON "agenda_items" ("agenda_version_id","position");
--> statement-breakpoint
CREATE TABLE "file_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "proposal_id" uuid NOT NULL REFERENCES "proposals"("id") ON DELETE CASCADE,
  "meeting_id" uuid REFERENCES "meetings"("id") ON DELETE SET NULL,
  "action_at" timestamp with time zone DEFAULT now() NOT NULL,
  "acting_body" text NOT NULL,
  "action" text NOT NULL,
  "sent_to" text,
  "result" text,
  "action_note" text,
  "action_text" text,
  "status_before" text,
  "status_after" text,
  "votes" text DEFAULT '[]' NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX "file_actions_proposal_idx" ON "file_actions" ("proposal_id","action_at");
--> statement-breakpoint
CREATE INDEX "file_actions_meeting_idx" ON "file_actions" ("meeting_id","action_at");
--> statement-breakpoint
CREATE TABLE "action_certifications" (
  "action_id" uuid PRIMARY KEY NOT NULL REFERENCES "file_actions"("id") ON DELETE RESTRICT,
  "certified_by" uuid NOT NULL REFERENCES "users"("id"),
  "certified_at" timestamp with time zone DEFAULT now() NOT NULL,
  "note" text
);
--> statement-breakpoint
CREATE TABLE "meeting_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "meeting_id" uuid NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "detail" text DEFAULT '{}' NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX "meeting_events_meeting_idx" ON "meeting_events" ("meeting_id","occurred_at");
--> statement-breakpoint
CREATE TABLE "publications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "meeting_id" uuid REFERENCES "meetings"("id") ON DELETE RESTRICT,
  "proposal_id" uuid REFERENCES "proposals"("id") ON DELETE RESTRICT,
  "agenda_version_id" uuid REFERENCES "agenda_versions"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "manifest" text NOT NULL,
  "content_hash" text NOT NULL,
  "reason" text,
  "supersedes_id" uuid,
  "published_by" uuid NOT NULL REFERENCES "users"("id"),
  "published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "publications_meeting_idx" ON "publications" ("meeting_id","published_at");
--> statement-breakpoint
CREATE INDEX "publications_proposal_idx" ON "publications" ("proposal_id","published_at");
--> statement-breakpoint
CREATE TABLE "governance_terms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone,
  "is_current" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "governance_terms_name_key" ON "governance_terms" ("name");
--> statement-breakpoint
CREATE TABLE "governance_bodies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "body_type" text DEFAULT 'COMMITTEE' NOT NULL,
  "parent_id" uuid,
  "authority" text,
  "quorum_rule" text,
  "vote_threshold" text,
  "active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "governance_bodies_name_key" ON "governance_bodies" ("name");
--> statement-breakpoint
CREATE TABLE "people" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "email" text,
  "biography" text,
  "active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "people_name_idx" ON "people" ("name");
--> statement-breakpoint
CREATE TABLE "body_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "body_id" uuid NOT NULL REFERENCES "governance_bodies"("id") ON DELETE RESTRICT,
  "person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE RESTRICT,
  "term_id" uuid REFERENCES "governance_terms"("id") ON DELETE RESTRICT,
  "title" text DEFAULT 'Member' NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "body_memberships_body_idx" ON "body_memberships" ("body_id","starts_at");
--> statement-breakpoint
CREATE INDEX "body_memberships_person_idx" ON "body_memberships" ("person_id","starts_at");
