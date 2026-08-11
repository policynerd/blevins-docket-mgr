ALTER TABLE "users" ADD COLUMN "entra_oid" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "users_entra_oid_key" ON "users" USING btree ("entra_oid");