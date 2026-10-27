-- Two-way contact edits (docs/CONTACTS.md, xero/contact-sync.js). One row for
-- each linked pair: the fields both sides last agreed on (the merge base), so
-- Flow can tell which side changed a field. `clashes` lists the fields both
-- sides changed; they wait for a person. The Xero adapter's own table.
CREATE TABLE IF NOT EXISTS "xero_contact_sync" (
	"organisation_id" uuid NOT NULL REFERENCES "organisations"("id"),
	"xero_contact_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"base" jsonb NOT NULL,
	"clashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_at" timestamp with time zone,
	CONSTRAINT "xero_contact_sync_pk" PRIMARY KEY("organisation_id", "xero_contact_id")
);
