import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { CallsStopped, countsAsFailure, createCallGuard, normaliseRequestPath } from '../call-guard.js';
import { seazonaApiGovernor, seazonaApiRequests } from './schema.js';
import { MAX_REQUESTS_PER_MINUTE } from './settings.js';

export { countsAsFailure, normaliseRequestPath };

// The Seazona rate governor. Seazona sees every process that holds the same
// API client as one client, so the limit is kept in PostgreSQL, not in
// memory: a workspace and a deployment on one database share it.
//
// A request is admitted when fewer than `requestsPerMinute` requests were
// admitted in the last minute, the minimum gap since the last admission has
// passed, and no 429 cooldown is running. Admission takes a transaction-level
// advisory lock per client, so two processes never admit the same slot.
//
// Issue #101: a vendor can cut off API access after many failed calls, even
// inside the rate limit. So the governor also stops calls outright, through
// the shared call guard (../call-guard.js, issue #111) on these same tables:
//   - a 401 or 403 halts every call until a person acts (the adapter restarts
//     with new or saved settings, which calls resume());
//   - `circuitFailures` failed calls inside `circuitWindowMs` open the circuit:
//     no call for `circuitPauseMs`, then one probe call; a failed probe opens
//     it again for twice as long, to at most 6 hours, and a success closes it;
//   - `dailyFailureBudget` failed calls in one UTC day stop calls until the
//     next day.
// A stopped call fails at once with SeazonaCallsStopped; it never waits. The
// lanes report each held failure once (lanes.js), so the guard does not.

// The call guard's tables and policy. The adapter declares it (index.js), and
// the shared contract suite runs on it (test/integration-call-guard.test.js).
export const SEAZONA_CALL_GUARD = Object.freeze({
  integration: 'seazona',
  name: 'Seazona',
  tables: Object.freeze({ state: 'seazona_api_governor', calls: 'seazona_api_requests' }),
  columns: Object.freeze({ key: 'client_key', at: 'admitted_at' }),
  callDefaults: Object.freeze({ workflow: 'seazona' }),
  lockName: 'seazona-governor',
  policy: Object.freeze({ authStops: 'all' }),
});

const WINDOW_MS = 60_000;
const MAX_COOLDOWN_MS = 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function normaliseWorkflow(value) {
  return String(value || 'seazona').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').slice(0, 80) || 'seazona';
}

export class SeazonaGovernorTimeout extends Error {
  constructor(waitedMs, retryAfterMs) {
    super(`Seazona request waited ${waitedMs} ms for a free slot and gave up`);
    this.name = 'SeazonaGovernorTimeout';
    this.code = 'seazona_api_governor_timeout';
    this.kind = 'governor_timeout';
    this.retryAfterMs = retryAfterMs;
  }
}

// Calls are stopped: halted for a person, circuit open, or the day's failed
// calls are spent. `retryAfterMs` is null for a halt, which no wait clears.
// The shared CallsStopped, with Seazona's own words.
export class SeazonaCallsStopped extends CallsStopped {
  constructor(reason, retryAfterMs = null) {
    super({ integration: 'seazona', name: 'Seazona', reason, retryAfterMs });
    if (reason === 'halted') this.message = 'Seazona calls are stopped until a person checks the API client (it was refused)';
    this.name = 'SeazonaCallsStopped';
  }
}

