-- Which Flow invoice each Xero invoice is (the Import page, xero/links.js). A
-- Flow invoice that Flow sent to Xero is linked by its push already; this
-- table holds the others: matched by the import (`auto`), picked by a person
-- (`person`), or a Flow invoice made from the Xero invoice (`made`). One Flow
-- invoice per Xero invoice, and one Xero invoice per Flow invoice.
CREATE TABLE IF NOT EXISTS "xero_invoice_links" (
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"xero_invoice_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"matched_by" text NOT NULL,
	"linked_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_invoice_links_pk" PRIMARY KEY("organisation_id", "xero_invoice_id"),
	CONSTRAINT "xero_invoice_links_invoice" UNIQUE("organisation_id", "invoice_id"),
	CONSTRAINT "xero_invoice_links_invoice_same_org" FOREIGN KEY ("organisation_id", "invoice_id") REFERENCES "invoices"("organisation_id", "id"),
	CONSTRAINT "xero_invoice_links_matched_by_valid" CHECK ("matched_by" in ('auto', 'person', 'made'))
);
--> statement-breakpoint
-- The Import page's settings, one row for each organisation.
CREATE TABLE IF NOT EXISTS "xero_import_settings" (
	"organisation_id" uuid PRIMARY KEY NOT NULL REFERENCES "organisations"("id"),
	"make_unmatched" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
