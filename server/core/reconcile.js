import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { backgroundJobs, billingObligations, invoices, reviewItems } from '../db/schema.js';
import { HISTORY_ACTOR } from './history.js';
import { soleOrganisation } from './pipeline.js';
import { deadHoldSince, deadSince, enqueueJob, runNextJob } from './queue.js';
import { openReview, resolveReviewFor } from './review.js';

// The daily reconcile (issue 129, docs/RECONCILE.md). Flow checks each record
// as it moves; once a day it also checks the whole. For each of the last
// `days` days it counts and totals the jobs in three places, from Flow's own
// tables only (no call to any other system):
//
// 1. the work system's copy (each adapter's `billableJobs`);
// 2. the billing obligation ledger;
// 3. the Flow invoices the ledger made, and the accounting system's copy of
//    the invoices linked to them (`findInvoices`).
//
// A day where they do not agree opens one review item (`reconcile.day`) with
// the counts, the totals and up to 20 record ids for each difference. A
// difference is an alert only: the reconcile never changes a record. The item
// closes by itself when a later run agrees.
//
// A difference first seen is checked again an hour later, and opens an item
// only when it is still there: a job the pipeline has not reached yet is not
// a difference.

export const RECONCILE_KIND = 'reconcile.daily';
export const RECONCILE_REVIEW_KIND = 'reconcile.day';
export const ACTOR = 'system:reconcile';
export const RECONCILE_DAYS = 60;
export const EVIDENCE_IDS = 20;
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
const RECHECK_MS = 60 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;
const FIND_BATCH = 400;
// Accounting states where the ledger holds a link to an invoice that exists.
// `non_chargeable` is settled in Flow with no accounting invoice expected.
const LINKED = ['drafted', 'authorised', 'part_paid', 'paid'];

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const withGst = (cents) => Math.round(cents * 1.1);

