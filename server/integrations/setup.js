import { eq, sql } from 'drizzle-orm';
import express from 'express';
import { FlowError } from '../core/errors.js';
import { deriveKey, openSecret, sealSecret } from '../core/secrets.js';
import { integrationSettingEvents, integrationSettings, organisations } from '../db/schema.js';

// Integration setup in Settings (docs/INTEGRATIONS.md, "Set up in Flow"). An
// owner turns an integration on and enters its settings in the app; no one
// edits the host's secrets. Plain settings are stored by their environment
// name; credentials are sealed with Flow's secrets key. Each adapter reads
// the result as its environment: the host's own environment wins, then the
// stored settings, then each derived key. A change applies at once
// (registry.reconfigure), without a restart.

const MAX_VALUE = 2000;
const ONOFF = ['on', 'off'];
const context = (adapterId, name) => `integration:${adapterId}:${name}`;

const hostValue = (env, name) => String(env[name] ?? '').trim();

export async function readStoredSettings(db) {
  const rows = await db.select().from(integrationSettings);
  return new Map(rows.map((row) => [row.adapterId, row]));
}

// The ids the host turns on (FLOW_INTEGRATIONS) and the ids an owner turned
// on in Settings.
export function hostEnabled(env) {
  return new Set((env.FLOW_INTEGRATIONS ?? '').split(',').map((id) => id.trim().toLowerCase()).filter(Boolean));
}

