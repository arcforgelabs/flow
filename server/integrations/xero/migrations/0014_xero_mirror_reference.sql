-- Whether the copy kept Xero's free text (XERO_KEEP_REFERENCE) when each
-- resource was read. When the setting differs from the one the copy was read
-- with, the next read starts again from the beginning, so old rows get the
-- Reference and line text (or lose it). Null: read before Flow kept this,
-- which is read again once.
ALTER TABLE "xero_mirror_cursors" ADD COLUMN IF NOT EXISTS "kept_reference" boolean;
