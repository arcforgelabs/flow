ALTER TABLE "invoices" ADD COLUMN "send_state" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "send_error" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "send_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "send_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_send_requested_by_people_id_fk" FOREIGN KEY ("send_requested_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_send_state_valid" CHECK ("invoices"."send_state" is null or "invoices"."send_state" in ('queued', 'sent', 'failed'));