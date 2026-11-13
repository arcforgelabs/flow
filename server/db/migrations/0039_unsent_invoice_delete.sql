-- An issued invoice that never reached the accounting system can be deleted
-- (docs/INVOICE_SENDING.md, "A send that failed"). What a customer was sent
-- stays a record: the triggers below still refuse every other delete. The
-- code sets flow.remove_unsent to the invoice's id, for its own transaction
-- only, after the accounting adapter says the invoice never reached it
-- (server/core/invoices.js, removeUnsentInvoice).
CREATE OR REPLACE FUNCTION flow.flow_invoice_rules() RETURNS trigger LANGUAGE plpgsql
SET search_path = flow, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.issued_version > 0 AND current_setting('flow.remove_unsent', true) IS DISTINCT FROM OLD.id::text THEN
      RAISE EXCEPTION 'flow: an invoice that was issued cannot be deleted; void it'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.organisation_id <> OLD.organisation_id THEN
    RAISE EXCEPTION 'flow: an invoice cannot move to another organisation'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'flow: an invoice number never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'flow: a void invoice cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.issued_version < OLD.issued_version THEN
    RAISE EXCEPTION 'flow: issued_version only goes up'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- The issued versions of that one invoice go with it. Every other change or
-- delete is refused, as before.
CREATE OR REPLACE FUNCTION flow.flow_invoice_versions_append_only() RETURNS trigger LANGUAGE plpgsql
SET search_path = flow, public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('flow.remove_unsent', true) = OLD.invoice_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'flow: % on % is not allowed; issued records are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER invoice_versions_append_only
  BEFORE UPDATE OR DELETE ON flow.invoice_versions
  FOR EACH ROW EXECUTE FUNCTION flow.flow_invoice_versions_append_only();
