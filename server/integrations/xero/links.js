import { and, eq, sql } from 'drizzle-orm';
import { contacts, priceItems } from '../../db/schema.js';
import { createContact } from '../../core/directory.js';
import { FlowError } from '../../core/errors.js';
import { createDraftInvoice, issueInvoice } from '../../core/invoices.js';
import { linkJobToInvoice } from '../../core/ledger.js';
import { normaliseName } from './catalogue.js';

// The Import page (docs/XERO_IMPORT.md): each sales invoice in Flow's copy of
// Xero against Flow's own invoices. Flow's own records are the ones it works
// from; this integration says which Flow invoice each Xero invoice is.
//
//   linked        a Flow invoice is this Xero invoice: Flow sent it (a push),
//                 the import matched it, or a person linked or made it.
//   invoice_fits  a Flow invoice of the same client, total and week has no
//                 Xero invoice. One fit both ways is linked by `matchXero`;
//                 more than one waits for a person.
//   job_fits      no Flow invoice, but a Flow job with no invoice fits: the
//                 earlier matcher tied it to this Xero invoice, or it has the
//                 same client and total within a week. A person makes the Flow
//                 invoice from the Xero one and links the job.
//   none          nothing in Flow fits. The Xero invoice stays in the copy; a
//                 person can make its Flow invoice at any time, or the
//                 `make_unmatched` setting makes one for each.
//
// It reads only Flow's database: no Xero call.

export const IMPORT_STATES = Object.freeze(['linked', 'invoice_fits', 'job_fits', 'none']);
const FIT_DAYS = 7;
const SKIP_STATUSES = ['DELETED', 'VOIDED'];
const num = (value) => (value === null || value === undefined ? null : Number(value));
const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null);
const daysApart = (a, b) => (a && b ? Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000)) : null);
const near = (a, b) => {
  const days = daysApart(a, b);
  return days !== null && days <= FIT_DAYS;
};

// Every sales invoice in the copy, and what in Flow fits it.
async function classify(db, organisationId) {
  const { rows: xero } = await db.execute(sql`
    select x.xero_invoice_id, x.invoice_number, x.reference, x.status, x.issued_on, x.total_cents, x.amount_due_cents,
      x.xero_contact_id, c.name as contact_name, c.email as contact_email
    from xero_invoices x
    left join xero_contacts c on c.organisation_id = x.organisation_id and c.xero_contact_id = x.xero_contact_id
    where x.organisation_id = ${organisationId} and x.type = 'ACCREC'
      and not (x.status = any(${sql.param(SKIP_STATUSES)}::text[]))
    order by x.issued_on desc nulls last, x.invoice_number desc`);
  const { rows: linkRows } = await db.execute(sql`
    select xero_invoice_id, invoice_id, 'sent' as matched_by from xero_invoice_pushes
      where organisation_id = ${organisationId} and xero_invoice_id is not null
    union all
    select xero_invoice_id, invoice_id, matched_by from xero_invoice_links where organisation_id = ${organisationId}`);
  const linkOf = new Map();
  const linkedInvoices = new Set();
  for (const r of linkRows) {
    if (!linkOf.has(r.xero_invoice_id)) linkOf.set(r.xero_invoice_id, r);
    linkedInvoices.add(r.invoice_id);
  }
  // Flow's customers by name, as the drafts match them (only a name with one
  // contact counts).
  const people = await db.select({ id: contacts.id, name: contacts.name }).from(contacts)
    .where(and(eq(contacts.organisationId, organisationId), eq(contacts.kind, 'customer')));
  const byName = new Map();
  for (const p of people) {
    const key = normaliseName(p.name);
    byName.set(key, byName.has(key) ? null : p.id);
  }
  const { rows: flowInvoices } = await db.execute(sql`
    select i.id, i.number, i.contact_id, i.total_cents, i.status, coalesce(i.issue_date, i.created_at::date) as date
    from invoices i
    where i.organisation_id = ${organisationId} and i.status <> 'void'`);
  const open = flowInvoices.filter((i) => !linkedInvoices.has(i.id));
  const { rows: jobs } = await db.execute(sql`
    select o.id, o.contact_id, o.total_cents, o.job_date, o.practitioner, o.case_ref, o.accounting_ref
    from billing_obligations o
    where o.organisation_id = ${organisationId} and o.invoice_id is null`);
  const jobByRef = new Map(jobs.filter((j) => j.accounting_ref).map((j) => [j.accounting_ref, j]));

  const rows = xero.map((x) => {
    const contactId = x.contact_name ? byName.get(normaliseName(x.contact_name)) ?? null : null;
    const row = {
      xeroInvoiceId: x.xero_invoice_id,
      number: x.invoice_number,
      reference: x.reference,
      status: x.status,
      issuedOn: day(x.issued_on),
      totalCents: num(x.total_cents),
      amountDueCents: num(x.amount_due_cents),
      clientName: x.contact_name,
      contactId,
      link: null,
      invoices: [],
      jobs: [],
    };
    const link = linkOf.get(x.xero_invoice_id);
    if (link) {
      const invoice = flowInvoices.find((i) => i.id === link.invoice_id);
      row.link = { invoiceId: link.invoice_id, number: invoice?.number ?? null, matchedBy: link.matched_by };
      return { ...row, state: 'linked' };
    }
    if (contactId) {
      row.invoices = open.filter((i) => i.contact_id === contactId && num(i.total_cents) === row.totalCents && near(day(i.date), row.issuedOn))
        .map((i) => ({ id: i.id, number: i.number, status: i.status, date: day(i.date), totalCents: num(i.total_cents) }));
    }
    if (row.invoices.length) return { ...row, state: 'invoice_fits' };
    const tied = jobByRef.get(x.xero_invoice_id);
    const fits = tied ? [tied] : contactId
      ? jobs.filter((j) => !j.accounting_ref && j.contact_id === contactId && num(j.total_cents) === row.totalCents && near(day(j.job_date), row.issuedOn))
      : [];
    row.jobs = fits.map((j) => ({ id: j.id, jobDate: day(j.job_date), practitioner: j.practitioner, caseRef: j.case_ref, totalCents: num(j.total_cents), tied: j === tied }));
    return { ...row, state: row.jobs.length ? 'job_fits' : 'none' };
  });
  // A Flow invoice that fits more than one Xero invoice is not a sure match.
  const fitsOf = new Map();
  for (const r of rows) for (const i of r.invoices) fitsOf.set(i.id, (fitsOf.get(i.id) ?? 0) + 1);
  for (const r of rows) r.sure = r.state === 'invoice_fits' && r.invoices.length === 1 && fitsOf.get(r.invoices[0].id) === 1;
  return rows;
}

