-- Who deleted a Xero draft from Flow, and when. The push keeps Xero's status
-- (DELETED or VOIDED). A link made on the Import page has no push, so it
-- keeps the same who and when. The Xero adapter's own table: the core does
-- not store this.
ALTER TABLE "xero_invoice_pushes" ADD COLUMN IF NOT EXISTS "deleted_by" text;
--> statement-breakpoint
ALTER TABLE "xero_invoice_pushes" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "xero_invoice_links" ADD COLUMN IF NOT EXISTS "deleted_by" text;
--> statement-breakpoint
ALTER TABLE "xero_invoice_links" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
