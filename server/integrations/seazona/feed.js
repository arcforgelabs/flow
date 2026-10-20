import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { ledgerLinesFor, toLedgerHold, toLedgerJob } from './ledger.js';
import { isFinalStatus, orderStatusLabel, parseSeazonaDate } from './map.js';
import { seazonaClients, seazonaInvoices, seazonaOrders, seazonaReference } from './schema.js';

// The billing feed behind the port's pullWorkItems: every order that changed
// since a cursor, oldest change first. A complete or shipped order is an
// item, with the Seazona invoice that carries it and its client. Any other
// changed order comes back in `withdrawn`, so invoice preparation can drop
// work it holds: an order deleted in Seazona is never an item (issue #12).
//
// The cursor is opaque; pass back `cursor` from the last page. A change to
// the order or to its invoice moves the order to the end of the feed.
//
// A read that found no change moves the order to the end of the feed too, at
// most once an hour (`SEEN_STEP`). Without it, an order that never changes
// is reported once, its ledger report gets older than a day, and the ledger
// refuses its draft as "out of date" for ever, though the lanes read the
// order every few minutes.

const BILLABLE = /\b(complete|completed|shipped|delivered)\b/i;
const SHIPPED = /\b(shipped|delivered)\b/i;
const SEEN_STEP = 'hour';

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

