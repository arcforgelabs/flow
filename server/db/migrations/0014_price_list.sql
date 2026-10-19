CREATE TABLE IF NOT EXISTS "price_item_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"price_item_id" uuid NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"external_code" text,
	"matched_by" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_item_links_matched_by_valid" CHECK ("price_item_links"."matched_by" in ('code', 'person')),
	CONSTRAINT "price_item_links_system_valid" CHECK ("price_item_links"."system" ~ '^[a-z][a-z0-9-]{1,31}$')
);
--> statement-breakpoint
ALTER TABLE "price_items" ADD COLUMN IF NOT EXISTS "account_code" text;--> statement-breakpoint
ALTER TABLE "price_items" ADD COLUMN IF NOT EXISTS "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "price_items" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "price_item_links" ADD CONSTRAINT "price_item_links_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "price_item_links" ADD CONSTRAINT "price_item_links_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "price_item_links" ADD CONSTRAINT "price_item_links_item_same_org" FOREIGN KEY ("organisation_id","price_item_id") REFERENCES "public"."price_items"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_item_links_external" ON "price_item_links" USING btree ("organisation_id","system","external_id");--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "price_items" ADD CONSTRAINT "price_items_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;