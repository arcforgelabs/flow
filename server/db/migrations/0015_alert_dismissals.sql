CREATE TABLE IF NOT EXISTS "alert_dismissals" (
	"organisation_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"alert_key" text NOT NULL,
	"members" text[] DEFAULT '{}'::text[] NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_dismissals_organisation_id_person_id_alert_key_pk" PRIMARY KEY("organisation_id","person_id","alert_key")
);
--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "alert_dismissals" ADD CONSTRAINT "alert_dismissals_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "alert_dismissals" ADD CONSTRAINT "alert_dismissals_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;