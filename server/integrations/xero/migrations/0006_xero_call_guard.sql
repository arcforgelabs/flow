-- The call guard's state and telemetry (server/integrations/call-guard.js,
-- issue 111): one row per Xero organisation (tenant) with the circuit, a halt
-- and the resources Xero refused, and one row per call sent. A call row keeps
-- the resource and path, never the host, the query, a token or a response.
CREATE TABLE IF NOT EXISTS "xero_call_guard" (
	"key" text PRIMARY KEY NOT NULL,
	"circuit_open_until" timestamp with time zone DEFAULT 'epoch' NOT NULL,
	"circuit_opens" integer DEFAULT 0 NOT NULL,
	"halted_reason" text,
	"halted_at" timestamp with time zone,
	"stopped_resources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "xero_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"resource" text,
	"request_path" text,
	"status_code" integer,
	"failure_kind" text,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xero_calls_window" ON "xero_calls" USING btree ("key","at");
