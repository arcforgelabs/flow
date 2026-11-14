ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'flow' NOT NULL;
--> statement-breakpoint
-- The import takes an invoice a customer saw (approved, paid or voided in the
-- accounting system), so an imported invoice is issued or void, never a
-- draft. Its lines therefore never change: flow_invoice_lines_draft_only
-- (migration 0001) lets lines change only under a draft.
DO $flow_guard$ BEGIN
	ALTER TABLE "invoices" ADD CONSTRAINT "invoices_imported_not_draft" CHECK ("invoices"."origin" = 'flow' or "invoices"."status" <> 'draft');
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;
--> statement-breakpoint
-- An imported invoice (origin is not 'flow') belongs to the accounting system
-- it was copied from. Only the import changes or removes it: its code sets
-- flow.mirror_write to the invoice's id for its own transaction
-- (server/core/invoices.js, mirrorWrite). Every other change is refused here,
-- whatever route it came by. A contact merge may still move any invoice,
-- void ones too, to the kept contact (contact_id and updated_at only).
CREATE OR REPLACE FUNCTION flow.flow_invoice_rules() RETURNS trigger LANGUAGE plpgsql
SET search_path = flow, public AS $$
DECLARE
  mirror boolean := current_setting('flow.mirror_write', true) IS NOT DISTINCT FROM OLD.id::text;
  moved_only boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.origin <> 'flow' THEN
      IF NOT mirror THEN
        RAISE EXCEPTION 'flow: an imported invoice is removed only by its import'
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN OLD;
    END IF;
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
  IF NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'flow: the origin of an invoice never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  moved_only := (to_jsonb(NEW) - 'contact_id' - 'updated_at') = (to_jsonb(OLD) - 'contact_id' - 'updated_at');
  IF OLD.origin <> 'flow' AND NOT mirror AND NOT moved_only THEN
    RAISE EXCEPTION 'flow: an imported invoice follows its accounting system; Flow does not change it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number AND NOT (OLD.origin <> 'flow' AND mirror) THEN
    RAISE EXCEPTION 'flow: an invoice number never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'void' AND NOT moved_only THEN
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
-- The issued versions go with an invoice the code may remove: one that never
-- reached the accounting system (flow.remove_unsent, migration 0039), or an
-- imported one its import removes (flow.mirror_write).
CREATE OR REPLACE FUNCTION flow.flow_invoice_versions_append_only() RETURNS trigger LANGUAGE plpgsql
SET search_path = flow, public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('flow.remove_unsent', true) = OLD.invoice_id::text THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('flow.mirror_write', true) = OLD.invoice_id::text
    AND EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id AND origin <> 'flow') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'flow: % on % is not allowed; issued records are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
-- A job's own invoice (invoice_id) is one Flow made for it. A job is tied to
-- an imported invoice by its accounting reference, as the matcher ties it,
-- so several jobs can share one accounting invoice and the import changes no
-- job (docs/XERO_IMPORT.md, "An imported invoice").
CREATE OR REPLACE FUNCTION flow.flow_job_invoice_is_own() RETURNS trigger LANGUAGE plpgsql
SET search_path = flow, public AS $$
BEGIN
  IF NEW.invoice_id IS NOT NULL AND EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id AND origin <> 'flow') THEN
    RAISE EXCEPTION 'flow: a job is tied to an imported invoice by its accounting reference, not as its own invoice'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER billing_obligations_invoice_is_own
  BEFORE INSERT OR UPDATE OF invoice_id ON flow.billing_obligations
  FOR EACH ROW EXECUTE FUNCTION flow.flow_job_invoice_is_own();
--> statement-breakpoint
-- An override is an owner's yes to a send by Flow. An imported invoice is
-- never sent by Flow, and an override row stays for ever (migration 0037), so
-- it would keep the import from removing its copy. A row for one is refused.
-- No row moves to one: an override row never changes.
CREATE OR REPLACE FUNCTION flow.flow_override_invoice_is_own() RETURNS trigger LANGUAGE plpgsql
SET search_path = flow, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id AND origin <> 'flow') THEN
    RAISE EXCEPTION 'flow: an imported invoice is never sent by Flow, so it has no send override'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER send_overrides_invoice_is_own
  BEFORE INSERT ON flow.send_overrides
  FOR EACH ROW EXECUTE FUNCTION flow.flow_override_invoice_is_own();
