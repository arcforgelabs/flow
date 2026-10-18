-- One row for each issued Flow invoice version sent to Xero as a draft. It
-- holds the exact request and its Idempotency-Key from before the request
-- leaves, so an uncertain outcome is resolved without a second invoice.
CREATE TABLE "xero_invoice_pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_body" text NOT NULL,
	"body_hash" text NOT NULL,
	"pre_existing_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"xero_invoice_id" text,
	"xero_invoice_number" text,
	"xero_status" text,
	"verified" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"pushed_by" uuid REFERENCES "people"("id") ON DELETE SET NULL,
	"first_dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_invoice_pushes_invoice_version" UNIQUE("invoice_id", "version"),
	CONSTRAINT "xero_invoice_pushes_invoice_same_org" FOREIGN KEY ("organisation_id", "invoice_id") REFERENCES "invoices"("organisation_id", "id"),
	CONSTRAINT "xero_invoice_pushes_version_issued" FOREIGN KEY ("invoice_id", "version") REFERENCES "invoice_versions"("invoice_id", "version"),
	CONSTRAINT "xero_invoice_pushes_state_valid" CHECK ("state" in ('dispatching', 'ambiguous', 'created', 'existing', 'mismatch')),
	CONSTRAINT "xero_invoice_pushes_settled_has_id" CHECK ("state" in ('dispatching', 'ambiguous') or "xero_invoice_id" is not null)
);
--> statement-breakpoint
CREATE INDEX "xero_invoice_pushes_org_invoice" ON "xero_invoice_pushes" ("organisation_id", "invoice_id");
