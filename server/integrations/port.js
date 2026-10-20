// The integration port: the one contract between the Flow core and every
// adapter (Seazona, Xero, and later ones). The core calls only the
// capabilities an adapter declares, and never imports an adapter directly.
// VISION.md, "The core and its integrations".
//
// An adapter owns its tables. It declares them in `schema` with its own
// migrations, and Flow creates them only while the adapter is enabled
// (server/integrations/schema.js). docs/INTEGRATIONS.md has the rules.

import { isMissingTable, migrateAdapterSchema } from './schema.js';

export const CAPABILITIES = Object.freeze([
  'pullWorkItems', // billable work since a cursor (Seazona: completed cases)
  'readWorkItem', // { state: read | withdrawn | unavailable }: one job read from the work system now, as pullWorkItems gives it (read before act, server/core/read-before-act.js)
  'pullHistoryJobs', // past work from a history import, as ledger jobs marked historical (Seazona: its API backfill)
  'pushInvoice', // send an issued invoice; the Flow record id is the idempotency key
  'pushInvoices', // send several issued invoices in one pass (Send all ready, server/core/sending.js)
  'checkDrafts', // the accounting system's problems with Flow drafts, from its copy; null while not connected
  'documentFacts', // what the customer's copy of a sent invoice says (number, reference, dates), from the system's copy in Flow; never a live call
  'sendStatus', // { connected, writesAllowed }: may Flow send invoices now?
  'pushBill', // send an approved bill; the Flow record id is the idempotency key
  'pullPayments', // payments since a cursor, matched to invoices and bills
  'checkInvoice', // does the accounting system hold an invoice for a billable job? (the ledger's liveCheck)
  'billableJobs', // billable jobs by day from the work system's copy in Flow, for the daily reconcile; never a live call
  'jobReferenceFields', // { patient }: the fields a job gives the invoice Reference (server/core/references.js)
  'listWork', // the work system's jobs from its copy in Flow, open and lately finished, for the Jobs board
  'jobIssues', // open issues the integration holds for jobs, by job ref: a short phrase and the page where a person fixes it
  'listCustomers', // the system's customers, by id and name, for the identity map (Seazona: clients; Xero: contacts)
  'findInvoices', // sales invoices in the accounting system's copy, for the matcher; never a live call
  'listPriceItems', // the system's own price list from its copy in Flow, for the price list's links and check; never a live call
  'health', // connection state for Settings
  'alerts', // what only a person can clear (a refused sign-in, stopped calls), for the Integrations page; reads Flow's data only
  'captureError', // an error Flow logged, sent to the installation's own error service (Sentry)
  'browserMonitoring', // the public settings a browser needs to report errors and problems to that service
]);

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const TABLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

// An adapter's tables start with its id (dashes become underscores), so they
// can never collide with the core's or another adapter's.
export function tablePrefix(id) {
  return `${id.replaceAll('-', '_')}_`;
}

function defineSchema(id, schema) {
  if (schema === undefined || schema === null) return null;
  const { migrationsFolder, tables } = schema;
  if (typeof migrationsFolder !== 'string' || migrationsFolder === '') {
    throw new TypeError(`Adapter ${id} schema needs a migrationsFolder`);
  }
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new TypeError(`Adapter ${id} schema must list its tables`);
  }
  const prefix = tablePrefix(id);
  for (const table of tables) {
    if (typeof table !== 'string' || !TABLE_PATTERN.test(table) || !table.startsWith(prefix)) {
      throw new TypeError(`Adapter ${id} table ${table} must be a lower-case name that starts with ${prefix}`);
    }
  }
  return Object.freeze({ migrationsFolder, tables: Object.freeze([...new Set(tables)]) });
}

// What code gets when it asks for an adapter that is off, instead of an error
// from a table that does not exist. `reason` is `disabled` (turned off),
// `restart_needed` (turned on after this start: its tables come at the next
// start) or `tables_missing` (its tables were removed by hand).
export function turnedOff(adapter, reason = 'disabled') {
  const error = {
    disabled: `${adapter.name} is turned off on this installation.`,
    restart_needed: `${adapter.name} was turned on after Flow started. Restart Flow to finish turning it on.`,
    tables_missing: `${adapter.name} has no tables on this installation. Restart Flow to create them.`,
    failed: `${adapter.name} could not start. An owner can check its settings in Settings, Integrations.`,
  }[reason];
  return { ok: false, code: 'integration_off', integration: adapter.id, reason, error };
}

