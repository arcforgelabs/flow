// Seazona work, shaped for the billing obligation ledger (server/core/ledger.js,
// issue #3). The adapter does not import the ledger: the core reads the
// billing feed and passes these shapes to it.
//
//   item.ledgerJob       -> observeJob(db, organisationId, { ...item.ledgerJob, contactId })
//   withdrawn.ledgerHold -> setHold(db, organisationId, <obligation id>, { ...ledgerHold, actor })
//
// One Seazona order is one billable job. The contact is Flow's, so the core
// resolves it (from item.client) and adds contactId; the ledger keeps a job
// without one pending.

export const SEAZONA_SOURCE_SYSTEM = 'seazona';

function ledgerLine(line) {
  return {
    // The ledger maps a line to a price item by its exact code only.
    itemCode: line.code ?? null,
    description: line.description,
    quantity: 1,
    // Unknown amount or tax: the price item with the same code fills them.
    unitAmountCents: line.amountCents ?? undefined,
    taxCode: typeof line.taxable === 'boolean' ? (line.taxable ? 'GST' : 'GST_FREE') : undefined,
  };
}

// The lines that bill the job. When the job's Seazona invoice carries this
// order and no other, its lines are what the lab billed, discounts included.
// When it carries several orders, its lines cannot be split between them, so
// the order's own lines are used and nothing is billed twice.
export function ledgerLinesFor(item) {
  const invoiceLines = item.invoice?.lines ?? [];
  const useInvoice = item.invoice && item.invoiceOrderCount === 1 && invoiceLines.length > 0;
  return { lines: (useInvoice ? invoiceLines : item.lines ?? []).map(ledgerLine), linesFrom: useInvoice ? 'invoice' : 'order' };
}

// observeJob's input for one billable feed item, without contactId.
// `observedAt` is the last successful read from Seazona, so the ledger's
// out-of-date check measures how old Seazona's report really is.
export function toLedgerJob(item) {
  return {
    sourceSystem: SEAZONA_SOURCE_SYSTEM,
    sourceJobRef: item.sourceId,
    sourceInvoiceRef: item.invoiceNumber ?? null,
    // The Seazona order id is the case number. Never patient data.
    caseRef: item.sourceId,
    practitioner: item.doctorName ?? null,
    // The Seazona API gives a shipped status but no shipped date.
    shippedOn: null,
    // The day of the work, for matching it to its accounting invoice.
    jobDate: item.invoice?.invoiceDate ?? item.dueOn ?? item.orderedOn ?? null,
    // The draft rules bill only the statuses the lab chose (for example Shipped).
    sourceStatus: item.status ?? null,
    lines: ledgerLinesFor(item).lines,
    observedAt: item.syncedAt,
    actor: SEAZONA_SOURCE_SYSTEM,
  };
}

// An order deleted in Seazona sends its obligation, if there is one, to
// review: a person decides what happens to any invoice already made. An order
// that only stopped being billable needs nothing from the ledger.
export function toLedgerHold(entry) {
  if (entry.reason !== 'deleted_in_seazona') return null;
  return {
    sourceSystem: SEAZONA_SOURCE_SYSTEM,
    sourceJobRef: entry.sourceId,
    holdState: 'review',
    reason: 'the order was deleted in Seazona',
  };
}
