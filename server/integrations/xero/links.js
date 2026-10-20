import { and, eq, sql } from 'drizzle-orm';
import { contacts, priceItems } from '../../db/schema.js';
import { createContact } from '../../core/directory.js';
import { FlowError } from '../../core/errors.js';
import { createDraftInvoice, issueInvoice } from '../../core/invoices.js';
import { linkJobToInvoice } from '../../core/ledger.js';
import { normaliseName } from './catalogue.js';
import { canFit, markRivals, scoreFit, sureFits } from './fit.js';

// The Import page (docs/XERO_IMPORT.md): each sales invoice in Flow's copy of
// Xero against Flow's own invoices. Flow's own records are the ones it works
// from; this integration says which Flow invoice each Xero invoice is.
//
//   linked        a Flow invoice is this Xero invoice: Flow sent it (a push),
//                 the import matched it, or a person linked or made it.
//   invoice_fits  a Flow invoice with no Xero invoice fits (fit.js: hard
//                 evidence from its jobs, or the same client, an amount that
//                 fits and dates within two weeks). A sure fit is linked by
//                 `matchXero`; the rest wait for a person.
//   job_fits      no Flow invoice, but a Flow job with no invoice fits: the
//                 earlier matcher tied it to this Xero invoice, its work-system
//                 invoice number is this Xero number, or it has the
//                 same client and total within a week. A person makes the Flow
//                 invoice from the Xero one and links the job.
//   none          nothing in Flow fits. The Xero invoice stays in the copy; a
//                 person can make its Flow invoice at any time, or the
//                 `make_unmatched` setting makes one for each.
//
// It reads only Flow's database: no Xero call.

