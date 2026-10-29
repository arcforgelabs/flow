import { guardAlerts } from '../call-guard.js';
import { createActReader } from './act.js';
import { createSeazonaClient } from './client.js';
import { listClients, listProducts, listWork, readBillableWork } from './feed.js';
import { historyJobIssues, historySummary, readHistoryWork } from './history/index.js';
import { readSeazonaSyncHealth, runSeazonaSync } from './lanes.js';
import { readBillableJobs } from './reconcile.js';
import { SEAZONA_CALL_GUARD } from './governor.js';
import { createSeazonaRouter } from './routes.js';
import {
  cancelStageMove, handOff, readPersonSettings, requestStageMove, settleStageMoves, waitingStageMoves, writePersonSetting,
} from './stage-moves.js';
import { orderPatient } from './patients.js';
import { createSeazonaScheduler } from './scheduler.js';
import { readSweepHealth } from './sweep.js';
import { resetFailedLanes, resetStoppedLanes } from './store.js';
import { describeSeazonaSettings, orderLink, resolveSeazonaSettings } from './settings.js';
import { seazonaSchema } from './tables.js';

// The Seazona adapter (docs/SEAZONA.md). FLOW_INTEGRATIONS=seazona turns it
// on and SEAZONA_MODE says which Seazona it acts on. Its tables are created
// only while it is on (docs/INTEGRATIONS.md). Core code never imports this
// file; it reaches the adapter through the registry.

// Seazona on with no mode, or a malformed setting, stops boot: the adapter
// never guesses which account it acts on (issue #10).
export function requireSeazonaSettings(env = process.env) {
  const settings = resolveSeazonaSettings(env);
  if (!settings.mode) {
    throw new Error('FLOW_INTEGRATIONS turns Seazona on, so SEAZONA_MODE must be "live", "sandbox" or "replay" (docs/SEAZONA.md)');
  }
  return settings;
}

// `env`, `fetchImpl`, `now` and `timers` are for tests. Otherwise start()
// reads the environment, so a turned-off adapter never reads its settings.
// What an owner enters in Settings, Integrations (server/integrations/setup.js).
export const SEAZONA_SETUP = {
  guide: {
    title: 'Get a Seazona API client',
    link: null,
    steps: [
      'In Seazona, create an API client for Flow. If you cannot find the option, ask Seazona support for API access.',
      'Copy the API address, the client id and the client secret.',
      'Paste them below, choose the mode, and turn Seazona on.',
      'Live mode starts the background sync. Flow only reads from Seazona.',
    ],
  },
  fields: [
    { name: 'SEAZONA_MODE', label: 'Mode', kind: 'choice', choices: [{ value: 'live', label: 'Live: your Seazona account' }, { value: 'sandbox', label: 'Sandbox: a Seazona test account' }] },
    { name: 'SEAZONA_API_BASE_URL', label: 'API address', kind: 'url', help: 'The API root of your account, https://…' },
    { name: 'SEAZONA_API_CLIENT_ID', label: 'Client id' },
    { name: 'SEAZONA_API_CLIENT_SECRET', label: 'Client secret', secret: true, help: 'Stored encrypted. Flow never shows it again.' },
    { name: 'SEAZONA_ORDER_URL', label: 'Order address', kind: 'url', help: 'Optional. Open any order in Seazona and paste its address here, or write {ref} where the order id goes. Stage moves on the Jobs board and Open in Seazona use it.' },
    { name: 'SEAZONA_KEEP_PATIENT_REFERENCE', label: 'Keep patient names', kind: 'onoff', help: 'On: Flow keeps the patient name of each job for the invoice Reference.' },
  ],
};

// What a person reads for each lane: the Seazona records it copies.
const READ_NAMES = {
  invoices: 'invoices',
  orders_recent: 'new orders',
  orders_active: 'open orders',
  clients: 'practices',
  products: 'products',
  users: 'lab users',
  history: 'past orders',
};
const readNames = (lanes) => lanes.map((lane) => READ_NAMES[lane.lane] ?? lane.lane).join(', ');

