import { migrateDatabase, openDatabase } from './index.js';
import { adapters as shipped } from '../integrations/adapters.js';
import { migrateAdapterSchema } from '../integrations/schema.js';

// Brings a database up to this build: the core migrations, then the tables
// of every adapter this build ships, whether or not it is on
// (`flow-server migrate`). Not for a Replit workspace: its database follows
// production instead (scripts/replit-workspace-db.js, docs/REPLIT.md).
export async function migrateEverything(db, { adapters = shipped, log = () => {} } = {}) {
  await migrateDatabase(db);
  for (const adapter of adapters) {
    if (!adapter.schema) continue;
    await migrateAdapterSchema(db, adapter);
    log(`${adapter.id} tables are up to date`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = openDatabase({ max: 1 });
  try {
    await migrateEverything(handle.db, { log: (line) => console.log(`[deploy] ${line}`) });
  } finally {
    await handle.close();
  }
}
