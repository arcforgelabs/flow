CREATE TABLE IF NOT EXISTS "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"file_key" text NOT NULL,
	"file_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"file_sha256" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"read" jsonb,
	"match" jsonb,
	"proposal" jsonb DEFAULT '{"action":null,"jobId":null,"changes":[]}'::jsonb NOT NULL,
	"problem" text,
	"decision" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"photo_deleted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "captures_org_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "captures_org_idempotency" UNIQUE("organisation_id","idempotency_key"),
	CONSTRAINT "captures_file_key" UNIQUE("file_key"),
	CONSTRAINT "captures_state_valid" CHECK (state in ('reading', 'ready', 'done', 'problem')),
	CONSTRAINT "captures_source_valid" CHECK (source in ('phone', 'desk', 'api')),
	CONSTRAINT "captures_decision_valid" CHECK ("captures"."decision" is null or "captures"."decision" in ('applied', 'discarded')),
	CONSTRAINT "captures_done_has_decision" CHECK (("captures"."state" = 'done') = ("captures"."decision" is not null)),
	CONSTRAINT "captures_file_size_valid" CHECK ("captures"."file_size" >= 0),
	CONSTRAINT "captures_sha256_valid" CHECK ("captures"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "captures_problem_valid" CHECK ("captures"."problem" is null or length("captures"."problem") between 1 and 200)
);
--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "captures" ADD CONSTRAINT "captures_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "flow"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "captures" ADD CONSTRAINT "captures_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "flow"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "captures" ADD CONSTRAINT "captures_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "flow"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "captures_photo_open" ON "captures" USING btree ("created_at") WHERE photo_deleted_at is null;