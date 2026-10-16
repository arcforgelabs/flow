-- What a customer was sent is a record. These triggers hold that rule in the
-- database, so no code path (or manual query) can quietly change it.

CREATE FUNCTION flow_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'flow: % on % is not allowed; issued records are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_versions_append_only
  BEFORE UPDATE OR DELETE ON invoice_versions
  FOR EACH ROW EXECUTE FUNCTION flow_refuse_change();
--> statement-breakpoint
CREATE FUNCTION flow_invoice_lines_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM invoices
    WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  -- A cascade from a deleted draft invoice finds no parent row.
  IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
    RAISE EXCEPTION 'flow: invoice lines change only while the invoice is a draft'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION flow_invoice_lines_draft_only();
--> statement-breakpoint
CREATE FUNCTION flow_invoice_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.issued_version > 0 THEN
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
CREATE TRIGGER invoices_rules
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION flow_invoice_rules();