// Builds the environment the adapters read: the stored settings, then the
// host's environment over them. A credential that cannot be opened (the key
// changed) is left out and reported. Never logs a value.
export function settingsEnvironment({ env, stored, adapters, secrets }) {
  const merged = {};
  const unreadable = [];
  for (const adapter of adapters) {
    const row = stored.get(adapter.id);
    if (!adapter.setup) continue;
    for (const field of adapter.setup.fields) {
      if (field.secret) {
        const sealed = row?.secrets?.[field.name];
        if (!sealed) continue;
        try {
          merged[field.name] = openSecret(secrets, sealed, context(adapter.id, field.name));
        } catch {
          unreadable.push(`${adapter.id}:${field.name}`);
        }
      } else if (row?.config?.[field.name] != null) {
        merged[field.name] = String(row.config[field.name]);
      }
    }
    if (secrets) {
      for (const name of adapter.setup.derivedKeys ?? []) merged[name] = deriveKey(secrets, name).toString('hex');
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (value != null && String(value).trim() !== '') merged[name] = value;
  }
  return { env: merged, unreadable };
}

// The adapters an owner turned on in Settings and the host does not.
export function storedEnabled(stored, env) {
  const host = hostEnabled(env);
  return [...stored.values()].filter((row) => row.enabled && !host.has(row.adapterId)).map((row) => row.adapterId);
}

// What Settings shows for one adapter. A credential shows only whether it
// is set and where from; never its value.
export function describeSetup({ adapter, row, env, secrets, entry, unreadable = [] }) {
  const host = hostEnabled(env);
  const fields = adapter.setup.fields.map((field) => {
    const fromHost = hostValue(env, field.name) !== '';
    const base = {
      name: field.name,
      label: field.label,
      kind: field.kind ?? 'text',
      secret: Boolean(field.secret),
      help: field.help ?? null,
      choices: field.choices ?? null,
      suggest: field.suggest ?? null,
      default: field.default ?? null,
      advanced: Boolean(field.advanced),
      source: fromHost ? 'host' : null,
    };
    if (field.secret) {
      const storedHere = Boolean(row?.secrets?.[field.name]);
      return {
        ...base,
        set: fromHost || (storedHere && !unreadable.includes(`${adapter.id}:${field.name}`)),
        source: fromHost ? 'host' : storedHere ? 'flow' : null,
        unreadable: !fromHost && unreadable.includes(`${adapter.id}:${field.name}`),
      };
    }
    const value = fromHost ? hostValue(env, field.name) : (row?.config?.[field.name] ?? null);
    return { ...base, value, source: fromHost ? 'host' : value != null ? 'flow' : null };
  });
  return {
    ...(adapter.capabilities?.listWork ? { twoWaySync: { enabled: false, supported: false } } : {}),
    id: adapter.id,
    name: adapter.name,
    enabled: entry?.enabled ?? false,
    enabledBy: host.has(adapter.id) ? 'host' : row?.enabled ? 'flow' : null,
    state: entry?.state ?? 'disabled',
    error: entry?.error ?? null,
    guide: adapter.setup.guide,
    fields,
    updatedAt: row?.updatedAt ?? null,
  };
}

function checkValue(field, value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new FlowError('invalid', `${field.label} must be text`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_VALUE) throw new FlowError('invalid', `${field.label} is too long`);
  if (field.kind === 'choice' && !field.choices.some((c) => c.value === trimmed)) {
    throw new FlowError('invalid', `${field.label} must be one of ${field.choices.map((c) => c.value).join(', ')}`);
  }
  if (field.kind === 'onoff' && !ONOFF.includes(trimmed)) throw new FlowError('invalid', `${field.label} must be on or off`);
  if (field.kind === 'url') {
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw new FlowError('invalid', `${field.label} must be an address that starts with https://`);
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new FlowError('invalid', `${field.label} must start with https://`);
  }
  if (field.secret && /\s/.test(trimmed)) throw new FlowError('invalid', `${field.label} must be one value with no spaces`);
  return trimmed;
}

// Stores an owner's change: `enabled` (optional) and `values` by setting
// name (null removes one). Answers the event kinds written.
export async function saveSettings(db, { adapter, secrets, actor, enabled, values = {} }) {
  if (!adapter.setup) throw new FlowError('invalid', `${adapter.name} has no settings here`);
  const byName = new Map(adapter.setup.fields.map((f) => [f.name, f]));
  const unknown = Object.keys(values).filter((name) => !byName.has(name));
  if (unknown.length) throw new FlowError('invalid', `unknown setting: ${unknown.join(', ')}`);
  const checked = Object.entries(values).map(([name, value]) => [byName.get(name), checkValue(byName.get(name), value)]);
  if (checked.some(([field, value]) => field.secret && value !== null) && !secrets) {
    throw new FlowError('secrets_key_missing', 'Flow has no secrets key. Set FLOW_SECRETS_KEY (or SESSION_SECRET) on the host, then restart.');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`integration_settings:${adapter.id}`}, 0))`);
    const [row] = await tx.select().from(integrationSettings).where(eq(integrationSettings.adapterId, adapter.id));
    const config = { ...(row?.config ?? {}) };
    const sealed = { ...(row?.secrets ?? {}) };
    const events = [];
    const changed = [];
    for (const [field, value] of checked) {
      if (field.secret) {
        if (value === null) {
          if (sealed[field.name]) { delete sealed[field.name]; events.push({ kind: 'secret_removed', settings: [field.name] }); }
        } else {
          sealed[field.name] = sealSecret(secrets, value, context(adapter.id, field.name));
          events.push({ kind: 'secret_set', settings: [field.name] });
        }
      } else if ((config[field.name] ?? null) !== value) {
        if (value === null) delete config[field.name];
        else config[field.name] = value;
        changed.push(field.name);
      }
    }
    if (changed.length) events.push({ kind: 'setting_changed', settings: changed });
    const on = enabled ?? row?.enabled ?? false;
    if (enabled !== undefined && enabled !== (row?.enabled ?? false)) events.push({ kind: enabled ? 'turned_on' : 'turned_off', settings: [] });
    await tx.insert(integrationSettings)
      .values({ adapterId: adapter.id, enabled: on, config, secrets: sealed, updatedBy: actor })
      .onConflictDoUpdate({
        target: integrationSettings.adapterId,
        set: { enabled: on, config, secrets: sealed, updatedBy: actor, updatedAt: sql`now()` },
      });
    for (const event of events) {
      await tx.insert(integrationSettingEvents).values({ adapterId: adapter.id, actor, ...event });
    }
    return events.map((e) => e.kind);
  });
}

// GET /api/integrations (owner): every adapter with settings, its state and
// what is set. PUT /api/integrations/:id (owner): save and apply.
export function createSetupRouter({ db, registry, personAuth, secrets, baseEnv = process.env, log = console }) {
  const router = express.Router();
  const owner = [personAuth.requireSession, personAuth.requireRole('owner')];
  // A change needs a verified owner sign-in, as connecting Xero does.
  const verifiedOwner = [personAuth.requireSession, personAuth.requireOwner];

  const describeAll = async () => {
    const stored = await readStoredSettings(db);
    const adapters = registry.list().filter((entry) => registry.get(entry.id).setup);
    const { unreadable } = settingsEnvironment({ env: {}, stored, adapters: adapters.map((e) => registry.get(e.id)), secrets });
    return adapters.map((entry) => describeSetup({
      adapter: registry.get(entry.id), row: stored.get(entry.id), env: baseEnv, secrets, entry, unreadable,
    }));
  };

  router.get('/', ...owner, async (_req, res, next) => {
    try {
      const labs = await db.select({ id: organisations.id, name: organisations.name }).from(organisations);
      res.json({ ok: true, secretsKey: secrets ? { source: secrets.source, id: secrets.id } : null, organisations: labs, integrations: await describeAll() });
    } catch (error) { next(error); }
  });

  router.put('/:id', ...verifiedOwner, express.json({ limit: '32kb' }), async (req, res) => {
    const adapter = registry.get(req.params.id);
    if (!adapter?.setup) return res.status(404).json({ ok: false, code: 'not_found', error: 'No such integration' });
    try {
      const { enabled, values } = req.body ?? {};
      if (enabled !== undefined && typeof enabled !== 'boolean') throw new FlowError('invalid', 'enabled must be true or false');
      if (enabled === false && hostEnabled(baseEnv).has(adapter.id)) {
        throw new FlowError('invalid', `${adapter.name} is turned on by the host (FLOW_INTEGRATIONS). Turn it off there.`);
      }
      const events = await saveSettings(db, { adapter, secrets, actor: req.person.id, enabled, values: values ?? {} });
      const stored = await readStoredSettings(db);
      const { env } = settingsEnvironment({ env: baseEnv, stored, adapters: [...registry.list().map((e) => registry.get(e.id))], secrets });
      const on = hostEnabled(baseEnv).has(adapter.id) || Boolean(stored.get(adapter.id)?.enabled);
      const state = await registry.reconfigure(adapter.id, { enabled: on, env });
      log.info?.(`[integrations] ${adapter.id} settings changed by person ${req.person.id} (${events.join(', ') || 'no change'}); now ${state}`);
      const entry = registry.list().find((e) => e.id === adapter.id);
      const { unreadable } = settingsEnvironment({ env: {}, stored, adapters: [adapter], secrets });
      return res.json({ ok: true, integration: describeSetup({ adapter, row: stored.get(adapter.id), env: baseEnv, secrets, entry, unreadable }) });
    } catch (error) {
      if (error instanceof FlowError) {
        return res.status(error.code === 'secrets_key_missing' ? 409 : 400).json({ ok: false, code: error.code, error: error.message });
      }
      log.error?.(`[integrations] saving ${adapter.id} settings failed: ${error.message}`);
      return res.status(500).json({ ok: false, code: 'error', error: 'Saving the settings failed.' });
    }
  });

  return router;
}
