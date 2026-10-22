-- Flow's tables move from "public" to their own schema, "flow" (issue: Replit's
-- publish compares the workspace's "public" schema with production's and
-- offers to make production match, deletes included; docs/REPLIT.md, "The
-- workspace database"). Every connection searches "flow" first
-- (server/db/index.js, FLOW_SEARCH_PATH), so queries keep their table names.
-- The adapters' tables move too, when they exist; an adapter turned on later
-- creates its tables in "flow". It runs again without harm.
DO $flow_guard$
DECLARE
	t text;
BEGIN
	CREATE SCHEMA IF NOT EXISTS flow;
	FOREACH t IN ARRAY ARRAY[
		'alert_dismissals', 'automations', 'background_jobs', 'billing_obligations', 'contacts',
		'customer_billing_settings', 'external_links', 'integration_setting_events', 'integration_settings',
		'invoice_lines', 'invoice_rules', 'invoice_versions', 'invoices', 'invoicing_settings',
		'job_field_events', 'job_field_settings', 'job_field_values', 'job_fields', 'line_mappings',
		'link_rejections', 'link_suggestions', 'obligation_events', 'obligation_payments',
		'obligation_writebacks', 'organisations', 'outbox', 'people', 'pipeline_cursors',
		'price_item_links', 'price_items', 'prior_links', 'review_items',
		'seazona_api_governor', 'seazona_api_requests', 'seazona_clients', 'seazona_history_batch_jobs',
		'seazona_history_batches', 'seazona_history_jobs', 'seazona_history_rows', 'seazona_invoices',
		'seazona_lane_state', 'seazona_order_read_failures', 'seazona_orders', 'seazona_person_settings',
		'seazona_record_read_failures', 'seazona_reference', 'seazona_stage_moves', 'seazona_sweep_findings',
		'xero_call_guard', 'xero_calls', 'xero_connections', 'xero_contacts', 'xero_credit_notes',
		'xero_daily_checks', 'xero_import_settings', 'xero_invoice_links', 'xero_invoice_pushes',
		'xero_invoices', 'xero_items', 'xero_mirror_cursors', 'xero_payment_cursors', 'xero_payments',
		'xero_sync_runs', 'xero_webhook_events'
	] LOOP
		IF to_regclass(format('public.%I', t)) IS NOT NULL AND to_regclass(format('flow.%I', t)) IS NULL THEN
			EXECUTE format('ALTER TABLE public.%I SET SCHEMA flow', t);
		END IF;
	END LOOP;
	FOREACH t IN ARRAY ARRAY['flow_refuse_change', 'flow_invoice_lines_draft_only', 'flow_invoice_rules'] LOOP
		IF to_regprocedure(format('public.%I()', t)) IS NOT NULL AND to_regprocedure(format('flow.%I()', t)) IS NULL THEN
			EXECUTE format('ALTER FUNCTION public.%I() SET SCHEMA flow', t);
		END IF;
		-- The trigger functions name tables without a schema.
		IF to_regprocedure(format('flow.%I()', t)) IS NOT NULL THEN
			EXECUTE format('ALTER FUNCTION flow.%I() SET search_path = flow, public', t);
		END IF;
	END LOOP;
	-- New sessions, a pooler's included, search "flow" first: a transaction
	-- pooler does not keep a session's SET. Flow's role sets it for itself, and
	-- the database too when Flow owns it; Flow's own connections set it anyway.
	BEGIN
		EXECUTE format('ALTER ROLE %I IN DATABASE %I SET search_path TO flow, public', current_user, current_database());
	EXCEPTION WHEN insufficient_privilege THEN
		RAISE NOTICE 'flow: this role cannot set its own search_path; Flow sets its own';
	END;
	BEGIN
		EXECUTE format('ALTER DATABASE %I SET search_path TO flow, public', current_database());
	EXCEPTION WHEN insufficient_privilege THEN
		RAISE NOTICE 'flow: not the database owner, so its default search_path stays; Flow sets its own';
	END;
	-- A pooler keeps the server sessions it opened before this move, with the
	-- old search_path, and hands them to new clients. Close the idle ones
	-- of this role: the pooler opens new ones, which take the setting above.
	BEGIN
		PERFORM pg_terminate_backend(a.pid) FROM pg_stat_activity a
		 WHERE a.datname = current_database() AND a.usename = current_user
		   AND a.pid <> pg_backend_pid() AND a.state = 'idle' AND a.backend_type = 'client backend';
	EXCEPTION WHEN others THEN
		RAISE NOTICE 'flow: could not close the idle sessions; a pooler''s open sessions keep the old search_path until they close';
	END;
	-- This session too: the migrations after this one create their tables in "flow".
	PERFORM set_config('search_path', 'flow, public', false);
END $flow_guard$;
