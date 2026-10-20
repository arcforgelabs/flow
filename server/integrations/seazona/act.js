import { readBillableOrder } from './feed.js';
import { readOrder } from './lanes.js';

// Read before act (issue #141). Just before Flow drafts or sends from a job
// whose report is old, it reads that one order from Seazona: one
// GET orders/{id}, through the call guard, stored through the mirror like
// any lane read. The answer is the order as the feed gives it:
//
//   { state: 'read', item }               billable; `item` is a feed item
//   { state: 'withdrawn', ledgerHold, reason }
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
      return { state: 'withdrawn', ledgerHold: entry.withdrawn.ledgerHold, reason: entry.withdrawn.reason };
    }
    return { state: 'read', item: entry.item };
  }

  return { read, status: () => (tally ? { ...tally } : null) };
}
