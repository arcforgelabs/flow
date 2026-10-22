-- The lane a call counted against, and a 429's X-Rate-Limit-Problem, so the
-- Xero card can show the day's calls without asking Xero. A row from before
-- this column has no lane: the card does not guess one.
ALTER TABLE "xero_calls" ADD COLUMN IF NOT EXISTS "lane" text;
--> statement-breakpoint
ALTER TABLE "xero_calls" ADD COLUMN IF NOT EXISTS "rate_limit_problem" text;
--> statement-breakpoint
DO $flow_guard$ BEGIN
	ALTER TABLE "xero_calls" ADD CONSTRAINT "xero_calls_lane_valid" CHECK ("lane" is null or "lane" in ('writes', 'sync', 'reads', 'other'));
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;
