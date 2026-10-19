-- Flow's copy of the Xero contacts and items of each connected organisation,
-- and a record of each sync. Xero owns these records; a sync replaces the copy.
CREATE TABLE IF NOT EXISTS "xero_contacts" (
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"xero_contact_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"status" text NOT NULL,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"sales_tracking" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"xero_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_contacts_pk" PRIMARY KEY("organisation_id", "xero_contact_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xero_contacts_org_name" ON "xero_contacts" ("organisation_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "xero_items" (
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"xero_item_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"description" text,
	"is_sold" boolean DEFAULT true NOT NULL,
	"sales_unit_amount_cents" integer,
	"sales_account_code" text,
	"sales_tax_type" text,
	"xero_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_items_pk" PRIMARY KEY("organisation_id", "xero_item_id"),
	CONSTRAINT "xero_items_org_code" UNIQUE("organisation_id", "code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "xero_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"status" text DEFAULT 'running' NOT NULL,
	"started_by" uuid REFERENCES "people"("id") ON DELETE SET NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"contact_count" integer,
	"item_count" integer,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "xero_sync_runs_status_valid" CHECK ("status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xero_sync_runs_org_started" ON "xero_sync_runs" ("organisation_id", "started_at");
