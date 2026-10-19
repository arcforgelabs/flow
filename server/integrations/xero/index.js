import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { pushInvoice } from './drafts.js';
import { createImportWorker } from './import.js';
import { readPayments, xeroLiveCheck } from './ledger.js';
import { createXeroRouter } from './routes.js';
import { createXeroRuntime, requireXeroSettings } from './runtime.js';
import { writesAllowed } from './settings.js';

// The Xero adapter (docs/XERO.md). FLOW_INTEGRATIONS=xero turns it on and
// XERO_MODE says which Xero it acts on. Its tables are created only while it
// is on (docs/INTEGRATIONS.md).

export const XERO_TABLES = Object.freeze(['xero_connections', 'xero_contacts', 'xero_items', 'xero_sync_runs', 'xero_invoice_pushes', 'xero_payment_cursors', 'xero_invoices', 'xero_credit_notes', 'xero_payments', 'xero_mirror_cursors']);

// What an owner enters in Settings, Integrations (server/integrations/setup.js).
// The refresh token's key comes from Flow's secrets key.
export const XERO_SETUP = {
  guide: {
    title: 'Create your own Xero app',
    link: 'https://developer.xero.com/app/manage',
    steps: [
      'Sign in at developer.xero.com with a Xero login that can manage the organisation, and open My Apps.',
      'Press New app. Name it, for example "Flow". Choose Web app.',
      'Company or application URL: this installation\'s address.',
      'Redirect URI: copy it from below, exactly.',
      'Open the app\'s Configuration. Copy the client id. Generate a secret and copy it: Xero shows it once.',
      'Paste both below, choose the mode, name your Xero organisation, and turn Xero on.',
    ],
  },
  fields: [
    { name: 'XERO_MODE', label: 'Mode', kind: 'choice', choices: [{ value: 'live', label: 'Live: your Xero organisation' }, { value: 'sandbox', label: 'Sandbox: a Xero Demo Company' }] },
    { name: 'XERO_REDIRECT_URI', label: 'Redirect URI', kind: 'url', suggest: 'callback', help: 'This installation\'s address plus /api/xero/oauth/callback. Register the same address on the Xero app.' },
    { name: 'XERO_CLIENT_ID', label: 'Client id', help: 'From the Xero app\'s Configuration.' },
    { name: 'XERO_CLIENT_SECRET', label: 'Client secret', secret: true, help: 'Stored encrypted. Flow never shows it again.' },
    { name: 'XERO_TENANT_NAME', label: 'Xero organisation name', help: 'Live mode connects only the organisation with this exact name.' },
    { name: 'XERO_ALLOW_LIVE_WRITES', label: 'Create draft invoices in live Xero', kind: 'onoff', help: 'Off: Flow only reads from Xero.' },
  ],
  derivedKeys: ['XERO_TOKEN_KEY'],
};

// `runtime` is for tests. Otherwise start() builds it from its settings, so a
// turned-off adapter never reads them, and a malformed setting stops it.
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
    setup: XERO_SETUP,
    async start({ db, log, env }) {
      database = db;
      if (!given) runtime = createXeroRuntime({ settings: requireXeroSettings(env ?? process.env) });
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
      runtime = given;
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
      // Xero's invoice for one billable job, looked up live (ledger.js): the
      // `liveCheck` for draftInvoiceForObligation.
      checkInvoice: ({ organisationId, obligation }) => xeroLiveCheck(database, current(), organisationId)(obligation),
    },
    routes: ({ db, personAuth, log, messagePage }) => createXeroRouter({ db, personAuth, runtime: current(), log, messagePage }),
  };
}

export const xeroAdapter = createXeroAdapter();
