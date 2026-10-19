-- How each push was sent (invoicing_settings.send_mode) and, for an invoice
-- sent approved, whether Xero emailed it to the customer. Xero's email action
-- is not idempotent, so Flow records `sending` before the call and retries
-- only a refusal (`failed`), never an unknown outcome.
ALTER TABLE "xero_invoice_pushes" ADD COLUMN IF NOT EXISTS "send_mode" text DEFAULT 'accounting_draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "xero_invoice_pushes" ADD COLUMN IF NOT EXISTS "email_state" text;--> statement-breakpoint
ALTER TABLE "xero_invoice_pushes" ADD COLUMN IF NOT EXISTS "email_error" text;--> statement-breakpoint
ALTER TABLE "xero_invoice_pushes" ADD COLUMN IF NOT EXISTS "emailed_at" timestamp with time zone;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "xero_invoice_pushes" ADD CONSTRAINT "xero_invoice_pushes_send_mode_valid" CHECK ("send_mode" in ('accounting_draft', 'approve_and_email'));
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "xero_invoice_pushes" ADD CONSTRAINT "xero_invoice_pushes_email_state_valid" CHECK ("email_state" is null or "email_state" in ('pending', 'sending', 'sent', 'failed', 'unknown'));
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;
