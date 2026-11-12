ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "merged_by" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_into_same_org" FOREIGN KEY ("organisation_id","merged_into_id") REFERENCES "flow"."contacts"("organisation_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_into_other" CHECK ("contacts"."merged_into_id" is null or "contacts"."merged_into_id" <> "contacts"."id");
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;