export const IMPORT_STATES = Object.freeze(['linked', 'invoice_fits', 'job_fits', 'none']);
const CHECK = new Set(['invoice_fits', 'job_fits']);
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
      x.xero_contact_id, x.lines, c.name as contact_name, c.email as contact_email
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
    select i.id, i.number, i.contact_id, i.total_cents, i.subtotal_cents, i.reference, i.status, coalesce(i.issue_date, i.created_at::date) as date,
      coalesce((select array_agg(distinct p.code) from invoice_lines l join price_items p on p.id = l.price_item_id
        where l.invoice_id = i.id and p.code is not null), '{}') as item_codes,
      coalesce((select jsonb_agg(jsonb_build_object('accountingRef', o.accounting_ref, 'sourceInvoiceRef', o.source_invoice_ref, 'practitioner', o.practitioner))
        from billing_obligations o where o.organisation_id = i.organisation_id and o.invoice_id = i.id), '[]') as jobs
    from invoices i
    where i.organisation_id = ${organisationId} and i.status <> 'void'`);
  const open = flowInvoices.filter((i) => !linkedInvoices.has(i.id));
  const { rows: jobs } = await db.execute(sql`
    select o.id, o.contact_id, o.total_cents, o.job_date, o.practitioner, o.case_ref, o.accounting_ref, o.source_invoice_ref, o.lines
    from billing_obligations o
    where o.organisation_id = ${organisationId} and o.invoice_id is null`);
  const jobByRef = new Map(jobs.filter((j) => j.accounting_ref).map((j) => [j.accounting_ref, j]));
  // The work system's own invoice number, as Xero numbers it (a trailing R is
  // a reissue). Only a number one job holds counts.
  const workNumber = (ref) => String(ref ?? '').trim().replace(/R$/i, '').toLowerCase();
  const jobByNumber = new Map();
  for (const j of jobs) {
    if (!j.source_invoice_ref) continue;
    const key = workNumber(j.source_invoice_ref);
    jobByNumber.set(key, jobByNumber.has(key) ? null : j);
  }

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
    row.itemCodes = [...new Set((x.lines ?? []).map((l) => l.itemCode).filter(Boolean))];
    const xeroFit = { id: x.xero_invoice_id, number: x.invoice_number, contactId, totalCents: row.totalCents, issuedOn: row.issuedOn,
      itemCodes: (x.lines ?? []).map((l) => l.itemCode).filter(Boolean), reference: x.reference };
    row.invoices = open.map((i) => {
      const flowFit = { id: i.id, contactId: i.contact_id, totalCents: num(i.total_cents), subtotalCents: num(i.subtotal_cents), date: day(i.date),
        itemCodes: i.item_codes ?? [], reference: i.reference, jobs: i.jobs ?? [] };
      const scored = scoreFit(xeroFit, flowFit);
      return canFit(xeroFit, flowFit, scored)
        ? { id: i.id, number: i.number, status: i.status, date: day(i.date), totalCents: num(i.total_cents), reference: i.reference, itemCodes: flowFit.itemCodes,
          score: scored.score, hard: scored.hard, apart: daysApart(day(i.date), row.issuedOn) ?? 99 }
        : null;
    }).filter(Boolean);
    const tied = jobByRef.get(x.xero_invoice_id) ?? (x.invoice_number ? jobByNumber.get(workNumber(x.invoice_number)) : null) ?? null;
    const fits = tied ? [tied] : contactId
      ? jobs.filter((j) => !j.accounting_ref && j.contact_id === contactId && num(j.total_cents) === row.totalCents && near(day(j.job_date), row.issuedOn))
      : [];
    row.jobs = fits.map((j) => ({ id: j.id, jobDate: day(j.job_date), practitioner: j.practitioner, caseRef: j.case_ref, totalCents: num(j.total_cents), tied: j === tied,
      itemCodes: [...new Set((j.lines ?? []).map((l) => l.itemCode).filter(Boolean))] }));
    return row;
  });
  // A Flow invoice dated closer to another Xero invoice more likely is that
  // one (the job matcher's closer_job lesson): those fits lose points.
  markRivals(rows.flatMap((r) => r.invoices.map((i) => ({ xeroId: r.xeroInvoiceId, flowId: i.id, apart: i.apart, fit: i }))));
  for (const r of rows) {
    if (r.state === 'linked') continue;
    r.invoices.sort((a, b) => b.score - a.score);
    const hard = r.invoices.some((i) => i.hard);
    const tiedJob = r.jobs.some((j) => j.tied);
    const plain = r.invoices.some((i) => !i.rival);
    // Hard evidence wins; a job tied to this Xero invoice beats a plain fit;
    // a Flow invoice that is closer to another Xero invoice yields to a job.
    if (hard || (!tiedJob && (plain || !r.jobs.length) && r.invoices.length)) r.state = 'invoice_fits';
    else if (r.jobs.length) {
      r.state = 'job_fits';
      r.invoices = [];
    } else r.state = 'none';
    if (r.state === 'invoice_fits') r.jobs = [];
  }
  // Sure only when it is clearly the one fit both ways (fit.js).
  const sure = sureFits(rows.filter((r) => r.state === 'invoice_fits')
    .flatMap((r) => r.invoices.map((i) => ({ xeroId: r.xeroInvoiceId, flowId: i.id, score: i.score, hard: i.hard }))));
  for (const r of rows) {
    r.sure = r.state === 'invoice_fits' && sure.has(r.xeroInvoiceId);
    if (r.sure) r.invoices.sort((a, b) => (b.id === sure.get(r.xeroInvoiceId)) - (a.id === sure.get(r.xeroInvoiceId)));
    for (const i of r.invoices) { delete i.apart; delete i.rival; }
  }
  return rows;
}

const matches = (row, q) => {
  const words = q.trim().toLowerCase();
  if (!words) return true;
  const amount = /^\$?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)$/.exec(words);
  if (amount && row.totalCents === Math.round(Number(amount[1].replace(/,/g, '')) * 100)) return true;
  return [row.number, row.clientName, row.reference].some((v) => v && String(v).toLowerCase().includes(words));
};

// The page: counts by state, and one page of rows. `show` is a state, 'check'
// (what a person checks: a Flow invoice or a job fits), or 'all'; `q`
// searches number, client, Reference or amount.
export async function importOverview(db, organisationId, { show = 'all', q = '', limit = 50, offset = 0 } = {}) {
  const rows = await classify(db, organisationId);
  const counts = Object.fromEntries(IMPORT_STATES.map((s) => [s, 0]));
  for (const r of rows) counts[r.state] += 1;
  const shown = rows.filter((r) => (show === 'all' || r.state === show || (show === 'check' && CHECK.has(r.state))) && matches(r, q));
  const settings = await readImportSettings(db, organisationId);
  return { counts, total: shown.length, rows: shown.slice(offset, offset + limit), settings };
}

// `autoLink` (on): the import links each sure fit. `makeUnmatched` (off):
// it also makes a Flow invoice for each Xero invoice nothing fits.
export async function readImportSettings(db, organisationId) {
  const { rows } = await db.execute(sql`select auto_link, make_unmatched from xero_import_settings where organisation_id = ${organisationId}`);
  return { autoLink: rows[0] ? Boolean(rows[0].auto_link) : true, makeUnmatched: Boolean(rows[0]?.make_unmatched) };
}

// Saves the settings given; a setting left out keeps its value.
export async function saveImportSettings(db, organisationId, { autoLink, makeUnmatched, actor }) {
  for (const [name, value] of [['autoLink', autoLink], ['makeUnmatched', makeUnmatched]]) {
    if (value !== undefined && typeof value !== 'boolean') throw new FlowError('invalid', `${name} must be true or false`);
  }
  const next = { ...(await readImportSettings(db, organisationId)) };
  if (autoLink !== undefined) next.autoLink = autoLink;
  if (makeUnmatched !== undefined) next.makeUnmatched = makeUnmatched;
  await db.execute(sql`insert into xero_import_settings (organisation_id, auto_link, make_unmatched, updated_by, updated_at)
    values (${organisationId}, ${next.autoLink}, ${next.makeUnmatched}, ${actor}, now())
    on conflict (organisation_id) do update set auto_link = excluded.auto_link, make_unmatched = excluded.make_unmatched,
      updated_by = excluded.updated_by, updated_at = now()`);
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

// With `autoLink` on, links each sure fit; with `makeUnmatched` on, makes a Flow invoice for
// each Xero invoice nothing fits. Answers counts. The history import runs it
// after each read of the copy; a person can run it from the page.
export async function matchXero(db, organisationId, { actor = 'automation:xero-import' } = {}) {
  const rows = await classify(db, organisationId);
  const { autoLink, makeUnmatched } = await readImportSettings(db, organisationId);
  const result = { linked: 0, made: 0, failed: 0 };
  for (const row of rows) {
    if (row.sure && autoLink) {
      await insertLink(db, organisationId, { xeroInvoiceId: row.xeroInvoiceId, invoiceId: row.invoices[0].id, matchedBy: 'auto', actor }).then(() => { result.linked += 1; }, () => { result.failed += 1; });
    } else if (makeUnmatched && row.state === 'none') {
      await makeFrom(db, organisationId, row, { actor }).then(() => { result.made += 1; }, () => { result.failed += 1; });
    }
  }
  return result;
}
