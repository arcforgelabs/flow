-- Flow's copy of the connected organisation's Xero invoices, credit notes and
-- payments (docs/DATA_SPINE.md, issue 54). Xero owns these records; Flow keeps
-- them so it can report on years of history and link them to its own records
-- without spending Xero calls. A row is upserted by its Xero id, and changes
-- only when its content hash changes. Free text (references, line
-- descriptions) is kept only with XERO_KEEP_REFERENCE=on.
CREATE TABLE "xero_invoices" (
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"xero_invoice_id" text NOT NULL,
	"type" text NOT NULL,
	"invoice_number" text,
	"reference" text,
	"xero_contact_id" text,
	"status" text NOT NULL,
	"issued_on" date,
	"due_on" date,
	"fully_paid_on" date,
	"currency" text,
	"subtotal_cents" bigint,
	"tax_cents" bigint,
	"total_cents" bigint,
	"amount_due_cents" bigint,
	"amount_paid_cents" bigint,
	"amount_credited_cents" bigint,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"xero_updated_at" timestamp with time zone,
	"record_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_invoices_pk" PRIMARY KEY("organisation_id", "xero_invoice_id")
);
--> statement-breakpoint
CREATE INDEX "xero_invoices_number" ON "xero_invoices" ("organisation_id", "invoice_number");
--> statement-breakpoint
CREATE INDEX "xero_invoices_contact" ON "xero_invoices" ("organisation_id", "xero_contact_id", "issued_on");
--> statement-breakpoint
CREATE TABLE "xero_credit_notes" (
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"xero_credit_note_id" text NOT NULL,
	"type" text NOT NULL,
	"credit_note_number" text,
	"reference" text,
	"xero_contact_id" text,
	"status" text NOT NULL,
	"issued_on" date,
	"currency" text,
	"subtotal_cents" bigint,
	"tax_cents" bigint,
	"total_cents" bigint,
	"remaining_credit_cents" bigint,
	"allocations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"xero_updated_at" timestamp with time zone,
	"record_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_credit_notes_pk" PRIMARY KEY("organisation_id", "xero_credit_note_id")
);
--> statement-breakpoint
CREATE TABLE "xero_payments" (
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"xero_payment_id" text NOT NULL,
	"payment_type" text,
	"status" text NOT NULL,
	"xero_invoice_id" text,
	"xero_credit_note_id" text,
	"paid_on" date,
	"amount_cents" bigint,
	"reference" text,
	"is_reconciled" boolean,
	"xero_updated_at" timestamp with time zone,
	"record_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_payments_pk" PRIMARY KEY("organisation_id", "xero_payment_id")
);
--> statement-breakpoint
CREATE INDEX "xero_payments_invoice" ON "xero_payments" ("organisation_id", "xero_invoice_id");
--> statement-breakpoint
-- Where the next read of each resource starts. `modified_since` is the
-- keyset: the next read asks Xero for records changed since then, oldest
-- change first. `page` moves on only when one second holds a full page.
CREATE TABLE "xero_mirror_cursors" (
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"resource" text NOT NULL,
	"modified_since" timestamp with time zone,
	"page" integer DEFAULT 1 NOT NULL,
	"passes" integer DEFAULT 0 NOT NULL,
	"rows_read" bigint DEFAULT 0 NOT NULL,
	"last_read_at" timestamp with time zone,
	"last_pass_finished_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "xero_mirror_cursors_pk" PRIMARY KEY("organisation_id", "resource"),
	CONSTRAINT "xero_mirror_cursors_resource_valid" CHECK ("resource" in ('invoices', 'credit_notes', 'payments')),
	CONSTRAINT "xero_mirror_cursors_page_positive" CHECK ("page" > 0)
);
