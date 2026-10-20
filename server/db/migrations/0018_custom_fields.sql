CREATE TABLE IF NOT EXISTS "job_field_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_job_ref" text NOT NULL,
	"from_value" jsonb,
	"to_value" jsonb,
	"actor" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_field_values" (
	"organisation_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_job_ref" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_field_values_organisation_id_field_id_source_system_source_job_ref_pk" PRIMARY KEY("organisation_id","field_id","source_system","source_job_ref")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_fields_org_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "job_fields_type_valid" CHECK ("job_fields"."type" in ('dropdown', 'person', 'checkbox', 'date', 'number', 'text')),
	CONSTRAINT "job_fields_name_valid" CHECK (length("job_fields"."name") between 1 and 60)
);
--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_field_events" ADD CONSTRAINT "job_field_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_field_events" ADD CONSTRAINT "job_field_events_actor_people_id_fk" FOREIGN KEY ("actor") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_field_events" ADD CONSTRAINT "job_field_events_field_same_org" FOREIGN KEY ("organisation_id","field_id") REFERENCES "public"."job_fields"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_field_values" ADD CONSTRAINT "job_field_values_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_field_values" ADD CONSTRAINT "job_field_values_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_field_values" ADD CONSTRAINT "job_field_values_field_same_org" FOREIGN KEY ("organisation_id","field_id") REFERENCES "public"."job_fields"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_fields" ADD CONSTRAINT "job_fields_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_fields" ADD CONSTRAINT "job_fields_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "job_fields" ADD CONSTRAINT "job_fields_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_field_events_job" ON "job_field_events" USING btree ("organisation_id","source_system","source_job_ref","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_field_values_job" ON "job_field_values" USING btree ("organisation_id","source_system","source_job_ref");