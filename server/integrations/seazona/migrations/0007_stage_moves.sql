CREATE TABLE IF NOT EXISTS "seazona_person_settings" (
	"person_id" text PRIMARY KEY NOT NULL,
	"ask_before_stage_moves" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seazona_stage_moves" (
	"order_id" text PRIMARY KEY NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seazona_stage_moves_state" ON "seazona_stage_moves" USING btree ("state","expires_at");