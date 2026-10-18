import { eq, sql } from 'drizzle-orm';
import { orderStatusLabel, parseSeazonaDate } from './map.js';
import { seazonaClients, seazonaInvoices, seazonaOrders } from './schema.js';

// The billing feed behind the port's pullWorkItems: every order that changed
// since a cursor, oldest change first. A complete or shipped order is an
// item, with the Seazona invoice that carries it and its client. Any other
// changed order comes back in `withdrawn`, so invoice preparation can drop
// work it holds: an order deleted in Seazona is never an item (issue #12).
//
// The cursor is opaque; pass back `cursor` from the last page. A change to
// the order or to its invoice moves the order to the end of the feed.

const BILLABLE = /\b(complete|completed|shipped|delivered)\b/i;
const SHIPPED = /\b(shipped|delivered)\b/i;

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const { at, id } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof id === 'string' && typeof at === 'string' && at) return { at, id };
  } catch { /* fall through */ }
  throw new TypeError('Not a Seazona feed cursor');
}

// `at` is PostgreSQL's own text for the time, so no precision is lost.
function encodeCursor(at, id) {
  return Buffer.from(JSON.stringify({ at, id })).toString('base64url');
}

export async function readBillableWork(db, { cursor = null, limit = 200 } = {}) {
  const after = decodeCursor(cursor);
  const changedAt = sql`greatest(${seazonaOrders.lastChangedAt}, coalesce(${seazonaInvoices.lastChangedAt}, ${seazonaOrders.lastChangedAt}))`;
  const pageSize = Math.max(1, Math.min(1000, limit));
  const rows = await db.select({
    order: seazonaOrders,
    invoice: seazonaInvoices,
    client: { accountNumber: seazonaClients.accountNumber, company: seazonaClients.company, email: seazonaClients.email },
    changedAt: sql`to_char(${changedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  })
    .from(seazonaOrders)
    .leftJoin(seazonaInvoices, eq(seazonaInvoices.invoiceNumber, seazonaOrders.invoiceNumber))
    .leftJoin(seazonaClients, eq(seazonaClients.id, seazonaOrders.clientId))
    .where(after ? sql`(${changedAt}, ${seazonaOrders.id}) > (${after.at}::timestamptz, ${after.id})` : undefined)
    .orderBy(changedAt, seazonaOrders.id)
    .limit(pageSize);

  const items = [];
  const withdrawn = [];
  for (const { order, invoice, client } of rows) {
    const billable = !order.deletedInSourceAt && BILLABLE.test(order.status ?? '');
    if (!billable) {
      withdrawn.push({
        sourceId: order.id,
        status: orderStatusLabel(order),
        reason: order.deletedInSourceAt ? 'deleted_in_seazona' : 'not_billable',
      });
      continue;
    }
    items.push({
      source: 'seazona',
      sourceId: order.id,
      invoiceNumber: order.invoiceNumber,
      status: order.status,
      shipped: SHIPPED.test(order.status ?? ''),
      clientId: order.clientId,
      company: order.company,
      doctorName: order.doctorName,
      orderedOn: parseSeazonaDate(order.orderedText),
      dueOn: parseSeazonaDate(order.dueText),
      lines: order.lines,
      subtotalCents: order.subtotalCents,
      patientReference: order.patientReference,
      syncedAt: order.lastSyncedAt.toISOString(),
      invoice: invoice ? {
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        accountNumber: invoice.accountNumber,
        invoiceDate: parseSeazonaDate(invoice.invoiceDateText),
        dueDate: parseSeazonaDate(invoice.dueText),
        lines: invoice.lines,
        subtotalCents: invoice.subtotalCents,
        taxCents: invoice.taxCents,
        totalCents: invoice.totalCents,
        discountCents: invoice.discountCents,
        patientReference: invoice.patientReference,
      } : null,
      client: client?.accountNumber || client?.company || client?.email ? client : null,
    });
  }
  const lastRow = rows.at(-1);
  return {
    items,
    withdrawn,
    cursor: lastRow ? encodeCursor(lastRow.changedAt, lastRow.order.id) : cursor,
    more: rows.length === pageSize,
  };
}
