import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { billingObligations, contacts, invoiceLines, invoices, invoiceVersions, invoicingSettings, obligationEvents, organisations, priceItems } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { invoiceTotals, lineTotals } from './money.js';

// Invoices (accounts receivable). A draft can change. Issuing gives the
// invoice its number and stores the document exactly as sent, as a new
// version. To change an issued invoice, revise it back to a draft and issue
// it again: the number stays and the earlier versions stay as they were.
// A draft that was never issued can be deleted. An issued invoice is voided.
// When its accounting copy is still a draft, deleteDraft asks the accounting
// adapter to delete it there first, and voids in Flow only after the adapter
// confirms (docs/XERO.md, "Deleting a draft"). With no accounting system, an
// issued invoice answers accounting_unavailable.

// An imported invoice (origin is not 'flow') was copied from the accounting
// system, which owns it: Flow shows it and never changes, sends, voids or
// deletes it. Only the import writes it (mirrorWrite). The database refuses
// every other change too (migration 0041).
export const isImported = (invoice) => (invoice?.origin ?? 'flow') !== 'flow';

export function requireOwn(invoice) {
  if (isImported(invoice)) {
    throw Object.assign(new FlowError('imported', `${invoice.number ?? 'This invoice'} came from the accounting system. Change it there: Flow follows.`), { status: 409 });
  }
  return invoice;
}

// `own`: refuse an imported invoice, for every path that changes one.
async function loadInvoice(tx, organisationId, invoiceId, { lock = false, own = false } = {}) {
  let query = tx.select().from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)));
  if (lock) query = query.for('update');
  const [row] = await query;
  if (!row) throw notFound('invoice');
  return own ? requireOwn(row) : row;
}

// Whether the lab's prices include GST (Settings, Invoicing). A new invoice
// and a newly reported job take it; an invoice keeps the one it was made with.
export async function pricesIncludeTax(db, organisationId) {
  const [row] = await db.select({ inclusive: invoicingSettings.amountsIncludeTax }).from(invoicingSettings)
    .where(eq(invoicingSettings.organisationId, organisationId));
  return row?.inclusive ?? false;
}

async function resolveLines(tx, organisationId, lines, { inclusive = false } = {}) {
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
      totals = lineTotals({ quantity, unitAmountCents, taxCode, inclusive });
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
    .set({ ...invoiceTotals(lines, { inclusive: invoice.amountsIncludeTax }), updatedAt: sql`now()` })
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
    if (contact.mergedIntoId) throw new FlowError('invalid', 'this contact was merged into another; pick that one');
    const amountsIncludeTax = await pricesIncludeTax(tx, organisationId);
    const resolved = await resolveLines(tx, organisationId, lines, { inclusive: amountsIncludeTax });
    const [invoice] = await tx.insert(invoices)
      .values({ organisationId, contactId, reference, dueDate, amountsIncludeTax })
      .returning();
    return writeLines(tx, invoice, resolved);
  });
}

export async function updateDraftInvoice(db, organisationId, invoiceId, changes) {
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true, own: true });
    if (invoice.status !== 'draft') throw new FlowError('not_draft', 'only a draft invoice can change; revise it first');
    const fields = {};
    if ('contactId' in changes && changes.contactId !== invoice.contactId) {
      const [contact] = await tx.select().from(contacts)
        .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, changes.contactId)));
      if (!contact) throw new FlowError('invalid', 'contact not found');
      if (contact.kind !== 'customer') throw new FlowError('invalid', 'an invoice goes to a customer contact');
      if (contact.mergedIntoId) throw new FlowError('invalid', 'this contact was merged into another; pick that one');
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
      // `lines` may be a function of the draft's current lines, read under
      // the lock, so a change made at the same time is not lost.
      let lines = changes.lines;
      if (typeof lines === 'function') {
        const current = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(asc(invoiceLines.position));
        lines = lines(current);
        if (lines === null) return row;
      }
      row = await writeLines(tx, row, await resolveLines(tx, organisationId, lines, { inclusive: row.amountsIncludeTax }));
    }
    return row;
  });
}

