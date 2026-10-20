import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { guardAlerts } from '../call-guard.js';
import { checkDrafts, pushInvoice, pushInvoices } from './drafts.js';
import { readConnection } from './connections.js';
import { createImportWorker } from './import.js';
import { readPayments, xeroLiveCheck } from './ledger.js';
import { findInvoices, listCustomers, listPriceItems, mirrorState } from './lookup.js';
import { createXeroRouter } from './routes.js';
import { createXeroRuntime, requireXeroSettings, XERO_CALL_GUARD } from './runtime.js';
import { writesAllowed } from './settings.js';

// The Xero adapter (docs/XERO.md). FLOW_INTEGRATIONS=xero turns it on and
// XERO_MODE says which Xero it acts on. Its tables are created only while it
// is on (docs/INTEGRATIONS.md).

export const XERO_TABLES = Object.freeze(['xero_connections', 'xero_contacts', 'xero_items', 'xero_sync_runs', 'xero_invoice_pushes', 'xero_payment_cursors', 'xero_invoices', 'xero_credit_notes', 'xero_payments', 'xero_mirror_cursors', 'xero_call_guard', 'xero_calls', 'xero_webhook_events', 'xero_daily_checks']);

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
      'Optional, for changes in seconds: open the app\'s Webhooks page. Delivery URL: this installation\'s address plus /api/xero/webhooks. Tick Contacts and Invoices, and Credit notes when Xero offers it. Copy the webhook key into "Webhook key" below and save, then press Send "Intent to receive" in Xero.',
    ],
  },
  fields: [
    { name: 'XERO_MODE', label: 'Mode', kind: 'choice', choices: [{ value: 'live', label: 'Live: your Xero organisation' }, { value: 'sandbox', label: 'Sandbox: a Xero Demo Company' }] },
    { name: 'XERO_REDIRECT_URI', label: 'Redirect URI', kind: 'url', suggest: 'callback', help: 'Register the same address on the Xero app.' },
    { name: 'XERO_CLIENT_ID', label: 'Client id', help: 'From the Xero app\'s Configuration.' },
    { name: 'XERO_CLIENT_SECRET', label: 'Client secret', secret: true, help: 'Stored encrypted. Flow never shows it again.' },
    { name: 'XERO_TENANT_NAME', label: 'Xero organisation name', help: 'Live mode connects only the organisation with this exact name.' },
    { name: 'XERO_ALLOW_LIVE_WRITES', label: 'Create draft invoices in live Xero', kind: 'onoff', help: 'Off: Flow only reads from Xero.' },
    { name: 'XERO_WEBHOOK_KEY', label: 'Webhook key', secret: true, help: 'From the Xero app\'s Webhooks page. Empty: Flow reads Xero\'s changes every 15 minutes instead.' },
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
    // Every Xero call goes through this call guard (docs/INTEGRATIONS.md,
    // "Outbound calls").
    callGuard: XERO_CALL_GUARD,
    // `reconfigured` is true when a person saved the settings or turned Xero
    // on: that clears a halt, stopped resources and an open circuit.
    async start({ db, log, env, reconfigured = false }) {
      database = db;
      if (!given) runtime = createXeroRuntime({ settings: requireXeroSettings(env ?? process.env) });
      const { settings } = current();
      if (reconfigured) await current().guardFor(db).resume();
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
        const { rows } = await database.execute(sql`select organisation_id, tenant_id from xero_connections where mode = ${settings.mode}`);
        const guard = current().guardFor(database);
        const calls = await Promise.all(rows.map(async (r) => ({ tenantId: r.tenant_id, ...await guard.status(r.tenant_id) })));
        const stopped = calls.some((c) => c.circuit !== 'closed' || c.stoppedResources.length || c.failedToday >= c.dailyFailureBudget);
        // How fresh each copy of Xero is (lookup.js): a complete copy that is
        // not fresh stops drafts by rule (issue #131).
        const copies = await Promise.all(rows.map(async (r) => {
          const { complete, fresh, lastPassAt } = await mirrorState(database, r.organisation_id);
          return { tenantId: r.tenant_id, complete, fresh, lastPassAt };
        }));
        const stale = copies.some((c) => c.complete && !c.fresh);
        return { ok: !stopped && !stale, mode: settings.mode, writesAllowed: writesAllowed(settings), connected: rows.length, calls, copies };
      },
      // What only a person can clear, for the Integrations page
      // (server/core/alerts.js): a refused connection stops calls.
      async alerts({ organisationId }) {
        const connection = await readConnection(database, organisationId);
        if (!connection || connection.mode !== current().settings.mode) return [];
        return guardAlerts('Xero', await current().guardFor(database).status(connection.tenantId));
      },
      // One issued invoice to a Xero draft (drafts.js). The Flow invoice id
      // and version are the idempotency key.
      pushInvoice: ({ organisationId, invoiceId, pushedBy = null }) => pushInvoice(database, current(), { organisationId, invoiceId, pushedBy }),
      // Several issued invoices, in batches of MAX_BATCH (drafts.js).
      pushInvoices: ({ organisationId, invoiceIds, pushedBy = null }) => pushInvoices(database, current(), { organisationId, invoiceIds, pushedBy }),
      // What would stop each Flow draft in Xero, from Flow's copy (no calls).
      checkDrafts: ({ organisationId, invoiceIds }) => checkDrafts(database, current(), { organisationId, invoiceIds }),
      sendStatus: async ({ organisationId }) => {
        const { settings } = current();
        const connection = await readConnection(database, organisationId);
        return { connected: Boolean(connection && connection.mode === settings.mode), writesAllowed: writesAllowed(settings) };
      },
      // Sales invoice payments changed since `since` (ledger.js). The answer's
      // cursor is the next `since`.
      pullPayments: ({ organisationId, since }) => readPayments(database, current(), organisationId, { since: new Date(since) }),
      // Xero's invoice for one billable job, looked up live (ledger.js): the
      // `liveCheck` for draftInvoiceForObligation.
      checkInvoice: ({ organisationId, obligation }) => xeroLiveCheck(database, current(), organisationId)(obligation),
      // Active Xero contacts, from Flow's copy (lookup.js).
      listCustomers: ({ organisationId }) => listCustomers(database, organisationId),
      // Sales invoices from the mirror, with the mirror's state (lookup.js).
      findInvoices: ({ organisationId, ...query }) => findInvoices(database, organisationId, query),
      // Xero items, from Flow's copy, for the price list (lookup.js).
      listPriceItems: ({ organisationId }) => listPriceItems(database, organisationId, { taxTypes: current().settings.taxTypes }),
    },
    routes: ({ db, personAuth, log, messagePage }) => createXeroRouter({ db, personAuth, runtime: current(), log, messagePage }),
  };
}

export const xeroAdapter = createXeroAdapter();
