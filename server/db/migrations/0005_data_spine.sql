CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"result" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_jobs_state_valid" CHECK (state in ('queued', 'running', 'succeeded', 'failed', 'dead')),
	CONSTRAINT "background_jobs_attempts_valid" CHECK ("background_jobs"."attempts" >= 0 and "background_jobs"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "external_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"flow_id" uuid NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"matched_by" text NOT NULL,
	"state" text NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_links_org_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "external_links_entity_valid" CHECK (entity in ('contact', 'price_item', 'obligation', 'invoice', 'payment', 'credit_note')),
	CONSTRAINT "external_links_matched_by_valid" CHECK (matched_by in ('created_by_flow', 'exact_id', 'imported', 'name', 'person')),
	CONSTRAINT "external_links_state_valid" CHECK (state in ('active', 'proposed', 'superseded')),
	CONSTRAINT "external_links_name_needs_person" CHECK ("external_links"."matched_by" <> 'name' or "external_links"."state" <> 'active' or "external_links"."confirmed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"system" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"flow_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"external_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_org_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "outbox_idempotency_key" UNIQUE("idempotency_key"),
	CONSTRAINT "outbox_state_valid" CHECK (state in ('pending', 'sending', 'ambiguous', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "outbox_sent_has_id" CHECK ("outbox"."state" <> 'sent' or "outbox"."external_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity" text NOT NULL,
	"flow_id" uuid NOT NULL,
	"systems" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"money_at_risk_cents" bigint DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"resolution" text,
	"note" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_items_org_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "review_items_state_valid" CHECK (state in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "review_items_money_not_negative" CHECK ("review_items"."money_at_risk_cents" >= 0),
	CONSTRAINT "review_items_closed_has_resolution" CHECK ("review_items"."state" = 'open' or ("review_items"."resolution" is not null and "review_items"."resolved_by" is not null and "review_items"."resolved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_confirmed_by_people_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_one_open" ON "background_jobs" USING btree ("organisation_id","kind","dedupe_key") WHERE state in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "background_jobs_due" ON "background_jobs" USING btree ("state","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_active_external" ON "external_links" USING btree ("organisation_id","system","entity","external_id") WHERE state = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_active_flow" ON "external_links" USING btree ("organisation_id","system","entity","flow_id") WHERE state = 'active';--> statement-breakpoint
CREATE INDEX "external_links_flow" ON "external_links" USING btree ("organisation_id","entity","flow_id");--> statement-breakpoint
CREATE INDEX "outbox_pending" ON "outbox" USING btree ("system","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_items_one_open" ON "review_items" USING btree ("organisation_id","kind","entity","flow_id") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "review_items_queue" ON "review_items" USING btree ("organisation_id","state","money_at_risk_cents");