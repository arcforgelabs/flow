CREATE TABLE "link_rejections" (
	"organisation_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_rejections_pk" PRIMARY KEY("organisation_id","obligation_id","system","external_id")
);
--> statement-breakpoint
CREATE TABLE "link_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"external_number" text,
	"score" integer NOT NULL,
	"rank" integer NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_suggestions_pair" UNIQUE("organisation_id","obligation_id","system","external_id"),
	CONSTRAINT "link_suggestions_state_valid" CHECK (state in ('open', 'accepted', 'rejected', 'stale'))
);
--> statement-breakpoint
CREATE TABLE "pipeline_cursors" (
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_cursors_pk" PRIMARY KEY("organisation_id","name")
);
--> statement-breakpoint
ALTER TABLE "external_links" DROP CONSTRAINT "external_links_matched_by_valid";--> statement-breakpoint
ALTER TABLE "billing_obligations" ADD COLUMN "job_date" date;--> statement-breakpoint
ALTER TABLE "link_rejections" ADD CONSTRAINT "link_rejections_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_rejections" ADD CONSTRAINT "link_rejections_obligation_same_org" FOREIGN KEY ("organisation_id","obligation_id") REFERENCES "public"."billing_obligations"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_suggestions" ADD CONSTRAINT "link_suggestions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_suggestions" ADD CONSTRAINT "link_suggestions_obligation_same_org" FOREIGN KEY ("organisation_id","obligation_id") REFERENCES "public"."billing_obligations"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cursors" ADD CONSTRAINT "pipeline_cursors_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "link_suggestions_open" ON "link_suggestions" USING btree ("organisation_id","state","obligation_id");--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_matched_by_valid" CHECK (matched_by in ('created_by_flow', 'exact_id', 'exact_name', 'imported', 'name', 'person'));