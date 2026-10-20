-- Xero's webhooks and the daily check (issue #45). Each event Xero pushes, and
-- each record the daily check finds out of step, waits here until Flow reads
-- that record by id into its copy. One row per record: a second event for the
-- same record before it is read only marks it pending again.
CREATE TABLE IF NOT EXISTS "xero_webhook_events" (
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"resource" text NOT NULL,
	"resource_id" text NOT NULL,
	"event_type" text,
	"source" text NOT NULL,
	"event_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending" boolean DEFAULT true NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "xero_webhook_events_pk" PRIMARY KEY("organisation_id", "resource", "resource_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xero_webhook_events_pending" ON "xero_webhook_events" ("organisation_id", "resource") WHERE "pending";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xero_webhook_events_received" ON "xero_webhook_events" ("organisation_id", "source", "received_at");
--> statement-breakpoint
-- One full summary read of the invoices a day for each organisation.
CREATE TABLE IF NOT EXISTS "xero_daily_checks" (
	"organisation_id" uuid PRIMARY KEY NOT NULL REFERENCES "organisations"("id"),
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_read" integer,
	"last_flagged" integer,
	"last_error" text
);
