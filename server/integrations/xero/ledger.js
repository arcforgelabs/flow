import { and, eq, inArray, sql } from 'drizzle-orm';
import { recordAccountingEvidence, recordPayment } from '../../core/ledger.js';
import { billingObligations, contacts as flowContacts } from '../../db/schema.js';
import { matchContact, parseXeroDate } from './catalogue.js';
import { withXeroLane } from './governor.js';

// What the billing obligation ledger (server/core/ledger.js) needs from Xero:
//
// - checkInvoice: does Xero hold an invoice for this job? It answers in the
//   ledger's evidence shape ({ state, accountingRef, accountingUrl,
//   matchedBy, checkedAt }) and is the `liveCheck` for
//   draftInvoiceForObligation, so a draft is made only when Xero has none.
// - readPayments: sales invoice payments changed since a time, in the shape
//   recordPayment takes.
// - recordXeroPayments: reads those payments, ties each to its job by an
//   exact match only, refreshes the job's invoice state, and records them.
//
// Exact matches, as the ledger defines them:
//   flow_invoice        the Xero invoice Flow made from the job's Flow invoice
//                       (xero_invoice_pushes)
//   accounting_ref      the Xero invoice id the ledger already holds
//   source_invoice_ref  a Xero invoice whose number or reference is the work
//                       system's own invoice number for the job
// A Xero invoice for the same customer with the job's case reference is not
// exact: it is reported with matchedBy "reference", which the ledger records
// as ambiguous and which refuses a draft. Any doubt fails closed.

export const PAYMENTS_FIRST_DAYS = 90;

// Xero invoice status to the ledger's accounting state.
export function ledgerState(invoice) {
  switch (invoice?.Status) {
    case 'DRAFT':
    case 'SUBMITTED':
      return 'drafted';
    case 'AUTHORISED':
      return Number(invoice.AmountPaid) > 0 || Number(invoice.AmountCredited) > 0 ? 'part_paid' : 'authorised';
    case 'PAID':
      return 'paid';
    case 'VOIDED':
      return 'voided';
    case 'DELETED':
      return 'deleted';
    default:
      return null;
  }
}

const shortCodes = new Map(); // tenant id -> Xero organisation short code

async function invoiceUrl(runtime, client, invoiceId) {
  if (!shortCodes.has(client.tenantId)) {
    const organisation = await client.getOrganisation().catch(() => null);
    if (organisation?.ShortCode) shortCodes.set(client.tenantId, organisation.ShortCode);
  }
  const shortCode = shortCodes.get(client.tenantId);
  const view = `/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(invoiceId)}`;
  if (!shortCode) return null;
  return `${runtime.settings.endpoints.web}/organisationlogin/default.aspx?shortcode=${encodeURIComponent(shortCode)}&redirecturl=${encodeURIComponent(view)}`;
}

async function evidenceFor(runtime, client, invoice, matchedBy, checkedAt) {
  return {
    state: ledgerState(invoice),
    accountingRef: invoice.InvoiceID,
    accountingUrl: await invoiceUrl(runtime, client, invoice.InvoiceID),
    matchedBy,
    checkedAt,
    xero: { invoiceId: invoice.InvoiceID, number: invoice.InvoiceNumber ?? null, status: invoice.Status, totalCents: Math.round(Number(invoice.Total ?? 0) * 100) },
  };
}

const notFound = (checkedAt) => ({ state: 'not_found', accountingRef: null, accountingUrl: null, matchedBy: null, checkedAt });

// More than one Xero invoice answers for the job: report one, with no exact
// match, so the ledger records the job as ambiguous for a person.
async function several(runtime, client, found, checkedAt) {
  const evidence = await evidenceFor(runtime, client, found[0], 'several', checkedAt);
  return { ...evidence, candidates: found.map((inv) => ({ invoiceId: inv.InvoiceID, number: inv.InvoiceNumber ?? null, status: inv.Status })) };
}