const matches = (row, q) => {
  const words = q.trim().toLowerCase();
  if (!words) return true;
  const amount = /^\$?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)$/.exec(words);
  if (amount && row.totalCents === Math.round(Number(amount[1].replace(/,/g, '')) * 100)) return true;
  return [row.number, row.clientName, row.reference].some((v) => v && String(v).toLowerCase().includes(words));
};

// The page: counts by state, and one page of rows. `show` is a state or
// 'all'; `q` searches number, client, Reference or amount.
export async function importOverview(db, organisationId, { show = 'all', q = '', limit = 50, offset = 0 } = {}) {
  const rows = await classify(db, organisationId);
  const counts = Object.fromEntries(IMPORT_STATES.map((s) => [s, 0]));
  for (const r of rows) counts[r.state] += 1;
  const shown = rows.filter((r) => (show === 'all' || r.state === show) && matches(r, q));
  const settings = await readImportSettings(db, organisationId);
  return { counts, total: shown.length, rows: shown.slice(offset, offset + limit), settings };
}

export async function readImportSettings(db, organisationId) {
  const { rows } = await db.execute(sql`select make_unmatched from xero_import_settings where organisation_id = ${organisationId}`);
  return { makeUnmatched: Boolean(rows[0]?.make_unmatched) };
}

export async function saveImportSettings(db, organisationId, { makeUnmatched, actor }) {
  if (typeof makeUnmatched !== 'boolean') throw new FlowError('invalid', 'makeUnmatched must be true or false');
  await db.execute(sql`insert into xero_import_settings (organisation_id, make_unmatched, updated_by, updated_at)
    values (${organisationId}, ${makeUnmatched}, ${actor}, now())
    on conflict (organisation_id) do update set make_unmatched = excluded.make_unmatched, updated_by = excluded.updated_by, updated_at = now()`);
  return readImportSettings(db, organisationId);
}

async function insertLink(db, organisationId, { xeroInvoiceId, invoiceId, matchedBy, actor }) {
  const { rows } = await db.execute(sql`insert into xero_invoice_links (organisation_id, xero_invoice_id, invoice_id, matched_by, linked_by)
    values (${organisationId}, ${xeroInvoiceId}, ${invoiceId}, ${matchedBy}, ${actor})
    on conflict do nothing returning xero_invoice_id`);
  if (!rows.length) throw new FlowError('invalid', 'the Xero invoice or the Flow invoice is linked already');
}

async function rowFor(db, organisationId, xeroInvoiceId) {
  const row = (await classify(db, organisationId)).find((r) => r.xeroInvoiceId === xeroInvoiceId);
  if (!row) throw new FlowError('not_found', 'Xero invoice not found in the copy');
  if (row.state === 'linked') throw new FlowError('invalid', 'the Xero invoice is linked already');
  return row;
}

