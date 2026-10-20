import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isCallsStopped } from '../call-guard.js';
import { parseXeroDate } from './catalogue.js';
import { withXeroLane } from './governor.js';

// Flow's copy of the connected organisation's Xero invoices, credit notes and
// payments (docs/DATA_SPINE.md, issue 54). Xero owns these records. Flow keeps
// them so its reports cover the years before it was installed, and so the
// ledger and the identity map can link them without spending Xero calls.
//
// Each resource keeps a cursor. A read asks Xero for the records changed since
// the cursor, oldest change first, one page at a time, and stores each page in
// one transaction with the cursor's next position. So a read can stop at any
// page (the day's call budget, an error, a restart) and the next read goes on
// from there. The first read has no cursor and copies the whole history; every
// later read copies only changes.
//
// Paging is by time, not by page number: after a full page the cursor moves to
// the last record's change time (less one second), so a record that changes
// during a read moves ahead of the cursor and is read again, never skipped.
// Only when one second holds a whole page does the page number move on.

export const MIRROR_RESOURCES = Object.freeze(['invoices', 'credit_notes', 'payments']);

// A Xero amount (a JSON number with up to 4 decimals) to whole cents, half away
// from zero, without float drift.
export function toCents(amount) {
  if (amount === null || amount === undefined || amount === '') return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const digits = `${fraction}000`;
  let cents = Number(whole) * 100 + Number(digits.slice(0, 2));
  if (Number(digits[2]) >= 5) cents += 1;
  return sign ? -cents : cents;
}

// A Xero date to a calendar date (YYYY-MM-DD), as Xero shows it.
function toDay(value) {
  const at = parseXeroDate(value);
  return at ? at.toISOString().slice(0, 10) : null;
}

const text = (value, keep) => (keep && value ? String(value) : null);

function mapLines(lines, keep) {
  return (lines ?? []).map((line) => ({
    lineItemId: line.LineItemID ?? null,
    itemCode: line.ItemCode || null,
    description: text(line.Description, keep),
    quantity: line.Quantity ?? null,
    unitAmount: line.UnitAmount ?? null,
    lineAmountCents: toCents(line.LineAmount),
    taxAmountCents: toCents(line.TaxAmount),
    discountRate: line.DiscountRate ?? null,
    accountCode: line.AccountCode || null,
    taxType: line.TaxType || null,
  }));
}

export function mapInvoice(invoice, { keepReference = false } = {}) {
  return {
    xeroInvoiceId: invoice.InvoiceID,
    type: invoice.Type,
    invoiceNumber: invoice.InvoiceNumber || null,
    reference: text(invoice.Reference, keepReference),
    xeroContactId: invoice.Contact?.ContactID ?? null,
    status: invoice.Status,
    issuedOn: toDay(invoice.Date ?? invoice.DateString),
    dueOn: toDay(invoice.DueDate ?? invoice.DueDateString),
    fullyPaidOn: toDay(invoice.FullyPaidOnDate),
    currency: invoice.CurrencyCode || null,
    subtotalCents: toCents(invoice.SubTotal),
    taxCents: toCents(invoice.TotalTax),
    totalCents: toCents(invoice.Total),
    amountDueCents: toCents(invoice.AmountDue),
    amountPaidCents: toCents(invoice.AmountPaid),
    amountCreditedCents: toCents(invoice.AmountCredited),
    lines: mapLines(invoice.LineItems, keepReference),
    xeroUpdatedAt: parseXeroDate(invoice.UpdatedDateUTC),
  };
}

export function mapCreditNote(note, { keepReference = false } = {}) {
  return {
    xeroCreditNoteId: note.CreditNoteID,
    type: note.Type,
    creditNoteNumber: note.CreditNoteNumber || null,
    reference: text(note.Reference, keepReference),
    xeroContactId: note.Contact?.ContactID ?? null,
    status: note.Status,
    issuedOn: toDay(note.Date ?? note.DateString),
    currency: note.CurrencyCode || null,
    subtotalCents: toCents(note.SubTotal),
    taxCents: toCents(note.TotalTax),
    totalCents: toCents(note.Total),
    remainingCreditCents: toCents(note.RemainingCredit),
    allocations: (note.Allocations ?? []).map((a) => ({
      xeroInvoiceId: a.Invoice?.InvoiceID ?? null,
      amountCents: toCents(a.Amount),
      allocatedOn: toDay(a.Date),
    })),
    lines: mapLines(note.LineItems, keepReference),
    xeroUpdatedAt: parseXeroDate(note.UpdatedDateUTC),
  };
}