export async function issueInvoice(db, organisationId, invoiceId, { issuedBy, issueDate }) {
  if (!issuedBy) throw new FlowError('invalid', 'issuedBy is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate ?? '')) throw new FlowError('invalid', 'issueDate must be YYYY-MM-DD');
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true, own: true });
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
      ...(invoice.amountsIncludeTax ? { amountsIncludeTax: true } : {}),
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
    const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true, own: true });
    if (invoice.status !== 'issued') throw new FlowError('not_issued', 'only an issued invoice can be revised');
    // A revision is a new version: what happened to the last send no longer applies.
    const [row] = await tx.update(invoices).set({ status: 'draft', readyAt: null, readyBy: null, sendState: null, sendError: null, updatedAt: sql`now()` })
      .where(eq(invoices.id, invoice.id)).returning();
    return row;
  });
}

// Void is only for an invoice a customer has seen (owner rule, 14 November 2026).
// With an accounting system, only that system sends invoices to customers:
// Flow never voids there. An invoice that never reached it is deleted
// (deleteDraft); one that did is voided in the accounting system, and Flow's
// Void tab follows it. Without one, Flow sent the invoice itself, so Flow
// voids it.
export async function voidInvoice(db, organisationId, invoiceId, { accounting = null, actor = null } = {}) {
  let unseen = false;
  if (accounting) {
    const current = await loadInvoice(db, organisationId, invoiceId, { own: true });
    if (current.status !== 'void' && current.issuedVersion > 0) {
      if (!(await neverSent(accounting, organisationId, invoiceId))) {
        throw new FlowError('void_in_accounting', `${current.number} is in ${accounting.name}. Void it in ${accounting.name}: Flow follows.`);
      }
      // An owner's override record keeps its invoice, so that one cannot be
      // deleted: Flow voids it here, and the record stays.
      if (!(await hasSendOverride(db, invoiceId))) {
        throw new FlowError('delete_instead', `${current.number} never reached ${accounting.name}, so no customer saw it. Delete it instead.`);
      }
      unseen = true;
    }
  }
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true, own: true });
    if (invoice.status === 'void') return invoice;
    if (invoice.issuedVersion === 0) throw new FlowError('never_issued', 'delete a draft that was never issued; do not void it');
    if (unseen && !(await stillUnsent(accounting, organisationId, invoice, 'void'))) {
      throw new FlowError('void_in_accounting', `${invoice.number} is in ${accounting.name}. Void it in ${accounting.name}: Flow follows.`);
    }
    const [row] = await tx.update(invoices).set({ status: 'void', updatedAt: sql`now()` })
      .where(eq(invoices.id, invoice.id)).returning();
    // No customer saw it, so its job is free again, as after Delete.
    if (unseen) await freeJobs(tx, organisationId, row, actor);
    return row;
  });
}

// The job an invoice billed is free again: its obligation no longer points at
// the invoice, so the lab's rules decide whether Flow drafts it once more.
async function freeJobs(tx, organisationId, invoice, actor, evidence = {}) {
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
      evidence: { invoiceId: invoice.id, ...evidence },
    });
  }
}

// An issued or void invoice that never reached the accounting system is
// deleted, not voided (Samuel, 13 November 2026: a send that failed is not a
// void, and an invoice that never reached Xero can be deleted). Its lines,
// issued versions and tab go with it. The job's history keeps the number,
// total and who deleted it. The number is not used again.
export async function removeUnsentInvoice(tx, organisationId, invoice, actor, evidence = {}) {
  requireOwn(invoice);
  await freeJobs(tx, organisationId, invoice, actor, { number: invoice.number, totalCents: invoice.totalCents, removed: true, ...evidence });
  await deleteUnsentRows(tx, organisationId, invoice.id);
}

