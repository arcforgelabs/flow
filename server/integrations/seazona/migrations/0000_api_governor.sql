CREATE TABLE IF NOT EXISTS "seazona_api_governor" (
	"client_key" text PRIMARY KEY NOT NULL,
	"next_eligible_at" timestamp with time zone DEFAULT 'epoch' NOT NULL,
	"cooldown_until" timestamp with time zone DEFAULT 'epoch' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seazona_api_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"client_key" text NOT NULL,
	"workflow" text NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"request_path" text,
	"status_code" integer,
	"failure_kind" text,
	"duration_ms" integer,
	"is_retry" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seazona_api_requests_window" ON "seazona_api_requests" USING btree ("client_key","admitted_at");