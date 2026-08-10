ALTER TABLE "milestone_documents" DROP CONSTRAINT "milestone_documents_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "milestone_documents" DROP CONSTRAINT "milestone_documents_version_id_document_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "milestone_documents" ADD CONSTRAINT "milestone_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_documents" ADD CONSTRAINT "milestone_documents_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;