CREATE TABLE IF NOT EXISTS "agent_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"grant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"status" integer NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"app_name" text NOT NULL,
	"resource" text NOT NULL,
	"organisation_id" uuid NOT NULL,
	"access_level" text DEFAULT 'read' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"failure_day" date,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	CONSTRAINT "agent_grants_person_client_resource" UNIQUE("person_id","client_id","resource"),
	CONSTRAINT "agent_grants_read_only" CHECK (access_level = 'read')
);
--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "flow"."people"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "flow"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_audit_created" ON "agent_audit" USING btree ("created_at");