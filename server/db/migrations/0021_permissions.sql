CREATE TABLE IF NOT EXISTS "permission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"target_role" text,
	"target_person_id" uuid,
	"key" text NOT NULL,
	"from_value" text NOT NULL,
	"to_value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_events_one_target" CHECK (("permission_events"."target_role" is not null) <> ("permission_events"."target_person_id" is not null)),
	CONSTRAINT "permission_events_role_valid" CHECK ("permission_events"."target_role" is null or "permission_events"."target_role" in ('owner', 'admin', 'staff')),
	CONSTRAINT "permission_events_value_valid" CHECK ("permission_events"."from_value" in ('allow', 'deny', 'inherit') and "permission_events"."to_value" in ('allow', 'deny', 'inherit'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "person_permissions" (
	"person_id" uuid NOT NULL,
	"key" text NOT NULL,
	"effect" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_permissions_pk" PRIMARY KEY("person_id","key"),
	CONSTRAINT "person_permissions_effect_valid" CHECK ("person_permissions"."effect" in ('allow', 'deny')),
	CONSTRAINT "person_permissions_key_valid" CHECK ("person_permissions"."key" in ('invoices.send', 'invoices.approve', 'invoices.void', 'invoices.draft', 'priceList.edit', 'rules.edit', 'customFields.edit', 'integrations.run', 'integrations.connect', 'people.manage'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permissions" (
	"role" text NOT NULL,
	"key" text NOT NULL,
	"allowed" boolean NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pk" PRIMARY KEY("role","key"),
	CONSTRAINT "role_permissions_role_valid" CHECK ("role_permissions"."role" in ('owner', 'admin', 'staff')),
	CONSTRAINT "role_permissions_key_valid" CHECK ("role_permissions"."key" in ('invoices.send', 'invoices.approve', 'invoices.void', 'invoices.draft', 'priceList.edit', 'rules.edit', 'customFields.edit', 'integrations.run', 'integrations.connect', 'people.manage'))
);
--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "permission_events" ADD CONSTRAINT "permission_events_actor_id_people_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "permission_events" ADD CONSTRAINT "permission_events_target_person_id_people_id_fk" FOREIGN KEY ("target_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "person_permissions" ADD CONSTRAINT "person_permissions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "person_permissions" ADD CONSTRAINT "person_permissions_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permission_events_created" ON "permission_events" USING btree ("created_at");