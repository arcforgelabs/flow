import { createCallGuard } from '../call-guard.js';
import { createXeroClient, xeroError } from './client.js';
import { decryptToken, readConnection, storeRotatedToken } from './connections.js';
import { createGovernor } from './governor.js';
import { createStateStore, refreshTokens } from './oauth.js';
import { createReplayFetch, DEFAULT_REPLAY_FIXTURES, loadReplayFixtures } from './replay.js';
import { resolveXeroSettings, writesAllowed } from './settings.js';

// The Xero adapter's state for one Flow process: settings, the rate-limit
// governor, the call guard (its state is in PostgreSQL), the transport (real
// fetch, or replay), OAuth states, and the access tokens in memory. Access
// tokens live 30 minutes and are never stored; the refresh token is stored
// sealed (connections.js).

// The call guard's tables and policy (../call-guard.js, docs/XERO.md). A 401
// or 403 that a fresh token does not clear stops only the resource it came
// from: a connection can lack one scope (payments) and still serve the rest.
// A refused token refresh halts every call.
export const XERO_CALL_GUARD = Object.freeze({
  integration: 'xero',
  name: 'Xero',
  tables: Object.freeze({ state: 'xero_call_guard', calls: 'xero_calls' }),
  policy: Object.freeze({ authStops: 'resource' }),
});

export function requireXeroSettings(env = process.env) {
  const settings = resolveXeroSettings(env);
  if (!settings) {
    throw new Error('FLOW_INTEGRATIONS turns Xero on, so XERO_MODE must be "live", "sandbox" or "replay" (docs/XERO.md)');
  }
  return settings;
}

