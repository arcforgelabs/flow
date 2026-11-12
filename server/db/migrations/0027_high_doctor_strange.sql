CREATE TABLE IF NOT EXISTS "invoice_rule_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_rule_exceptions_reason_valid" CHECK (length("invoice_rule_exceptions"."reason") between 1 and 200)
);
--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoice_rule_exceptions" ADD CONSTRAINT "invoice_rule_exceptions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "flow"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoice_rule_exceptions" ADD CONSTRAINT "invoice_rule_exceptions_rule_id_invoice_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "flow"."invoice_rules"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "invoice_rule_exceptions" ADD CONSTRAINT "invoice_rule_exceptions_obligation_id_billing_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "flow"."billing_obligations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_rule_exceptions_rule_job" ON "invoice_rule_exceptions" USING btree ("rule_id","obligation_id");