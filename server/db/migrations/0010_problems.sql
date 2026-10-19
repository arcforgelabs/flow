CREATE TABLE "error_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"build" text,
	"count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "error_events_fingerprint" UNIQUE("fingerprint"),
	CONSTRAINT "error_events_status_valid" CHECK (status in ('new', 'seen', 'closed')),
	CONSTRAINT "error_events_count_positive" CHECK ("error_events"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "problem_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reported_by" uuid,
	"reporter_email" text,
	"message" text NOT NULL,
	"page" text,
	"user_agent" text,
	"build" text,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "problem_reports_status_valid" CHECK (status in ('new', 'seen', 'closed')),
	CONSTRAINT "problem_reports_message_length" CHECK (char_length("problem_reports"."message") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_reported_by_people_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "error_events_status_last_seen" ON "error_events" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "problem_reports_status_created" ON "problem_reports" USING btree ("status","created_at");