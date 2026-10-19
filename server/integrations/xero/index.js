import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { pushInvoice } from './drafts.js';
import { createImportWorker } from './import.js';
import { readPayments } from './ledger.js';
import { createXeroRouter } from './routes.js';
import { createXeroRuntime, requireXeroSettings } from './runtime.js';
import { writesAllowed } from './settings.js';

// The Xero adapter (docs/XERO.md). FLOW_INTEGRATIONS=xero turns it on and
// XERO_MODE says which Xero it acts on. Its tables are created only while it
// is on (docs/INTEGRATIONS.md).

export const XERO_TABLES = Object.freeze(['xero_connections', 'xero_contacts', 'xero_items', 'xero_sync_runs', 'xero_invoice_pushes', 'xero_payment_cursors', 'xero_invoices', 'xero_credit_notes', 'xero_payments', 'xero_mirror_cursors']);

// `runtime` is for tests. Otherwise start() builds it from the environment,
// so a turned-off adapter never reads its settings, and a malformed setting
// stops boot when Xero is on.
export function createXeroAdapter({ runtime: given = null } = {}) {
  let runtime = given;
  let database = null;
  let importer = null;
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
      // The history import (import.js) runs in the background outside replay
      // mode. Replay tests run its slices directly.
      if (settings.mode !== 'replay') {
        importer = createImportWorker({ db, runtime: current(), log });
        await importer.start();
      }
    },
    async stop() {
      await importer?.stop();
      importer = null;
    },
    capabilities: {
      async health() {
        const { settings } = current();
        const { rows } = await database.execute(sql`select count(*)::int as connected from xero_connections where mode = ${settings.mode}`);
        return { ok: true, mode: settings.mode, writesAllowed: writesAllowed(settings), connected: rows[0].connected };
      },
      // One issued invoice to a Xero draft (drafts.js). The Flow invoice id
      // and version are the idempotency key.
      pushInvoice: ({ organisationId, invoiceId, pushedBy = null }) => pushInvoice(database, current(), { organisationId, invoiceId, pushedBy }),
      // Sales invoice payments changed since `since` (ledger.js). The answer's
      // cursor is the next `since`.
      pullPayments: ({ organisationId, since }) => readPayments(database, current(), organisationId, { since: new Date(since) }),
    },
    routes: ({ db, personAuth, log, messagePage }) => createXeroRouter({ db, personAuth, runtime: current(), log, messagePage }),
  };
}

export const xeroAdapter = createXeroAdapter();
