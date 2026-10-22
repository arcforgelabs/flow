import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { billingObligations, contacts, invoiceLines, invoices, invoiceVersions, obligationEvents, organisations, priceItems } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { invoiceTotals, lineTotals } from './money.js';

// Invoices (accounts receivable). A draft can change. Issuing gives the
// invoice its number and stores the document exactly as sent, as a new
// version. To change an issued invoice, revise it back to a draft and issue
// it again: the number stays and the earlier versions stay as they were.
// A draft that was never issued can be deleted. An issued invoice is voided.
// When that invoice's accounting copy is still a draft, deleteDraft asks the
// accounting adapter to delete it there first, and voids in Flow only after
// the adapter confirms (docs/XERO.md, "Deleting a draft").

async function loadInvoice(tx, organisationId, invoiceId, { lock = false } = {}) {
  let query = tx.select().from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)));
  if (lock) query = query.for('update');
  const [row] = await query;
  if (!row) throw notFound('invoice');
  return row;
}

async function resolveLines(tx, organisationId, lines) {
  if (!Array.isArray(lines)) throw new FlowError('invalid', 'lines must be a list');
  const resolved = [];
  for (const [index, line] of lines.entries()) {
    let { description, unitAmountCents, taxCode } = line;
    const quantity = line.quantity ?? 1;
    if (line.priceItemId) {
      const [item] = await tx.select().from(priceItems)
        .where(and(eq(priceItems.organisationId, organisationId), eq(priceItems.id, line.priceItemId)));
      if (!item) throw new FlowError('invalid', `line ${index + 1}: price item not found`);
      description ??= item.name;
      unitAmountCents ??= item.unitAmountCents;
      taxCode ??= item.taxCode;
    }
    taxCode ??= 'GST';
    if (!description?.trim()) throw new FlowError('invalid', `line ${index + 1}: description is required`);
    let totals;
    try {
      totals = lineTotals({ quantity, unitAmountCents, taxCode });
    } catch (error) {
      throw new FlowError('invalid', `line ${index + 1}: ${error.message}`);
    }
    const accountCode = line.priceItemId ? null : (typeof line.accountCode === 'string' && line.accountCode.trim() ? line.accountCode.trim().slice(0, 20) : null);
    resolved.push({
      position: index + 1,
      priceItemId: line.priceItemId ?? null,
      accountCode,
      description: description.trim(),
      quantity,
      unitAmountCents,
      taxCode,
      ...totals,
    });
  }
  return resolved;
}

async function writeLines(tx, invoice, lines) {
  await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id));
  if (lines.length) {
    await tx.insert(invoiceLines).values(lines.map((line) => ({
      ...line,
      organisationId: invoice.organisationId,
      invoiceId: invoice.id,
    })));
  }
  const [row] = await tx.update(invoices)
    .set({ ...invoiceTotals(lines), updatedAt: sql`now()` })
    .where(eq(invoices.id, invoice.id))
    .returning();
  return row;
}

export async function createDraftInvoice(db, organisationId, { contactId, reference = null, dueDate = null, lines = [] }) {
  return db.transaction(async (tx) => {
    const [contact] = await tx.select().from(contacts)
      .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, contactId)));
    if (!contact) throw new FlowError('invalid', 'contact not found');
    if (contact.kind !== 'customer') throw new FlowError('invalid', 'an invoice goes to a customer contact');
    const resolved = await resolveLines(tx, organisationId, lines);
    const [invoice] = await tx.insert(invoices)
      .values({ organisationId, contactId, reference, dueDate })
      .returning();
    return writeLines(tx, invoice, resolved);
  });
}

export async function updateDraftInvoice(db, organisationId, invoiceId, changes) {
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true });
    if (invoice.status !== 'draft') throw new FlowError('not_draft', 'only a draft invoice can change; revise it first');
    const fields = {};
    if ('contactId' in changes && changes.contactId !== invoice.contactId) {
      const [contact] = await tx.select().from(contacts)
        .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, changes.contactId)));
      if (!contact) throw new FlowError('invalid', 'contact not found');
      if (contact.kind !== 'customer') throw new FlowError('invalid', 'an invoice goes to a customer contact');
      fields.contactId = changes.contactId;
    }
    if ('reference' in changes) fields.reference = changes.reference;
    if ('dueDate' in changes) fields.dueDate = changes.dueDate;
    // A saved change keeps the draft where it is. Flow's checks still run on
    // it, so a change that breaks one puts the draft in Problem.
    let row = invoice;
    if (Object.keys(fields).length) {
      [row] = await tx.update(invoices).set({ ...fields, updatedAt: sql`now()` })
        .where(eq(invoices.id, invoice.id)).returning();
    }
    if ('lines' in changes) {
      row = await writeLines(tx, row, await resolveLines(tx, organisationId, changes.lines));
    }
    return row;
  });
}

