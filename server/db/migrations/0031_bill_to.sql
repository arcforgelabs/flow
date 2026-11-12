ALTER TABLE "customer_billing_settings" ADD COLUMN IF NOT EXISTS "bill_to_contact_id" uuid;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "customer_billing_settings" ADD CONSTRAINT "customer_billing_settings_bill_to_same_org" FOREIGN KEY ("organisation_id","bill_to_contact_id") REFERENCES "flow"."contacts"("organisation_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_billing_settings_bill_to" ON "customer_billing_settings" USING btree ("organisation_id","bill_to_contact_id");--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "customer_billing_settings" ADD CONSTRAINT "customer_billing_settings_bill_to_other" CHECK ("customer_billing_settings"."bill_to_contact_id" is null or "customer_billing_settings"."bill_to_contact_id" <> "customer_billing_settings"."contact_id");
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;