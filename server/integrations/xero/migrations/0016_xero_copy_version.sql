-- The version of the copy each resource was read with: the mapper's version
-- (mirror.js COPY_VERSION) and whether free text is kept. When it changes,
-- the next read starts again from the beginning, so old rows get a new field.
-- Null: read before Flow noted it; the first read notes it without starting
-- again (kept_reference still starts one when the setting differs).
ALTER TABLE "xero_mirror_cursors" ADD COLUMN IF NOT EXISTS "copy_version" text;
--> statement-breakpoint
-- Who asked for a full read again, and when (POST /api/xero/mirror/reread).
ALTER TABLE "xero_mirror_cursors" ADD COLUMN IF NOT EXISTS "reread_by" text;
--> statement-breakpoint
ALTER TABLE "xero_mirror_cursors" ADD COLUMN IF NOT EXISTS "reread_at" timestamp with time zone;
