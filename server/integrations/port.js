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
  'pushInvoice', // send an issued invoice; the Flow record id is the idempotency key
  'pushBill', // send an approved bill; the Flow record id is the idempotency key
  'pullPayments', // payments since a cursor, matched to invoices and bills
  'health', // connection state for Settings
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
  }[reason];
  return { ok: false, code: 'integration_off', integration: adapter.id, reason, error };
}

export function defineAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('An adapter must be an object');
  }
  const { id, name, bundled = false, capabilities, schema, start, stop } = adapter;
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
  });
}

export function createRegistry({ log = console } = {}) {
  const adapters = new Map();
  const enabled = new Set();
  // Adapters whose tables this process created or found at start. An adapter
  // without a schema needs none, so it is ready as soon as it is enabled.
  const tablesReady = new Set();
  let started = false;
  const running = []; // adapters whose start() ran, in start order

  const state = (adapter) => {
    if (!enabled.has(adapter.id)) return 'disabled';
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
    enable(id) {
      if (!adapters.has(id)) throw new Error(`No adapter ${id}`);
      enabled.add(id);
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
        await adapter.start({ db, log });
        running.push(adapter);
      }
      return migrated;
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
    // The one way to read or write an adapter's tables: runs fn(adapter) when
    // the adapter is enabled and its tables are in place, and otherwise
    // returns the adapter's turned-off answer. A table removed by hand gives
    // the same answer rather than an error.
    async whenEnabled(id, fn) {
      const adapter = adapters.get(id);
      if (!adapter) throw new Error(`No adapter ${id}`);
      const now = state(adapter);
      if (now === 'disabled') return turnedOff(adapter, 'disabled');
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
