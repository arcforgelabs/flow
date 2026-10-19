CREATE TABLE "line_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"match" text DEFAULT 'exact' NOT NULL,
	"label" text NOT NULL,
	"unit_amount_cents" integer,
	"item_code" text,
	"account_code" text,
	"tax_code" text,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"origin" text DEFAULT 'person' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "line_mappings_kind_valid" CHECK ("line_mappings"."kind" in ('alias', 'price_alias', 'saved', 'account')),
	CONSTRAINT "line_mappings_match_valid" CHECK ("line_mappings"."match" in ('exact', 'starts_with')),
	CONSTRAINT "line_mappings_tax_code_valid" CHECK ("line_mappings"."tax_code" is null or "line_mappings"."tax_code" in ('GST', 'GST_FREE')),
	CONSTRAINT "line_mappings_target" CHECK (("line_mappings"."kind" = 'account' and "line_mappings"."account_code" is not null) or ("line_mappings"."kind" <> 'account' and "line_mappings"."item_code" is not null)),
	CONSTRAINT "line_mappings_price" CHECK ("line_mappings"."kind" not in ('price_alias', 'saved') or "line_mappings"."unit_amount_cents" is not null),
	CONSTRAINT "line_mappings_label_valid" CHECK (length("line_mappings"."label") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "account_code" text;--> statement-breakpoint
ALTER TABLE "price_items" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "line_mappings" ADD CONSTRAINT "line_mappings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_mappings" ADD CONSTRAINT "line_mappings_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "line_mappings_unique" ON "line_mappings" USING btree ("organisation_id","kind","match","label",coalesce("unit_amount_cents", -1));