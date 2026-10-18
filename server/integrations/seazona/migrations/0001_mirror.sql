CREATE TABLE "seazona_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"account_number" text,
	"company" text,
	"full_name" text,
	"email" text,
	"phone" text,
	"address" jsonb,
	"tax_rate" text,
	"active" boolean,
	"doctors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_modified_text" text,
	"list_signature" text,
	"record_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"last_changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seazona_invoices" (
	"invoice_number" text PRIMARY KEY NOT NULL,
	"seazona_id" text,
	"client_id" text,
	"account_number" text,
	"company" text,
	"doctor_name" text,
	"status" text,
	"invoice_date_text" text,
	"due_text" text,
	"last_modified_text" text,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal_cents" bigint,
	"tax_cents" bigint,
	"total_cents" bigint,
	"discount_cents" bigint,
	"patient_reference" text,
	"list_signature" text,
	"record_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"last_changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seazona_lane_state" (
	"lane" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"cursor_time" timestamp with time zone,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"failure_details" jsonb,
	"held_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seazona_order_read_failures" (
	"order_id" text PRIMARY KEY NOT NULL,
	"failure_count" integer NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"last_http_status" integer,
	"last_failure_kind" text,
	"last_error" text,
	"quarantined_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "seazona_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_number" text,
	"client_id" text,
	"company" text,
	"doctor_name" text,
	"status" text,
	"ordered_text" text,
	"due_text" text,
	"last_modified_text" text,
	"department" text,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal_cents" bigint,
	"patient_reference" text,
	"deleted_in_source_at" timestamp with time zone,
	"list_signature" text,
	"record_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"last_changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seazona_reference" (
	"resource" text NOT NULL,
	"id" text NOT NULL,
	"name" text,
	"code" text,
	"kind" text,
	"price_cents" bigint,
	"taxable" boolean,
	"record_hash" text NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seazona_reference_resource_id_pk" PRIMARY KEY("resource","id")
);
--> statement-breakpoint
CREATE INDEX "seazona_invoices_changed" ON "seazona_invoices" USING btree ("last_changed_at");--> statement-breakpoint
CREATE INDEX "seazona_orders_invoice_number" ON "seazona_orders" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "seazona_orders_changed" ON "seazona_orders" USING btree ("last_changed_at");