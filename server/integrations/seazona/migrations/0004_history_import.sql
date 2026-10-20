CREATE TABLE IF NOT EXISTS "seazona_history_batch_jobs" (
	"batch_id" bigint NOT NULL,
	"job_key" text NOT NULL,
	"job" jsonb NOT NULL,
	"record_hash" text NOT NULL,
	"outcome" text,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mirror_order_id" text,
	"mirror_invoice_number" text,
	"client_id" text,
	"decision" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "seazona_history_batch_jobs_batch_id_job_key_pk" PRIMARY KEY("batch_id","job_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seazona_history_batches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"file_name" text,
	"file_sha256" text NOT NULL,
	"profile" text NOT NULL,
	"columns" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ignored_columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"applied_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seazona_history_jobs" (
	"job_key" text PRIMARY KEY NOT NULL,
	"invoice_number" text,
	"case_ref" text,
	"client_id" text,
	"company" text,
	"doctor_name" text,
	"status" text,
	"job_date" text,
	"due_date" text,
	"shipped_date" text,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal_cents" bigint,
	"total_cents" bigint,
	"patient_reference" text,
	"mirror_order_id" text,
	"mirror_invoice_number" text,
	"record_hash" text NOT NULL,
	"batch_id" bigint NOT NULL,
	"first_batch_id" bigint NOT NULL,
	"first_imported_at" timestamp with time zone NOT NULL,
	"last_changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seazona_history_rows" (
	"batch_id" bigint NOT NULL,
	"row_number" integer NOT NULL,
	"job_key" text,
	"fields" jsonb NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "seazona_history_rows_batch_id_row_number_pk" PRIMARY KEY("batch_id","row_number")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seazona_history_batches_file" ON "seazona_history_batches" USING btree ("file_sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seazona_history_jobs_invoice" ON "seazona_history_jobs" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seazona_history_jobs_changed" ON "seazona_history_jobs" USING btree ("last_changed_at");