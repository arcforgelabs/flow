ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "ready_by" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "send_state" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "send_error" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "send_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "send_updated_at" timestamp with time zone;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoices" ADD CONSTRAINT "invoices_ready_by_people_id_fk" FOREIGN KEY ("ready_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoices" ADD CONSTRAINT "invoices_send_requested_by_people_id_fk" FOREIGN KEY ("send_requested_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoices" ADD CONSTRAINT "invoices_send_state_valid" CHECK ("invoices"."send_state" is null or "invoices"."send_state" in ('queued', 'sent', 'failed'));
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;