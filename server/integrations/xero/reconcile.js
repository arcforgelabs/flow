import { sql } from 'drizzle-orm';
import { openReview, resolveReviewFor } from '../../core/review.js';

// Each invoice Flow sent, against Flow's copy of Xero (issue #132). People
// change invoices in both places after Flow sends them: a Xero draft is edited
// before approval, an invoice is voided in Xero, or voided in Flow. The issued
// version Flow sent is the merge base: the document both sides agreed on.
// This module compares the Xero copy with it and with the Flow invoice now.
// It never calls Xero and never writes to Xero or to the Flow invoice: a
// difference opens one review item (alert only), and a person fixes it where
// they choose. The item closes when a later check finds no difference.

export const OUT_OF_SYNC = 'invoice.accounting_differs';
export const ACTOR = 'system:xero-reconcile';

// Xero's status in the words the Flow screens show.
const LABELS = {
  not_sent: 'Not in Xero',
  sending: 'Sending to Xero',
  not_copied: 'Sent, not read back yet',
  draft: 'Draft in Xero',
  approved: 'Approved in Xero',
  part_paid: 'Part paid in Xero',
  paid: 'Paid in Xero',
  voided: 'Voided in Xero',
  deleted: 'Deleted in Xero',
};

const GONE = new Set(['VOIDED', 'DELETED']);

function xeroState(row) {
  switch (row.status) {
    case 'DRAFT':
    case 'SUBMITTED':
      return 'draft';
    case 'AUTHORISED':
      return Number(row.amount_paid_cents ?? 0) > 0 ? 'part_paid' : 'approved';
    case 'PAID':
      return 'paid';
    case 'VOIDED':
      return 'voided';
    case 'DELETED':
      return 'deleted';
    default:
      return 'draft';
  }
}

const num = (value) => (value === null || value === undefined ? null : Number(value));
const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null);
const codes = (lines) => [...(lines ?? []).map((l) => l.itemCode ?? '')].sort().join(',');

// What differs between the Xero copy and the version Flow sent. Free text
// (reference, descriptions) is not compared yet.
export function sentDifferences(sent, document, copy) {
  const found = [];
  const add = (field, flow, xero) => found.push({ field, flow, xero });
  if (sent?.Contact?.ContactID && copy.xero_contact_id !== sent.Contact.ContactID) add('contact', sent.Contact.ContactID, copy.xero_contact_id);
  if (num(copy.subtotal_cents) !== document.subtotalCents) add('subtotal', document.subtotalCents, num(copy.subtotal_cents));
  if (num(copy.tax_cents) !== document.taxCents) add('tax', document.taxCents, num(copy.tax_cents));
  if (num(copy.total_cents) !== document.totalCents) add('total', document.totalCents, num(copy.total_cents));
  const lines = copy.lines ?? [];
  if (lines.length !== document.lines.length) add('line count', document.lines.length, lines.length);
  else if (codes(lines) !== codes(document.lines)) add('items', codes(document.lines), codes(lines));
  if (sent?.Date && day(copy.issued_on) !== sent.Date) add('date', sent.Date, day(copy.issued_on));
  return found;
}

// The finding for one invoice, or null when Flow and Xero agree.
//   differs         Xero's copy no longer matches the version Flow sent
//   voided_in_xero  Xero voided or deleted it; the Flow invoice is still issued
//   voided_in_flow  Flow voided it; Xero's invoice is still live
function findingFor(status) {
  if (!status.xero) return null;
  const live = !GONE.has(status.xero.status);
  if (status.flowStatus === 'void' && live) return 'voided_in_flow';
  if (status.flowStatus === 'issued' && status.current && !live) return 'voided_in_xero';
  if (live && status.differences.length) return 'differs';
  return null;
}

const MESSAGES = {
  differs: 'Xero no longer matches the invoice Flow sent.',
  voided_in_xero: 'Xero voided or deleted this invoice. It is still issued in Flow.',
  voided_in_flow: 'This invoice is void in Flow. Xero still holds it as a live invoice.',
};