export function createXeroRuntime({ settings, fetch, now = Date.now, log = console } = {}) {
  if (!settings) throw new TypeError('createXeroRuntime: settings are required');
  const transport = fetch
    ?? (settings.mode === 'replay' ? createReplayFetch(loadReplayFixtures(settings.replayFixtures ?? DEFAULT_REPLAY_FIXTURES)) : globalThis.fetch);
  const governor = createGovernor({
    config: { dayLimit: settings.dayLimit, usageWarningFraction: settings.usageWarningFraction },
    now,
    log,
  });
  const states = createStateStore({ now });
  const accessTokens = new Map(); // organisation id -> { token, expiresAt }
  const refreshing = new Map(); // organisation id -> promise
  const queues = new Map(); // organisation id -> tail of its work queue
  const guards = new WeakMap(); // database handle -> call guard

  // The call guard for one database. Keyed by the Xero tenant id: Xero's
  // limits are per organisation.
  function guardFor(db) {
    if (!guards.has(db)) guards.set(db, createCallGuard({ db, ...XERO_CALL_GUARD, now, log }));
    return guards.get(db);
  }

  // Runs heavy Xero work for one organisation one at a time, in order: a
  // sync and a batch of drafts draw on the same call budget, and running them
  // together only buys 429s.
  function serial(organisationId, fn) {
    const run = (queues.get(organisationId) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    queues.set(organisationId, tail);
    tail.then(() => {
      if (queues.get(organisationId) === tail) queues.delete(organisationId);
    });
    return run;
  }

  function remember(organisationId, tokens) {
    const seconds = Number(tokens.expires_in) || 1800;
    accessTokens.set(organisationId, { token: tokens.access_token, expiresAt: now() + Math.max(5, seconds - 60) * 1000 });
  }

  // A stored connection made in another mode is not used: a sandbox
  // connection never serves live, and the other way round.
  function usable(connection) {
    if (!connection) {
      throw xeroError('xero_not_connected', 'Xero is not connected. An owner must connect Xero first.', { status: 409 });
    }
    if (connection.mode !== settings.mode) {
      throw xeroError('xero_mode_changed', `Xero was connected in ${connection.mode} mode, and XERO_MODE is now ${settings.mode}. An owner must connect Xero again.`, { status: 409 });
    }
    if (settings.tenantId && connection.tenantId !== settings.tenantId) {
      throw xeroError('xero_wrong_organisation', 'The connected Xero organisation is not the one XERO_TENANT_ID names. An owner must connect Xero again.', { status: 409 });
    }
    return connection;
  }

  // Refresh under a row lock, and store the rotated refresh token in the same
  // transaction, so two refreshes never race and the newest token is kept.
  // A refresh Xero refuses for good halts every call until an owner connects
  // again or saves the settings; another failed refresh counts as a failed
  // call.
  async function refresh(db, organisationId) {
    const guard = guardFor(db);
    return db.transaction(async (tx) => {
      const connection = usable(await readConnection(tx, organisationId, { lock: true }));
      await guard.check(connection.tenantId, { resource: 'token' });
      const refreshToken = decryptToken(connection.refreshTokenEnc, settings.tokenKey, organisationId);
      let tokens;
      try {
        tokens = await refreshTokens(settings, transport, refreshToken);
      } catch (error) {
        // invalid_grant: the connection is gone. invalid_client: the app's
        // client id or secret is wrong. Neither clears without a person.
        if (error?.code === 'xero_reconnect_needed' || ['invalid_client', 'unauthorized_client'].includes(error?.oauthError)) {
          await guard.halt(connection.tenantId, 'auth', { detail: `Xero refused the token refresh${error.oauthError ? ` (${error.oauthError})` : ''}` });
        } else if (error?.code !== 'xero_replay_no_match') {
          await guard.record(connection.tenantId, { resource: 'token', failureKind: error?.code === 'xero_unreachable' ? 'network' : 'token_refresh' });
        }
        throw error;
      }
      await guard.record(connection.tenantId, { resource: 'token', statusCode: 200 });
      await storeRotatedToken(tx, organisationId, { refreshToken: tokens.refresh_token, scope: tokens.scope, key: settings.tokenKey });
      remember(organisationId, tokens);
      return tokens.access_token;
    });
  }

  async function accessToken(db, organisationId) {
    const cached = accessTokens.get(organisationId);
    if (cached && cached.expiresAt > now()) return cached.token;
    if (!refreshing.has(organisationId)) {
      refreshing.set(organisationId, refresh(db, organisationId).finally(() => refreshing.delete(organisationId)));
    }
    return refreshing.get(organisationId);
  }

  // A client for one Flow organisation's connected Xero.
  async function clientFor(db, organisationId) {
    const connection = usable(await readConnection(db, organisationId));
    const client = createXeroClient({
      tenantId: connection.tenantId,
      accessToken: () => accessToken(db, organisationId),
      invalidateAccessToken: () => accessTokens.delete(organisationId),
      fetch: transport,
      governor,
      guard: guardFor(db),
      apiBase: settings.endpoints.api,
      log,
    });
    return { client, connection };
  }

  // A sandbox acts only on a Xero Demo Company: Flow proves it before it
  // connects and before every write, and fails closed if it cannot.
  async function assertEnvironment(client) {
    if (settings.mode !== 'sandbox') return;
    const organisation = await client.getOrganisation();
    if (organisation?.Class !== 'DEMO') {
      throw xeroError('xero_not_demo', 'XERO_MODE=sandbox acts only on a Xero Demo Company, and this organisation is not one.', { status: 409 });
    }
  }

  function assertWritesAllowed() {
    if (!writesAllowed(settings)) {
      throw xeroError('xero_writes_off', 'XERO_MODE=live writes to Xero only when XERO_ALLOW_LIVE_WRITES=on.', { status: 409 });
    }
  }

  return {
    settings,
    transport,
    governor,
    guardFor,
    states,
    remember,
    forget: (organisationId) => accessTokens.delete(organisationId),
    clientFor,
    serial,
    assertEnvironment,
    assertWritesAllowed,
    log,
    now,
  };
}
