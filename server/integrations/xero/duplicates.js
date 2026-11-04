import { sql } from 'drizzle-orm';
import { matchContactFor } from './catalogue.js';
import { mirrorState } from './lookup.js';
import { ledgerState } from './ledger.js';

// Only a current mirrored sales invoice of the linked client, containing
// every issued product at the same quantity/amount/tax, is offered. Reference
// alone is never proof. The person must still compare and confirm the pair.
export async function duplicateCandidate(db, organisationId, invoice, candidateId = null) {
  const id = candidateId ?? invoice.sendError?.xero?.invoiceId;
  if (!id || id !== invoice.sendError?.xero?.invoiceId) return null;
  const mirror = await mirrorState(db, organisationId);
  if (!mirror.complete || !mirror.fresh) return null;
  const { rows: [connection] } = await db.execute(sql`select tenant_id, connected_at from xero_connections where organisation_id = ${organisationId} for share`);
  if (!connection || mirror.lastPassAt < new Date(connection.connected_at)) return null;
  const { rows: pushes } = await db.execute(sql`select 1 from xero_invoice_pushes where organisation_id = ${organisationId} and invoice_id = ${invoice.id} limit 1`);
  if (pushes.length) return null; // includes unknown create/email outcomes
  const { rows: links } = await db.execute(sql`select 1 from xero_invoice_links where organisation_id = ${organisationId} and invoice_id = ${invoice.id} limit 1`);
  if (links.length) return null;
  const { rows: [version] } = await db.execute(sql`select document from invoice_versions where organisation_id = ${organisationId} and invoice_id = ${invoice.id} and version = ${invoice.issuedVersion}`);
  if (!version) return null;
  const match = await matchContactFor(db, organisationId, { contactId: invoice.contactId, name: version.document.contact.name });
  if (match.state !== 'matched') return null;
  const { rows: [candidate] } = await db.execute(sql`select * from xero_invoices where organisation_id = ${organisationId} and xero_invoice_id = ${id} and type = 'ACCREC' for share`);
  if (!candidate || new Date(candidate.first_seen_at) < new Date(connection.connected_at) || candidate.xero_contact_id !== match.contact.xeroContactId || candidate.currency !== invoice.currency || !['AUTHORISED', 'PAID'].includes(candidate.status)) return null;
  const remaining = [...(candidate.lines ?? [])];
  for (const line of version.document.lines) {
    if (!line.itemCode) return null;
    const index = remaining.findIndex((l) => l.itemCode === line.itemCode && Number(l.quantity) === line.quantity
      && l.lineAmountCents === line.lineAmountCents && l.taxAmountCents === line.taxCents);
    if (index < 0) return null;
    remaining.splice(index, 1);
  }
  return { system: 'xero', id: candidate.xero_invoice_id, number: candidate.invoice_number, reference: candidate.reference,
    contactId: candidate.xero_contact_id, totalCents: Number(candidate.total_cents), date: candidate.issued_on instanceof Date ? candidate.issued_on.toISOString().slice(0, 10) : String(candidate.issued_on).slice(0, 10),
    state: ledgerState({ Status: candidate.status, AmountPaid: Number(candidate.amount_paid_cents ?? 0), AmountCredited: Number(candidate.amount_credited_cents ?? 0) }),
    lines: candidate.lines, tenantId: connection.tenant_id, changedAt: candidate.last_changed_at,
    url: 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' + encodeURIComponent(candidate.xero_invoice_id) };
}
