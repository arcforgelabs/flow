import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { billingObligations, invoices, linkSuggestions, obligationEvents } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';

// The existing terminal status excludes a retained duplicate from every send,
// rule, import and reconciliation path. The resolution receipt distinguishes
// Duplicate from Void without a second independently mutable lifecycle.
export async function invoiceDuplicateCandidate(db, organisationId, invoiceId, { accounting, candidateId = null } = {}) {
  if (!accounting?.capabilities?.duplicateCandidate) return null;
  const [invoice] = await db.select().from(invoices).where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)));
  if (!invoice) throw notFound('invoice');
  if (invoice.status !== 'issued' || ![null, 'failed'].includes(invoice.sendState)) return null;
  const jobs = await db.select().from(billingObligations).where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, invoiceId))).orderBy(billingObligations.id);
  if (!jobs.length || jobs.some((j) => j.contactId !== invoice.contactId || j.holdState !== 'none')) return null;
  const candidate = await accounting.capabilities.duplicateCandidate({ transaction: db, organisationId, invoice, candidateId });
  if (!candidate) return null;
  const snapshot = { ...candidate, invoiceUpdatedAt: invoice.updatedAt.toISOString(), jobUpdates: jobs.map((j) => [j.id, j.updatedAt.toISOString()]) };
  return { ...snapshot, confirmation: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}

export async function linkInvoiceDuplicate(db, organisationId, invoiceId, { accounting, candidateId, confirmation, actor }) {
  if (!actor || !candidateId || !confirmation) throw new FlowError('invalid', 'Confirm the matching invoice before linking.');
  return db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId))).for('update');
    if (!invoice) throw notFound('invoice');
    if (invoice.duplicate) {
      if (invoice.duplicate.id === candidateId && invoice.duplicate.confirmation === confirmation) return invoice;
      throw new FlowError('conflict', 'This invoice was already resolved differently.');
    }
    // Lock the jobs before checking the receipt. A source change cannot race
    // the association; no job is freed, and none can draft another invoice.
    const jobs = await tx.select().from(billingObligations).where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, invoiceId))).orderBy(billingObligations.id).for('update');
    const candidate = await invoiceDuplicateCandidate(tx, organisationId, invoiceId, { accounting, candidateId });
    if (!candidate || candidate.confirmation !== confirmation) throw new FlowError('conflict', 'The invoice or match changed. Refresh and compare again.');
    if (jobs.some((j) => j.accountingRef && j.accountingRef !== candidate.id)) throw new FlowError('conflict', 'A job is linked to another accounting invoice.');
    const receipt = { ...candidate, confirmation, actor, at: new Date().toISOString() };
    for (const job of jobs) {
      await tx.update(billingObligations).set({ accountingRef: candidate.id, accountingState: candidate.state, accountingCheckedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(billingObligations.id, job.id));
      await tx.update(linkSuggestions).set({ state: 'stale', updatedAt: sql`now()` }).where(and(eq(linkSuggestions.organisationId, organisationId), eq(linkSuggestions.obligationId, job.id), eq(linkSuggestions.state, 'open')));
      await tx.insert(obligationEvents).values({ organisationId, obligationId: job.id, kind: 'duplicate_linked', actor, evidence: { invoiceId, number: invoice.number, matchedBy: 'person', candidate: receipt } });
    }
    const [closed] = await tx.update(invoices).set({ status: 'void', duplicate: receipt, sendState: null, updatedAt: sql`now()` }).where(eq(invoices.id, invoiceId)).returning();
    return closed;
  });
}
