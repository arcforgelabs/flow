CREATE TABLE "prior_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_job_ref" text NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"external_number" text,
	"matched_by" text NOT NULL,
	"matched_at" timestamp with time zone,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prior_links_matched_by_valid" CHECK (matched_by in ('person', 'imported'))
);
--> statement-breakpoint
ALTER TABLE "prior_links" ADD CONSTRAINT "prior_links_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prior_links_job" ON "prior_links" USING btree ("organisation_id","source_system","source_job_ref","system");--> statement-breakpoint
CREATE INDEX "prior_links_external" ON "prior_links" USING btree ("organisation_id","system","external_id");