CREATE TABLE IF NOT EXISTS "seazona_record_read_failures" (
	"resource" text NOT NULL,
	"record_key" text NOT NULL,
	"failure_count" integer NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"last_http_status" integer,
	"last_failure_kind" text,
	"quarantined_until" timestamp with time zone,
	CONSTRAINT "seazona_record_read_failures_resource_record_key_pk" PRIMARY KEY("resource","record_key")
);
--> statement-breakpoint
ALTER TABLE "seazona_api_governor" ADD COLUMN IF NOT EXISTS "circuit_open_until" timestamp with time zone DEFAULT 'epoch' NOT NULL;--> statement-breakpoint
ALTER TABLE "seazona_api_governor" ADD COLUMN IF NOT EXISTS "circuit_opens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "seazona_api_governor" ADD COLUMN IF NOT EXISTS "halted_reason" text;--> statement-breakpoint
ALTER TABLE "seazona_api_governor" ADD COLUMN IF NOT EXISTS "halted_at" timestamp with time zone;