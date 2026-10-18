-- Where the next read of Xero payments starts, for each Flow organisation.
-- (This is the Xero adapter's own migration journal, not the core's.)
CREATE TABLE "xero_payment_cursors" (
	"organisation_id" uuid PRIMARY KEY NOT NULL REFERENCES "organisations"("id"),
	"payments_since" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
