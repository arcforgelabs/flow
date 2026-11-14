-- Which Xero invoice a Flow invoice was, after Flow removed that Flow invoice
-- (delete-invoice.js, forgetXeroInvoice). A Flow invoice that no customer saw
-- is removed with its link and push rows; one row here keeps the pair, who
-- made it, who released or deleted it, and who removed it and why. The Flow
-- invoice is gone, so `invoice_id` points at nothing and `invoice_number`
-- keeps its number. Rows are only added.
CREATE TABLE IF NOT EXISTS "xero_invoice_link_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"xero_invoice_id" text,
	"invoice_id" uuid NOT NULL,
	"invoice_number" text,
	"matched_by" text NOT NULL,
	"linked_by" text,
	"linked_at" timestamp with time zone,
	"released_by" text,
	"released_at" timestamp with time zone,
	"deleted_by" text,
	"deleted_at" timestamp with time zone,
	"removed_by" text,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xero_invoice_link_history_xero" ON "xero_invoice_link_history" ("organisation_id", "xero_invoice_id");
