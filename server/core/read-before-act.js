import { and, eq } from 'drizzle-orm';
import { billingObligations } from '../db/schema.js';
import { FlowError } from './errors.js';
import { observeJob, observeWithdrawn } from './ledger.js';
import { matchJobs, workJobMaker } from './pipeline.js';

// Read before act (issue #141). Flow drafts and sends from its own copy of
// the work system. Just before a draft, and before Send all ready, a job
// whose work system report is older than READ_BEFORE_ACT_MS is read again
// from the work system (its readWorkItem capability): one call per job. What
// the read finds goes into the ledger as any report does (observeJob), so a
// change after the invoice was made sends the job to review there.
//
// A job the work system deleted, or that is no longer billable, goes through
// the ledger's observeWithdrawn like a feed report: review when it was
// deleted or already has its invoice. A job that is not billable now, or a
// read that cannot run, waits: Flow never drafts or sends from an old copy.
//
// The lanes re-report each job they read at most once an hour
// (seazona/feed.js), so most reports are under two hours old and cost no
// call here.

export const READ_BEFORE_ACT_MS = 2 * 60 * 60 * 1000;
// The most reads one pipeline run or one Send all ready press makes; the
// other old jobs wait for the next one. Seazona's calls are spaced 2 s apart.
export const READS_PER_PASS = 20;
const NO_LONGER_BILLABLE = 'the work system no longer reports the job as billable';

// Reads each job that needs it. `work` is the work integration, or null.
// Answers Map(obligationId -> { outcome, obligation, reason? }), where
// outcome is fresh (no read needed), read, review (sent to review) or
// waiting (the read could not run).
// `force` reads even a fresh report (a person's "Recheck").
export async function readBeforeAct(db, organisationId, obligations, { work, now = new Date(), actor, force = false }) {
  const outcomes = new Map();
  let toJob = null;
  for (const obligation of obligations) {
    if (!needsRead(obligation, { work, now: force ? new Date(8.64e15) : now })) {
      outcomes.set(obligation.id, { outcome: 'fresh', obligation });
      continue;
    }
    const answer = await work.capabilities.readWorkItem({ sourceJobRef: obligation.sourceJobRef });
    if (answer?.state === 'read') {
      toJob ??= await workJobMaker(db, organisationId, work);
      try {
        await observeJob(db, organisationId, toJob(answer.item));
      } catch (error) {
        if (!(error instanceof FlowError) || error.code !== 'invalid') throw error;
        outcomes.set(obligation.id, { outcome: 'waiting', obligation, reason: 'the work system job has no lines' });
        continue;
      }
      const fresh = await reload(db, organisationId, obligation.id);
      outcomes.set(obligation.id, { outcome: fresh.holdState === 'review' ? 'review' : 'read', obligation: fresh });
    } else if (answer?.state === 'withdrawn') {
      // The ledger decides as for the feed (observeWithdrawn): deleted, or
      // moved back after its invoice, goes to review; moved back while only
      // ready clears the ready mark.
      if (answer.ledgerWithdrawn) await observeWithdrawn(db, organisationId, { ...answer.ledgerWithdrawn, actor });
      const row = await reload(db, organisationId, obligation.id);
      outcomes.set(obligation.id, row.holdState === 'review'
        ? { outcome: 'review', obligation: row, reason: row.holdReason }
        : { outcome: 'waiting', obligation: row, reason: NO_LONGER_BILLABLE });
    } else {
      outcomes.set(obligation.id, { outcome: 'waiting', obligation, reason: answer?.reason || 'the work system read failed' });
    }
  }
  return outcomes;
}

// True when the job's report is old and its work system can read it now.
export function needsRead(obligation, { work, now = new Date() }) {
  return typeof work?.capabilities?.readWorkItem === 'function'
    && obligation.sourceSystem === work.id
    && now - new Date(obligation.sourceSeenAt) > READ_BEFORE_ACT_MS;
}

// The accounting side of read before act (issue #45, step 5): once per
// automatic draft pass or Send all ready press, before the first draft or
// send, the accounting system reads its latest changes into its copy (its
// readChanges capability). When the copy changed, the matcher runs first, so
// a job someone invoiced in the accounting system meanwhile is linked to that
// invoice and never drafted or sent twice. Answers { outcome, reason? }:
// fresh or read (act), or waiting (act on nothing now).
export async function readAccountingFirst(db, organisationId, { accounting, now = new Date() }) {
  if (typeof accounting?.capabilities?.readChanges !== 'function') return { outcome: 'fresh' };
  const answer = await accounting.capabilities.readChanges({ organisationId });
  if (answer?.state === 'fresh') return { outcome: 'fresh' };
  if (answer?.state !== 'read') return { outcome: 'waiting', reason: answer?.reason || 'the accounting system read failed' };
  if (answer.changed) await matchJobs(db, organisationId, { accounting, now });
  return { outcome: 'read', changed: answer.changed ?? 0 };
}

async function reload(db, organisationId, id) {
  const [row] = await db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, id)));
  return row;
}
