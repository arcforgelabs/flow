CREATE TABLE IF NOT EXISTS "flow"."xero_tracking_settings" (
  "organisation_id" uuid PRIMARY KEY REFERENCES "flow"."organisations"("id"),
  "category" text,
  "option" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text,
  CONSTRAINT "xero_tracking_pair" CHECK (("category" IS NULL AND "option" IS NULL) OR
    (length(trim("category")) > 0 AND length(trim("option")) > 0 AND "category" IS NOT NULL AND "option" IS NOT NULL))
);
--> statement-breakpoint
-- Transactional upgrade receipt; this is not a runtime setting.
CREATE TABLE IF NOT EXISTS "flow"."xero_tracking_cutover" (
  "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton")
);
