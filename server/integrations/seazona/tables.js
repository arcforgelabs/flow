import { fileURLToPath } from 'node:url';

// The adapter's schema declaration for the integration port: its own
// migrations, and every table they create (docs/INTEGRATIONS.md).
export const seazonaSchema = Object.freeze({
  migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
  tables: Object.freeze([
    'seazona_api_governor',
    'seazona_api_requests',
  ]),
});