// The rows only, inside the caller's transaction. The database refuses to
// delete an issued invoice or its versions (migration 0001) unless this
// transaction names that one invoice (migration 0039). The caller has
// checked that it never reached the accounting system, and freed its jobs.
export async function deleteUnsentRows(tx, organisationId, invoiceId) {
  await tx.execute(sql`select set_config('flow.remove_unsent', ${String(invoiceId)}, true)`);
  await tx.delete(invoiceVersions).where(and(eq(invoiceVersions.organisationId, organisationId), eq(invoiceVersions.invoiceId, invoiceId)));
  await tx.delete(invoices).where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)));
  await tx.execute(sql`select set_config('flow.remove_unsent', '', true)`);
}

// The import's own writes to an imported invoice, inside the caller's
// transaction: the database lets a change or a delete through only while the
// transaction names that one invoice (migration 0041). Answers what `write`
// answers.
export async function mirrorWrite(tx, invoiceId, write) {
  const name = (id) => tx.execute(sql`select set_config('flow.mirror_write', ${id}, true)`);
  await name(String(invoiceId));
  let result;
  try {
    result = await write();
  } catch (error) {
    // A caller that catches this and goes on must not keep the scope. When a
    // statement failed, the transaction is over and the setting went with it.
    await name('').catch(() => {});
    throw error;
  }
  await name('');
  return result;
}

// Removes an imported invoice and its versions: the import's release of a
// batch, or a draft the accounting system deleted. It was only Flow's copy,
// so nothing is voided and the accounting system is never called. No job
// holds it as its own invoice (the database refuses that), so no job changes.
// An invoice Flow made is refused: deleteDraft owns those.
export async function removeImportedInvoice(tx, organisationId, invoiceId) {
  const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true });
  if (!isImported(invoice)) throw new FlowError('invalid', 'Flow made this invoice; only an imported invoice is removed this way');
  await mirrorWrite(tx, invoice.id, async () => {
    await tx.delete(invoiceVersions).where(and(eq(invoiceVersions.organisationId, organisationId), eq(invoiceVersions.invoiceId, invoice.id)));
    await tx.delete(invoices).where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoice.id)));
  });
  return invoice;
}

// An owner's override (send_overrides) is a record that stays: its row
// keeps the invoice. An invoice with one is voided, never deleted.
export async function hasSendOverride(db, invoiceId) {
  const { rows } = await db.execute(sql`select 1 from send_overrides where invoice_id = ${invoiceId} limit 1`);
  return rows.length > 0;
}

// True only when the accounting system says this invoice never reached it:
// no send was started and no link was made. Without that answer, false.
async function neverSent(accounting, organisationId, invoiceId) {
  if (typeof accounting?.capabilities?.everSent !== 'function') return false;
  return (await accounting.capabilities.everSent({ organisationId, invoiceId })) === false;
}

// Under the invoice's lock, before Flow treats it as never sent. A send that
// is on its way stops the step: the worker took the invoice as issued and
// will make it in the accounting system. A send that finished since the
// caller's first check answers false.
async function stillUnsent(accounting, organisationId, invoice, verb) {
  if (invoice.sendState === 'queued') {
    throw new FlowError('conflict', `${invoice.number} is on its way to ${accounting.name}. Wait for the send to finish, then ${verb} it.`);
  }
  return neverSent(accounting, organisationId, invoice.id);
}

// Same words as the Send gate (server/core/sending.js): writes that are off,
// or a system that is not connected, stop before anything changes. An issued
// invoice with no accounting delete answers accounting_unavailable.
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
  if (['deleted', 'gone', 'voided'].includes(answer?.state)) return answer;
  throw new FlowError('accounting_unavailable', answer?.message || 'The accounting system cannot delete this invoice. Nothing was changed.');
}

