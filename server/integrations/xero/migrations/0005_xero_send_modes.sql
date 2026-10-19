-- How each push was sent (invoicing_settings.send_mode) and, for an invoice
-- sent approved, whether Xero emailed it to the customer. Xero's email action
-- is not idempotent, so Flow records `sending` before the call and retries
-- only a refusal (`failed`), never an unknown outcome.
ALTER TABLE "xero_invoice_pushes" ADD COLUMN "send_mode" text DEFAULT 'accounting_draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "xero_invoice_pushes" ADD COLUMN "email_state" text;--> statement-breakpoint
ALTER TABLE "xero_invoice_pushes" ADD COLUMN "email_error" text;--> statement-breakpoint
ALTER TABLE "xero_invoice_pushes" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "xero_invoice_pushes" ADD CONSTRAINT "xero_invoice_pushes_send_mode_valid" CHECK ("send_mode" in ('accounting_draft', 'approve_and_email'));--> statement-breakpoint
ALTER TABLE "xero_invoice_pushes" ADD CONSTRAINT "xero_invoice_pushes_email_state_valid" CHECK ("email_state" is null or "email_state" in ('pending', 'sending', 'sent', 'failed', 'unknown'));
