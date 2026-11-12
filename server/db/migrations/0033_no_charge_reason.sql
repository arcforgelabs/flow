ALTER TABLE "billing_obligations" ADD COLUMN IF NOT EXISTS "no_charge_reason" text;--> statement-breakpoint
ALTER TABLE "billing_obligations" ADD COLUMN IF NOT EXISTS "no_charge_by" text;--> statement-breakpoint
ALTER TABLE "billing_obligations" ADD COLUMN IF NOT EXISTS "no_charge_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoicing_settings" ADD COLUMN IF NOT EXISTS "no_charge_reasons" jsonb DEFAULT '["Promotion","Internal","Remake","Rework","Warranty","Goodwill"]'::jsonb NOT NULL;