// Each invoice's Xero status, from Flow's copy (no Xero calls). Answers a map
// from Flow invoice id to { state, label, xero, differences, finding, message }.
export async function accountingStatus(db, runtime, organisationId, invoiceIds = null) {
  const only = invoiceIds ? sql`and i.id = any(${sql.param([...new Set(invoiceIds.map(String))])}::uuid[])` : sql``;
  // Without ids: only invoices Flow sent or linked, for the check after each read.
  const sentOnly = invoiceIds ? sql`` : sql`and (p.id is not null or l.xero_invoice_id is not null)`;
  const { rows } = await db.execute(sql`
    select i.id, i.status, i.issued_version, i.total_cents,
      p.version as sent_version, p.state as push_state, p.request_body, p.xero_invoice_id, p.xero_invoice_number,
      v.document, l.xero_invoice_id as linked_xero_id, l.matched_by as linked_by,
      x.status as x_status, x.invoice_number as x_number, x.xero_contact_id, x.subtotal_cents, x.tax_cents,
      x.total_cents as x_total_cents, x.amount_paid_cents, x.amount_due_cents, x.lines, x.issued_on
    from invoices i
    left join lateral (
      select * from xero_invoice_pushes
      where organisation_id = i.organisation_id and invoice_id = i.id
      order by version desc limit 1
    ) p on true
    left join invoice_versions v on v.invoice_id = i.id and v.version = p.version
    -- A Flow invoice the Import page linked to a Xero invoice (links.js).
    left join xero_invoice_links l on l.organisation_id = i.organisation_id and l.invoice_id = i.id
    left join xero_invoices x on x.organisation_id = i.organisation_id and x.xero_invoice_id = coalesce(p.xero_invoice_id, l.xero_invoice_id)
    where i.organisation_id = ${organisationId} ${only} ${sentOnly}`);
  const web = runtime.settings.endpoints?.web ?? 'https://go.xero.com';
  const out = new Map();
  for (const r of rows) {
    let state;
    const linked = !r.push_state && Boolean(r.linked_xero_id);
    if (linked) state = r.x_status ? xeroState({ status: r.x_status, amount_paid_cents: r.amount_paid_cents }) : 'not_copied';
    else if (!r.push_state) state = 'not_sent';
    else if (['dispatching', 'ambiguous'].includes(r.push_state)) state = 'sending';
    else if (!r.x_status) state = 'not_copied';
    else state = xeroState({ status: r.x_status, amount_paid_cents: r.amount_paid_cents });
    let sent = null;
    try {
      sent = r.request_body ? JSON.parse(r.request_body) : null;
    } catch {
      sent = null;
    }
    const xeroInvoiceId = r.xero_invoice_id ?? r.linked_xero_id;
    const xero = r.x_status ? {
      invoiceId: xeroInvoiceId,
      number: r.x_number ?? r.xero_invoice_number ?? null,
      status: r.x_status,
      totalCents: num(r.x_total_cents),
      amountDueCents: num(r.amount_due_cents),
      url: `${web}/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(xeroInvoiceId)}`,
    } : null;
    const status = {
      invoiceId: r.id,
      flowStatus: r.status,
      sentVersion: r.sent_version ?? null,
      // A linked invoice was never sent: it is the Xero invoice, as it stands.
      current: linked || (r.sent_version !== null && r.sent_version === r.issued_version),
      linkedBy: linked ? r.linked_by : null,
      state,
      label: LABELS[state],
      xero,
      differences: !linked && xero && r.document && !GONE.has(r.x_status) ? sentDifferences(sent, r.document, { ...r, total_cents: r.x_total_cents }) : [],
      flowTotalCents: num(r.total_cents),
    };
    status.finding = findingFor(status);
    status.message = status.finding ? MESSAGES[status.finding] : null;
    out.set(r.id, status);
  }
  return out;
}

// Opens or refreshes one review item for each finding, and closes the item of
// an invoice whose finding went away. Answers counts.
export async function checkSentInvoices(db, runtime, organisationId, { invoiceIds = null } = {}) {
  const statuses = await accountingStatus(db, runtime, organisationId, invoiceIds);
  const result = { checked: 0, open: 0, closed: 0 };
  for (const status of statuses.values()) {
    if (status.state === 'not_sent') continue;
    result.checked += 1;
    if (status.finding) {
      await openReview(db, organisationId, {
        kind: OUT_OF_SYNC,
        entity: 'invoice',
        flowId: status.invoiceId,
        systems: ['flow', 'xero'],
        evidence: { finding: status.finding, message: status.message, flowStatus: status.flowStatus, sentVersion: status.sentVersion, xero: status.xero, differences: status.differences },
        moneyAtRiskCents: Math.abs(status.xero?.totalCents ?? status.flowTotalCents ?? 0),
      });
      result.open += 1;
    } else if (await resolveReviewFor(db, organisationId, { kind: OUT_OF_SYNC, entity: 'invoice', flowId: status.invoiceId, resolution: 'no_difference', actor: ACTOR })) {
      result.closed += 1;
    }
  }
  return result;
}
