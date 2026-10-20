CREATE TABLE IF NOT EXISTS "job_field_settings" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"group_colors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assignee_made_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_fields" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_field_settings" ADD CONSTRAINT "job_field_settings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_field_settings" ADD CONSTRAINT "job_field_settings_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_fields" ADD CONSTRAINT "job_fields_color_valid" CHECK ("job_fields"."color" is null or "job_fields"."color" in ('gray', 'blue', 'teal', 'green', 'amber', 'red', 'purple', 'pink'));
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;