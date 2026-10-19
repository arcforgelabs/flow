CREATE TABLE IF NOT EXISTS "invoice_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" text DEFAULT 'job_ready' NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"starter_key" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_rules_trigger_valid" CHECK ("invoice_rules"."trigger" in ('job_ready')),
	CONSTRAINT "invoice_rules_name_valid" CHECK (length("invoice_rules"."name") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "invoicing_settings" ADD COLUMN IF NOT EXISTS "rules_seeded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoice_rules" ADD CONSTRAINT "invoice_rules_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoice_rules" ADD CONSTRAINT "invoice_rules_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_rules_starter_key" ON "invoice_rules" USING btree ("organisation_id","starter_key");