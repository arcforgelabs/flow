-- Who read or changed practice data is a record. No code path (or manual
-- query) may change or remove an audit event.
DO $flow_guard$ BEGIN
	CREATE TRIGGER audit_events_append_only
	  BEFORE UPDATE OR DELETE ON audit_events
	  FOR EACH ROW EXECUTE FUNCTION flow_refuse_change();
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $flow_guard$;
