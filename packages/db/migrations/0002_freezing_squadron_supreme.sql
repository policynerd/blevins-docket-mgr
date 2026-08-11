CREATE TABLE "contribution_documents" (
	"contribution_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"xml" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_documents_contribution_id_document_id_pk" PRIMARY KEY("contribution_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "contribution_documents" ADD CONSTRAINT "contribution_documents_contribution_id_contributions_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contributions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_documents" ADD CONSTRAINT "contribution_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_documents" ADD CONSTRAINT "contribution_documents_base_version_id_document_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;