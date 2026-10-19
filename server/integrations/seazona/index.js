import { createSeazonaClient } from './client.js';
import { listClients, listWork, readBillableWork } from './feed.js';
import { readSeazonaSyncHealth, runSeazonaSync } from './lanes.js';
import { orderPatient } from './patients.js';
import { createSeazonaScheduler } from './scheduler.js';
import { resetFailedLanes, resetStoppedLanes } from './store.js';
import { describeSeazonaSettings, resolveSeazonaSettings } from './settings.js';
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
    { name: 'SEAZONA_KEEP_PATIENT_REFERENCE', label: 'Keep patient names', kind: 'onoff', help: 'On: Flow keeps the patient name of each job for the invoice Reference.' },
  ],
};

export function createSeazonaAdapter({ env = null, fetchImpl = null, now = Date.now, timers } = {}) {
  let runtime = null; // { settings, db, client, scheduler }

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
      log.info?.(`[seazona] mode ${settings.mode}; background sync ${scheduler ? 'on' : 'off (live mode only)'}; ${settings.rate.requestsPerMinute} requests a minute at most`);
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
        return {
          ok: sync.ok,
          ...describeSeazonaSettings(settings),
          scheduler: scheduler ? scheduler.status() : null,
          governor: await client.governor.status(),
          ...sync,
        };
      },

      // Billable work since a cursor: complete and shipped orders that
      // changed, with the Seazona invoice that carries each one. Orders
      // deleted in Seazona are never billable; they come back in `withdrawn`
      // so invoice preparation can drop them (issue #12).
      async pullWorkItems(cursor = null, options = {}) {
        return readBillableWork(current().db, { cursor, ...options });
      },

      // Seazona clients by id and company name, for the identity map. Reads
      // Flow's copy only.
      async listCustomers() {
        return listClients(current().db);
      },

      // Open orders and orders finished lately, with their statuses, for the
      // Jobs board. Reads Flow's copy only.
      async listWork() {
        return listWork(current().db, { now: now() });
      },

      // The fields a job gives the invoice Reference: the patient name, when
      // this installation keeps patient names (patients.js).
      async jobReferenceFields({ sourceJobRef, read = false }) {
        const { db, client, settings } = current();
        return orderPatient({ db, client, settings, now }, sourceJobRef, { read });
      },
    },
  };
}

export const seazonaAdapter = createSeazonaAdapter();
