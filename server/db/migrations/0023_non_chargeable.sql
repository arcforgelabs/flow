DO $flow_guard$ BEGIN
	ALTER TABLE "billing_obligations" DROP CONSTRAINT IF EXISTS "billing_obligations_accounting_state_valid";
	ALTER TABLE "billing_obligations" ADD CONSTRAINT "billing_obligations_accounting_state_valid" CHECK (accounting_state in ('unknown', 'not_found', 'drafted', 'authorised', 'part_paid', 'paid', 'voided', 'deleted', 'ambiguous', 'conflict', 'non_chargeable'));
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_status_valid";
	ALTER TABLE "invoices" ADD CONSTRAINT "invoices_status_valid" CHECK ("invoices"."status" in ('draft', 'issued', 'void', 'non_chargeable'));
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_issued_has_number";
	ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_has_number" CHECK ("invoices"."status" in ('draft', 'non_chargeable') or "invoices"."number" is not null);
END $flow_guard$;