export function defineAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('An adapter must be an object');
  }
  const { id, name, bundled = false, capabilities, schema, start, stop, routes, setup, callGuard } = adapter;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TypeError(`Adapter id must match ${ID_PATTERN}`);
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError(`Adapter ${id} needs a name`);
  }
  if (!capabilities || typeof capabilities !== 'object') {
    throw new TypeError(`Adapter ${id} declares no capabilities`);
  }
  for (const [key, fn] of Object.entries(capabilities)) {
    if (!CAPABILITIES.includes(key)) {
      throw new TypeError(`Adapter ${id} declares unknown capability ${key}`);
    }
    if (typeof fn !== 'function') {
      throw new TypeError(`Adapter ${id} capability ${key} must be a function`);
    }
  }
  if (typeof capabilities.health !== 'function') {
    throw new TypeError(`Adapter ${id} must declare health`);
  }
  for (const [hook, fn] of Object.entries({ start, stop })) {
    if (fn !== undefined && typeof fn !== 'function') {
      throw new TypeError(`Adapter ${id} ${hook} must be a function`);
    }
  }
  if (routes !== undefined && typeof routes !== 'function') {
    throw new TypeError(`Adapter ${id} routes must be a function that returns a router`);
  }
  if (setup !== undefined && (!setup || !Array.isArray(setup.fields))) {
    throw new TypeError(`Adapter ${id} setup must list its fields`);
  }
  for (const field of setup?.fields ?? []) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(field?.name ?? '') || !field.label) {
      throw new TypeError(`Adapter ${id} setup field ${field?.name} needs an upper-case setting name and a label`);
    }
  }
  if (callGuard !== undefined && callGuard !== null) {
    const { integration, tables } = callGuard;
    if (integration !== id || !tables?.state || !tables?.calls) {
      throw new TypeError(`Adapter ${id} callGuard must name integration ${id} and its tables.state and tables.calls`);
    }
    const owned = new Set(schema?.tables ?? []);
    if (!owned.has(tables.state) || !owned.has(tables.calls)) {
      throw new TypeError(`Adapter ${id} callGuard tables must be among its own schema tables`);
    }
  }
  return Object.freeze({
    id,
    name,
    bundled: Boolean(bundled),
    capabilities: Object.freeze({ ...capabilities }),
    schema: defineSchema(id, schema),
    // Optional lifecycle: start({ db, log }) runs once at server start, after
    // the adapter's tables are in place, and only while it is enabled; it is
    // where an adapter keeps its database handle and starts background work.
    // stop() ends that work (tests, shutdown).
    start: start ?? null,
    stop: stop ?? null,
    // The call guard (./call-guard.js) every outbound call goes through: the
    // integration id, its two tables, and its policy. An adapter that calls
    // an outside system declares it (docs/INTEGRATIONS.md, "Outbound calls").
    callGuard: callGuard ? Object.freeze({ ...callGuard }) : null,
    // Optional HTTP routes: routes({ db, personAuth, log, messagePage }) returns a router
    // mounted at /api/<id> (registry.routes).
    routes: routes ?? null,
    // Optional: the settings an owner may enter in Settings, Integrations
    // (server/integrations/setup.js). `fields` name environment settings;
    // `derivedKeys` name key settings Flow derives from its secrets key.
    setup: setup ? Object.freeze({ fields: Object.freeze(setup.fields.map((f) => Object.freeze({ ...f }))), derivedKeys: Object.freeze([...(setup.derivedKeys ?? [])]), guide: setup.guide ?? null }) : null,
  });
}

