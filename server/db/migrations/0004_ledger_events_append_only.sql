-- The reasons for an obligation's state are a record. No code path (or
-- manual query) may change or remove them.
CREATE TRIGGER obligation_events_append_only
  BEFORE UPDATE OR DELETE ON obligation_events
  FOR EACH ROW EXECUTE FUNCTION flow_refuse_change();