// A person says which Flow invoice a Xero invoice is. Any Flow invoice of the
// same client with no Xero invoice may be picked, not only a fit.
export async function linkXeroInvoice(db, organisationId, xeroInvoiceId, { invoiceId, actor }) {
  await rowFor(db, organisationId, xeroInvoiceId);
  const { rows } = await db.execute(sql`select id, status from invoices where organisation_id = ${organisationId} and id = ${invoiceId}`);
  if (!rows.length) throw new FlowError('not_found', 'Flow invoice not found');
  if (rows[0].status === 'void') throw new FlowError('invalid', 'the Flow invoice is void');
  const { rows: pushed } = await db.execute(sql`select 1 from xero_invoice_pushes where organisation_id = ${organisationId} and invoice_id = ${invoiceId} and xero_invoice_id is not null limit 1`);
  if (pushed.length) throw new FlowError('invalid', 'Flow sent that invoice to Xero already');
  await insertLink(db, organisationId, { xeroInvoiceId, invoiceId, matchedBy: 'person', actor });
  return { xeroInvoiceId, invoiceId };
}

// Makes Flow's own invoice from a Xero invoice in the copy, finalised on the
// Xero invoice's date, and links the two. With `jobId`, the job gets it as its
// invoice. The client is Flow's customer of the same name, or a new one.
// Lines keep the Xero item code where Flow's price list has it; Flow works
// out its own totals from the lines.
export async function makeFlowInvoice(db, organisationId, xeroInvoiceId, { jobId = null, actor }) {
  return makeFrom(db, organisationId, await rowFor(db, organisationId, xeroInvoiceId), { jobId, actor });
}

async function makeFrom(db, organisationId, row, { jobId = null, actor }) {
  const { xeroInvoiceId } = row;
  const { rows: [x] } = await db.execute(sql`select x.lines, x.due_on, c.email from xero_invoices x
    left join xero_contacts c on c.organisation_id = x.organisation_id and c.xero_contact_id = x.xero_contact_id
    where x.organisation_id = ${organisationId} and x.xero_invoice_id = ${xeroInvoiceId}`);
  if (!row.clientName) throw new FlowError('invalid', 'the Xero invoice has no contact in the copy; sync contacts first');
  return db.transaction(async (tx) => {
    const contactId = row.contactId ?? (await createContact(tx, organisationId, { kind: 'customer', name: row.clientName, email: x.email ?? null })).id;
    const items = await tx.select({ id: priceItems.id, code: priceItems.code, name: priceItems.name }).from(priceItems)
      .where(eq(priceItems.organisationId, organisationId));
    const byCode = new Map(items.map((i) => [i.code.toUpperCase(), i]));
    const lines = (x.lines ?? []).filter((l) => l.lineAmountCents).map((l) => {
      const item = l.itemCode ? byCode.get(String(l.itemCode).toUpperCase()) : null;
      const whole = Number.isInteger(l.quantity) && l.quantity > 0 && l.lineAmountCents % l.quantity === 0;
      return {
        priceItemId: item?.id ?? null,
        accountCode: item ? null : l.accountCode ?? null,
        description: l.description ?? item?.name ?? l.itemCode ?? 'Line from Xero',
        quantity: whole ? l.quantity : 1,
        unitAmountCents: whole ? l.lineAmountCents / l.quantity : l.lineAmountCents,
        taxCode: l.taxAmountCents ? 'GST' : 'GST_FREE',
      };
    });
    if (!lines.length) throw new FlowError('invalid', 'the Xero invoice has no lines in the copy');
    const draft = await createDraftInvoice(tx, organisationId, { contactId, reference: row.reference ?? null, dueDate: day(x.due_on), lines });
    const invoice = await issueInvoice(tx, organisationId, draft.id, { issuedBy: actor, issueDate: row.issuedOn ?? new Date().toISOString().slice(0, 10) });
    await insertLink(tx, organisationId, { xeroInvoiceId, invoiceId: invoice.id, matchedBy: 'made', actor });
    if (jobId) await linkJobToInvoice(tx, organisationId, jobId, { invoiceId: invoice.id, accountingRef: xeroInvoiceId, actor });
    return { xeroInvoiceId, invoice };
  });
}

// Links each sure fit, and with `make_unmatched` on makes a Flow invoice for
// each Xero invoice nothing fits. Answers counts. The history import runs it
// after each read of the copy; a person can run it from the page.
export async function matchXero(db, organisationId, { actor = 'automation:xero-import' } = {}) {
  const rows = await classify(db, organisationId);
  const { makeUnmatched } = await readImportSettings(db, organisationId);
  const result = { linked: 0, made: 0, failed: 0 };
  for (const row of rows) {
    if (row.sure) {
      await insertLink(db, organisationId, { xeroInvoiceId: row.xeroInvoiceId, invoiceId: row.invoices[0].id, matchedBy: 'auto', actor }).then(() => { result.linked += 1; }, () => { result.failed += 1; });
    } else if (makeUnmatched && row.state === 'none') {
      await makeFrom(db, organisationId, row, { actor }).then(() => { result.made += 1; }, () => { result.failed += 1; });
    }
  }
  return result;
}
