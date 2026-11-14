-- The history import (import-history.js) copies Xero sales invoices into Flow
-- in batches. One row for each batch: the year it covers (null: every year),
-- who started it, what it did, and who released it. Releasing a batch removes
-- the invoices it imported.
CREATE TABLE IF NOT EXISTS "xero_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"year" integer,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"released_by" text,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xero_import_batches_org" ON "xero_import_batches" ("organisation_id", "started_at");
--> statement-breakpoint
-- One live batch for a year, and one for every year (year null): a year is
-- imported again only after its batch is released.
CREATE UNIQUE INDEX IF NOT EXISTS "xero_import_batches_one_live" ON "xero_import_batches" ("organisation_id", coalesce("year", 0)) WHERE "released_at" IS NULL;
--> statement-breakpoint
-- The batch that imported the linked Flow invoice, and the hash of the Xero
-- copy it was last made to follow: when the copy's hash moves on, the import
-- reads the Xero invoice again.
ALTER TABLE "xero_invoice_links" ADD COLUMN IF NOT EXISTS "batch_id" uuid;
--> statement-breakpoint
ALTER TABLE "xero_invoice_links" ADD COLUMN IF NOT EXISTS "copy_hash" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xero_invoice_links_batch" ON "xero_invoice_links" ("organisation_id", "batch_id");
