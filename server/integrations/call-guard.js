import { sql } from 'drizzle-orm';

// The call guard: one pattern every adapter that calls an outside system
// follows (docs/INTEGRATIONS.md, "Outbound calls"). A provider can cut off an
// installation's API access after many failed calls, even inside its rate
// limit (issues #101 and #111). So, before each call, the guard says whether
// a call may go, and after it, the guard records how it ended:
//
//   - a refused credential halts every call until a person acts (saves the
//     settings or connects again, which calls resume());
//   - a 401 or 403 on one resource, when the adapter's auth failures stop a
//     resource only, stops that resource; after `resourceRetryMs` one probe
//     call may go, and a refused probe stops it again for twice as long, to
//     at most `maxResourceRetryMs`. A good call, or a person connecting
//     again, starts it again;
//   - `circuitFailures` failed calls inside `circuitWindowMs` open the
//     circuit: no call for `circuitPauseMs`, then a probe; a failed probe opens
//     it again for twice as long, to at most `maxCircuitPauseMs`, and a
//     success closes it;
//   - `dailyFailureBudget` failed calls in one UTC day stop calls until the
//     next day.
//
// A stopped call fails at once with CallsStopped; it never waits. Each stop
// is reported once with log.error, so the connected error service gets one
// report per problem; a repeat is a warning.
//
// State lives in PostgreSQL, in two tables the adapter owns and creates in its
// own migrations (CALL_GUARD_COLUMNS), so every process on one database
// shares it and a restart does not reset it. Nothing here names a vendor.

export const CALL_GUARD_POLICY = Object.freeze({
  circuitFailures: 5,
  circuitWindowMs: 10 * 60_000,
  circuitPauseMs: 5 * 60_000,
  maxCircuitPauseMs: 6 * 60 * 60_000,
  dailyFailureBudget: 50,
  // 'all': a 401 or 403 halts every call. 'resource': it stops only the
  // resource it came from; halt() still stops everything.
  authStops: 'all',
  resourceRetryMs: 6 * 60 * 60_000,
  maxResourceRetryMs: 24 * 60 * 60_000,
  telemetryRetentionMs: 35 * 24 * 60 * 60_000,
});

// The columns each guard table must have. `key` and `at` may have other names
// (the `columns` option), so an adapter that kept telemetry before the guard
// existed can keep its tables.
export const CALL_GUARD_COLUMNS = Object.freeze({
  state: ['key', 'circuit_open_until', 'circuit_opens', 'halted_reason', 'halted_at', 'stopped_resources', 'updated_at'],
  calls: ['key', 'at', 'resource', 'request_path', 'status_code', 'failure_kind', 'duration_ms'],
});

const DAY_MS = 24 * 60 * 60_000;
const EPOCH = new Date(0);

// A call that failed in a way a provider sees as a fault: no answer, a 5xx, a
// 429, or a 4xx other than 404 (a 404 on one record means it was deleted).
export function countsAsFailure({ statusCode = null, failureKind = null } = {}) {
  if (failureKind) return true;
  if (!Number.isInteger(statusCode)) return false;
  return statusCode >= 500 || (statusCode >= 400 && statusCode !== 404);
}

export const isAuthRefusal = (statusCode) => statusCode === 401 || statusCode === 403;

