CREATE TABLE "integration_setting_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adapter_id" text NOT NULL,
	"kind" text NOT NULL,
	"settings" text[] DEFAULT '{}'::text[] NOT NULL,
	"actor" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_setting_events_kind_valid" CHECK (kind in ('turned_on', 'turned_off', 'setting_changed', 'secret_set', 'secret_removed'))
);
--> statement-breakpoint
CREATE TABLE "integration_settings" (
	"adapter_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_setting_events" ADD CONSTRAINT "integration_setting_events_actor_people_id_fk" FOREIGN KEY ("actor") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_setting_events_adapter" ON "integration_setting_events" USING btree ("adapter_id","created_at");