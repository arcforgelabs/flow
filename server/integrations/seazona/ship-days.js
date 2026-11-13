import { and, eq, inArray, isNull } from 'drizzle-orm';
import { billingObligations } from '../../db/schema.js';
import { fillShippedDay } from '../../core/ledger.js';
import { parseSeazonaDate } from './map.js';
import { seazonaHistoryJobs, seazonaInvoices, seazonaOrders } from './schema.js';
import { SEAZONA_SOURCE_SYSTEM } from './ledger.js';

// Ship-days backfill. Seazona's API has a shipped status but no shipped date
// and no status history, so Flow keeps the day it sees a job move to Shipped
// (core/ledger.js). A job Flow first saw already shipped has no day. This
// finds one for each, from Flow's copy of Seazona only (no calls):
//
//   history        the ship date column of the lab's history export
//   invoice_date   the date of the job's Seazona invoice: the lab invoices
//                  the work when it ships it
//
// A dry run (the default) answers what it would set. `apply` writes each day
// on the job, with a "shipped_day" event that names where the day came from.
// A job that has a shipped day keeps it.

const SHIPPED = /\b(shipped|delivered)\b/i;

export async function shipDays(db, organisationId, { apply = false, actor = null } = {}) {
  const jobs = (await db.select({
    id: billingObligations.id, sourceJobRef: billingObligations.sourceJobRef,
    sourceInvoiceRef: billingObligations.sourceInvoiceRef, sourceStatus: billingObligations.sourceStatus,
  }).from(billingObligations).where(and(
    eq(billingObligations.organisationId, organisationId),
    eq(billingObligations.sourceSystem, SEAZONA_SOURCE_SYSTEM),
    isNull(billingObligations.shippedOn),
  ))).filter((o) => SHIPPED.test(o.sourceStatus ?? ''));
  if (!jobs.length) return { ok: true, apply, found: 0, set: 0, none: 0, rows: [] };

  const refs = jobs.map((o) => o.sourceJobRef);
  const [history, orders] = await Promise.all([
    db.select({ ref: seazonaHistoryJobs.mirrorOrderId, shippedDate: seazonaHistoryJobs.shippedDate })
      .from(seazonaHistoryJobs).where(inArray(seazonaHistoryJobs.mirrorOrderId, refs)),
    db.select({ id: seazonaOrders.id, invoiceNumber: seazonaOrders.invoiceNumber })
      .from(seazonaOrders).where(inArray(seazonaOrders.id, refs)),
  ]);
  const shippedOf = new Map(history.filter((h) => h.shippedDate).map((h) => [h.ref, h.shippedDate]));
  const invoiceOfOrder = new Map(orders.map((o) => [o.id, o.invoiceNumber]));
  const numbers = [...new Set(jobs.map((o) => o.sourceInvoiceRef ?? invoiceOfOrder.get(o.sourceJobRef)).filter(Boolean))];
  const invoices = numbers.length
    ? await db.select({ number: seazonaInvoices.invoiceNumber, dateText: seazonaInvoices.invoiceDateText })
      .from(seazonaInvoices).where(inArray(seazonaInvoices.invoiceNumber, numbers))
    : [];
  const dateOf = new Map(invoices.map((i) => [i.number, parseSeazonaDate(i.dateText)]));

  const rows = jobs.map((o) => {
    const number = o.sourceInvoiceRef ?? invoiceOfOrder.get(o.sourceJobRef) ?? null;
    const fromHistory = shippedOf.get(o.sourceJobRef) ?? null;
    const day = fromHistory ?? (number ? dateOf.get(number) ?? null : null);
    return { obligationId: o.id, caseRef: o.sourceJobRef, invoiceRef: number, shippedOn: day, from: fromHistory ? 'history' : day ? 'invoice_date' : null };
  });
  let set = 0;
  if (apply) {
    for (const row of rows.filter((r) => r.shippedOn)) {
      if (await fillShippedDay(db, organisationId, row.obligationId, { day: row.shippedOn, from: row.from, actor })) set += 1;
    }
  }
  return { ok: true, apply, found: rows.length, set, none: rows.filter((r) => !r.shippedOn).length, rows };
}