export function startOfUtcDay(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// The pause after the circuit has opened `opens` times before.
export function circuitPauseMs(opens, policy = CALL_GUARD_POLICY) {
  return Math.min(policy.maxCircuitPauseMs, policy.circuitPauseMs * 2 ** Math.min(Math.max(0, opens), 10));
}

// The wait before the next probe of a stopped resource, after `probes`
// refused probes.
export function resourceRetryMs(probes, policy = CALL_GUARD_POLICY) {
  return Math.min(policy.maxResourceRetryMs, policy.resourceRetryMs * 2 ** Math.min(Math.max(0, probes), 10));
}

// When a stopped resource may be probed again (ms). An entry written before
// probes existed has no `retryAt`: it is due `resourceRetryMs` after `at`.
export function resourceRetryAt(entry, policy = CALL_GUARD_POLICY) {
  const due = entry?.retryAt ? new Date(entry.retryAt).getTime() : NaN;
  if (Number.isFinite(due)) return due;
  const at = entry?.at ? new Date(entry.at).getTime() : NaN;
  return Number.isFinite(at) ? at + resourceRetryMs(0, policy) : Infinity;
}

// Why no call may go now, or null. `state` is the guard row
// ({ haltedReason, circuitOpenUntil, stoppedResources }); `failedToday`
// counts failed calls since the start of the UTC day.
export function stoppedReason(state, { nowMs, failedToday, resource = null }, policy = CALL_GUARD_POLICY) {
  if (state?.haltedReason) return { reason: 'halted', retryAfterMs: null };
  const entry = resource ? state?.stoppedResources?.[resource] : null;
  if (entry) {
    const due = resourceRetryAt(entry, policy);
    if (due > nowMs) return { reason: 'resource_stopped', retryAfterMs: due - nowMs, resource };
  }
  const openUntil = state?.circuitOpenUntil ? new Date(state.circuitOpenUntil).getTime() : 0;
  if (openUntil > nowMs) return { reason: 'circuit_open', retryAfterMs: openUntil - nowMs };
  const dayStart = startOfUtcDay(nowMs);
  if (failedToday >= policy.dailyFailureBudget) return { reason: 'budget_spent', retryAfterMs: dayStart + DAY_MS - nowMs };
  return null;
}

// Whether a failed call opens the circuit. `recentFailures` counts failed
// calls since max(now - circuitWindowMs, the end of the last pause), this one
// included. Answers { pauseMs } or null.
export function circuitAfterFailure(state, { nowMs, recentFailures }, policy = CALL_GUARD_POLICY) {
  const opens = state?.circuitOpens ?? 0;
  const openUntil = state?.circuitOpenUntil ? new Date(state.circuitOpenUntil).getTime() : 0;
  // After a pause the next call is a probe: if it fails, open again at once.
  const probeFailed = opens > 0 && openUntil <= nowMs;
  if (!probeFailed && (recentFailures < policy.circuitFailures || openUntil > nowMs)) return null;
  return { pauseMs: circuitPauseMs(opens, policy) };
}

const STOP_TEXT = {
  halted: (name) => `${name} calls are stopped until a person checks the connection (it was refused)`,
  resource_stopped: (name, resource) => `${name} calls to ${resource} are stopped (they were refused); Flow tries again later by itself`,
  circuit_open: (name) => `${name} calls are paused after repeated failures`,
  budget_spent: (name) => `${name} calls are stopped for today: the day's failed calls are spent`,
};
const STOP_CODE = {
  halted: 'api_halted',
  resource_stopped: 'api_resource_stopped',
  circuit_open: 'api_circuit_open',
  budget_spent: 'api_failure_budget_spent',
};

// Calls are stopped. `retryAfterMs` is null for a stop that only a person
// clears. `code` is `<integration>_<what>`, for example api_circuit_open.
export class CallsStopped extends Error {
  constructor({ integration, name = integration, reason, retryAfterMs = null, resource = null }) {
    super(STOP_TEXT[reason](name, resource));
    this.name = 'CallsStopped';
    this.code = `${integration}_${STOP_CODE[reason]}`;
    this.kind = 'calls_stopped';
    this.integration = integration;
    this.reason = reason;
    this.resource = resource;
    this.retryAfterMs = retryAfterMs;
    this.status = 503;
  }
}

export const isCallsStopped = (error) => error?.kind === 'calls_stopped';

// The quiet alerts a guard's status() makes (server/core/alerts.js): only the
// stops a person must clear. A paused circuit or a spent day ends by itself,
// so it is no alert. `name` is what a person reads; `fix` says how a person
// clears the stop.
export function guardAlerts(name, status, { fix = 'Check the connection, then connect again.' } = {}) {
  const alerts = [];
  if (status?.haltedReason) {
    alerts.push({
      id: 'calls-stopped',
      tone: 'danger',
      title: `${name} refused Flow. Flow stopped all ${name} calls. ${fix}`,
      members: [`halted:${status.haltedAt ?? ''}`],
    });
  }
  // One refused resource is a warning, not a stop: every other call still
  // goes, and Flow probes the resource again by itself.
  const resources = status?.stoppedResources ?? [];
  if (resources.length) {
    alerts.push({
      id: 'resources-stopped',
      tone: 'warn',
      title: `${name} refused Flow for ${resources.map((r) => r.resource).join(', ')}. Other ${name} calls still work. Flow tries again by itself. To fix it now, connect again.`,
      members: resources.map((r) => `${r.resource}:${r.at ?? ''}`),
    });
  }
  return alerts;
}

// Path only: drop any host and query, and keep a safe character set.
export function normaliseRequestPath(value) {
  const path = String(value || '').split(/[?#]/)[0].replace(/^[a-z]+:\/\/[^/]+/i, '');
  return path.replace(/[^A-Za-z0-9/_.:-]+/g, '').slice(0, 160) || null;
}

const cleanKey = (value) => String(value ?? '').trim().slice(0, 120);
const cleanResource = (value) => (value ? String(value).replace(/[^A-Za-z0-9/_.:-]+/g, '').slice(0, 80) || null : null);
const iso = (value) => (value ? new Date(value).toISOString() : null);

// `integration` is the adapter id (codes, the advisory lock), `name` what a
// person reads. `tables` names the adapter's two tables; `columns` renames
// the `key` and `at` columns when an adapter's tables use other names, and
// `callDefaults` fills other required columns of a new call row. An adapter
// that admits its calls in its own transaction passes `lockName`, so the
// guard takes the same lock. `report: false` leaves the reports to the
// adapter, for one that already reports each stop once at a higher level.
export function createCallGuard({
  db,
  integration,
  name = integration,
  tables,
  columns = {},
  callDefaults = {},
  lockName = `${integration}-call-guard`,
  report: reports = true,
  policy: overrides = {},
  now = Date.now,
  log = console,
} = {}) {
  if (!db) throw new TypeError('createCallGuard: db is required');
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(integration ?? '')) throw new TypeError('createCallGuard: integration must be an adapter id');
  if (!tables?.state || !tables?.calls) throw new TypeError('createCallGuard: tables.state and tables.calls are required');
  const policy = { ...CALL_GUARD_POLICY, ...overrides };
  if (!['all', 'resource'].includes(policy.authStops)) throw new TypeError('createCallGuard: authStops must be "all" or "resource"');
  const T = { state: sql.identifier(tables.state), calls: sql.identifier(tables.calls) };
  const C = { key: sql.identifier(columns.key ?? 'key'), at: sql.identifier(columns.at ?? 'at') };
  const tag = `[${integration}]`;
  const failed = sql`(failure_kind is not null or status_code >= 500 or (status_code >= 400 and status_code <> 404))`;

  const lock = (tx, key) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${lockName}:${key}`}))`);
  const extraColumns = Object.keys(callDefaults).map((column) => sql`, ${sql.identifier(column)}`);
  const extraValues = Object.values(callDefaults).map((value) => sql`, ${value}`);

  async function readState(runner, key) {
    const { rows } = await runner.execute(sql`select circuit_open_until, circuit_opens, halted_reason, halted_at, stopped_resources
      from ${T.state} where ${C.key} = ${key}`);
    const row = rows[0];
    if (!row) return { circuitOpenUntil: EPOCH, circuitOpens: 0, haltedReason: null, haltedAt: null, stoppedResources: {} };
    return {
      circuitOpenUntil: new Date(row.circuit_open_until),
      circuitOpens: Number(row.circuit_opens),
      haltedReason: row.halted_reason,
      haltedAt: row.halted_at ? new Date(row.halted_at) : null,
      stoppedResources: row.stopped_resources ?? {},
    };
  }

  async function failuresSince(runner, key, fromMs) {
    const { rows } = await runner.execute(sql`select count(*)::int as n from ${T.calls}
      where ${C.key} = ${key} and ${C.at} >= ${new Date(fromMs)} and ${failed}`);
    return Number(rows[0].n);
  }

  const ensureRow = (runner, key) => runner.execute(sql`insert into ${T.state} (${C.key}) values (${key}) on conflict do nothing`);

  // Why no call may go to `resource` now, or null. `runner` is the database
  // or a transaction the adapter holds (with the guard's lock).
  async function stoppedNow(runner, rawKey, { resource = null } = {}) {
    const key = cleanKey(rawKey);
    const nowMs = Number(now());
    const state = await readState(runner, key);
    const failedToday = await failuresSince(runner, key, startOfUtcDay(nowMs));
    return stoppedReason(state, { nowMs, failedToday, resource: cleanResource(resource) }, policy);
  }

  // Throws CallsStopped when no call may go to `resource` now.
  async function check(rawKey, options = {}) {
    const stopped = await stoppedNow(db, rawKey, options);
    if (stopped) throw new CallsStopped({ integration, name, ...stopped });
  }

  // Records how one call ended, and what that does to the guard. Answers
  // what this call changed ({ halted, resourceStopped, resourceStillStopped,
  // resourceResumed, opened, closed, budgetSpent }),
  // each of which was just reported once. `callId` names a call row the
  // adapter wrote when it admitted the call: that row is updated, not added.
  async function record(rawKey, { callId = null, resource = null, path = null, statusCode = null, failureKind = null, durationMs = null } = {}) {
    const key = cleanKey(rawKey);
    const where = cleanResource(resource);
    const nowMs = Number(now());
    const nowAt = new Date(nowMs);
    const status = Number.isInteger(statusCode) ? statusCode : null;
    const outcome = await db.transaction(async (tx) => {
      await lock(tx, key);
      await ensureRow(tx, key);
      const kind = failureKind ? String(failureKind).slice(0, 40) : null;
      const took = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null;
      if (callId !== null) {
        await tx.execute(sql`update ${T.calls} set resource = ${where}, request_path = ${normaliseRequestPath(path)}, status_code = ${status},
          failure_kind = ${kind}, duration_ms = ${took} where id = ${callId} and ${C.key} = ${key}`);
      } else {
        await tx.execute(sql`insert into ${T.calls} (${C.key}, ${C.at}, resource, request_path, status_code, failure_kind, duration_ms${sql.join(extraColumns, sql``)})
          values (${key}, ${nowAt}, ${where}, ${normaliseRequestPath(path)}, ${status}, ${kind}, ${took}${sql.join(extraValues, sql``)})`);
      }
      const state = await readState(tx, key);
      if (!countsAsFailure({ statusCode: status, failureKind })) {
        const result = {};
        // A good probe: the resource is allowed again.
        if (where && state.stoppedResources[where] && status !== null && status < 400) {
          await tx.execute(sql`update ${T.state} set stopped_resources = stopped_resources - ${where}, updated_at = ${nowAt} where ${C.key} = ${key}`);
          result.resourceResumed = where;
        }
        if (state.circuitOpens > 0) {
          await tx.execute(sql`update ${T.state} set circuit_opens = 0, updated_at = ${nowAt} where ${C.key} = ${key}`);
          result.closed = true;
        }
        return result;
      }
      const result = {};
      const dayStart = startOfUtcDay(nowMs);
      if (await failuresSince(tx, key, dayStart) === policy.dailyFailureBudget) result.budgetSpent = { until: new Date(dayStart + DAY_MS).toISOString() };
      if (isAuthRefusal(status)) {
        if (policy.authStops === 'resource' && where) {
          const before = state.stoppedResources[where];
          const probes = before ? (Number(before.probes) || 0) + 1 : 0;
          const entry = {
            statusCode: status,
            at: before?.at ?? nowAt.toISOString(),
            probes,
            retryAt: new Date(nowMs + resourceRetryMs(probes, policy)).toISOString(),
          };
          await tx.execute(sql`update ${T.state} set stopped_resources = stopped_resources || ${JSON.stringify({ [where]: entry })}::jsonb,
            updated_at = ${nowAt} where ${C.key} = ${key}`);
          if (before) result.resourceStillStopped = { resource: where, retryAt: entry.retryAt };
          else result.resourceStopped = where;
          return result;
        }
        if (!state.haltedReason) {
          await tx.execute(sql`update ${T.state} set halted_reason = 'auth', halted_at = ${nowAt}, updated_at = ${nowAt} where ${C.key} = ${key}`);
          result.halted = 'auth';
        }
        return result;
      }
      const recentFailures = await failuresSince(tx, key, Math.max(nowMs - policy.circuitWindowMs, state.circuitOpenUntil.getTime()));
      const open = circuitAfterFailure(state, { nowMs, recentFailures }, policy);
      if (open) {
        const until = new Date(nowMs + open.pauseMs);
        await tx.execute(sql`update ${T.state} set circuit_open_until = ${until}, circuit_opens = circuit_opens + 1, updated_at = ${nowAt} where ${C.key} = ${key}`);
        result.opened = { until: until.toISOString(), pauseMs: open.pauseMs, opens: state.circuitOpens + 1 };
      }
      return result;
    });
    report(outcome, { status, failureKind, where });
    await db.execute(sql`delete from ${T.calls} where ${C.key} = ${key} and ${C.at} < ${new Date(nowMs - policy.telemetryRetentionMs)}`);
    return outcome;
  }

  // One log.error per stop, so the error service gets one report each. A
  // circuit that opens again after a failed probe is a warning: the first
  // opening was reported.
  function report(outcome, { status, failureKind, where }) {
    if (!reports) return;
    const cause = status ? `HTTP ${status}` : failureKind;
    if (outcome.halted) log.error?.(`${tag} ${name} refused the connection (${cause}). Calls are stopped until a person checks the ${name} settings or connects again.`);
    if (outcome.resourceStopped) log.error?.(`${tag} ${name} refused calls to ${where} (${cause}). Calls to ${where} are stopped; Flow tries again by itself, or a person connects again.`);
    if (outcome.resourceStillStopped) log.warn?.(`${tag} ${name} still refuses calls to ${where} (${cause}). Flow tries again at ${outcome.resourceStillStopped.retryAt}.`);
    if (outcome.resourceResumed) log.info?.(`${tag} ${name} allows calls to ${outcome.resourceResumed} again.`);
    if (outcome.opened) {
      const line = `${tag} ${name} calls failed repeatedly (last: ${cause}${where ? ` on ${where}` : ''}). Calls pause until ${outcome.opened.until}.`;
      if (outcome.opened.opens === 1) log.error?.(line);
      else log.warn?.(line);
    }
    if (outcome.budgetSpent) log.error?.(`${tag} ${policy.dailyFailureBudget} ${name} calls failed today (last: ${cause}). Calls stop until ${outcome.budgetSpent.until}.`);
  }

  // Stops every call until resume(): for a refusal found outside a call, for
  // example a credential the provider no longer accepts. Reported once.
  async function halt(rawKey, reason = 'auth', { detail = null } = {}) {
    const key = cleanKey(rawKey);
    const nowAt = new Date(Number(now()));
    const changed = await db.transaction(async (tx) => {
      await lock(tx, key);
      await ensureRow(tx, key);
      const { rows } = await tx.execute(sql`update ${T.state} set halted_reason = ${String(reason).slice(0, 40)}, halted_at = ${nowAt}, updated_at = ${nowAt}
        where ${C.key} = ${key} and halted_reason is null returning 1`);
      return rows.length > 0;
    });
    if (changed && reports) log.error?.(`${tag} ${name} calls are stopped until a person checks the ${name} settings or connects again${detail ? ` (${detail})` : ''}.`);
    return changed;
  }

  // A person acted: clear a halt and stopped resources, and close the
  // circuit. The day's failure budget stays. No key: every key.
  async function resume(rawKey = null) {
    const nowAt = new Date(Number(now()));
    if (rawKey === null) {
      await db.execute(sql`update ${T.state} set halted_reason = null, halted_at = null, stopped_resources = '{}'::jsonb,
        circuit_open_until = ${EPOCH}, circuit_opens = 0, updated_at = ${nowAt}`);
      return;
    }
    const key = cleanKey(rawKey);
    await ensureRow(db, key);
    await db.execute(sql`update ${T.state} set halted_reason = null, halted_at = null, stopped_resources = '{}'::jsonb,
      circuit_open_until = ${EPOCH}, circuit_opens = 0, updated_at = ${nowAt} where ${C.key} = ${key}`);
  }

  // What Settings and /health show, the same for every adapter.
  async function status(rawKey) {
    const key = cleanKey(rawKey);
    const nowMs = Number(now());
    const state = await readState(db, key);
    const openUntil = state.circuitOpenUntil.getTime();
    return {
      circuit: state.haltedReason ? 'halted' : openUntil > nowMs ? 'open' : state.circuitOpens > 0 ? 'half_open' : 'closed',
      circuitOpenUntil: openUntil > nowMs ? iso(openUntil) : null,
      haltedReason: state.haltedReason,
      haltedAt: iso(state.haltedAt),
      stoppedResources: Object.entries(state.stoppedResources).map(([resource, entry]) => ({ resource, ...entry, retryAt: Number.isFinite(resourceRetryAt(entry, policy)) ? iso(resourceRetryAt(entry, policy)) : null })),
      failedToday: await failuresSince(db, key, startOfUtcDay(nowMs)),
      dailyFailureBudget: policy.dailyFailureBudget,
    };
  }

  return { integration, policy, check, stoppedNow, record, halt, resume, status };
}

// ── Button presses ─────────────────────────────────────────────────────────
//
// The action guard: a person's button press that calls an outside system (a
// copy, a recheck, a send) is one action. Pressed again and again, it spends
// the provider's rate limit and can trip the call guard above. So each
// guarded route:
//
//   - runs once at a time per key: a second press while it runs waits
//     (429, `action_running`);
//   - after a run, waits `cooldownMs` before it runs again for that key
//     (429, `action_cooldown`);
//   - after a failed run (a 5xx, a 429 or a stopped call), waits twice as
//     long each time, to at most `maxCooldownMs`; a good run resets it;
//   - shares one budget per integration: at most `budget` runs in `budgetMs`
//     for all its actions together (429, `action_budget`). An action with
//     `budget: false` (a send a person makes one invoice at a time) is
//     outside it; the provider's rate limit still paces its calls.
//
// A 429 carries Retry-After and `retryAfterMs`, so the page shows the wait.
// A good run says its cooldown in the `Flow-Cooldown-Ms` header. A refused
// request (another 4xx) costs nothing: no call went. The state is in memory:
// one Flow process serves one lab (server/rate-limit.js), and the call guard
// above still protects every process.

export const ACTION_GUARD_POLICY = Object.freeze({
  cooldownMs: 30_000,
  maxCooldownMs: 15 * 60_000,
  budget: 30,
  budgetMs: 10 * 60_000,
});

const ACTION_TEXT = {
  action_running: () => 'This is already running. Wait for it to finish.',
  action_cooldown: (seconds) => `Flow just did this. Try again in ${seconds} seconds.`,
  action_budget: (seconds) => `Too many requests to this system. Try again in ${seconds} seconds.`,
};

// The wait after `failures` failed runs in a row.
export function actionCooldownMs(failures, { cooldownMs, maxCooldownMs }) {
  if (failures <= 0) return cooldownMs;
  return Math.min(maxCooldownMs, Math.max(cooldownMs, 5_000) * 2 ** Math.min(failures, 10));
}

// How a response ends a run: 'ok', 'failed' (the system or the call guard
// said no) or 'refused' (Flow refused the request; nothing was called).
export function actionOutcome(statusCode) {
  if (statusCode >= 500 || statusCode === 429) return 'failed';
  if (statusCode >= 400) return 'refused';
  return 'ok';
}

const cleanPart = (value) => String(value ?? '').replace(/[^A-Za-z0-9_.:-]+/g, '').slice(0, 80);

// `integration` names the budget; `actions` maps each action name to its
// policy ({ cooldownMs, maxCooldownMs, budget }). `route(name, { key })` answers the
// Express middleware for one route; `key(req)` names what the cooldown
// covers inside the organisation (an invoice id, say), or null for all of it.
// `off: true` lets every press through (tests that press one route often).
export function createActionGuard({ integration, actions = {}, policy: overrides = {}, off = false, now = Date.now } = {}) {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(integration ?? '')) throw new TypeError('createActionGuard: integration must be an adapter id');
  const policy = { ...ACTION_GUARD_POLICY, ...overrides };
  const runs = new Map(); // key -> { running, failures, readyAt }
  const started = []; // start times inside the budget window
  const policyOf = (name) => ({ cooldownMs: policy.cooldownMs, maxCooldownMs: policy.maxCooldownMs, ...(actions[name] ?? {}) });

  const runOf = (key) => {
    let run = runs.get(key);
    if (!run) runs.set(key, (run = { running: false, failures: 0, readyAt: 0 }));
    return run;
  };

  // Why `name` may not run for `key` now, or null.
  function waitFor(name, key) {
    const nowMs = Number(now());
    const run = runs.get(key);
    if (run?.running) return { code: 'action_running', retryAfterMs: 5_000 };
    if (run && run.readyAt > nowMs) return { code: 'action_cooldown', retryAfterMs: run.readyAt - nowMs };
    if (policyOf(name).budget === false) return null;
    while (started.length && started[0] <= nowMs - policy.budgetMs) started.shift();
    if (started.length >= policy.budget) return { code: 'action_budget', retryAfterMs: started[0] + policy.budgetMs - nowMs };
    return null;
  }

  function begin(name, key) {
    const wait = waitFor(name, key);
    if (wait) return wait;
    runOf(key).running = true;
    if (policyOf(name).budget !== false) started.push(Number(now()));
    return null;
  }

  // `retryAfterMs`: a wait the system or the call guard asked for.
  function end(name, key, outcome, { retryAfterMs = 0 } = {}) {
    const run = runOf(key);
    const rule = policyOf(name);
    run.running = false;
    if (outcome === 'refused') {
      if (rule.budget !== false) started.pop();
      return 0;
    }
    run.failures = outcome === 'failed' ? run.failures + 1 : 0;
    const waitMs = Math.max(actionCooldownMs(run.failures, rule), retryAfterMs || 0);
    run.readyAt = Number(now()) + waitMs;
    return waitMs;
  }

  function route(name, { key = () => null } = {}) {
    if (!actions[name]) throw new TypeError(`createActionGuard: ${name} is not a declared action`);
    if (off) return (_req, _res, next) => next();
    return (req, res, next) => {
      const organisation = cleanPart(req.body?.organisationId ?? req.query?.organisationId) || 'sole';
      const sub = key(req);
      const runKey = [name, organisation, sub === null || sub === undefined ? '' : cleanPart(sub)].join('|');
      const wait = begin(name, runKey);
      if (wait) {
        const seconds = Math.max(1, Math.ceil(wait.retryAfterMs / 1000));
        res.set('Retry-After', String(seconds));
        return res.status(429).json({ ok: false, code: wait.code, error: ACTION_TEXT[wait.code](seconds), retryAfterMs: wait.retryAfterMs });
      }
      let ended = false;
      const finish = (statusCode) => {
        if (ended) return 0;
        ended = true;
        const asked = Number(res.getHeader('Retry-After')) * 1000;
        return end(name, runKey, actionOutcome(statusCode), { retryAfterMs: Number.isFinite(asked) ? asked : 0 });
      };
      // The cooldown is set as the answer is written, so a press right after
      // it already waits, and the page learns the wait from the header.
      const writeHead = res.writeHead;
      res.writeHead = function writeHeadWithCooldown(statusCode, ...rest) {
        const waitMs = finish(statusCode);
        if (waitMs && actionOutcome(statusCode) === 'ok' && !res.headersSent) res.setHeader('Flow-Cooldown-Ms', String(waitMs));
        return writeHead.call(this, statusCode, ...rest);
      };
      res.on('close', () => finish(res.headersSent ? res.statusCode : 500));
      return next();
    };
  }

  // Forget every run: for tests, and when a person connects again.
  const reset = () => {
    runs.clear();
    started.length = 0;
  };

  return { integration, policy, actions, route, waitFor, reset };
}
