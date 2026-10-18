import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createXeroRouter } from './routes.js';
import { createXeroRuntime, requireXeroSettings } from './runtime.js';
import { writesAllowed } from './settings.js';

// The Xero adapter (docs/XERO.md). FLOW_INTEGRATIONS=xero turns it on and
// XERO_MODE says which Xero it acts on. Its tables are created only while it
// is on (docs/INTEGRATIONS.md).

export const XERO_TABLES = Object.freeze(['xero_connections', 'xero_contacts', 'xero_items', 'xero_sync_runs']);

// `runtime` is for tests. Otherwise start() builds it from the environment,
// so a turned-off adapter never reads its settings, and a malformed setting
// stops boot when Xero is on.
export function createXeroAdapter({ runtime: given = null } = {}) {
  let runtime = given;
  let database = null;
  const current = () => {
    runtime ??= createXeroRuntime({ settings: requireXeroSettings(process.env) });
    return runtime;
  };

  return {
    id: 'xero',
    name: 'Xero',
    bundled: false,
    schema: {
      migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
      tables: [...XERO_TABLES],
    },
    async start({ db, log }) {
      database = db;
      const { settings } = current();
      log.info?.(`[xero] mode ${settings.mode}; writes ${writesAllowed(settings) ? 'on' : 'off (XERO_ALLOW_LIVE_WRITES)'}; redirect URI ${settings.redirectUri ?? 'not set (FLOW_PUBLIC_ORIGIN)'}`);
    },
    capabilities: {
      async health() {
        const { settings } = current();
        const { rows } = await database.execute(sql`select count(*)::int as connected from xero_connections where mode = ${settings.mode}`);
        return { ok: true, mode: settings.mode, writesAllowed: writesAllowed(settings), connected: rows[0].connected };
      },
    },
    routes: ({ db, personAuth, log }) => createXeroRouter({ db, personAuth, runtime: current(), log }),
  };
}

export const xeroAdapter = createXeroAdapter();
