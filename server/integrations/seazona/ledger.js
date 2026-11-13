// Seazona work, shaped for the billing obligation ledger (server/core/ledger.js,
// issue #3). The adapter does not import the ledger: the core reads the
// billing feed and passes these shapes to it.
//
//   item.ledgerJob            -> observeJob(db, organisationId, { ...item.ledgerJob, contactId })
//   withdrawn.ledgerWithdrawn -> observeWithdrawn(db, organisationId, withdrawn.ledgerWithdrawn)
//
// One Seazona order is one billable job. The contact is Flow's, so the core
// resolves it (from item.client) and adds contactId; the ledger keeps a job
// without one pending.

export const SEAZONA_SOURCE_SYSTEM = 'seazona';

export function ledgerLine(line) {
  return {
    // The ledger maps a line to a price item by its exact code only.
    itemCode: line.code ?? null,
    description: line.description,
    quantity: 1,
    // A mapped price item can fill unknown amounts or tax.
    // Explicit null tax must not take the legacy GST default.
    unitAmountCents: line.amountCents ?? undefined,
    taxCode: typeof line.taxable === 'boolean' ? (line.taxable ? 'GST' : 'GST_FREE') : null,
  };
}

// The lines that bill the job. When the job's Seazona invoice carries this
// order and no other, its lines are what the lab billed, discounts included.
// When it carries several orders, its lines cannot be split between them, so
// the order's own lines are used and nothing is billed twice.
//
// A Seazona invoice line has the product's id but not its code; the order's
// line for the same product has both. The invoice line takes the code from
// there, so the price list's link for that product maps the line at any price.
export function ledgerLinesFor(item) {
  const invoiceLines = item.invoice?.lines ?? [];
  const useInvoice = item.invoice && item.invoiceOrderCount === 1 && invoiceLines.length > 0;
  if (!useInvoice) return { lines: (item.lines ?? []).map(ledgerLine), linesFrom: 'order' };
  const codeOf = new Map((item.lines ?? []).filter((l) => l.itemId && l.code).map((l) => [l.itemId, l.code]));
  const withCode = (line) => (line.code || !codeOf.has(line.itemId) ? line : { ...line, code: codeOf.get(line.itemId) });
  return { lines: invoiceLines.map((line) => ledgerLine(withCode(line))), linesFrom: 'invoice' };
}

// observeJob's input for one billable feed item, without contactId.
// `observedAt` is the last successful read from Seazona, so the ledger's
// out-of-date check measures how old Seazona's report really is.
export function toLedgerJob(item) {
  const { lines } = ledgerLinesFor(item);
  // Totals remain evidence when an invoice has no lines.
  // A shared invoice cannot supply one job's totals. Never split its tax.
  const sourceTotals = item.invoice && item.invoiceOrderCount === 1 ? {
    subtotalCents: item.invoice.subtotalCents ?? null,
    taxCents: item.invoice.taxCents ?? null,
    totalCents: item.invoice.totalCents ?? null,
  } : null;
  return {
    sourceSystem: SEAZONA_SOURCE_SYSTEM,
    sourceJobRef: item.sourceId,
    sourceInvoiceRef: item.invoiceNumber ?? null,
    // The Seazona order id is the case number. Never patient data.
    caseRef: item.sourceId,
    practitioner: item.doctorName ?? null,
    // The Seazona API gives a shipped status but no shipped date: the
    // ledger keeps the day it first sees the job shipped. A job first seen
    // already shipped takes its Seazona invoice date: the lab invoices the
    // work when it ships it.
    shipped: item.shipped === true,
    shippedEstimate: item.shipped === true ? item.invoice?.invoiceDate ?? null : null,
    // The day of the work, for matching it to its accounting invoice.
    jobDate: item.invoice?.invoiceDate ?? item.dueOn ?? item.orderedOn ?? null,
    // The draft rules bill only the statuses the lab chose (for example Shipped).
    sourceStatus: item.status ?? null,
    remake: item.remake === true,
    lines,
    sourceTotals,
    observedAt: item.syncedAt,
    actor: SEAZONA_SOURCE_SYSTEM,
  };
}

// observeWithdrawn's input for an order that is no longer billable. An
// order deleted in Seazona sends its obligation, if there is one, to review:
// a person decides what happens to any invoice already made. An order whose
// status moved back (for example from Shipped to In Production) loses an
// unsent ready mark, and goes to review when its invoice was made.
export function toLedgerWithdrawn(entry) {
  const deleted = entry.reason === 'deleted_in_seazona';
  return {
    sourceSystem: SEAZONA_SOURCE_SYSTEM,
    sourceJobRef: entry.sourceId,
    sourceStatus: entry.status ?? null,
    deleted,
    reason: deleted ? 'the order was deleted in Seazona' : null,
    observedAt: entry.syncedAt ?? null,
    actor: `system:${SEAZONA_SOURCE_SYSTEM}`,
  };
}
