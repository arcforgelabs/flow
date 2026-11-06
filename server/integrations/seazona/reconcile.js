import { and, inArray, isNull } from 'drizzle-orm';
import { readBillableWork } from './feed.js';
import { seazonaOrders } from './schema.js';

// Presence is not billing eligibility. Keep a job that returned to an open
// status, lost its lines, or changed its date separate from a missing job.
export async function readWorkJobPresence(db, { jobRefs }) {
  if (!jobRefs.length) return { presentRefs: [] };
  const rows = await db.select({ ref: seazonaOrders.id }).from(seazonaOrders).where(and(
    inArray(seazonaOrders.id, jobRefs), isNull(seazonaOrders.deletedInSourceAt),
  ));
  return { presentRefs: rows.map((row) => row.ref) };
}

// The billable jobs in Flow's copy of Seazona, by day, behind the port's
// `billableJobs` (the daily reconcile, server/core/reconcile.js). It walks the
// billing feed from its start, so a job counts here exactly when the feed
// gives it to the ledger, on the day the ledger files it (its `jobDate`). It
// reads Flow's copy only; it never calls Seazona.
//
// A feed key only moves forward, so an order read again while the walk runs
// is counted once, and none is missed.
export async function readBillableJobs(db, { from, to, pageSize = 1000 } = {}) {
  const jobs = new Map();
  let cursor = null;
  for (;;) {
    const page = await readBillableWork(db, { cursor, limit: pageSize });
    for (const { ledgerJob: job } of page.items) {
      // A job with no lines never reaches the ledger (pipeline.js, ingestWork).
      if (!job.lines.length) {
        jobs.delete(job.sourceJobRef);
        continue;
      }
      if (!job.jobDate || (from && job.jobDate < from) || (to && job.jobDate > to)) {
        jobs.delete(job.sourceJobRef);
        continue;
      }
      // Unknown when a line has no amount: its price item fills it.
      const priced = job.lines.every((l) => Number.isInteger(l.unitAmountCents));
      jobs.set(job.sourceJobRef, {
        ref: job.sourceJobRef,
        day: job.jobDate,
        subtotalCents: priced ? job.lines.reduce((sum, l) => sum + l.unitAmountCents * l.quantity, 0) : null,
      });
    }
    // A job that stopped being billable, or was deleted, is not counted.
    for (const { sourceId } of page.withdrawn) jobs.delete(sourceId);
    if (!page.more) break;
    cursor = page.cursor;
  }
  return { jobs: [...jobs.values()] };
}
