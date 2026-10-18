CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"clerk_user_id" text,
	"invited_by" uuid,
	"linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_email" UNIQUE("email"),
	CONSTRAINT "people_clerk_user_id" UNIQUE("clerk_user_id"),
	CONSTRAINT "people_email_lower" CHECK ("people"."email" = lower("people"."email")),
	CONSTRAINT "people_role_valid" CHECK ("people"."role" in ('owner', 'admin', 'staff')),
	CONSTRAINT "people_status_valid" CHECK ("people"."status" in ('active', 'pending', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_invited_by_people_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;