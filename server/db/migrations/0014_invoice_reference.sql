ALTER TABLE "invoicing_settings" ADD COLUMN IF NOT EXISTS "reference_template" text DEFAULT '{practitioner} - {patient}' NOT NULL;
