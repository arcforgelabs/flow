ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "duplicate" jsonb;
--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoices" ADD CONSTRAINT "invoices_duplicate_terminal" CHECK ("invoices"."duplicate" is null or "invoices"."status" = 'void');
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;
