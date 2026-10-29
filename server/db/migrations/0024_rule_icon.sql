ALTER TABLE "invoice_rules" ADD COLUMN IF NOT EXISTS "icon" text;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoice_rules" ADD CONSTRAINT "invoice_rules_icon_valid" CHECK ("invoice_rules"."icon" is null or (length("invoice_rules"."icon") between 1 and 64 and "invoice_rules"."icon" !~ '[^a-z0-9-]'));
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;