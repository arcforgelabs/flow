import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { enqueueJob, runNextJob } from '../../core/queue.js';
import { isCallsStopped } from '../call-guard.js';
import { lastSync, syncCatalogue } from './catalogue.js';
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
// Contacts and items are read again once a day, so the matcher can link each
// customer (server/core/pipeline.js) without a person pressing Sync.
const CATALOGUE_EVERY_MS = 24 * 60 * 60 * 1000;

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
// While the call guard stops Xero calls the slice does not fail, so it does
// not spend the job's attempts: it answers `more: 'stopped'` with the wait,
// or no wait for a stop only a person clears (connecting queues the import).
export async function runImportSlice(db, runtime, job, { maxPages = SLICE_PAGES } = {}) {
  let results;
  try {
    results = await mirrorXero(db, runtime, job.organisationId, { maxPages });
  } catch (error) {
    if (!isCallsStopped(error)) throw error;
    return { results: [], more: error.retryAfterMs === null ? null : 'stopped', retryAfterMs: error.retryAfterMs, stoppedBy: error.code };
  }
  // A refused resource waits for a person; it never queues another slice.
  const stopped = results.find((r) => !['done', 'refused'].includes(r.stopped))?.stopped ?? null;
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
    const { more, retryAfterMs } = ran.job.result;
    const wait = more === 'budget' ? BUDGET_WAIT_MS : more === 'stopped' ? Math.max(IDLE_MS, Number(retryAfterMs) || BUDGET_WAIT_MS) : 0;
    await queueHistoryImport(db, ran.job.organisationId, { reason: ran.job.result.more, runAfter: new Date(Number(now()) + wait) });
  }
  return ran;
}

// Failed catalogue reads in a row since the last good one, and the newest
// failure's code.
async function failuresInARow(db, organisationId) {
  const { rows } = await db.execute(sql`
    select count(*)::int as failures,
      (array_agg(error_code order by started_at desc))[1] as last_code
    from xero_sync_runs
    where organisation_id = ${organisationId} and status = 'failed'
      and started_at > coalesce((select max(started_at) from xero_sync_runs
        where organisation_id = ${organisationId} and status = 'succeeded'), 'epoch')`);
  return { failures: rows[0]?.failures ?? 0, lastCode: rows[0]?.last_code ?? null };
}

// The wait after `failures` failed reads in a row: an hour, doubling, at most
// a day (issue #111: never every hour for ever).
export function catalogueRetryMs(failures) {
  return Math.min(CATALOGUE_EVERY_MS, BUDGET_WAIT_MS * 2 ** Math.max(0, failures - 1));
}

// Reads the contacts and items of each connected organisation whose last good
// read is older than a day. A failed read waits longer each time (above). A
// failure is reported once with log.error; the same failure again is a
// warning. While the call guard stops Xero calls, no read is tried.
export async function refreshStaleCatalogues(db, runtime, { now = Date.now, log = console } = {}) {
  const { rows } = await db.execute(sql`select organisation_id, tenant_id from xero_connections where mode = ${runtime.settings.mode}`);
  for (const { organisation_id: organisationId, tenant_id: tenantId } of rows) {
    const last = await lastSync(db, organisationId);
    const at = last?.finishedAt ?? last?.startedAt;
    const { failures, lastCode } = last?.status === 'failed' ? await failuresInARow(db, organisationId) : { failures: 0, lastCode: null };
    if (last && at && Number(now()) - new Date(at) < (last.status === 'succeeded' ? CATALOGUE_EVERY_MS : catalogueRetryMs(failures))) continue;
    try {
      await runtime.guardFor(db).check(tenantId);
    } catch (error) {
      if (isCallsStopped(error)) continue;
      throw error;
    }
    try {
      const run = await syncCatalogue(db, runtime, organisationId);
      log.info?.(`[xero] contacts and items read for organisation ${organisationId}: ${run.contactCount} contacts, ${run.itemCount} items`);
    } catch (error) {
      const code = error?.code ?? 'error';
      const line = `[xero] reading contacts and items for organisation ${organisationId} failed: ${code}; next try in ${Math.round(catalogueRetryMs(failures + 1) / 60_000)} minutes`;
      // The guard reported a stop already; a repeat of the same failure is a warning.
      if (isCallsStopped(error) || (failures > 0 && code === lastCode)) log.warn?.(line);
      else log.error?.(line);
    }
  }
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
        await refreshStaleCatalogues(db, runtime, { log });
        const ran = await runImportOnce(db, runtime, { workerId });
        if (ran) {
          busy = true;
          const read = (ran.job.result?.results ?? []).map((r) => `${r.resource} ${r.read}`).join(', ');
          if (ran.outcome === 'dead') log.error?.('[xero] the history import gave up after its last attempt');
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
