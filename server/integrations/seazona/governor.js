import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { seazonaApiGovernor, seazonaApiRequests } from './schema.js';
import { MAX_REQUESTS_PER_MINUTE } from './settings.js';

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
// inside the rate limit. So the governor also stops calls outright:
//   - a 401 or 403 halts every call until a person acts (the adapter restarts
//     with new or saved settings, which calls resume());
//   - `circuitFailures` failed calls inside `circuitWindowMs` open the circuit:
//     no call for `circuitPauseMs`, then one probe call; a failed probe opens
//     it again for twice as long, to at most 6 hours, and a success closes it;
//   - `dailyFailureBudget` failed calls in one UTC day stop calls until the
//     next day.
// A stopped call fails at once with SeazonaCallsStopped; it never waits.

const WINDOW_MS = 60_000;
const MAX_COOLDOWN_MS = 60_000;
const MAX_CIRCUIT_PAUSE_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const EPOCH = new Date(0);

// A call that failed in a way the vendor sees as a fault: no answer, a 5xx, a
// 429, or a 4xx other than 404 (a 404 on one record means it was deleted).
export function countsAsFailure({ statusCode = null, failureKind = null } = {}) {
  if (failureKind) return true;
  if (!Number.isInteger(statusCode)) return false;
  return statusCode >= 500 || (statusCode >= 400 && statusCode !== 404);
}

const failedCall = sql`(${seazonaApiRequests.failureKind} is not null or ${seazonaApiRequests.statusCode} >= 500
  or (${seazonaApiRequests.statusCode} >= 400 and ${seazonaApiRequests.statusCode} <> 404))`;