// One order, its invoice and its client, as the feed reads them.
function feedQuery(db, changedAt) {
  return db.select({
    order: seazonaOrders,
    invoice: seazonaInvoices,
    client: { accountNumber: seazonaClients.accountNumber, company: seazonaClients.company, email: seazonaClients.email },
    // How many orders carry the same Seazona invoice (ledger.js, ledgerLinesFor).
    invoiceOrderCount: sql`(select count(*)::int from ${seazonaOrders} as same where same.invoice_number = ${seazonaOrders.invoiceNumber} and same.deleted_in_source_at is null)`,
    changedAt: sql`to_char(${changedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  })
    .from(seazonaOrders)
    .leftJoin(seazonaInvoices, eq(seazonaInvoices.invoiceNumber, seazonaOrders.invoiceNumber))
    .leftJoin(seazonaClients, eq(seazonaClients.id, seazonaOrders.clientId));
}

// A feed row as an item, or as a withdrawn entry when it is not billable.
function toFeedEntry({ order, invoice, client, invoiceOrderCount }) {
  const billable = !order.deletedInSourceAt && BILLABLE.test(order.status ?? '');
  if (!billable) {
    const entry = {
      sourceId: order.id,
      status: orderStatusLabel(order),
      reason: order.deletedInSourceAt ? 'deleted_in_seazona' : 'not_billable',
    };
    return { withdrawn: { ...entry, ledgerHold: toLedgerHold(entry) } };
  }
  const item = {
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
    invoiceOrderCount: order.invoiceNumber ? Number(invoiceOrderCount) : 0,
  };
  return { item: { ...item, linesFrom: ledgerLinesFor(item).linesFrom, ledgerJob: toLedgerJob(item) } };
}

export async function readBillableWork(db, { cursor = null, limit = 200 } = {}) {
  const after = decodeCursor(cursor);
  const changedAt = sql`greatest(${seazonaOrders.lastChangedAt}, coalesce(${seazonaInvoices.lastChangedAt}, ${seazonaOrders.lastChangedAt}), date_trunc(${SEEN_STEP}, ${seazonaOrders.lastSyncedAt}))`;
  const pageSize = Math.max(1, Math.min(1000, limit));
  const rows = await feedQuery(db, changedAt)
    .where(after ? sql`(${changedAt}, ${seazonaOrders.id}) > (${after.at}::timestamptz, ${after.id})` : undefined)
    .orderBy(changedAt, seazonaOrders.id)
    .limit(pageSize);

  const items = [];
  const withdrawn = [];
  for (const row of rows) {
    const entry = toFeedEntry(row);
    if (entry.item) items.push(entry.item);
    else withdrawn.push(entry.withdrawn);
  }
  const lastRow = rows.at(-1);
  return {
    items,
    withdrawn,
    cursor: lastRow ? encodeCursor(lastRow.changedAt, lastRow.order.id) : cursor,
    more: rows.length === pageSize,
  };
}

// One order as the feed gives it (issue #141, read before act): `{ item }`
// when it is billable, `{ withdrawn }` when it is not, or null when Flow's
// copy does not have it.
export async function readBillableOrder(db, orderId) {
  const [row] = await feedQuery(db, seazonaOrders.lastChangedAt).where(eq(seazonaOrders.id, orderId));
  return row ? toFeedEntry(row) : null;
}

// Seazona clients, by id and the company name an invoice bills. A client
// with no company name is listed by its full name. A client the client list
// never gave (the list can be closed to an API client) is listed by the
// company name its orders carry, so its jobs still find their customer.
export async function listClients(db) {
  const rows = await db.select({ id: seazonaClients.id, company: seazonaClients.company, fullName: seazonaClients.fullName, active: seazonaClients.active })
    .from(seazonaClients);
  const listed = rows
    .filter((r) => r.active !== false)
    .map((r) => ({ id: r.id, name: (r.company || r.fullName || '').trim() }))
    .filter((r) => r.name);
  const known = new Set(rows.map((r) => r.id));
  const fromOrders = await db.selectDistinctOn([seazonaOrders.clientId], { id: seazonaOrders.clientId, company: seazonaOrders.company })
    .from(seazonaOrders)
    .where(sql`${seazonaOrders.clientId} is not null and coalesce(${seazonaOrders.company}, '') <> '' and ${seazonaOrders.deletedInSourceAt} is null`)
    .orderBy(seazonaOrders.clientId, sql`${seazonaOrders.lastChangedAt} desc`);
  return [
    ...listed,
    ...fromOrders.filter((r) => !known.has(r.id)).map((r) => ({ id: r.id, name: r.company.trim() })),
  ];
}

// Seazona's products, from Flow's copy (the products lane reads them daily),
// for the price list's links and price check (server/core/price-list.js).
// Seazona says only whether a product is taxable: taxable reads as GST.
export async function listProducts(db) {
  const rows = await db.select({
    id: seazonaReference.id, code: seazonaReference.code, name: seazonaReference.name,
    priceCents: seazonaReference.priceCents, taxable: seazonaReference.taxable, syncedAt: seazonaReference.lastSyncedAt,
  }).from(seazonaReference).where(eq(seazonaReference.resource, 'products'));
  return {
    kind: 'work',
    syncedAt: rows.reduce((at, r) => (!at || r.syncedAt > at ? r.syncedAt : at), null),
    items: rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      unitAmountCents: r.priceCents === null ? null : Number(r.priceCents),
      taxCode: r.taxable === null ? null : (r.taxable ? 'GST' : 'GST_FREE'),
      sold: true,
    })),
  };
}

// A final order (shipped, delivered, cancelled; map.js isFinalStatus) stays on
// the Jobs board this long after it last changed.
export const WORK_FINISHED_DAYS = 30;
const WORK_LIMIT = 2000;
const FINAL_SQL = sql`coalesce(${seazonaOrders.status}, '') ~* '(shipped|delivered|cancelled|canceled|void|closed|archived|deleted)'`;

// The orders behind the port's listWork, for the Jobs board: every open
// order, and each final order that changed in the last WORK_FINISHED_DAYS
// days, newest change first. An order deleted in Seazona is never listed.
// The client name is the Seazona client's company (or full name), else the
// order's own company. `statuses` lists each status once, with the first time
// Flow saw an order in it, so the board can order its columns.
export async function listWork(db, { now = Date.now(), finishedDays = WORK_FINISHED_DAYS, limit = WORK_LIMIT } = {}) {
  const since = new Date(now - finishedDays * 86_400_000);
  const rows = await db.select({ order: seazonaOrders, company: seazonaClients.company, fullName: seazonaClients.fullName })
    .from(seazonaOrders)
    .leftJoin(seazonaClients, eq(seazonaClients.id, seazonaOrders.clientId))
    .where(and(isNull(seazonaOrders.deletedInSourceAt), or(sql`not (${FINAL_SQL})`, gte(seazonaOrders.lastChangedAt, since))))
    .orderBy(desc(seazonaOrders.lastChangedAt), seazonaOrders.id)
    .limit(limit);
  const firstSeen = new Map();
  const items = rows.map(({ order, company, fullName }) => {
    const status = orderStatusLabel(order) || null;
    const seen = firstSeen.get(status);
    if (status && (!seen || order.firstSeenAt < seen)) firstSeen.set(status, order.firstSeenAt);
    return {
      sourceSystem: 'seazona',
      sourceJobRef: order.id,
      // The Seazona order id is the case number. Never patient data.
      caseRef: order.id,
      status,
      clientId: order.clientId,
      clientName: (company || order.company || fullName || '').trim() || null,
      practitioner: order.doctorName,
      department: order.department,
      orderedOn: parseSeazonaDate(order.orderedText),
      dueOn: parseSeazonaDate(order.dueText),
      lines: (order.lines ?? []).map((l) => ({ code: l.code ?? null, description: l.description, amountCents: l.amountCents ?? null })),
      totalCents: order.subtotalCents,
    };
  });
  return {
    items,
    statuses: [...firstSeen].map(([label, at]) => ({ label, final: isFinalStatus(label), firstSeenAt: at.toISOString() })),
  };
}
