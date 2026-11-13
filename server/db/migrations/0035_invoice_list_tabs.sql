CREATE TABLE IF NOT EXISTS "invoice_list_tabs" (
	"invoice_id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"tab" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoice_list_tabs" ADD CONSTRAINT "invoice_list_tabs_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "flow"."invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoice_list_tabs" ADD CONSTRAINT "invoice_list_tabs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "flow"."organisations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_list_tabs_org_tab_idx" ON "invoice_list_tabs" USING btree ("organisation_id","tab");