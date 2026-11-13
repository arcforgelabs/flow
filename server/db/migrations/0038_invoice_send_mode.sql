ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "send_mode" text;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoices" ADD CONSTRAINT "invoices_send_mode_valid" CHECK ("invoices"."send_mode" is null or "invoices"."send_mode" in ('accounting_draft', 'approve_and_email'));
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;