// Removes a draft that was never issued, and frees its job. An issued or void
// invoice that never reached the accounting system (a send that failed, or
// one never sent) is removed too (removeUnsentInvoice); one of those that an
// owner's override record holds is voided in Flow instead, with no accounting
// call. Any other issued
// invoice goes only after its accounting adapter deletes the draft there, or
// reports it already gone: a draft no customer saw, so Flow removes its
// invoice as well. When the accounting system says it was voided there (a
// customer may have seen it), or that a customer saw an earlier version
// (`customerSaw`), or an owner's override record holds it, Flow voids it and
// the issued versions stay. With no accounting delete, or when
// the accounting invoice is approved or paid, nothing in Flow changes.
export async function deleteDraft(db, organisationId, invoiceId, { actor = null, accounting = null } = {}) {
  const current = await loadInvoice(db, organisationId, invoiceId, { own: true });
  if (current.issuedVersion > 0 && await neverSent(accounting, organisationId, invoiceId)) {
    const held = await hasSendOverride(db, invoiceId);
    if (!held || current.status !== 'void') {
      const forget = accounting.capabilities.forgetInvoice;
      return db.transaction(async (tx) => {
        const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true });
        if (!(await stillUnsent(accounting, organisationId, invoice, 'delete'))) {
          throw new FlowError('conflict', `${invoice.number} reached ${accounting.name} while this ran. Delete it again.`);
        }
        // An owner's override record keeps its invoice: Flow voids it, the
        // record stays, and the job is free again.
        if (held) {
          if (invoice.status === 'void') return invoice;
          const [row] = await tx.update(invoices).set({ status: 'void', updatedAt: sql`now()` })
            .where(eq(invoices.id, invoice.id)).returning();
          await freeJobs(tx, organisationId, row, actor);
          return row;
        }
        // The adapter's own rows for it (a released link) go first, and the
        // adapter keeps its record of the pair.
        if (typeof forget === 'function') await forget({ tx, organisationId, invoiceId: invoice.id, actor, reason: 'never_sent' });
        await removeUnsentInvoice(tx, organisationId, invoice, actor, { reason: 'never_sent' });
        return { ...invoice, removed: true };
      });
    }
  }
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
  const answer = await deleteInAccounting(accounting, organisationId, invoiceId, actor);
  const forget = accounting.capabilities.forgetInvoice;
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, organisationId, invoiceId, { lock: true });
    if (invoice.status === 'void') return invoice;
    if (invoice.issuedVersion === 0) {
      throw new FlowError('was_issued', 'an invoice that was issued cannot be deleted; void it');
    }
    if (answer.state !== 'voided' && !answer.customerSaw && typeof forget === 'function' && !(await hasSendOverride(tx, invoice.id))) {
      const forgotten = await forget({ tx, organisationId, invoiceId: invoice.id, actor, reason: 'deleted_in_accounting' });
      await removeUnsentInvoice(tx, organisationId, invoice, actor, { reason: 'deleted_in_accounting', accountingStatus: answer.status ?? null, accountingRef: forgotten?.accountingRef ?? null });
      return { ...invoice, removed: true };
    }
    const [row] = await tx.update(invoices).set({ status: 'void', updatedAt: sql`now()` })
      .where(eq(invoices.id, invoice.id)).returning();
    await freeJobs(tx, organisationId, row, actor);
    return row;
  });
}

export async function getInvoice(db, organisationId, invoiceId) {
  const invoice = await loadInvoice(db, organisationId, invoiceId);
  if (isImported(invoice)) return { ...invoice, lines: await importedLines(db, invoice) };
  const lines = await db.select().from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(asc(invoiceLines.position));
  return { ...invoice, lines };
}

// An imported invoice has no rows in Flow's line table: its lines are the
// accounting document's, as its newest version holds them. A quantity or a
// unit price can be null or a part number, as the accounting system gave it.
async function importedLines(db, invoice) {
  const [row] = await db.select({ document: invoiceVersions.document }).from(invoiceVersions)
    .where(and(eq(invoiceVersions.invoiceId, invoice.id), eq(invoiceVersions.version, invoice.issuedVersion)));
  return (row?.document?.lines ?? []).map((l, index) => ({
    position: l.position ?? index + 1,
    priceItemId: null,
    itemCode: l.itemCode ?? null,
    description: l.description ?? '',
    quantity: l.quantity ?? null,
    unitAmountCents: l.unitAmountCents ?? null,
    taxCode: l.taxCode ?? 'GST_FREE',
    taxType: l.taxType ?? null,
    discountRate: l.discountRate ?? null,
    accountCode: l.accountCode ?? null,
    lineAmountCents: l.lineAmountCents ?? 0,
    taxCents: l.taxCents ?? 0,
  }));
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