// The Xero invoice for one obligation (a row of billing_obligations), looked
// up live. Costs 1 to 4 Xero calls.
export async function checkInvoice(db, runtime, client, organisationId, obligation) {
  const checkedAt = new Date(runtime.now()).toISOString();

  // 1. The Xero invoice Flow made from the job's Flow invoice.
  if (obligation.invoiceId) {
    const { rows } = await db.execute(sql`select xero_invoice_id, state from xero_invoice_pushes
      where organisation_id = ${organisationId} and invoice_id = ${obligation.invoiceId} order by version desc`);
    const unsettled = rows.find((r) => !r.xero_invoice_id);
    if (unsettled) {
      // A push whose outcome is unknown: Xero may hold a draft. Never "not found".
      return { state: 'drafted', accountingRef: null, accountingUrl: null, matchedBy: 'unsettled_push', checkedAt };
    }
    // The newest version's Xero invoice that is still live; if every one is
    // deleted or voided, the newest one, so the ledger sees that.
    let newest = null;
    for (const row of rows) {
      const live = await client.getInvoice(row.xero_invoice_id);
      if (live && !['DELETED', 'VOIDED'].includes(live.Status)) return evidenceFor(runtime, client, live, 'flow_invoice', checkedAt);
      newest ??= live;
    }
    if (newest) return evidenceFor(runtime, client, newest, 'flow_invoice', checkedAt);
  }

  // 2. The Xero invoice the ledger already holds.
  if (obligation.accountingRef) {
    const live = await client.getInvoice(obligation.accountingRef).catch((error) => {
      if (error.status === 404) return null;
      throw error;
    });
    if (live) return evidenceFor(runtime, client, live, 'accounting_ref', checkedAt);
    return notFound(checkedAt); // the ledger records "seen before, now not found" as a conflict
  }

  const sales = (list) => list.filter((inv) => (inv.Type ?? 'ACCREC') === 'ACCREC' && !['DELETED', 'VOIDED'].includes(inv.Status));

  // 3. The work system's own invoice number, as Xero's number or reference.
  if (obligation.sourceInvoiceRef) {
    const byId = new Map();
    for (const inv of sales(await client.findInvoicesByNumber(obligation.sourceInvoiceRef))) byId.set(inv.InvoiceID, inv);
    for (const inv of sales(await client.findInvoicesByReference(obligation.sourceInvoiceRef))) byId.set(inv.InvoiceID, inv);
    const found = [...byId.values()];
    if (found.length === 1) return evidenceFor(runtime, client, found[0], 'source_invoice_ref', checkedAt);
    if (found.length > 1) return several(runtime, client, found, checkedAt);
  }

  // 4. The reference Flow would give the job's invoice, for the same
  // customer. Not exact: it refuses a draft and goes to a person.
  const reference = obligation.caseRef ?? obligation.sourceJobRef;
  if (reference) {
    let customer = null;
    if (obligation.contactId) {
      const [contact] = await db.select({ name: flowContacts.name }).from(flowContacts)
        .where(and(eq(flowContacts.organisationId, organisationId), eq(flowContacts.id, obligation.contactId)));
      const match = contact ? await matchContact(db, organisationId, contact.name) : { state: 'missing' };
      customer = match.state === 'matched' ? match.contact.xeroContactId : null;
      if (match.state === 'ambiguous') {
        const error = new Error(`More than one Xero contact is named "${contact.name}"; Flow cannot tell which invoices are this customer's.`);
        error.code = 'xero_contact_ambiguous';
        throw error;
      }
    }
    // Another customer's invoice with the same reference is not this job's.
    const found = sales(await client.findInvoicesByReference(reference))
      .filter((inv) => !customer || inv.Contact?.ContactID === customer);
    if (found.length === 1) return evidenceFor(runtime, client, found[0], 'reference', checkedAt);
    if (found.length > 1) return several(runtime, client, found, checkedAt);
  }
  return notFound(checkedAt);
}

// The ledger's liveCheck for draftInvoiceForObligation:
//   draftInvoiceForObligation(db, org, id, { liveCheck: xeroLiveCheck(db, runtime, org), actor })
// A Xero error throws, and the ledger then refuses the draft.
export function xeroLiveCheck(db, runtime, organisationId) {
  return (obligation) => withXeroLane('reads', async () => {
    const { client } = await runtime.clientFor(db, organisationId);
    return checkInvoice(db, runtime, client, organisationId, obligation);
  });
}

// Checks Xero for one obligation and records what it found as accounting
// evidence on the ledger.
export async function recordXeroEvidence(db, runtime, organisationId, obligation, { actor }) {
  const evidence = await xeroLiveCheck(db, runtime, organisationId)(obligation);
  if (evidence.state === null) return obligation;
  if (evidence.matchedBy === 'unsettled_push') return obligation;
  const { state, accountingRef, accountingUrl, matchedBy, checkedAt } = evidence;
  return recordAccountingEvidence(db, organisationId, obligation.id, { state, accountingRef, accountingUrl, matchedBy, checkedAt, actor });
}

function mapPayment(payment) {
  return {
    paymentRef: payment.PaymentID,
    paidOn: parseXeroDate(payment.Date)?.toISOString().slice(0, 10) ?? null,
    amountCents: Math.round(Number(payment.Amount) * 100),
    reference: payment.Reference || null,
    reconciled: Boolean(payment.IsReconciled),
    status: payment.Status ?? 'AUTHORISED',
    xeroInvoiceId: payment.Invoice?.InvoiceID ?? null,
    xeroInvoiceNumber: payment.Invoice?.InvoiceNumber ?? null,
    updatedAt: parseXeroDate(payment.UpdatedDateUTC),
  };
}

