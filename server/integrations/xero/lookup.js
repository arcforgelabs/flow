import { sql } from 'drizzle-orm';
import { ledgerState } from './ledger.js';

// What the core's matcher (server/core/pipeline.js) reads from Xero: the
// customers and the sales invoices in Flow's own copy. It never calls Xero, so
// matching a whole history costs no API calls.

// How old the mirror's last finished pass may be before "no invoice found"
// stops counting as proof.
export const MIRROR_FRESH_MS = 24 * 60 * 60 * 1000;

// The copies that prove whether Xero holds an invoice for a job. Payments do
// not: a connection without a payments scope (the default) never copies them,
// and must still match jobs.
export const PROOF_RESOURCES = Object.freeze(['invoices', 'credit_notes']);

export async function listCustomers(db, organisationId) {
  const { rows } = await db.execute(sql`
    select xero_contact_id, name, status from xero_contacts
    where organisation_id = ${organisationId} and status = 'ACTIVE'
    order by name`);
  return rows.map((r) => ({ id: r.xero_contact_id, name: r.name }));
}

// Whether the mirror holds the whole history and was read lately. Until then a
// search that finds nothing proves nothing.
export async function mirrorState(db, organisationId, { now = new Date() } = {}) {
  const { rows } = await db.execute(sql`
    select resource, passes, last_pass_finished_at from xero_mirror_cursors
    where organisation_id = ${organisationId}`);
  const byResource = new Map(rows.map((r) => [r.resource, r]));
  const invoices = byResource.get('invoices');
  const finished = PROOF_RESOURCES.every((r) => (byResource.get(r)?.passes ?? 0) > 0);
  const lastPass = invoices?.last_pass_finished_at ? new Date(invoices.last_pass_finished_at) : null;
  const { rows: [changed] } = await db.execute(sql`
    select max(last_changed_at) as at from xero_invoices where organisation_id = ${organisationId}`);
  return {
    complete: finished,
    fresh: Boolean(lastPass && now - lastPass <= MIRROR_FRESH_MS),
    lastPassAt: lastPass,
    // The latest change the mirror copied, so the matcher looks at a job again
    // only when the mirror moved on.
    changedAt: changed?.at ? new Date(changed.at) : null,
  };
}

const ids = (list) => sql.param([...new Set(list.map(String))]);

function invoiceRow(r) {
  return {
    id: r.xero_invoice_id,
    number: r.invoice_number,
    contactId: r.xero_contact_id,
    status: r.status,
    // The ledger's accounting state for this invoice.
    state: ledgerState({ Status: r.status, AmountPaid: Number(r.amount_paid_cents ?? 0), AmountCredited: Number(r.amount_credited_cents ?? 0) }),
    issuedOn: r.issued_on instanceof Date ? r.issued_on.toISOString().slice(0, 10) : r.issued_on,
    subtotalCents: r.subtotal_cents === null ? null : Number(r.subtotal_cents),
    totalCents: r.total_cents === null ? null : Number(r.total_cents),
    amountDueCents: r.amount_due_cents === null ? null : Number(r.amount_due_cents),
    amountPaidCents: r.amount_paid_cents === null ? null : Number(r.amount_paid_cents),
    amountCreditedCents: r.amount_credited_cents === null ? null : Number(r.amount_credited_cents),
    itemCodes: [...new Set((r.lines ?? []).map((l) => l.itemCode).filter(Boolean))],
    flowInvoiceId: r.flow_invoice_id ?? null,
    changedAt: r.last_changed_at,
  };
}

// Sales invoices from the mirror, by any of: Xero ids, invoice numbers, the
// Flow invoices Flow sent, or one customer within a date range. Answers the
// mirror's state with them, and the latest change time it holds.
export async function findInvoices(db, organisationId, query = {}) {
  const { invoiceIds = [], numbers = [], flowInvoiceIds = [], contactId = null, from = null, to = null } = query;
  const where = [];
  if (invoiceIds.length) where.push(sql`i.xero_invoice_id = any(${ids(invoiceIds)}::text[])`);
  if (numbers.length) where.push(sql`upper(i.invoice_number) = any(${sql.param([...new Set(numbers.map((n) => String(n).toUpperCase()))])}::text[])`);
  if (flowInvoiceIds.length) where.push(sql`p.invoice_id = any(${ids(flowInvoiceIds)}::uuid[])`);
  if (contactId) {
    where.push(sql`(i.xero_contact_id = ${contactId}
      ${from ? sql`and i.issued_on >= ${from}::date` : sql``}
      ${to ? sql`and i.issued_on <= ${to}::date` : sql``})`);
  }
  const state = await mirrorState(db, organisationId);
  if (!where.length) return { ...state, invoices: [] };
  const { rows } = await db.execute(sql`
    select i.*, p.invoice_id as flow_invoice_id
    from xero_invoices i
    left join lateral (
      select invoice_id from xero_invoice_pushes
      where organisation_id = i.organisation_id and xero_invoice_id = i.xero_invoice_id
      order by version desc limit 1
    ) p on true
    where i.organisation_id = ${organisationId} and i.type = 'ACCREC'
      and (${sql.join(where, sql` or `)})
    order by i.issued_on, i.xero_invoice_id
    limit 500`);
  return { ...state, invoices: rows.map(invoiceRow) };
}
