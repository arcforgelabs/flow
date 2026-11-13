ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "list_tab" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "list_tab_at" timestamp with time zone;