export async function issueInvoice(db, organisationId, invoiceId, { issuedBy, issueDate }) {
  if (!issuedBy) throw new FlowError('invalid', 'issuedBy is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate ?? '')) throw new FlowError('invalid', 'issueDate must be YYYY-MM-DD');
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true });
    if (invoice.status !== 'draft') throw new FlowError('not_draft', 'only a draft invoice can be issued');
    // Each line with its price item's code, so the document says which item
    // was sold even if the price list changes later.
    const lines = await tx.select({ line: invoiceLines, itemCode: priceItems.code }).from(invoiceLines)
      .leftJoin(priceItems, eq(priceItems.id, invoiceLines.priceItemId))
      .where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(asc(invoiceLines.position));
    if (!lines.length) throw new FlowError('invalid', 'an invoice needs at least one line');

    let number = invoice.number;
    if (!number) {
      const [org] = await tx.update(organisations)
        .set({ nextInvoiceNumber: sql`${organisations.nextInvoiceNumber} + 1` })
        .where(eq(organisations.id, organisationId))
        .returning({ prefix: organisations.invoicePrefix, next: organisations.nextInvoiceNumber });
      number = `${org.prefix}${String(org.next - 1).padStart(4, '0')}`;
    }
    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, invoice.contactId));
    const version = invoice.issuedVersion + 1;
    const document = {
      number,
      version,
      issueDate,
      dueDate: invoice.dueDate,
      reference: invoice.reference,
      currency: invoice.currency,
      contact: { id: contact.id, name: contact.name, email: contact.email },
      lines: lines.map(({ line: { position, description, quantity, unitAmountCents, taxCode, lineAmountCents, taxCents, accountCode }, itemCode }) => (
        { position, itemCode: itemCode ?? null, ...(accountCode ? { accountCode } : {}), description, quantity, unitAmountCents, taxCode, lineAmountCents, taxCents }
      )),
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
    };
    await tx.insert(invoiceVersions).values({ organisationId, invoiceId, version, issuedBy, document });
    const [row] = await tx.update(invoices)
      .set({ status: 'issued', number, issuedVersion: version, issueDate, updatedAt: sql`now()` })
      .where(eq(invoices.id, invoice.id))
      .returning();
    return row;
  });
}

// Opens an issued invoice for change. The sent versions are not touched.
export async function reviseInvoice(db, organisationId, invoiceId) {
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true });
    if (invoice.status !== 'issued') throw new FlowError('not_issued', 'only an issued invoice can be revised');
    // A revision is a new version: what happened to the last send no longer applies.
    const [row] = await tx.update(invoices).set({ status: 'draft', readyAt: null, readyBy: null, sendState: null, sendError: null, updatedAt: sql`now()` })
      .where(eq(invoices.id, invoice.id)).returning();
    return row;
  });
}

export async function voidInvoice(db, organisationId, invoiceId) {
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true });
    if (invoice.status === 'void') return invoice;
    if (invoice.issuedVersion === 0) throw new FlowError('never_issued', 'delete a draft that was never issued; do not void it');
    const [row] = await tx.update(invoices).set({ status: 'void', updatedAt: sql`now()` })
      .where(eq(invoices.id, invoice.id)).returning();
    return row;
  });
}

// The job an invoice billed is free again: its obligation no longer points at
// the invoice, so the lab's rules decide whether Flow drafts it once more.
async function freeJobs(tx, organisationId, invoice, actor) {
  const linked = await tx.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, invoice.id)))
    .for('update');
  if (linked.length && !actor) throw new FlowError('invalid', 'actor is required');
  for (const obligation of linked) {
    await tx.update(billingObligations)
      .set({ invoiceId: null, draftBasis: null, updatedAt: sql`now()` })
      .where(eq(billingObligations.id, obligation.id));
    await tx.insert(obligationEvents).values({
      createdAt: sql`clock_timestamp()`,
      organisationId,
      obligationId: obligation.id,
      kind: 'draft_deleted',
      actor,
      evidence: { invoiceId: invoice.id },
    });
  }
}

