CREATE TABLE "customer_billing_settings" (
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"default_practitioner" text,
	"auto_draft" boolean,
	"send_mode" text,
	"payment_terms_days" integer,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_billing_settings_pk" PRIMARY KEY("organisation_id","contact_id"),
	CONSTRAINT "customer_billing_settings_send_mode_valid" CHECK ("customer_billing_settings"."send_mode" is null or "customer_billing_settings"."send_mode" in ('accounting_draft', 'approve_and_email')),
	CONSTRAINT "customer_billing_settings_terms_valid" CHECK ("customer_billing_settings"."payment_terms_days" is null or "customer_billing_settings"."payment_terms_days" between 0 and 365)
);
--> statement-breakpoint
CREATE TABLE "invoicing_settings" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"auto_draft" boolean DEFAULT true NOT NULL,
	"send_mode" text DEFAULT 'accounting_draft' NOT NULL,
	"ready_statuses" text[] DEFAULT '{shipped,delivered}'::text[] NOT NULL,
	"stale_days" integer DEFAULT 90 NOT NULL,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"require_practitioner" boolean DEFAULT false NOT NULL,
	"rush_item_code" text,
	"rush_percent" integer DEFAULT 20 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoicing_settings_send_mode_valid" CHECK (send_mode in ('accounting_draft', 'approve_and_email')),
	CONSTRAINT "invoicing_settings_stale_days_valid" CHECK ("invoicing_settings"."stale_days" between 1 and 3650),
	CONSTRAINT "invoicing_settings_terms_valid" CHECK ("invoicing_settings"."payment_terms_days" between 0 and 365),
	CONSTRAINT "invoicing_settings_rush_valid" CHECK ("invoicing_settings"."rush_percent" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "billing_obligations" ADD COLUMN "source_status" text;--> statement-breakpoint
ALTER TABLE "customer_billing_settings" ADD CONSTRAINT "customer_billing_settings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_billing_settings" ADD CONSTRAINT "customer_billing_settings_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_billing_settings" ADD CONSTRAINT "customer_billing_settings_contact_same_org" FOREIGN KEY ("organisation_id","contact_id") REFERENCES "public"."contacts"("organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoicing_settings" ADD CONSTRAINT "invoicing_settings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoicing_settings" ADD CONSTRAINT "invoicing_settings_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;