// Sales invoice payments changed since `since` (a Date). `cursor` is the
// latest change seen: pass it as `since` next time.
export async function readPayments(db, runtime, organisationId, { since }) {
  return withXeroLane('reads', async () => {
    const { client } = await runtime.clientFor(db, organisationId);
    const payments = (await client.listPaymentsSince(since)).map(mapPayment).filter((p) => p.paymentRef && p.xeroInvoiceId);
    const latest = payments.reduce((max, p) => (p.updatedAt && p.updatedAt > max ? p.updatedAt : max), since);
    return { payments, cursor: latest };
  });
}

async function readCursor(db, organisationId) {
  const { rows } = await db.execute(sql`select payments_since from xero_payment_cursors where organisation_id = ${organisationId}`);
  return rows[0]?.payments_since ?? null;
}

// Reads Xero payments since the stored cursor and records each on its job.
// A payment counts only when its Xero invoice ties to one job exactly: the
// Xero invoice Flow made from the job's Flow invoice (flow_invoice), or the
// one the ledger holds (accounting_ref). Before it records, Flow refreshes
// that job's invoice state from Xero, so the ledger takes the payment. Others
// are listed, not recorded. A deleted payment is listed for a person: the
// ledger keeps what it recorded.
export async function recordXeroPayments(db, runtime, organisationId, { actor, since: given = null } = {}) {
  return runtime.serial(organisationId, async () => {
    const since = given ?? await readCursor(db, organisationId)
      ?? new Date(runtime.now() - PAYMENTS_FIRST_DAYS * 86_400_000);
    const { payments, cursor } = await readPayments(db, runtime, organisationId, { since: new Date(since) });
    const result = { since: new Date(since).toISOString(), cursor: cursor.toISOString(), recorded: [], unmatched: [], deleted: [], failed: [] };

    const xeroIds = [...new Set(payments.map((p) => p.xeroInvoiceId))];
    const byFlowInvoice = new Map();
    if (xeroIds.length) {
      // Flow invoices sent to Xero, and those the Import page linked (links.js).
      const { rows } = await db.execute(sql`select xero_invoice_id, invoice_id from xero_invoice_pushes
        where organisation_id = ${organisationId} and xero_invoice_id = any(${sql.param(xeroIds)}::text[])
        union all select xero_invoice_id, invoice_id from xero_invoice_links
        where organisation_id = ${organisationId} and xero_invoice_id = any(${sql.param(xeroIds)}::text[])`);
      for (const row of rows) byFlowInvoice.set(row.xero_invoice_id, row.invoice_id);
    }
    const flowInvoiceIds = [...new Set(byFlowInvoice.values())];
    const obligations = xeroIds.length ? await db.select().from(billingObligations).where(and(
      eq(billingObligations.organisationId, organisationId),
      sql`(${flowInvoiceIds.length ? inArray(billingObligations.invoiceId, flowInvoiceIds) : sql`false`} or ${inArray(billingObligations.accountingRef, xeroIds)})`,
    )) : [];

    const refreshed = new Set();
    for (const payment of payments) {
      const shown = { paymentRef: payment.paymentRef, xeroInvoiceId: payment.xeroInvoiceId, amountCents: payment.amountCents, paidOn: payment.paidOn };
      if (payment.status === 'DELETED') {
        result.deleted.push(shown);
        continue;
      }
      const flowInvoiceId = byFlowInvoice.get(payment.xeroInvoiceId);
      const byFlow = flowInvoiceId ? obligations.filter((o) => o.invoiceId === flowInvoiceId) : [];
      const byRef = obligations.filter((o) => o.accountingRef === payment.xeroInvoiceId);
      const [obligation, matchedBy] = byFlow.length === 1 ? [byFlow[0], 'flow_invoice'] : byRef.length === 1 ? [byRef[0], 'accounting_ref'] : [null, null];
      if (!obligation) {
        result.unmatched.push(shown);
        continue;
      }
      try {
        if (!refreshed.has(obligation.id)) {
          await recordXeroEvidence(db, runtime, organisationId, obligation, { actor });
          refreshed.add(obligation.id);
        }
        const { paymentRef, paidOn, amountCents, reference, reconciled } = payment;
        const accountingUrl = (await db.select({ url: billingObligations.accountingUrl }).from(billingObligations)
          .where(eq(billingObligations.id, obligation.id)))[0]?.url ?? null;
        await recordPayment(db, organisationId, obligation.id, { paymentRef, paidOn, amountCents, reference, reconciled, accountingUrl, matchedBy, actor });
        result.recorded.push({ ...shown, obligationId: obligation.id, matchedBy });
      } catch (error) {
        result.failed.push({ ...shown, obligationId: obligation.id, error: { code: error.code ?? 'failed', message: error.message } });
      }
    }

    // Move the cursor only when every payment was settled one way or another,
    // so a failed one is read again next time.
    if (!result.failed.length) {
      await db.execute(sql`insert into xero_payment_cursors (organisation_id, payments_since) values (${organisationId}, ${cursor})
        on conflict (organisation_id) do update set payments_since = excluded.payments_since, updated_at = now()`);
    }
    return result;
  });
}
