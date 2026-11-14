-- Flow sends only its own invoices to Xero. An imported invoice (invoices.origin
-- is not 'flow') came from the accounting system, so a push row for one is
-- refused here, whatever code asked for it (docs/XERO_IMPORT.md, "An imported
-- invoice"): a new row, and a row moved to an imported invoice.
CREATE OR REPLACE FUNCTION xero_push_own_invoice_only() RETURNS trigger LANGUAGE plpgsql
SET search_path = flow, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id AND origin <> 'flow') THEN
    RAISE EXCEPTION 'flow: an imported invoice is never sent to Xero'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER xero_invoice_pushes_own_only
  BEFORE INSERT OR UPDATE OF invoice_id ON "xero_invoice_pushes"
  FOR EACH ROW EXECUTE FUNCTION xero_push_own_invoice_only();
