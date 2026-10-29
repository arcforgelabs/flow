import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { READ_BEFORE_ACT_MS } from '../../core/read-before-act.js';
import { seazonaHistoryJobs } from './schema.js';
import { historyWorkItem } from './history/index.js';
import { orderToHistoryJob } from './history/backfill.js';
import { hashOf } from './map.js';
import { readBillableOrder } from './feed.js';
import { readOrder } from './lanes.js';

// Read before act (issue #141). Just before Flow drafts or sends from a job
// whose report is old, it reads that one order from Seazona: one
// GET orders/{id}, through the call guard, stored through the mirror like
// any lane read. The answer is the order as the feed gives it:
//
//   { state: 'read', item }               billable; `item` is a feed item
//   { state: 'withdrawn', ledgerWithdrawn, reason }
//                                          deleted in Seazona, or no longer
//                                          billable
//   { state: 'unavailable', reason }      the read failed or calls are stopped
//
// The day's counts are kept in memory for /health; a restart starts them again.
export function createActReader({ now }) {
  let tally = null;
  function count(key) {
    const day = new Date(Number(now())).toISOString().slice(0, 10);
    if (tally?.day !== day) tally = { day, reads: 0, changed: 0, withdrawn: 0, unavailable: 0 };
    tally[key] += 1;
  }
  const unavailable = (reason) => {
    count('unavailable');
    return { state: 'unavailable', reason };
  };

  async function read({ db, client, settings }, orderId) {
    count('reads');
    let result;
    try {
      result = await readOrder({ db, client, sync: settings.sync, at: new Date(Number(now())) }, orderId, { known: true });
    } catch (error) {
      return unavailable(error?.message || 'the read failed');
    }
    if (result.outcome === 'failed') return unavailable(result.failure?.error || 'the read failed');
    if (result.summary?.changed || result.summary?.created) count('changed');
    const entry = await readBillableOrder(db, orderId);
    if (!entry) return unavailable('Flow has no copy of the order');
    if (entry.withdrawn) {
      count('withdrawn');
      return { state: 'withdrawn', ledgerWithdrawn: entry.withdrawn.ledgerWithdrawn, reason: entry.withdrawn.reason };
    }
    return { state: 'read', item: entry.item };
  }

  // The short claim transaction coalesces workers without holding a database
  // connection while waiting for Seazona. A dead worker's claim expires in
  // fifteen minutes by default (longer for a longer configured wait/retry).
  // Failed opens wait one minute before trying again.
  async function inspect(runtime, orderId, personId) {
    const at = new Date(Number(now()));
    const { db, client, settings } = runtime;
    const leaseMs = Math.max(15 * 60_000, (settings.rate.maxWaitMs + settings.rate.timeoutMs + 60_250) * (settings.rate.maxRetries + 1) + 1000);
    const filter = sql`coalesce(${seazonaHistoryJobs.mirrorOrderId}, ${seazonaHistoryJobs.caseRef}) = ${orderId}`;
    const answer = (row, state = 'read') => ({ state, item: historyWorkItem(row), checkedAt: row.lastCheckedAt, deleted: Boolean(row.deletedInSourceAt) });
    const claim = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`seazona-inspect:${orderId}`}))`);
      const [job] = await tx.select().from(seazonaHistoryJobs).where(filter).limit(1);
      if (!job) return { answer: { state: 'unavailable', reason: 'Flow has no history copy with this order id.' } };
      if (job.lastCheckedAt && at - job.lastCheckedAt <= READ_BEFORE_ACT_MS) return { answer: answer(job, 'fresh') };
      if (job.lastAttemptAt && !job.lastReadError && job.lastAttemptAt > job.lastCheckedAt && at - job.lastAttemptAt < leaseMs) {
        return { answer: { state: 'waiting' } };
      }
      if (job.lastAttemptAt && at - job.lastAttemptAt < 60_000) {
        return { answer: { state: 'unavailable', reason: job.lastReadError ?? 'Try again in a minute.', checkedAt: job.lastCheckedAt } };
      }
      await tx.update(seazonaHistoryJobs).set({ lastAttemptAt: at, lastReadError: null }).where(filter);
      return { job };
    });
    if (claim.answer) return claim.answer;
    const { job } = claim;
    const owned = and(filter, eq(seazonaHistoryJobs.lastAttemptAt, at));
    let result;
    try {
      result = await readOrder({ db, client, sync: settings.sync, at }, orderId, {
        history: true, requestOptions: { priority: 1, personKey: createHash('sha256').update(String(personId)).digest('hex') },
      });
      if (result.outcome === 'failed' || (result.record && !result.record.lines.length)) throw new Error('The order read failed or has no lines.');
    } catch (error) {
      const reason = error?.code === 'seazona_person_read_limit' ? error.message : 'Seazona is unavailable. Check the integration or try again in a minute.';
      await db.update(seazonaHistoryJobs).set({ lastReadError: reason }).where(owned);
      return { state: 'unavailable', reason, checkedAt: job.lastCheckedAt };
    }
    const fields = result.outcome === 'deleted' ? {} : (() => {
      const record = result.record;
      const mapped = orderToHistoryJob(record);
      return { invoiceNumber: record.invoiceNumber, clientId: record.clientId, company: record.company,
        doctorName: record.doctorName, status: record.status, dueDate: mapped.dueDate,
        lines: mapped.lines, subtotalCents: record.subtotalCents, patientReference: record.patientReference };
    })();
    const deletedInSourceAt = result.outcome === 'deleted' ? job.deletedInSourceAt ?? at : null;
    const changed = Object.entries(fields).some(([k, v]) => hashOf(v) !== hashOf(job[k]))
      || Boolean(job.deletedInSourceAt) !== Boolean(deletedInSourceAt);
    // Use completion time for freshness, not time spent waiting in the queue.
    const [updated] = await db.update(seazonaHistoryJobs).set({ ...fields, deletedInSourceAt,
      lastCheckedAt: new Date(Number(now())), lastReadError: null,
      ...(changed ? { lastChangedAt: new Date(Number(now())), recordHash: result.record ? hashOf(orderToHistoryJob(result.record)) : job.recordHash } : {}),
    }).where(owned).returning();
    return updated ? answer(updated) : { state: 'waiting' };
  }

  return { read, inspect, status: () => (tally ? { ...tally } : null) };
}
