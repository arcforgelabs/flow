ALTER TABLE "invoice_rule_exceptions" ADD COLUMN IF NOT EXISTS "item_code" text;--> statement-breakpoint
ALTER TABLE "invoice_rule_exceptions" ADD COLUMN IF NOT EXISTS "line_fingerprint" text;