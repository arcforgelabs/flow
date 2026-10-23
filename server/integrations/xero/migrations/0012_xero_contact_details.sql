-- Billing fields on Flow's copy of a Xero contact, so a created client and
-- a synced client keep the same record (docs/CONTACTS.md). The Xero adapter's
-- own table: the core does not store this.
ALTER TABLE "xero_contacts" ADD COLUMN IF NOT EXISTS "first_name" text;
--> statement-breakpoint
ALTER TABLE "xero_contacts" ADD COLUMN IF NOT EXISTS "last_name" text;
--> statement-breakpoint
ALTER TABLE "xero_contacts" ADD COLUMN IF NOT EXISTS "phone" text;
--> statement-breakpoint
ALTER TABLE "xero_contacts" ADD COLUMN IF NOT EXISTS "mobile" text;
--> statement-breakpoint
ALTER TABLE "xero_contacts" ADD COLUMN IF NOT EXISTS "account_number" text;
--> statement-breakpoint
ALTER TABLE "xero_contacts" ADD COLUMN IF NOT EXISTS "tax_number" text;
--> statement-breakpoint
ALTER TABLE "xero_contacts" ADD COLUMN IF NOT EXISTS "address" jsonb;
