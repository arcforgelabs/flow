CREATE TABLE "billing_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_job_ref" text NOT NULL,
	"source_invoice_ref" text,
	"case_ref" text,
	"contact_id" uuid,
	"practitioner" text,
	"shipped_on" date,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"line_fingerprint" text NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"mapping_complete" boolean NOT NULL,
	"source_seen_at" timestamp with time zone NOT NULL,
	"hold_state" text DEFAULT 'none' NOT NULL,
	"hold_reason" text,
	"invoice_id" uuid,
	"accounting_state" text DEFAULT 'unknown' NOT NULL,
	"accounting_ref" text,
	"accounting_url" text,
	"accounting_matched_by" text,
	"accounting_checked_at" timestamp with time zone,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_obligations_org_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "billing_obligations_source_job" UNIQUE("organisation_id","source_system","source_job_ref"),
	CONSTRAINT "billing_obligations_invoice" UNIQUE("organisation_id","invoice_id"),
	CONSTRAINT "billing_obligations_hold_state_valid" CHECK (hold_state in ('none', 'held', 'review')),
	CONSTRAINT "billing_obligations_accounting_state_valid" CHECK (accounting_state in ('unknown', 'not_found', 'drafted', 'authorised', 'part_paid', 'paid', 'voided', 'deleted', 'ambiguous', 'conflict')),
	CONSTRAINT "billing_obligations_paid_not_negative" CHECK ("billing_obligations"."paid_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "obligation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obligation_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"payment_ref" text NOT NULL,
	"paid_on" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"reference" text,
	"reconciled" boolean NOT NULL,
	"accounting_url" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obligation_payments_ref" UNIQUE("organisation_id","obligation_id","payment_ref"),
	CONSTRAINT "obligation_payments_amount_positive" CHECK ("obligation_payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "obligation_writebacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"target_system" text NOT NULL,
	"status" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"evidence" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obligation_writebacks_status" UNIQUE("organisation_id","obligation_id","status"),
	CONSTRAINT "obligation_writebacks_state_valid" CHECK (state in ('pending', 'sent', 'failed', 'not_supported'))
);
--> statement-breakpoint
ALTER TABLE "billing_obligations" ADD CONSTRAINT "billing_obligations_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_obligations" ADD CONSTRAINT "billing_obligations_contact_same_org" FOREIGN KEY ("organisation_id","contact_id") REFERENCES "public"."contacts"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_obligations" ADD CONSTRAINT "billing_obligations_invoice_same_org" FOREIGN KEY ("organisation_id","invoice_id") REFERENCES "public"."invoices"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_events" ADD CONSTRAINT "obligation_events_obligation_same_org" FOREIGN KEY ("organisation_id","obligation_id") REFERENCES "public"."billing_obligations"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_payments" ADD CONSTRAINT "obligation_payments_obligation_same_org" FOREIGN KEY ("organisation_id","obligation_id") REFERENCES "public"."billing_obligations"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligation_writebacks" ADD CONSTRAINT "obligation_writebacks_obligation_same_org" FOREIGN KEY ("organisation_id","obligation_id") REFERENCES "public"."billing_obligations"("organisation_id","id") ON DELETE no action ON UPDATE no action;