export function createSeazonaGovernor({
  db,
  clientKey,
  requestsPerMinute = MAX_REQUESTS_PER_MINUTE,
  maxWaitMs = 120_000,
  telemetryRetentionMs = 35 * 24 * 60 * 60_000,
  circuitFailures = 5,
  circuitWindowMs = 10 * 60_000,
  circuitPauseMs = 5 * 60_000,
  dailyFailureBudget = 50,
  now = Date.now,
  sleepFn = sleep,
} = {}) {
  if (!db) throw new TypeError('db is required');
  const key = String(clientKey || '').trim().slice(0, 120);
  if (!key) throw new TypeError('clientKey is required');
  const limit = Math.min(MAX_REQUESTS_PER_MINUTE, Math.max(1, Math.trunc(requestsPerMinute) || MAX_REQUESTS_PER_MINUTE));
  const minIntervalMs = Math.ceil(WINDOW_MS / limit);
  const lockKey = `${SEAZONA_CALL_GUARD.lockName}:${key}`;
  const guard = createCallGuard({
    db,
    ...SEAZONA_CALL_GUARD,
    policy: { ...SEAZONA_CALL_GUARD.policy, circuitFailures, circuitWindowMs, circuitPauseMs, dailyFailureBudget, telemetryRetentionMs },
    report: false,
    now,
  });

  async function tryAdmit(workflow, isRetry) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const nowMs = Number(now());
      const nowAt = new Date(nowMs);
      await tx.insert(seazonaApiGovernor).values({ clientKey: key }).onConflictDoNothing();
      const [state] = await tx.select().from(seazonaApiGovernor).where(eq(seazonaApiGovernor.clientKey, key));
      const stopped = await guard.stoppedNow(tx, key);
      if (stopped) return { admitted: false, stopped };
      const windowStart = new Date(nowMs - WINDOW_MS);
      const [{ admitted, oldestMs }] = await tx
        .select({ admitted: count(), oldestMs: sql`(extract(epoch from min(${seazonaApiRequests.admittedAt})) * 1000)::float8` })
        .from(seazonaApiRequests)
        .where(and(eq(seazonaApiRequests.clientKey, key), gte(seazonaApiRequests.admittedAt, windowStart)));

      let eligibleAt = Math.max(nowMs, state.nextEligibleAt.getTime(), state.cooldownUntil.getTime());
      if (Number(admitted) >= limit && oldestMs !== null) {
        eligibleAt = Math.max(eligibleAt, Math.ceil(Number(oldestMs)) + WINDOW_MS + 1);
      }
      if (eligibleAt > nowMs) return { admitted: false, waitMs: eligibleAt - nowMs };

      const [row] = await tx.insert(seazonaApiRequests).values({
        clientKey: key,
        workflow: normaliseWorkflow(workflow),
        admittedAt: nowAt,
        isRetry: Boolean(isRetry),
      }).returning({ id: seazonaApiRequests.id });
      await tx.update(seazonaApiGovernor)
        .set({ nextEligibleAt: new Date(nowMs + minIntervalMs), updatedAt: nowAt })
        .where(eq(seazonaApiGovernor.clientKey, key));
      return { admitted: true, requestId: row.id };
    });
  }

  // Waits for a slot and records the admission. Returns { requestId }.
  async function reserve({ workflow = 'seazona', isRetry = false } = {}) {
    let waitedMs = 0;
    for (;;) {
      const decision = await tryAdmit(workflow, isRetry);
      if (decision.admitted) return { requestId: decision.requestId, waitedMs };
      if (decision.stopped) throw new SeazonaCallsStopped(decision.stopped.reason, decision.stopped.retryAfterMs);
      const delay = Math.max(1, Math.min(decision.waitMs, maxWaitMs));
      if (waitedMs + delay > maxWaitMs) throw new SeazonaGovernorTimeout(waitedMs, delay);
      waitedMs += delay;
      await sleepFn(delay);
    }
  }

  // Records how a request ended, any cooldown a 429 asked for, and what the
  // ending does to the circuit (the shared guard). Answers { halted, opened }
  // when this response stopped calls.
  async function recordResponse({ requestId, path = null, statusCode = null, failureKind = null, durationMs = null, retryAfterMs = null } = {}) {
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      const nowMs = Number(now());
      const until = new Date(nowMs + Math.min(retryAfterMs, MAX_COOLDOWN_MS));
      await db.update(seazonaApiGovernor)
        .set({ cooldownUntil: sql`greatest(${seazonaApiGovernor.cooldownUntil}, ${until})`, updatedAt: new Date(nowMs) })
        .where(eq(seazonaApiGovernor.clientKey, key));
    }
    const { halted, opened } = await guard.record(key, { callId: requestId, path, statusCode, failureKind, durationMs });
    return { ...(halted ? { halted } : {}), ...(opened ? { opened } : {}) };
  }

  // A person acted (new or saved settings, or the adapter turned on again):
  // clear a halt and close the circuit. The day's failure budget stays.
  async function resume() {
    await guard.resume(key);
  }

  // Counts for /health: the last minute, and the last day by status.
  async function status() {
    const nowMs = Number(now());
    const [state] = await db.select().from(seazonaApiGovernor).where(eq(seazonaApiGovernor.clientKey, key));
    const calls = await guard.status(key);
    const [{ lastMinute }] = await db.select({ lastMinute: count() }).from(seazonaApiRequests)
      .where(and(eq(seazonaApiRequests.clientKey, key), gte(seazonaApiRequests.admittedAt, new Date(nowMs - WINDOW_MS))));
    const day = await summarise({ from: new Date(nowMs - 24 * 60 * 60_000), to: new Date(nowMs) });
    const cooldownUntil = state && state.cooldownUntil.getTime() > nowMs ? state.cooldownUntil.toISOString() : null;
    return {
      limitPerMinute: limit,
      minIntervalMs,
      lastMinute: Number(lastMinute),
      cooldownUntil,
      circuit: calls.circuit,
      circuitOpenUntil: calls.circuitOpenUntil,
      haltedReason: calls.haltedReason,
      haltedAt: calls.haltedAt,
      failedToday: calls.failedToday,
      dailyFailureBudget: calls.dailyFailureBudget,
      lastDay: { requests: day.requests, failed: day.failed, rateLimited: day.rateLimited, retries: day.retries },
    };
  }

  // What was sent between two times: the totals, and each path that failed.
  // This answers "how many reads failed last month, and which ones?".
  async function summarise({ from, to, topFailures = 50 } = {}) {
    const range = and(
      eq(seazonaApiRequests.clientKey, key),
      gte(seazonaApiRequests.admittedAt, from),
      lt(seazonaApiRequests.admittedAt, to),
    );
    const [totals] = await db.select({
      requests: count(),
      failed: sql`count(*) filter (where ${seazonaApiRequests.statusCode} is null or ${seazonaApiRequests.statusCode} >= 400)`,
      rateLimited: sql`count(*) filter (where ${seazonaApiRequests.statusCode} = 429)`,
      retries: sql`count(*) filter (where ${seazonaApiRequests.isRetry})`,
    }).from(seazonaApiRequests).where(range);
    const failures = await db.select({
      path: seazonaApiRequests.requestPath,
      statusCode: seazonaApiRequests.statusCode,
      failureKind: seazonaApiRequests.failureKind,
      requests: count(),
    }).from(seazonaApiRequests)
      .where(and(range, sql`(${seazonaApiRequests.statusCode} is null or ${seazonaApiRequests.statusCode} >= 400)`))
      .groupBy(seazonaApiRequests.requestPath, seazonaApiRequests.statusCode, seazonaApiRequests.failureKind)
      .orderBy(desc(count()))
      .limit(topFailures);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      requests: Number(totals.requests),
      failed: Number(totals.failed),
      rateLimited: Number(totals.rateLimited),
      retries: Number(totals.retries),
      failures: failures.map((row) => ({ ...row, requests: Number(row.requests) })),
    };
  }

  return { clientKey: key, limitPerMinute: limit, minIntervalMs, reserve, recordResponse, resume, status, summarise };
}
