-- A person releases a Xero invoice's link to a Flow invoice that was voided
-- (links.js, releaseXeroLink): the pair was wrong, and the Xero invoice is
-- free to link again. The row stays, with who and when; a new link takes its
-- place. Nothing is deleted.
ALTER TABLE "xero_invoice_links" ADD COLUMN IF NOT EXISTS "released_by" text;
--> statement-breakpoint
ALTER TABLE "xero_invoice_links" ADD COLUMN IF NOT EXISTS "released_at" timestamp with time zone;
