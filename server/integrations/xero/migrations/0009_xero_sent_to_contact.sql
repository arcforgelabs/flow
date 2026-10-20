-- Whether Xero sent the invoice to the customer (Xero's SentToContact), for
-- the Invoices page Sent tab. Null until the copy reads the invoice again.
ALTER TABLE "xero_invoices" ADD COLUMN IF NOT EXISTS "sent_to_contact" boolean;
