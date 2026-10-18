CREATE TABLE "sample_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sample_cursor" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_item_id" integer REFERENCES "sample_items"("id")
);
