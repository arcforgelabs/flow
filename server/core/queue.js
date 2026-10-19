import { and, eq, sql } from 'drizzle-orm';
import { backgroundJobs } from '../db/schema.js';
import { FlowError } from './errors.js';
import { openReview } from './review.js';

// The background job queue (issue 6). Every sync and write step runs as a job
// here, so steps never overlap, a crash never loses one, and a person can see
// what is queued, running or stuck. It is PostgreSQL only: workers claim with
// FOR UPDATE SKIP LOCKED and hold a lease. A lease that runs out makes the job
// claimable again, so a dead process never holds a job for good.

export const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const FIRST_RETRY_MS = 60 * 1000;
const LAST_RETRY_MS = 6 * 60 * 60 * 1000;

// The wait before attempt `attempts + 1`: 1 minute, doubling, at most 6 hours.
export function retryDelayMs(attempts) {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), LAST_RETRY_MS);
}

// Queues a job. While a job with the same kind and dedupe key is queued or
// running, it is returned instead of a second one.
export async function enqueueJob(db, organisationId, {
  kind, dedupeKey = '', payload = {}, runAfter = null, maxAttempts = 8,
}) {
  if (!kind) throw new FlowError('invalid', 'kind is required');
  const [row] = await db.insert(backgroundJobs)
    .values({ organisationId, kind, dedupeKey, payload, maxAttempts, ...(runAfter ? { runAfter } : {}) })
    .onConflictDoNothing()
    .returning();
  if (row) return { job: row, queued: true };
  const [open] = await db.select().from(backgroundJobs).where(and(
    eq(backgroundJobs.organisationId, organisationId),
    eq(backgroundJobs.kind, kind),
    eq(backgroundJobs.dedupeKey, dedupeKey),
    sql`${backgroundJobs.state} in ('queued', 'running')`,
  ));
  return { job: open, queued: false };
}

async function giveUp(tx, job, error) {
  const [row] = await tx.update(backgroundJobs)
    .set({ state: 'dead', lockedBy: null, lockedUntil: null, lastError: error, updatedAt: sql`now()` })
    .where(eq(backgroundJobs.id, job.id))
    .returning();
  await openReview(tx, job.organisationId, {
    kind: 'job.dead',
    entity: 'background_job',
    flowId: job.id,
    evidence: { kind: job.kind, dedupeKey: job.dedupeKey, attempts: job.attempts, error },
  });
  return row;
}

// Claims up to `limit` due jobs for one worker. A running job whose lease ran
// out is due again; one that has used every attempt is given up instead.
export async function claimJobs(db, { workerId, kinds = null, limit = 1, leaseMs = DEFAULT_LEASE_MS }) {
  if (!workerId) throw new FlowError('invalid', 'workerId is required');
  return db.transaction(async (tx) => {
    const kindFilter = kinds?.length
      ? sql`and kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})`
      : sql``;
    const { rows: due } = await tx.execute(sql`
      select id, attempts, max_attempts from background_jobs
      where ((state = 'queued' and run_after <= now()) or (state = 'running' and locked_until < now()))
      ${kindFilter}
      order by run_after, created_at
      for update skip locked
      limit ${limit}`);
    const claimed = [];
    for (const candidate of due) {
      if (candidate.attempts >= candidate.max_attempts) {
        const [job] = await tx.select().from(backgroundJobs).where(eq(backgroundJobs.id, candidate.id));
        await giveUp(tx, job, job.lastError ?? 'lease ran out on the last attempt');
        continue;
      }
      const [job] = await tx.update(backgroundJobs)
        .set({
          state: 'running',
          lockedBy: workerId,
          lockedUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
          attempts: sql`${backgroundJobs.attempts} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(backgroundJobs.id, candidate.id))
        .returning();
      claimed.push(job);
    }
    return claimed;
  });
}

// Only the worker that holds the lease may finish a job. A worker whose lease
// ran out and was taken over finishes nothing and is told so.
async function finish(db, job, workerId, fields) {
  const [row] = await db.update(backgroundJobs)
    .set({ ...fields, lockedBy: null, lockedUntil: null, updatedAt: sql`now()` })
    .where(and(
      eq(backgroundJobs.id, job.id),
      eq(backgroundJobs.state, 'running'),
      eq(backgroundJobs.lockedBy, workerId),
      eq(backgroundJobs.attempts, job.attempts),
    ))
    .returning();
  if (!row) throw new FlowError('conflict', 'job lease was lost', { jobId: job.id });
  return row;
}

export async function completeJob(db, job, { workerId, result = null }) {
  return finish(db, job, workerId, { state: 'succeeded', result, lastError: null });
}

// A failed attempt waits and runs again, until its attempts run out or the
// error cannot be fixed by waiting (`retry: false`); then it opens a review item.
export async function failJob(db, job, { workerId, error, retry = true }) {
  const message = String(error?.message ?? error ?? 'failed').slice(0, 2000);
  if (!retry || job.attempts >= job.maxAttempts) {
    return db.transaction(async (tx) => {
      const row = await finish(tx, job, workerId, { state: 'running', lastError: message });
      return giveUp(tx, { ...row, attempts: job.attempts }, message);
    });
  }
  return finish(db, job, workerId, {
    state: 'queued',
    lastError: message,
    runAfter: sql`now() + make_interval(secs => ${retryDelayMs(job.attempts) / 1000})`,
  });
}

// Claims one due job and runs its handler. Answers what happened, or null when
// nothing was due. A handler throws to fail; `error.retry = false` gives up.
export async function runNextJob(db, { workerId, handlers, leaseMs }) {
  const [job] = await claimJobs(db, { workerId, kinds: Object.keys(handlers), limit: 1, leaseMs });
  if (!job) return null;
  try {
    const result = await handlers[job.kind](job);
    return { job: await completeJob(db, job, { workerId, result: result ?? null }), outcome: 'succeeded' };
  } catch (error) {
    const row = await failJob(db, job, { workerId, error, retry: error?.retry !== false });
    return { job: row, outcome: row.state };
  }
}
