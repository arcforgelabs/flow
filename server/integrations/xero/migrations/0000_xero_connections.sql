-- The Xero connection of each Flow organisation. The refresh token is
-- AES-256-GCM ciphertext (XERO_TOKEN_KEY); the plain token is never stored.
CREATE TABLE "xero_connections" (
	"organisation_id" uuid PRIMARY KEY NOT NULL REFERENCES "organisations"("id"),
	"mode" text NOT NULL,
	"tenant_id" text NOT NULL,
	"tenant_name" text,
	"scope" text,
	"refresh_token_enc" text NOT NULL,
	"connected_by" uuid REFERENCES "people"("id") ON DELETE SET NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xero_connections_tenant" UNIQUE("tenant_id"),
	CONSTRAINT "xero_connections_mode_valid" CHECK ("mode" in ('live', 'sandbox', 'replay')),
	CONSTRAINT "xero_connections_token_sealed" CHECK ("refresh_token_enc" like 'v1:%')
);
