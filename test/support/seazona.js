import { migrateAdapterSchema } from '../../server/integrations/schema.js';
import { seazonaSchema } from '../../server/integrations/seazona/tables.js';
import { freshDatabase } from './db.js';

// A throwaway database with the core tables and the Seazona adapter's own.
export async function freshSeazonaDatabase() {
  const handle = await freshDatabase();
  // The same step Flow takes at start for an enabled adapter (docs/INTEGRATIONS.md).
  await migrateAdapterSchema(handle.db, { id: 'seazona', schema: seazonaSchema });
  return handle;
}

// A clock that only moves when a test (or a sleep) moves it.
export function fakeClock(startIso = '2026-10-01T00:00:00.000Z') {
  let nowMs = Date.parse(startIso);
  return {
    now: () => nowMs,
    advance: (ms) => { nowMs += ms; },
    sleep: async (ms) => { nowMs += ms; },
    set: (iso) => { nowMs = Date.parse(iso); },
  };
}