export function createSeazonaAdapter({ env = null, fetchImpl = null, now = Date.now, timers } = {}) {
  let runtime = null; // { settings, db, client, scheduler }
  const actReader = createActReader({ now });

  function current() {
    if (!runtime) throw new Error('The Seazona adapter has not started');
    return runtime;
  }

  return {
    id: 'seazona',
    name: 'Seazona',
    // VISION.md: Seazona is bundled and on in the dental preset.
    bundled: true,
    schema: seazonaSchema,
    setup: SEAZONA_SETUP,
    // The history import's routes (routes.js), under /api/seazona.
    routes: ({ db, personAuth, log }) => createSeazonaRouter({ db: runtime?.db ?? db, personAuth, settings: current().settings, log }),
    // Every Seazona call goes through this call guard, inside the rate
    // governor (governor.js; docs/INTEGRATIONS.md, "Outbound calls").
    callGuard: SEAZONA_CALL_GUARD,

    // `reconfigured` is true when a person saved the settings or turned
    // Seazona on (issue #101): that clears a halt after a refused API client,
    // closes the circuit, and runs every failed lane again. A plain start (a
    // restart or a new release) runs again only the lanes stopped by a
    // refused path; a halt still waits for a person.
    async start({ db, log = console, env: settingsEnv, reconfigured = false }) {
      const settings = requireSeazonaSettings(env ?? settingsEnv ?? process.env);
      const client = createSeazonaClient({ settings, db, fetchImpl: fetchImpl ?? undefined, workflow: 'seazona-sync', now });
      const at = new Date(Number(now()));
      if (reconfigured) {
        await client.governor?.resume();
        await resetFailedLanes(db, { at });
      } else {
        await resetStoppedLanes(db, { at });
      }
      const run = (options = {}) => runSeazonaSync(db, client, { settings, now, ...options });
      // The background sync starts in live mode only. A sandbox or replay
      // installation syncs only when someone asks (sync-once.js).
      const scheduler = settings.scheduled ? createSeazonaScheduler({ db, settings, run, now, log, timers }) : null;
      runtime = { settings, db, client, run, scheduler };
      scheduler?.start();
      log.info?.(`[seazona] mode ${settings.mode}; background sync ${scheduler ? 'on' : settings.mode === 'live' ? 'off (FLOW_BACKGROUND_JOBS)' : 'off (live mode only)'}; ${settings.rate.requestsPerMinute} requests a minute at most`);
    },

    async stop() {
      await runtime?.scheduler?.stop();
      runtime = null;
    },

    capabilities: {
      // Connection state for /health and Settings: the mode, the rate
      // governor, and each lane with its failing and quarantined orders.
      // It reads Flow's database only; it never calls Seazona.
      async health() {
        if (!runtime) return { ok: false, reason: 'not_started', ...describeSeazonaSettings(null) };
        const { settings, db, client, scheduler } = runtime;
        const sync = await readSeazonaSyncHealth(db, settings, { now });
        const schedulerStatus = scheduler ? scheduler.status() : null;
        return {
          ok: sync.ok && !schedulerStatus?.stuckSince,
          ...describeSeazonaSettings(settings),
          scheduler: schedulerStatus,
          governor: await client.governor.status(),
          ...sync,
          // Issue #141: today's reads before a draft or a send.
          readsBeforeAct: actReader.status(),
          history: await historySummary(db),
          sweep: await readSweepHealth(db, settings, { now }),
        };
      },

      // What only a person can clear, for the Integrations page
      // (server/core/alerts.js): a refused API client halts every call until
      // a person saves the settings. Reads Flow's database only.
      async alerts() {
        if (!runtime?.client.governor) return [];
        const status = await runtime.client.governor.status();
        const alerts = guardAlerts('Seazona', status, { fix: 'Check the API client in the Seazona settings, then save them.' });
        // Issue #143: what the lanes cannot fix by themselves. A refused API
        // client already has its own alert above, so it stops no lane here.
        if (!runtime.settings.scheduled) return alerts;
        const { lanes } = await readSeazonaSyncHealth(runtime.db, runtime.settings, { now });
        const stopped = status.haltedReason ? [] : lanes.filter((lane) => lane.status === 'stopped');
        if (stopped.length) {
          alerts.push({
            id: 'reads-stopped',
            tone: 'danger',
            title: `Seazona refused Flow's request for ${readNames(stopped)}. Flow stopped reading them. Check the Seazona settings, then save them.`,
            members: stopped.map((lane) => `${lane.lane}:${lane.lastAttemptAt ?? ''}`),
          });
        }
        const stale = lanes.filter((lane) => lane.stale && lane.status !== 'stopped');
        if (stale.length) {
          alerts.push({
            id: 'reads-late',
            tone: 'warn',
            title: `Flow has not read ${readNames(stale)} from Seazona on time. Jobs and invoices may show old Seazona data.`,
            members: stale.map((lane) => `${lane.lane}:${lane.lastSuccessAt ?? ''}`),
          });
        }
        return alerts;
      },

      // Billable work since a cursor: complete and shipped orders that
      // changed, with the Seazona invoice that carries each one. Orders
      // deleted in Seazona are never billable; they come back in `withdrawn`
      // so invoice preparation can drop them (issue #12).
      async pullWorkItems(cursor = null, options = {}) {
        return readBillableWork(current().db, { cursor, ...options });
      },

      // Read before act (issue #141): reads one order from Seazona now, and
      // answers it as the feed would (act.js). The only capability here that
      // calls Seazona on a person's or an automation's behalf.
      async readWorkItem({ sourceJobRef, purpose, personId }) {
        if (purpose === 'inspect') return actReader.inspect(current(), sourceJobRef, personId);
        return actReader.read(current(), sourceJobRef);
      },

      // Past work from the history import (docs/SEAZONA.md, "History
      // import"), as ledger jobs marked `historical`. Reads Flow's copy only.
      async pullHistoryJobs(cursor = null, options = {}) {
        return readHistoryWork(current().db, { cursor, ...options });
      },

      // Billable jobs by day, for the daily reconcile
      // (server/core/reconcile.js). Reads Flow's copy only.
      async billableJobs({ from = null, to = null } = {}) {
        return readBillableJobs(current().db, { from, to });
      },

      // Seazona clients by id and company name, for the identity map. Reads
      // Flow's copy only.
      async listCustomers() {
        return listClients(current().db);
      },

      // Open orders and orders finished lately, with their statuses, for the
      // Jobs board. Reads Flow's copy only.
      async listWork() {
        const { db } = current();
        await settleStageMoves(db, { now: now() });
        const [work, waiting] = await Promise.all([listWork(db, { now: now() }), waitingStageMoves(db)]);
        // A stage move Seazona has not made yet (stage-moves.js): the card
        // shows in its new lane, waiting for Seazona.
        // Each card also carries the link that opens its order in Seazona.
        const { settings } = current();
        for (const item of work.items) {
          item.link = orderLink(settings, { sourceJobRef: item.sourceJobRef });
          const move = waiting.get(item.sourceJobRef);
          if (move) {
            const { to, from, requestedAt, expiresAt, openUrl, openExact } = handOff(move, { settings });
            item.pendingMove = { to, from, requestedAt, expiresAt, openUrl, openExact };
          }
        }
        return work;
      },

      // A person's move of a job to another Seazona stage. Seazona's API
      // cannot change an order's status, so this never calls Seazona: it
      // records a hand-off and answers what the person does in Seazona.
      async moveWork({ sourceJobRef, toStatus, personId = null }) {
        const { db, settings } = current();
        return requestStageMove(db, { orderId: sourceJobRef, toStatus, personId, settings, now: now() });
      },

      async cancelMove({ sourceJobRef }) {
        return cancelStageMove(current().db, { orderId: sourceJobRef, now: now() });
      },

      // Each person's own Seazona choices: today, whether the board asks
      // before a stage move.
      async personSettings({ personId }) {
        return readPersonSettings(current().db, personId);
      },

      async setPersonSetting({ personId, key, value }) {
        return writePersonSetting(current().db, personId, { key, value }, { now: now() });
      },

      // The fields a job gives the invoice Reference: the patient name, when
      // this installation keeps patient names (patients.js).
      async jobReferenceFields({ sourceJobRef, read = false }) {
        const { db, client, settings } = current();
        return orderPatient({ db, client, settings, now }, sourceJobRef, { read });
      },

      // History jobs a person must decide, as issues on their job cards,
      // each with a link to the reconciliation. Reads Flow's copy only.
      async jobIssues({ refs = [] } = {}) {
        return historyJobIssues(current().db, refs);
      },

      // The link to one order in Seazona's web app, for "Open in Seazona" on
      // a job's problem (settings.js, orderLink). Never calls Seazona.
      jobLink({ sourceJobRef }) {
        return runtime ? orderLink(runtime.settings, { sourceJobRef }) : null;
      },

      // Seazona's products, for the price list (server/core/price-list.js).
      // Reads Flow's copy only.
      async listPriceItems() {
        return listProducts(current().db);
      },
    },
  };
}

export const seazonaAdapter = createSeazonaAdapter();