export function createRegistry({ log = console, env = process.env } = {}) {
  const adapters = new Map();
  const enabled = new Set();
  // Adapters turned on in Settings, not by the host: one that cannot start
  // is reported, and Flow starts without it.
  const optional = new Set();
  const failures = new Map(); // id -> message
  const generation = new Map(); // id -> count of (re)starts, for its router
  const routers = new Map(); // id -> { generation, router }
  let settingsEnv = env;
  let database = null;
  // Adapters whose tables this process created or found at start. An adapter
  // without a schema needs none, so it is ready as soon as it is enabled.
  const tablesReady = new Set();
  let started = false;
  const running = []; // adapters whose start() ran, in start order

  const state = (adapter) => {
    if (!enabled.has(adapter.id)) return 'disabled';
    if (failures.has(adapter.id)) return 'failed';
    if (!adapter.schema || tablesReady.has(adapter.id)) return 'ready';
    return started ? 'restart_needed' : 'not_started';
  };
  const ready = (adapter) => state(adapter) === 'ready';

  return {
    register(adapter) {
      const defined = defineAdapter(adapter);
      if (adapters.has(defined.id)) {
        throw new Error(`Adapter ${defined.id} is already registered`);
      }
      adapters.set(defined.id, defined);
      return defined;
    },
    enable(id, { optional: isOptional = false } = {}) {
      if (!adapters.has(id)) throw new Error(`No adapter ${id}`);
      enabled.add(id);
      if (isOptional) optional.add(id);
      else optional.delete(id);
    },
    // Turning an adapter off never drops its tables. Removing them is a
    // separate step (removeAdapterTables in server/integrations/schema.js).
    disable(id) {
      enabled.delete(id);
    },
    // Runs once at server start, after the core migrations: creates the
    // tables of every enabled adapter and nothing else, then calls each
    // enabled adapter's start({ db, log }). An adapter turned on later gets
    // its tables at the next start. Returns the ids it migrated.
    async start(db) {
      if (started) throw new Error('The integration registry has already started');
      started = true;
      database = db;
      const migrated = [];
      for (const id of enabled) {
        const adapter = adapters.get(id);
        if (!adapter.schema) continue;
        await migrateAdapterSchema(db, adapter);
        tablesReady.add(id);
        migrated.push(id);
      }
      for (const id of enabled) {
        const adapter = adapters.get(id);
        if (!adapter.start) continue;
        try {
          await adapter.start({ db, log, env: settingsEnv });
        } catch (error) {
          if (!optional.has(id)) throw error;
          failures.set(id, error.message);
          log.error?.(`[integrations] ${id} could not start: ${error.message}`);
          continue;
        }
        running.push(adapter);
      }
      return migrated;
    },
    // Applies new settings to one adapter while Flow runs: stops it, then,
    // when it stays on, creates its tables and starts it with `env`. Its
    // routes are built again on the next request. A start that fails leaves
    // it `failed` with the reason, and the rest of Flow running.
    async reconfigure(id, { enabled: on, env: next }) {
      const adapter = adapters.get(id);
      if (!adapter) throw new Error(`No adapter ${id}`);
      if (!started) throw new Error('The integration registry has not started');
      if (next) settingsEnv = next;
      const index = running.indexOf(adapter);
      if (index >= 0) {
        running.splice(index, 1);
        await adapter.stop?.();
      }
      failures.delete(id);
      generation.set(id, (generation.get(id) ?? 0) + 1);
      if (!on) {
        enabled.delete(id);
        return state(adapter);
      }
      enabled.add(id);
      optional.add(id);
      try {
        if (adapter.schema && !tablesReady.has(id)) {
          await migrateAdapterSchema(database, adapter);
          tablesReady.add(id);
        }
        if (adapter.start) {
          // A person changed the settings: an adapter may clear a stop that
          // waits for a person (issue #101).
          await adapter.start({ db: database, log, env: settingsEnv, reconfigured: true });
          running.push(adapter);
        }
      } catch (error) {
        failures.set(id, error.message);
        log.error?.(`[integrations] ${id} could not start: ${error.message}`);
      }
      return state(adapter);
    },
    get(id) {
      return adapters.get(id) ?? null;
    },
    // Why an enabled adapter is not running, or null. The message names
    // settings, never their values.
    failure(id) {
      return failures.get(id) ?? null;
    },
    env() {
      return settingsEnv;
    },
    // Calls stop() on every adapter whose start() ran, newest first.
    async stop() {
      while (running.length) {
        const adapter = running.pop();
        await adapter.stop?.();
      }
    },
    list() {
      return [...adapters.values()].map((a) => ({
        id: a.id,
        name: a.name,
        bundled: a.bundled,
        enabled: enabled.has(a.id),
        state: state(a),
        tables: a.schema ? [...a.schema.tables] : [],
        ...(failures.has(a.id) ? { error: failures.get(a.id) } : {}),
        capabilities: Object.keys(a.capabilities),
      }));
    },
    // The enabled adapters, with their tables in place, that declare one
    // capability. The core fans out to these and nothing else, so a disabled
    // adapter changes nothing.
    with(capability) {
      if (!CAPABILITIES.includes(capability)) {
        throw new TypeError(`Unknown capability ${capability}`);
      }
      return [...enabled]
        .map((id) => adapters.get(id))
        .filter((a) => ready(a) && typeof a.capabilities[capability] === 'function');
    },
    // The adapters' own HTTP routes, each under /api/<id>. `context` is
    // { db, personAuth, log, messagePage }. An enabled, ready adapter's router is built
    // once, here; a request to an adapter that is off gets its turned-off
    // answer (503), so a turned-off adapter never reads its settings or
    // tables.
    routes(context) {
      return [...adapters.values()].filter((a) => a.routes).map((adapter) => {
        const path = `/api/${adapter.id}`;
        const handler = (req, res, next) => {
          const now = state(adapter);
          if (now !== 'ready') {
            const reason = now === 'disabled' || now === 'failed' ? now : 'restart_needed';
            return res.status(503).json(turnedOff(adapter, reason));
          }
          const current = generation.get(adapter.id) ?? 0;
          let built = routers.get(adapter.id);
          if (!built || built.generation !== current) {
            built = { generation: current, router: adapter.routes(context) };
            routers.set(adapter.id, built);
          }
          return built.router(req, res, next);
        };
        return { path, handler };
      });
    },
    // The one way to read or write an adapter's tables: runs fn(adapter) when
    // the adapter is enabled and its tables are in place, and otherwise
    // returns the adapter's turned-off answer. A table removed by hand gives
    // the same answer rather than an error.
    async whenEnabled(id, fn) {
      const adapter = adapters.get(id);
      if (!adapter) throw new Error(`No adapter ${id}`);
      const now = state(adapter);
      if (now === 'disabled' || now === 'failed') return turnedOff(adapter, now);
      if (now !== 'ready') return turnedOff(adapter, 'restart_needed');
      try {
        return await fn(adapter);
      } catch (error) {
        if (adapter.schema && isMissingTable(error)) {
          log.error?.(`[integrations] ${id}: ${error.message}`);
          return turnedOff(adapter, 'tables_missing');
        }
        throw error;
      }
    },
  };
}
