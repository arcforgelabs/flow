CREATE TABLE IF NOT EXISTS "seazona_sweep_findings" (
	"resource" text NOT NULL,
	"record_key" text NOT NULL,
	"kind" text NOT NULL,
	"first_found_at" timestamp with time zone NOT NULL,
	"last_found_at" timestamp with time zone NOT NULL,
	"detail" jsonb,
	CONSTRAINT "seazona_sweep_findings_resource_record_key_kind_pk" PRIMARY KEY("resource","record_key","kind")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seazona_sweep_findings_found" ON "seazona_sweep_findings" USING btree ("last_found_at");