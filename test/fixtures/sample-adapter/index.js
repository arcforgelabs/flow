import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';

// A synthetic adapter with two tables, for the integration schema tests.
export const SAMPLE_TABLES = ['sample_items', 'sample_cursor'];

export function sampleAdapter(db) {
  return {
    id: 'sample',
    name: 'Sample',
    schema: {
      migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
      tables: SAMPLE_TABLES,
    },
    capabilities: {
      health: async () => ({ ok: true }),
      pullWorkItems: async () => (await db.execute(sql`select id, reference from sample_items order by id`)).rows,
    },
  };
}
