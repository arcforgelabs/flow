#!/usr/bin/env node
// Removes a turned-off integration's tables: the separate, explicit step that
// turning an integration off never takes. It refuses while the integration is
// in FLOW_INTEGRATIONS and while any of its tables holds a row.
//
//   DATABASE_URL=postgres://… node server/integrations/remove-tables.js <id>
import { openDatabase } from '../db/index.js';
import { adapters } from './adapters.js';
import { resolveEnabledIntegrations } from './index.js';
import { defineAdapter } from './port.js';
import { removeAdapterTables } from './schema.js';

const id = process.argv[2];
const found = adapters.find((a) => a.id === id);
if (!found) {
  console.error(`Usage: remove-tables.js <id>. Known: ${adapters.map((a) => a.id).join(', ') || 'none'}.`);
  process.exit(2);
}

const database = openDatabase({ max: 1 });
try {
  const adapter = defineAdapter(found);
  const enabled = resolveEnabledIntegrations().includes(id);
  const { removed } = await removeAdapterTables(database.db, adapter, { enabled });
  console.log(removed.length ? `Removed ${removed.join(', ')}` : `${adapter.name} had no tables`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await database.close();
}
