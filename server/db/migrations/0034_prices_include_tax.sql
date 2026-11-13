ALTER TABLE "billing_obligations" ADD COLUMN IF NOT EXISTS "amounts_include_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "amounts_include_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoicing_settings" ADD COLUMN IF NOT EXISTS "amounts_include_tax" boolean DEFAULT false NOT NULL;