import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { enqueueJob, runNextJob } from '../../core/queue.js';
import { MIRROR_RESOURCES, mirrorXero } from './mirror.js';

// The history import. When an owner connects Xero, Flow copies the
// organisation's invoices, credit notes and payments into the mirror
// (mirror.js) as a background job, so nobody runs a script by hand. The job
// reads in slices; a slice that stops at the day's budget or its page limit
// queues the next slice. It only reads from Xero.

export const IMPORT_KIND = 'xero.import';
const IMPORT_KEY = 'history';
// Pages per resource in one slice, so one job stays well inside its lease.
const SLICE_PAGES = 20;
const LEASE_MS = 30 * 60 * 1000;
// Xero's day limit resets on a rolling day; an hour is a cheap re-check.
const BUDGET_WAIT_MS = 60 * 60 * 1000;
const IDLE_MS = 30 * 1000;

export async function queueHistoryImport(db, organisationId, { reason = 'connected', runAfter = null } = {}) {
  return enqueueJob(db, organisationId, { kind: IMPORT_KIND, dedupeKey: IMPORT_KEY, payload: { reason }, runAfter });
}

// Forgets where the copy stands, so the next slice reads from the start.
// Rows already copied stay; a re-read updates them.
export async function resetImport(db, organisationId) {
  await db.execute(sql`delete from xero_mirror_cursors where organisation_id = ${organisationId}`);
}

// Organisations connected in this mode whose history is not yet complete: a
// resource with no finished pass. Start-up queues these, so an installation
// connected before this release imports too.
export async function organisationsToImport(db, mode) {
  const { rows } = await db.execute(sql`
    select c.organisation_id from xero_connections c
    where c.mode = ${mode}
      and (select count(*) from xero_mirror_cursors m
           where m.organisation_id = c.organisation_id and m.passes > 0) < ${MIRROR_RESOURCES.length}`);
  return rows.map((r) => r.organisation_id);
}

// One slice of the import for one job. Answers what it read and whether more
// remains (`more`: 'budget' or 'max_pages').
export async function runImportSlice(db, runtime, job, { maxPages = SLICE_PAGES } = {}) {
  const results = await mirrorXero(db, runtime, job.organisationId, { maxPages });
  const stopped = results.find((r) => r.stopped !== 'done')?.stopped ?? null;
  return { results, more: stopped };
}

// Claims and runs one due import job, then queues the next slice when one is
// needed. Answers the queue's outcome, or null when nothing was due.
export async function runImportOnce(db, runtime, { workerId = `xero-import-${randomUUID()}`, maxPages, now = Date.now } = {}) {
  const ran = await runNextJob(db, {
    workerId,
    leaseMs: LEASE_MS,
    handlers: { [IMPORT_KIND]: (job) => runImportSlice(db, runtime, job, { maxPages }) },
  });
  if (ran?.outcome === 'succeeded' && ran.job.result?.more) {
    const wait = ran.job.result.more === 'budget' ? BUDGET_WAIT_MS : 0;
    await queueHistoryImport(db, ran.job.organisationId, { reason: ran.job.result.more, runAfter: new Date(Number(now()) + wait) });
  }
  return ran;
}

// The background worker: runs due slices one at a time, then waits. Started
// by the adapter outside replay mode; stop() waits for a slice in flight.
export function createImportWorker({ db, runtime, log = console, timers = { setTimeout, clearTimeout }, firstDelayMs = 10_000 }) {
  const workerId = `xero-import-${randomUUID()}`;
  let timer = null;
  let running = null;
  let stopped = true;

  function schedule(delayMs) {
    if (stopped) return;
    timer = timers.setTimeout(tick, delayMs);
    timer?.unref?.();
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    let busy = false;
    running = (async () => {
      try {
        const ran = await runImportOnce(db, runtime, { workerId });
        if (ran) {
          busy = true;
          const read = (ran.job.result?.results ?? []).map((r) => `${r.resource} ${r.read}`).join(', ');
          log.info?.(`[xero] import ${ran.outcome} for organisation ${ran.job.organisationId}${read ? `: ${read}` : ''}${ran.job.result?.more ? `; more (${ran.job.result.more})` : ''}`);
        }
      } catch (error) {
        log.error?.(`[xero] import worker: ${error?.code ?? 'error'}: ${error?.message ?? error}`);
      }
    })();
    await running;
    running = null;
    schedule(busy ? 0 : IDLE_MS);
  }

  return {
    async start() {
      stopped = false;
      for (const organisationId of await organisationsToImport(db, runtime.settings.mode)) {
        await queueHistoryImport(db, organisationId, { reason: 'start' });
      }
      schedule(firstDelayMs);
    },
    async stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
