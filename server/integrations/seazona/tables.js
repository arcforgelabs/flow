import { fileURLToPath } from 'node:url';

// The adapter's schema declaration for the integration port: its own
// migrations, and every table they create (docs/INTEGRATIONS.md).
export const seazonaSchema = Object.freeze({
  migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
  tables: Object.freeze([
    'seazona_api_governor',
    'seazona_api_requests',
    'seazona_orders',
    'seazona_invoices',
    'seazona_clients',
    'seazona_reference',
    'seazona_lane_state',
    'seazona_order_read_failures',
    'seazona_record_read_failures',
    'seazona_history_batches',
    'seazona_history_rows',
    'seazona_history_batch_jobs',
    'seazona_history_jobs',
    'seazona_sweep_findings',
    'seazona_stage_moves',
    'seazona_person_settings',
  ]),
});
