import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { billingObligations, contacts, invoices, invoiceVersions } from '../db/schema.js';
import { HISTORY_HOLD_REASON } from './history.js';
import { invoiceTab } from './invoice-status.js';

// A job for every accounting invoice (owner rule, 14 November 2026). An
// imported invoice that no job from a work system is tied to still has a
// job: Flow builds it from the invoice on each read. It is not stored, so it
// is never a second job for the same work: when a work system's job takes
// the invoice's accounting reference, the built job is gone and that job
// answers.
//
// A built job has the shape of a ledger job on GET /jobs, with `built: true`.
// Its id is the invoice's accounting reference. It is read only: every job
// route that writes answers "job not found" for it. It is past work, so it is
// listed with the history jobs only (history=include).

const STATE_OF_TAB = { paid: 'paid', void: 'voided' };
const VIEW_OF_STATE = { paid: 'paid', authorised: 'invoiced', voided: 'held' };

export async function builtJobs(db, organisationId, { accounting = null } = {}) {
  const refsFor = accounting?.capabilities?.importedRefs;
  if (typeof refsFor !== 'function') return [];
  const rows = await db.select({ invoice: invoices, contactName: contacts.name, document: invoiceVersions.document }).from(invoices)
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .leftJoin(invoiceVersions, and(eq(invoiceVersions.invoiceId, invoices.id), eq(invoiceVersions.version, invoices.issuedVersion)))
    .where(and(eq(invoices.organisationId, organisationId), ne(invoices.origin, 'flow')))
    .orderBy(desc(invoices.issueDate), desc(invoices.createdAt));
  if (!rows.length) return [];
  const invoiceIds = rows.map((r) => r.invoice.id);
  const refOf = await refsFor({ organisationId, invoiceIds });
  const refs = [...new Set(refOf.values())];
  if (!refs.length) return [];
  // A job from a work system holds this reference: that job answers.
  const tied = new Set((await db.selectDistinct({ ref: billingObligations.accountingRef }).from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), inArray(billingObligations.accountingRef, refs)))).map((r) => r.ref));
  const stages = typeof accounting.capabilities.invoiceStages === 'function'
    ? await accounting.capabilities.invoiceStages({ organisationId, invoiceIds })
    : new Map();
  return rows.filter(({ invoice }) => refOf.has(invoice.id) && !tied.has(refOf.get(invoice.id))).map(({ invoice, contactName, document }) => {
    const ref = refOf.get(invoice.id);
    const tab = invoiceTab({ status: invoice.status, stage: stages.get(invoice.id) ?? null, connected: true });
    const accountingState = STATE_OF_TAB[tab] ?? 'authorised';
    return {
      id: ref,
      built: true,
      sourceSystem: accounting.id,
      sourceJobRef: ref,
      sourceInvoiceRef: invoice.number,
      caseRef: null,
      sourceStatus: null,
      contactId: invoice.contactId,
      contactName: contactName ?? null,
      practitioner: null,
      jobDate: invoice.issueDate,
      shippedOn: null,
      lines: (document?.lines ?? []).map((l) => ({
        itemCode: l.itemCode ?? null, description: l.description ?? null, quantity: l.quantity ?? null,
        unitAmountCents: l.unitAmountCents ?? null, lineAmountCents: l.lineAmountCents ?? 0, taxCents: l.taxCents ?? 0,
      })),
      totalCents: invoice.totalCents,
      // The imported invoice is the accounting system's, never the job's own.
      invoiceId: null,
      importedInvoiceId: invoice.id,
      invoiceNumber: invoice.number,
      invoiceStatus: invoice.status,
      invoiceView: null,
      invoiceTab: tab,
      invoiceProblems: [],
      accountingRef: ref,
      accountingState,
      holdState: 'held',
      holdReason: HISTORY_HOLD_REASON,
      readyAt: null,
      noChargeReason: null,
      canUseNewLines: false,
      view: VIEW_OF_STATE[accountingState],
      reasons: [`invoice ${invoice.number} is ${accountingState.replace('_', ' ')} in ${accounting.name}`, 'no job from a work system is tied to it'],
      sourceNeeds: [],
      waitingFor: [],
      waitingRules: [],
    };
  });
}
