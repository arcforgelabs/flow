CREATE TABLE IF NOT EXISTS "seazona_api_waiters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"client_key" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seazona_api_requests" ADD COLUMN IF NOT EXISTS "person_key" text;--> statement-breakpoint
ALTER TABLE "seazona_history_jobs" ADD COLUMN IF NOT EXISTS "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seazona_history_jobs" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seazona_history_jobs" ADD COLUMN IF NOT EXISTS "last_read_error" text;--> statement-breakpoint
ALTER TABLE "seazona_history_jobs" ADD COLUMN IF NOT EXISTS "deleted_in_source_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seazona_api_waiters_queue" ON "seazona_api_waiters" USING btree ("client_key","priority","id");