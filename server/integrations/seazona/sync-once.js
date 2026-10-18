#!/usr/bin/env node
// Runs the Seazona sync lanes once, now, and prints what each did. This is
// how a sandbox or replay installation syncs, since only live mode runs on a
// timer. Every request still goes through the rate governor.
//
//   DATABASE_URL=postgres://… FLOW_INTEGRATIONS=seazona SEAZONA_MODE=sandbox … \
//     node server/integrations/seazona/sync-once.js [lane …]
//
// Lanes: invoices, orders_recent, orders_active, clients, products, users.
// None named: all of them.
import { openDatabase } from '../../db/index.js';
import { resolveEnabledIntegrations } from '../index.js';
import { migrateAdapterSchema } from '../schema.js';
import { createSeazonaClient } from './client.js';
import { requireSeazonaSettings } from './index.js';
import { LANES, runSeazonaSync } from './lanes.js';
import { seazonaSchema } from './tables.js';

const lanes = process.argv.slice(2);
const unknown = lanes.filter((lane) => !LANES.includes(lane));
if (unknown.length) {
  console.error(`Unknown lane ${unknown.join(', ')}. Lanes: ${LANES.join(', ')}.`);
  process.exit(2);
}

let database;
try {
  // The adapter's tables exist only while it is on (docs/INTEGRATIONS.md).
  if (!resolveEnabledIntegrations().includes('seazona')) {
    throw new Error('Seazona is turned off: add seazona to FLOW_INTEGRATIONS first');
  }
  const settings = requireSeazonaSettings();
  database = openDatabase({ max: 2 });
  await migrateAdapterSchema(database.db, { id: 'seazona', schema: seazonaSchema });
  const client = createSeazonaClient({ settings, db: database.db, workflow: 'seazona-sync-once' });
  const result = await runSeazonaSync(database.db, client, { settings, only: lanes, force: true });
  console.log(JSON.stringify({ mode: settings.mode, requests: client.stats.requests, ...result }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(`[seazona] ${error.message}`);
  process.exitCode = 1;
} finally {
  await database?.close();
}
