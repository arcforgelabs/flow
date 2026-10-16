CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_org_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "contacts_org_kind_name" UNIQUE("organisation_id","kind","name"),
	CONSTRAINT "contacts_kind_valid" CHECK ("contacts"."kind" in ('customer', 'supplier'))
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"price_item_id" uuid,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_amount_cents" integer NOT NULL,
	"tax_code" text NOT NULL,
	"line_amount_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	CONSTRAINT "invoice_lines_invoice_position" UNIQUE("invoice_id","position"),
	CONSTRAINT "invoice_lines_quantity_positive" CHECK ("invoice_lines"."quantity" > 0),
	CONSTRAINT "invoice_lines_tax_code_valid" CHECK ("invoice_lines"."tax_code" in ('GST', 'GST_FREE'))
);
--> statement-breakpoint
CREATE TABLE "invoice_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" text NOT NULL,
	"document" jsonb NOT NULL,
	CONSTRAINT "invoice_versions_invoice_version" UNIQUE("invoice_id","version"),
	CONSTRAINT "invoice_versions_version_positive" CHECK ("invoice_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"issued_version" integer DEFAULT 0 NOT NULL,
	"reference" text,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"issue_date" date,
	"due_date" date,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_org_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "invoices_org_number" UNIQUE("organisation_id","number"),
	CONSTRAINT "invoices_status_valid" CHECK ("invoices"."status" in ('draft', 'issued', 'void')),
	CONSTRAINT "invoices_issued_has_number" CHECK ("invoices"."status" = 'draft' or "invoices"."number" is not null)
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"invoice_prefix" text DEFAULT 'INV-' NOT NULL,
	"next_invoice_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_next_invoice_number_positive" CHECK ("organisations"."next_invoice_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "price_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"unit_amount_cents" integer NOT NULL,
	"tax_code" text DEFAULT 'GST' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_items_org_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "price_items_org_code" UNIQUE("organisation_id","code"),
	CONSTRAINT "price_items_tax_code_valid" CHECK ("price_items"."tax_code" in ('GST', 'GST_FREE'))
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_same_org" FOREIGN KEY ("organisation_id","invoice_id") REFERENCES "public"."invoices"("organisation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_price_item_same_org" FOREIGN KEY ("organisation_id","price_item_id") REFERENCES "public"."price_items"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_versions" ADD CONSTRAINT "invoice_versions_invoice_same_org" FOREIGN KEY ("organisation_id","invoice_id") REFERENCES "public"."invoices"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_same_org" FOREIGN KEY ("organisation_id","contact_id") REFERENCES "public"."contacts"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_items" ADD CONSTRAINT "price_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;