const startOfUtcDay = (ms) => {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// Path only: drop any host and query, and keep a safe character set.
export function normaliseRequestPath(value) {
  const path = String(value || '').split(/[?#]/)[0].replace(/^[a-z]+:\/\/[^/]+/i, '');
  return path.replace(/[^A-Za-z0-9/_.:-]+/g, '').slice(0, 160) || null;
}

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
export class SeazonaCallsStopped extends Error {
  constructor(reason, retryAfterMs = null) {
    const what = {
      halted: 'Seazona calls are stopped until a person checks the API client (it was refused)',
      circuit_open: 'Seazona calls are paused after repeated failures',
      budget_spent: "Seazona calls are stopped for today: the day's failed calls are spent",
    }[reason];
    super(what);
    this.name = 'SeazonaCallsStopped';
    this.code = { halted: 'seazona_api_halted', circuit_open: 'seazona_api_circuit_open', budget_spent: 'seazona_api_failure_budget_spent' }[reason];
    this.kind = 'calls_stopped';
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
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
  const lockKey = `seazona-governor:${key}`;

  async function tryAdmit(workflow, isRetry) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const nowMs = Number(now());
      const nowAt = new Date(nowMs);
      await tx.insert(seazonaApiGovernor).values({ clientKey: key }).onConflictDoNothing();
      const [state] = await tx.select().from(seazonaApiGovernor).where(eq(seazonaApiGovernor.clientKey, key));
      const stopped = await stoppedReason(tx, state, nowMs);
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

  async function failuresSince(tx, fromMs) {
    const [{ failed }] = await tx.select({ failed: count() }).from(seazonaApiRequests)
      .where(and(eq(seazonaApiRequests.clientKey, key), gte(seazonaApiRequests.admittedAt, new Date(fromMs)), failedCall));
    return Number(failed);
  }

  // Why no call may go now, or null.
  async function stoppedReason(tx, state, nowMs) {
    if (state.haltedReason) return { reason: 'halted', retryAfterMs: null };
    const openUntil = state.circuitOpenUntil.getTime();
    if (openUntil > nowMs) return { reason: 'circuit_open', retryAfterMs: openUntil - nowMs };
    const dayStart = startOfUtcDay(nowMs);
    if (await failuresSince(tx, dayStart) >= dailyFailureBudget) {
      return { reason: 'budget_spent', retryAfterMs: dayStart + DAY_MS - nowMs };
    }
    return null;
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
  // ending does to the circuit. Answers { halted, opened } when this response
  // stopped calls, so the caller can report it once.
  async function recordResponse({ requestId, path = null, statusCode = null, failureKind = null, durationMs = null, retryAfterMs = null } = {}) {
    const nowMs = Number(now());
    const nowAt = new Date(nowMs);
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      await tx.update(seazonaApiRequests).set({
        requestPath: normaliseRequestPath(path),
        statusCode: Number.isInteger(statusCode) ? statusCode : null,
        failureKind: failureKind ? String(failureKind).slice(0, 40) : null,
        durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
      }).where(and(eq(seazonaApiRequests.id, requestId), eq(seazonaApiRequests.clientKey, key)));
      if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        const until = new Date(nowMs + Math.min(retryAfterMs, MAX_COOLDOWN_MS));
        await tx.update(seazonaApiGovernor)
          .set({ cooldownUntil: sql`greatest(${seazonaApiGovernor.cooldownUntil}, ${until})`, updatedAt: nowAt })
          .where(eq(seazonaApiGovernor.clientKey, key));
      }
      const [state] = await tx.select().from(seazonaApiGovernor).where(eq(seazonaApiGovernor.clientKey, key));
      if (!state) return {};
      if (!countsAsFailure({ statusCode, failureKind })) {
        if (state.circuitOpens > 0) {
          await tx.update(seazonaApiGovernor).set({ circuitOpens: 0, updatedAt: nowAt }).where(eq(seazonaApiGovernor.clientKey, key));
        }
        return {};
      }
      if (statusCode === 401 || statusCode === 403) {
        if (state.haltedReason) return {};
        await tx.update(seazonaApiGovernor).set({ haltedReason: 'auth', haltedAt: nowAt, updatedAt: nowAt })
          .where(eq(seazonaApiGovernor.clientKey, key));
        return { halted: 'auth' };
      }
      const openUntil = state.circuitOpenUntil.getTime();
      // After a pause the next call is a probe: if it fails, open again at once.
      const probeFailed = state.circuitOpens > 0 && openUntil <= nowMs;
      const counted = probeFailed ? 0 : await failuresSince(tx, Math.max(nowMs - circuitWindowMs, openUntil));
      if (!probeFailed && counted < circuitFailures) return {};
      if (!probeFailed && openUntil > nowMs) return {};
      const pauseMs = Math.min(MAX_CIRCUIT_PAUSE_MS, circuitPauseMs * 2 ** Math.min(state.circuitOpens, 10));
      const until = new Date(nowMs + pauseMs);
      await tx.update(seazonaApiGovernor)
        .set({ circuitOpenUntil: until, circuitOpens: state.circuitOpens + 1, updatedAt: nowAt })
        .where(eq(seazonaApiGovernor.clientKey, key));
      return { opened: { until: until.toISOString(), pauseMs, opens: state.circuitOpens + 1 } };
    });
    await db.delete(seazonaApiRequests).where(and(
      eq(seazonaApiRequests.clientKey, key),
      lt(seazonaApiRequests.admittedAt, new Date(nowMs - telemetryRetentionMs)),
    ));
    return outcome;
  }

  // A person acted (new or saved settings, or the adapter turned on again):
  // clear a halt and close the circuit. The day's failure budget stays.
  async function resume() {
    await db.insert(seazonaApiGovernor).values({ clientKey: key }).onConflictDoNothing();
    await db.update(seazonaApiGovernor)
      .set({ haltedReason: null, haltedAt: null, circuitOpenUntil: EPOCH, circuitOpens: 0, updatedAt: new Date(Number(now())) })
      .where(eq(seazonaApiGovernor.clientKey, key));
  }

  // Counts for /health: the last minute, and the last day by status.
  async function status() {
    const nowMs = Number(now());
    const [state] = await db.select().from(seazonaApiGovernor).where(eq(seazonaApiGovernor.clientKey, key));
    const [{ lastMinute }] = await db.select({ lastMinute: count() }).from(seazonaApiRequests)
      .where(and(eq(seazonaApiRequests.clientKey, key), gte(seazonaApiRequests.admittedAt, new Date(nowMs - WINDOW_MS))));
    const day = await summarise({ from: new Date(nowMs - 24 * 60 * 60_000), to: new Date(nowMs) });
    const cooldownUntil = state && state.cooldownUntil.getTime() > nowMs ? state.cooldownUntil.toISOString() : null;
    const openUntil = state?.circuitOpenUntil?.getTime() ?? 0;
    const circuit = state?.haltedReason ? 'halted'
      : openUntil > nowMs ? 'open'
        : state?.circuitOpens > 0 ? 'half_open' : 'closed';
    return {
      limitPerMinute: limit,
      minIntervalMs,
      lastMinute: Number(lastMinute),
      cooldownUntil,
      circuit,
      circuitOpenUntil: openUntil > nowMs ? state.circuitOpenUntil.toISOString() : null,
      haltedReason: state?.haltedReason ?? null,
      haltedAt: state?.haltedAt?.toISOString() ?? null,
      failedToday: await failuresSince(db, startOfUtcDay(nowMs)),
      dailyFailureBudget,
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
