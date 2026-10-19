import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { contacts, invoiceLines, invoices, invoiceVersions, organisations, priceItems } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { invoiceTotals, lineTotals } from './money.js';

// Invoices (accounts receivable). A draft can change. Issuing gives the
// invoice its number and stores the document exactly as sent, as a new
// version. To change an issued invoice, revise it back to a draft and issue
// it again: the number stays and the earlier versions stay as they were.

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
    resolved.push({
      position: index + 1,
      priceItemId: line.priceItemId ?? null,
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
      lines: lines.map(({ line: { position, description, quantity, unitAmountCents, taxCode, lineAmountCents, taxCents }, itemCode }) => (
        { position, itemCode: itemCode ?? null, description, quantity, unitAmountCents, taxCode, lineAmountCents, taxCents }
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
    const [row] = await tx.update(invoices).set({ status: 'draft', updatedAt: sql`now()` })
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