// A stable id for one day's review item, so a repeat finding refreshes it.
export function dayReviewId(organisationId, day) {
  const hex = createHash('sha256').update(`${RECONCILE_REVIEW_KIND}:${organisationId}:${day}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function emptyDay(day) {
  return {
    day,
    work: { count: 0, subtotalCents: 0, unpriced: 0 },
    ledger: { count: 0, subtotalCents: 0, totalCents: 0 },
    flowInvoices: { count: 0, totalCents: 0 },
    accounting: { linked: 0, found: 0, totalCents: 0 },
    differences: {
      missingInLedger: [], missingInWork: [], missingInAccounting: [], accountingTotalDiffers: [],
    },
  };
}

const differenceCount = (entry) => Object.values(entry.differences).reduce((n, list) => n + list.length, 0);

// The evidence a review item keeps: the counts, the totals, and up to
// EVIDENCE_IDS ids for each difference with the full count beside them.
function evidenceFor(entry) {
  const differences = {};
  for (const [key, list] of Object.entries(entry.differences)) {
    if (list.length) differences[key] = { count: list.length, ids: list.slice(0, EVIDENCE_IDS).map((d) => d.id) };
  }
  return { ...entry, differences };
}

const moneyAtRisk = (entry) => Object.values(entry.differences).flat()
  .reduce((cents, d) => cents + Math.abs(d.cents ?? 0), 0);

// One pass over Flow's own tables. Answers one entry per day, oldest first.
export async function reconcileDays(db, organisationId, { integrations, from, to }) {
  const byDay = new Map();
  const dayOf = (day) => {
    if (!byDay.has(day)) byDay.set(day, emptyDay(day));
    return byDay.get(day);
  };

  // 1. The work systems' copies.
  const workAdapters = integrations?.with('billableJobs') ?? [];
  const work = new Map(); // `${system}:${ref}` -> job
  for (const adapter of workAdapters) {
    const { jobs } = await adapter.capabilities.billableJobs({ organisationId, from, to });
    for (const job of jobs) {
      if (!job.day || job.day < from || job.day > to) continue;
      work.set(`${adapter.id}:${job.ref}`, { ...job, system: adapter.id });
      const entry = dayOf(job.day);
      entry.work.count += 1;
      if (Number.isInteger(job.subtotalCents)) entry.work.subtotalCents += job.subtotalCents;
      else entry.work.unpriced += 1;
    }
  }

  // 2. The ledger. A job only a history import reported is left out: the
  // import keeps its own reconciliation record (docs/SEAZONA.md).
  const obligations = await db.select({
    id: billingObligations.id,
    sourceSystem: billingObligations.sourceSystem,
    sourceJobRef: billingObligations.sourceJobRef,
    jobDate: billingObligations.jobDate,
    subtotalCents: billingObligations.subtotalCents,
    totalCents: billingObligations.totalCents,
    accountingState: billingObligations.accountingState,
    accountingRef: billingObligations.accountingRef,
    invoiceId: billingObligations.invoiceId,
    invoiceStatus: invoices.status,
    invoiceTotalCents: invoices.totalCents,
  })
    .from(billingObligations)
    .leftJoin(invoices, and(eq(invoices.organisationId, billingObligations.organisationId), eq(invoices.id, billingObligations.invoiceId)))
    .where(and(
      eq(billingObligations.organisationId, organisationId),
      gte(billingObligations.jobDate, from),
      lte(billingObligations.jobDate, to),
      sql`exists (select 1 from obligation_events e
        where e.organisation_id = ${billingObligations.organisationId} and e.obligation_id = ${billingObligations.id}
          and e.kind in ('observed', 'source_changed') and e.actor <> ${HISTORY_ACTOR})`,
    ));

  const reported = new Set(workAdapters.map((a) => a.id));
  const inLedger = new Set();
  for (const o of obligations) {
    const entry = dayOf(o.jobDate);
    entry.ledger.count += 1;
    entry.ledger.subtotalCents += o.subtotalCents;
    entry.ledger.totalCents += o.totalCents;
    if (o.invoiceId) {
      entry.flowInvoices.count += 1;
      entry.flowInvoices.totalCents += o.invoiceTotalCents ?? 0;
    }
    // Only a work system that is on can say a job is gone from its copy.
    if (reported.has(o.sourceSystem)) {
      const key = `${o.sourceSystem}:${o.sourceJobRef}`;
      inLedger.add(key);
      if (!work.has(key)) entry.differences.missingInWork.push({ id: o.id, cents: o.totalCents });
    }
  }
  for (const [key, job] of work) {
    if (!inLedger.has(key)) dayOf(job.day).differences.missingInLedger.push({ id: job.ref, cents: job.subtotalCents ?? 0 });
  }

  // 3. The accounting system's copy of each linked invoice.
  const [accounting] = integrations?.with('findInvoices') ?? [];
  const linked = obligations.filter((o) => o.accountingRef && LINKED.includes(o.accountingState));
  if (accounting) {
    const copies = new Map();
    for (let i = 0; i < linked.length; i += FIND_BATCH) {
      const invoiceIds = linked.slice(i, i + FIND_BATCH).map((o) => o.accountingRef);
      const { invoices: found } = await accounting.capabilities.findInvoices({ organisationId, invoiceIds });
      for (const invoice of found) copies.set(String(invoice.id), invoice);
    }
    for (const o of linked) {
      const entry = dayOf(o.jobDate);
      entry.accounting.linked += 1;
      const copy = copies.get(String(o.accountingRef));
      if (!copy) {
        entry.differences.missingInAccounting.push({ id: o.id, cents: o.totalCents });
        continue;
      }
      entry.accounting.found += 1;
      entry.accounting.totalCents += copy.totalCents ?? 0;
      // An invoice Flow issued must carry Flow's total. One Flow only matched
      // may carry the job's total with or without GST, as the matcher allows.
      const expected = o.invoiceId && o.invoiceStatus === 'issued'
        ? [o.invoiceTotalCents]
        : [o.totalCents, o.subtotalCents, withGst(o.subtotalCents)];
      if (copy.totalCents !== null && !expected.includes(copy.totalCents)) {
        entry.differences.accountingTotalDiffers.push({ id: o.id, cents: copy.totalCents - expected[0] });
      }
    }
  }

  return {
    systems: { work: workAdapters.map((a) => a.id), accounting: accounting?.id ?? null },
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

async function openDayItems(db, organisationId) {
  const rows = await db.select({ flowId: reviewItems.flowId, evidence: reviewItems.evidence }).from(reviewItems).where(and(
    eq(reviewItems.organisationId, organisationId),
    eq(reviewItems.kind, RECONCILE_REVIEW_KIND),
    eq(reviewItems.state, 'open'),
  ));
  return new Map(rows.map((r) => [r.evidence?.day, r.flowId]).filter(([day]) => day));
}

// One run: reconcile, open or refresh an item for each day that still
// differs, and close the item of each day that now agrees. `unconfirmed` are
// the days the last run found different for the first time. Answers the
// summary the job keeps (GET /health shows it).
export async function runReconcile(db, organisationId, {
  integrations, now = Date.now(), days = RECONCILE_DAYS, unconfirmed = [],
}) {
  const to = isoDay(now);
  const open = await openDayItems(db, organisationId);
  // An open item older than the window is checked too, so it can close.
  const oldest = [...open.keys()].reduce((min, day) => (day < min ? day : min), isoDay(now - (days - 1) * 86_400_000));
  const { systems, days: entries } = await reconcileDays(db, organisationId, { integrations, from: oldest, to });
  const differing = entries.filter((e) => differenceCount(e) > 0);
  const recheck = new Set(unconfirmed);
  const firstSeen = [];
  let opened = 0;
  for (const entry of differing) {
    if (!open.has(entry.day) && !recheck.has(entry.day)) {
      firstSeen.push(entry.day);
      continue;
    }
    await openReview(db, organisationId, {
      kind: RECONCILE_REVIEW_KIND,
      entity: 'day',
      flowId: dayReviewId(organisationId, entry.day),
      systems: [...systems.work, ...(systems.accounting ? [systems.accounting] : [])],
      evidence: evidenceFor(entry),
      moneyAtRiskCents: moneyAtRisk(entry),
    });
    opened += 1;
  }
  const differs = new Set(differing.map((e) => e.day));
  let closed = 0;
  for (const [day, flowId] of open) {
    if (differs.has(day)) continue;
    await resolveReviewFor(db, organisationId, {
      kind: RECONCILE_REVIEW_KIND, entity: 'day', flowId, resolution: 'a later run agreed', actor: ACTOR,
    });
    closed += 1;
  }
  return {
    from: oldest,
    to,
    systems,
    daysChecked: entries.length,
    daysDifferent: differing.length,
    openItems: (await openDayItems(db, organisationId)).size,
    opened,
    closed,
    unconfirmed: firstSeen,
  };
}

async function lastRun(db, organisationId) {
  const [row] = await db.select().from(backgroundJobs).where(and(
    eq(backgroundJobs.organisationId, organisationId),
    eq(backgroundJobs.kind, RECONCILE_KIND),
    inArray(backgroundJobs.state, ['succeeded', 'failed', 'dead']),
  )).orderBy(desc(backgroundJobs.updatedAt)).limit(1);
  return row ?? null;
}

// The last run and its result, for GET /health: counts only, no record ids.
export async function reconcileHealth(db, { now = Date.now() } = {}) {
  const organisationId = await soleOrganisation(db);
  if (!organisationId) return null;
  const row = await lastRun(db, organisationId);
  if (!row) return { lastRunAt: null };
  const result = row.state === 'succeeded' ? row.result ?? {} : {};
  return {
    lastRunAt: row.updatedAt.toISOString(),
    state: row.state,
    ...(row.state === 'succeeded' ? {
      agrees: result.daysDifferent === 0,
      daysChecked: result.daysChecked ?? null,
      daysDifferent: result.daysDifferent ?? null,
      openItems: result.openItems ?? null,
      late: now - row.updatedAt.getTime() > RUN_EVERY_MS + 2 * TICK_MS + LEASE_MS,
    } : { error: row.lastError }),
  };
}

// Is a run due? Once a day, and an hour after a run that found a new difference.
export function reconcileDue(last, nowMs) {
  if (!last) return true;
  const age = nowMs - last.updatedAt.getTime();
  if (last.state !== 'succeeded') return age >= RECHECK_MS;
  if ((last.result?.unconfirmed ?? []).length) return age >= RECHECK_MS;
  return age >= RUN_EVERY_MS;
}

// The worker: every ten minutes it asks whether a run is due, and runs it on
// the job queue, so two Flow processes never run it at once. It runs only
// while an integration that feeds it is on.
export function createReconcileWorker({
  db, integrations, log = console, timers = { setTimeout, clearTimeout }, now = Date.now, everyMs = TICK_MS, firstDelayMs = 60_000,
}) {
  const workerId = `reconcile-${randomUUID()}`;
  const startedAtMs = now();
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
    running = (async () => {
      try {
        if (!integrations?.with('billableJobs').length && !integrations?.with('findInvoices').length) return;
        const organisationId = await soleOrganisation(db);
        if (!organisationId) return;
        const last = await lastRun(db, organisationId);
        if (!reconcileDue(last, now())) return;
        if (await deadSince(db, organisationId, { kind: RECONCILE_KIND, dedupeKey: 'all', since: deadHoldSince(startedAtMs, now()) })) return;
        const unconfirmed = last?.state === 'succeeded' ? last.result?.unconfirmed ?? [] : [];
        await enqueueJob(db, organisationId, { kind: RECONCILE_KIND, dedupeKey: 'all', maxAttempts: 3 });
        const ran = await runNextJob(db, {
          workerId,
          leaseMs: LEASE_MS,
          handlers: { [RECONCILE_KIND]: () => runReconcile(db, organisationId, { integrations, now: now(), unconfirmed }) },
        });
        if (!ran) return;
        if (ran.outcome === 'dead') log.error?.('[reconcile] the daily reconcile gave up after its last attempt');
        else if (ran.outcome === 'succeeded') {
          const { daysChecked, daysDifferent, opened, closed } = ran.job.result;
          (daysDifferent ? log.warn : log.info)?.(`[reconcile] ${daysChecked} days checked, ${daysDifferent} differ; ${opened} items open or refreshed, ${closed} closed`);
        } else log.warn?.(`[reconcile] ${ran.outcome}: ${ran.job.lastError}`);
      } catch (error) {
        log.error?.(`[reconcile] ${error?.code ?? 'error'}: ${error?.message ?? error}`);
      }
    })();
    await running;
    running = null;
    schedule(everyMs);
  }

  return {
    start() {
      stopped = false;
      schedule(firstDelayMs);
    },
    async stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      await running;
    },
    tick,
  };
}