export function mapPayment(payment, { keepReference = false } = {}) {
  return {
    xeroPaymentId: payment.PaymentID,
    paymentType: payment.PaymentType || null,
    status: payment.Status || 'AUTHORISED',
    xeroInvoiceId: payment.Invoice?.InvoiceID ?? null,
    xeroCreditNoteId: payment.CreditNote?.CreditNoteID ?? null,
    paidOn: toDay(payment.Date),
    amountCents: toCents(payment.Amount),
    reference: text(payment.Reference, keepReference),
    isReconciled: payment.IsReconciled ?? null,
    xeroUpdatedAt: parseXeroDate(payment.UpdatedDateUTC),
  };
}

// The hash covers what Flow keeps, so a change Flow does not keep (a field it
// drops) never counts as a change.
function hashOf(row) {
  const { xeroUpdatedAt, ...content } = row;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

const json = (value) => JSON.stringify(value);

// Each upsert writes only when the content changed, and answers whether it did.
const UPSERT = {
  invoices: (org, r, hash) => sql`
    insert into xero_invoices (organisation_id, xero_invoice_id, type, invoice_number, reference, xero_contact_id, status,
      issued_on, due_on, fully_paid_on, currency, subtotal_cents, tax_cents, total_cents, amount_due_cents,
      amount_paid_cents, amount_credited_cents, lines, xero_updated_at, record_hash)
    values (${org}, ${r.xeroInvoiceId}, ${r.type}, ${r.invoiceNumber}, ${r.reference}, ${r.xeroContactId}, ${r.status},
      ${r.issuedOn}, ${r.dueOn}, ${r.fullyPaidOn}, ${r.currency}, ${r.subtotalCents}, ${r.taxCents}, ${r.totalCents},
      ${r.amountDueCents}, ${r.amountPaidCents}, ${r.amountCreditedCents}, ${json(r.lines)}::jsonb, ${r.xeroUpdatedAt}, ${hash})
    on conflict (organisation_id, xero_invoice_id) do update set
      type = excluded.type, invoice_number = excluded.invoice_number, reference = excluded.reference,
      xero_contact_id = excluded.xero_contact_id, status = excluded.status, issued_on = excluded.issued_on,
      due_on = excluded.due_on, fully_paid_on = excluded.fully_paid_on, currency = excluded.currency,
      subtotal_cents = excluded.subtotal_cents, tax_cents = excluded.tax_cents, total_cents = excluded.total_cents,
      amount_due_cents = excluded.amount_due_cents, amount_paid_cents = excluded.amount_paid_cents,
      amount_credited_cents = excluded.amount_credited_cents, lines = excluded.lines,
      xero_updated_at = excluded.xero_updated_at, record_hash = excluded.record_hash, last_changed_at = now()
    where xero_invoices.record_hash is distinct from excluded.record_hash
    returning (xmax = 0) as inserted`,
  credit_notes: (org, r, hash) => sql`
    insert into xero_credit_notes (organisation_id, xero_credit_note_id, type, credit_note_number, reference, xero_contact_id,
      status, issued_on, currency, subtotal_cents, tax_cents, total_cents, remaining_credit_cents, allocations, lines,
      xero_updated_at, record_hash)
    values (${org}, ${r.xeroCreditNoteId}, ${r.type}, ${r.creditNoteNumber}, ${r.reference}, ${r.xeroContactId}, ${r.status},
      ${r.issuedOn}, ${r.currency}, ${r.subtotalCents}, ${r.taxCents}, ${r.totalCents}, ${r.remainingCreditCents},
      ${json(r.allocations)}::jsonb, ${json(r.lines)}::jsonb, ${r.xeroUpdatedAt}, ${hash})
    on conflict (organisation_id, xero_credit_note_id) do update set
      type = excluded.type, credit_note_number = excluded.credit_note_number, reference = excluded.reference,
      xero_contact_id = excluded.xero_contact_id, status = excluded.status, issued_on = excluded.issued_on,
      currency = excluded.currency, subtotal_cents = excluded.subtotal_cents, tax_cents = excluded.tax_cents,
      total_cents = excluded.total_cents, remaining_credit_cents = excluded.remaining_credit_cents,
      allocations = excluded.allocations, lines = excluded.lines, xero_updated_at = excluded.xero_updated_at,
      record_hash = excluded.record_hash, last_changed_at = now()
    where xero_credit_notes.record_hash is distinct from excluded.record_hash
    returning (xmax = 0) as inserted`,
  payments: (org, r, hash) => sql`
    insert into xero_payments (organisation_id, xero_payment_id, payment_type, status, xero_invoice_id, xero_credit_note_id,
      paid_on, amount_cents, reference, is_reconciled, xero_updated_at, record_hash)
    values (${org}, ${r.xeroPaymentId}, ${r.paymentType}, ${r.status}, ${r.xeroInvoiceId}, ${r.xeroCreditNoteId},
      ${r.paidOn}, ${r.amountCents}, ${r.reference}, ${r.isReconciled}, ${r.xeroUpdatedAt}, ${hash})
    on conflict (organisation_id, xero_payment_id) do update set
      payment_type = excluded.payment_type, status = excluded.status, xero_invoice_id = excluded.xero_invoice_id,
      xero_credit_note_id = excluded.xero_credit_note_id, paid_on = excluded.paid_on, amount_cents = excluded.amount_cents,
      reference = excluded.reference, is_reconciled = excluded.is_reconciled, xero_updated_at = excluded.xero_updated_at,
      record_hash = excluded.record_hash, last_changed_at = now()
    where xero_payments.record_hash is distinct from excluded.record_hash
    returning (xmax = 0) as inserted`,
};

const MAPPERS = { invoices: mapInvoice, credit_notes: mapCreditNote, payments: mapPayment };
const ID_OF = { invoices: 'xeroInvoiceId', credit_notes: 'xeroCreditNoteId', payments: 'xeroPaymentId' };

// Xero records as the copy's rows.
export const mapRecords = (resource, raw, settings) => raw.map((record) => MAPPERS[resource](record, settings)).filter((r) => r[ID_OF[resource]]);

// Writes each mapped row to the copy. `tx` is a transaction or the database.
// Adds to `counts` (inserted, changed, unchanged).
export async function storeRows(tx, organisationId, resource, rows, counts) {
  for (const row of rows) {
    const { rows: written } = await tx.execute(UPSERT[resource](organisationId, row, hashOf(row)));
    if (!written.length) counts.unchanged += 1;
    else if (written[0].inserted) counts.inserted += 1;
    else counts.changed += 1;
  }
}

async function readCursor(db, organisationId, resource) {
  await db.execute(sql`insert into xero_mirror_cursors (organisation_id, resource) values (${organisationId}, ${resource})
    on conflict do nothing`);
  const { rows: [row] } = await db.execute(sql`select * from xero_mirror_cursors
    where organisation_id = ${organisationId} and resource = ${resource}`);
  return { modifiedSince: row.modified_since ? new Date(row.modified_since) : null, page: row.page };
}

// Where the next page starts, from the page just read. A full page moves the
// time cursor to its last change, less one second (Xero compares whole
// seconds); when that does not move it forward, one second holds more than a
// page, and the page number moves on instead.
export function nextPosition({ modifiedSince, page }, rows, pageSize) {
  const times = rows.map((r) => r.xeroUpdatedAt?.getTime()).filter(Number.isFinite);
  const latest = times.length ? Math.max(...times) : null;
  const full = rows.length >= pageSize;
  if (!full) {
    const since = latest === null ? modifiedSince : new Date(Math.floor(latest / 1000) * 1000 - 1000);
    return { modifiedSince: since && modifiedSince && since < modifiedSince ? modifiedSince : since, page: 1, done: true };
  }
  const since = latest === null ? null : new Date(Math.floor(latest / 1000) * 1000 - 1000);
  if (since && (!modifiedSince || since > modifiedSince)) return { modifiedSince: since, page: 1, done: false };
  return { modifiedSince, page: page + 1, done: false };
}

// Reads one resource from its cursor until Xero has no more changes, the
// mirror's share of the day's calls is spent, or `maxPages` pages are read.
// Answers counts and why it stopped: `done`, `budget` or `max_pages`.
export async function mirrorResource(db, runtime, organisationId, resource, { maxPages = 50 } = {}) {
  if (!MIRROR_RESOURCES.includes(resource)) throw new TypeError(`unknown Xero mirror resource: ${resource}`);
  const { settings } = runtime;
  const pageSize = settings.mirrorPageSize;
  const counts = { pages: 0, read: 0, inserted: 0, changed: 0, unchanged: 0 };
  return withXeroLane('sync', async () => {
    const { client } = await runtime.clientFor(db, organisationId);
    let position = await readCursor(db, organisationId, resource);
    for (;;) {
      if (counts.pages >= maxPages) return { resource, ...counts, stopped: 'max_pages' };
      const budget = runtime.governor.status(client.tenantId);
      if (budget.dayRemaining <= Math.ceil(budget.dayLimit * settings.mirrorReserveFraction)) {
        return { resource, ...counts, stopped: 'budget' };
      }
      let raw;
      try {
        raw = await client.listChangedPage(resource, { page: position.page, pageSize, modifiedSince: position.modifiedSince });
      } catch (error) {
        await db.execute(sql`update xero_mirror_cursors set last_error = ${`${error.code ?? 'error'}: ${String(error.message).slice(0, 300)}`}
          where organisation_id = ${organisationId} and resource = ${resource}`);
        throw error;
      }
      const rows = mapRecords(resource, raw, settings);
      const next = nextPosition(position, rows, pageSize);
      await db.transaction(async (tx) => {
        await storeRows(tx, organisationId, resource, rows, counts);
        await tx.execute(sql`update xero_mirror_cursors set
          modified_since = ${next.modifiedSince}, page = ${next.page}, rows_read = rows_read + ${raw.length},
          last_read_at = now(), last_error = null,
          passes = passes + ${next.done ? 1 : 0},
          last_pass_finished_at = case when ${next.done} then now() else last_pass_finished_at end
          where organisation_id = ${organisationId} and resource = ${resource}`);
      });
      counts.pages += 1;
      counts.read += raw.length;
      position = next;
      if (next.done) return { resource, ...counts, stopped: 'done' };
    }
  });
}

// Reads each resource in turn, one organisation at a time with any other Xero
// work for it (runtime.serial). A resource Xero refused (the call guard
// stopped it: the connection lacks its scope) is skipped as `refused`, so
// the others still read.
export async function mirrorXero(db, runtime, organisationId, { resources = MIRROR_RESOURCES, maxPages } = {}) {
  return runtime.serial(organisationId, async () => {
    const results = [];
    for (const resource of resources) {
      let result;
      try {
        result = await mirrorResource(db, runtime, organisationId, resource, { maxPages });
      } catch (error) {
        if (!isCallsStopped(error) || error.reason !== 'resource_stopped') throw error;
        result = { resource, pages: 0, read: 0, inserted: 0, changed: 0, unchanged: 0, stopped: 'refused' };
      }
      results.push(result);
      if (result.stopped === 'budget') break;
    }
    return results;
  });
}

// What the copy holds, and where each cursor stands. No Xero calls.
export async function mirrorStatus(db, organisationId) {
  const { rows: cursors } = await db.execute(sql`select resource, modified_since, page, passes, rows_read,
    last_read_at, last_pass_finished_at, last_error from xero_mirror_cursors where organisation_id = ${organisationId}
    order by resource`);
  const { rows: [counts] } = await db.execute(sql`select
    (select count(*)::int from xero_invoices where organisation_id = ${organisationId}) as invoices,
    (select count(*)::int from xero_credit_notes where organisation_id = ${organisationId}) as credit_notes,
    (select count(*)::int from xero_payments where organisation_id = ${organisationId}) as payments`);
  return {
    counts,
    cursors: cursors.map((c) => ({
      resource: c.resource,
      modifiedSince: c.modified_since,
      page: c.page,
      passes: c.passes,
      rowsRead: Number(c.rows_read),
      lastReadAt: c.last_read_at,
      lastPassFinishedAt: c.last_pass_finished_at,
      lastError: c.last_error,
    })),
  };
}