// Same words as the Send gate (server/core/sending.js): writes that are off,
// or a system that is not connected, stop before anything changes.
async function deleteInAccounting(accounting, organisationId, invoiceId, actor) {
  if (!accounting || typeof accounting.capabilities?.deleteInvoice !== 'function') {
    throw new FlowError('accounting_unavailable', 'No accounting system is connected. An issued invoice stays as it is.');
  }
  const status = typeof accounting.capabilities.sendStatus === 'function'
    ? await accounting.capabilities.sendStatus({ organisationId })
    : { connected: false, writesAllowed: false };
  if (!status?.connected) {
    throw new FlowError('accounting_not_connected', `${accounting.name} is not connected. Connect it in Integrations, then send.`);
  }
  if (!status.writesAllowed) {
    throw new FlowError('accounting_writes_off', `${accounting.name} does not take invoices from this installation yet (writes are off). Nothing was issued.`);
  }
  const answer = await accounting.capabilities.deleteInvoice({ organisationId, invoiceId, actor });
  if (answer?.state === 'approved') {
    throw new FlowError('accounting_approved', answer.message || 'Approved in the accounting system. Void it there first.');
  }
  if (answer?.state === 'deleted' || answer?.state === 'gone') return answer;
  throw new FlowError('accounting_unavailable', answer?.message || 'The accounting system cannot delete this invoice. Nothing was changed.');
}

// Removes a draft that was never issued. An invoice that was issued is voided
// only after its accounting adapter deletes the draft there, or reports it
// already gone. The issued versions stay. With no adapter, or when the
// accounting invoice is approved or paid, nothing in Flow changes.
export async function deleteDraft(db, organisationId, invoiceId, { actor = null, accounting = null } = {}) {
  const current = await loadInvoice(db, organisationId, invoiceId);
  if (current.status === 'void') throw new FlowError('conflict', 'a void invoice is final');
  if (current.status === 'draft' && current.issuedVersion === 0) {
    return db.transaction(async (tx) => {
      const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true });
      if (invoice.status !== 'draft' || invoice.issuedVersion !== 0) {
        throw new FlowError('was_issued', 'an invoice that was issued cannot be deleted; void it');
      }
      await freeJobs(tx, organisationId, invoice, actor);
      try {
        await tx.delete(invoices).where(eq(invoices.id, invoice.id));
      } catch (error) {
        const code = error?.code ?? error?.cause?.code;
        if (code === '23503') throw new FlowError('conflict', 'this draft is still linked; remove the link, then delete it');
        throw error;
      }
      return invoice;
    });
  }
  // Read and delete outside the Flow transaction. A timeout or a refusal
  // throws here, and the invoice stays as it was. The next try reads again.
  await deleteInAccounting(accounting, organisationId, invoiceId, actor);
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true });
    if (invoice.status === 'void') return invoice;
    if (invoice.issuedVersion === 0) {
      throw new FlowError('was_issued', 'an invoice that was issued cannot be deleted; void it');
    }
    const [row] = await tx.update(invoices).set({ status: 'void', updatedAt: sql`now()` })
      .where(eq(invoices.id, invoice.id)).returning();
    await freeJobs(tx, organisationId, row, actor);
    return row;
  });
}

export async function getInvoice(db, organisationId, invoiceId) {
  const invoice = await loadInvoice(db, organisationId, invoiceId);
  const lines = await db.select().from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(asc(invoiceLines.position));
  return { ...invoice, lines };
}

export async function listInvoiceVersions(db, organisationId, invoiceId) {
  await loadInvoice(db, organisationId, invoiceId);
  return db.select().from(invoiceVersions)
    .where(and(eq(invoiceVersions.organisationId, organisationId), eq(invoiceVersions.invoiceId, invoiceId)))
    .orderBy(asc(invoiceVersions.version));
}

export async function listInvoices(db, organisationId, { status } = {}) {
  const where = [eq(invoices.organisationId, organisationId)];
  if (status) where.push(eq(invoices.status, status));
  return db.select().from(invoices).where(and(...where)).orderBy(desc(invoices.createdAt));
}
