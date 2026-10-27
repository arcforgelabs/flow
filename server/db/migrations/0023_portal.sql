CREATE TABLE IF NOT EXISTS "portal_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"practice_name" text NOT NULL,
	"phone" text,
	"status" text DEFAULT 'open' NOT NULL,
	"contact_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_access_requests_email_lower" CHECK ("portal_access_requests"."email" = lower("portal_access_requests"."email")),
	CONSTRAINT "portal_access_requests_status_valid" CHECK ("portal_access_requests"."status" in ('open', 'approved', 'declined'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "practice_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"clerk_user_id" text,
	"practitioner_name" text,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_members_org_id" UNIQUE("organisation_id","id"),
	CONSTRAINT "practice_members_contact_email" UNIQUE("contact_id","email"),
	CONSTRAINT "practice_members_email_lower" CHECK ("practice_members"."email" = lower("practice_members"."email")),
	CONSTRAINT "practice_members_role_valid" CHECK ("practice_members"."role" in ('owner', 'admin', 'dentist', 'staff')),
	CONSTRAINT "practice_members_status_valid" CHECK ("practice_members"."status" in ('invited', 'active', 'removed'))
);
--> statement-breakpoint
ALTER TABLE "invoicing_settings" ADD COLUMN IF NOT EXISTS "portal_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoicing_settings" ADD COLUMN IF NOT EXISTS "portal_status_names" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "portal_access_requests" ADD CONSTRAINT "portal_access_requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "flow"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "portal_access_requests" ADD CONSTRAINT "portal_access_requests_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "flow"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "portal_access_requests" ADD CONSTRAINT "portal_access_requests_contact_same_org" FOREIGN KEY ("organisation_id","contact_id") REFERENCES "flow"."contacts"("organisation_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "practice_members" ADD CONSTRAINT "practice_members_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "flow"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "practice_members" ADD CONSTRAINT "practice_members_contact_same_org" FOREIGN KEY ("organisation_id","contact_id") REFERENCES "flow"."contacts"("organisation_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_access_requests_open" ON "portal_access_requests" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "practice_members_clerk" ON "practice_members" USING btree ("clerk_user_id");