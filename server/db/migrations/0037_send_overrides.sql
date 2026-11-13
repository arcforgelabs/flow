CREATE TABLE IF NOT EXISTS "send_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"document_hash" text NOT NULL,
	"problems" jsonb NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "send_overrides_invoice_version" UNIQUE("invoice_id","version"),
	CONSTRAINT "send_overrides_reason_valid" CHECK (reason_code in ('xero_item_wrong', 'one_off', 'client_tax', 'other')),
	CONSTRAINT "send_overrides_other_has_note" CHECK ("send_overrides"."reason_code" <> 'other' or "send_overrides"."note" is not null),
	CONSTRAINT "send_overrides_note_length" CHECK ("send_overrides"."note" is null or length("send_overrides"."note") between 1 and 200)
);
--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "send_overrides" ADD CONSTRAINT "send_overrides_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "flow"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "send_overrides" ADD CONSTRAINT "send_overrides_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "flow"."invoices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "send_overrides" ADD CONSTRAINT "send_overrides_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "flow"."people"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "send_overrides_person_day" ON "send_overrides" USING btree ("person_id","created_at");--> statement-breakpoint
-- An override is a record (docs/INVOICE_SENDING.md, "Override"): no code path
-- or manual query may change or remove it.
DO $flow_guard$ BEGIN
	CREATE TRIGGER send_overrides_append_only BEFORE UPDATE OR DELETE ON "send_overrides" FOR EACH ROW EXECUTE FUNCTION flow_refuse_change();
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;
