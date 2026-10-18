import { createSeazonaClient } from './client.js';
import { readBillableWork } from './feed.js';
import { readSeazonaSyncHealth, runSeazonaSync } from './lanes.js';
import { createSeazonaScheduler } from './scheduler.js';
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
export function createSeazonaAdapter({ env = process.env, fetchImpl = null, now = Date.now, timers } = {}) {
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

    async start({ db, log = console }) {
      const settings = requireSeazonaSettings(env);
      const client = createSeazonaClient({ settings, db, fetchImpl: fetchImpl ?? undefined, workflow: 'seazona-sync', now });
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
    },
  };
}

export const seazonaAdapter = createSeazonaAdapter();
