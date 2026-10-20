import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { billingObligations, contacts, invoiceLines, invoices, priceItems } from '../db/schema.js';
import { notFound } from './errors.js';

// The Reconcile page (docs/JOB_INVOICE_LINKS.md, "Reconcile"): Flow's own
// jobs against Flow's own invoices. A job that is ready to invoice and has
// no Flow invoice, and a Flow invoice that no job is linked to, are gaps.
// For one of them it lists the possible other side, each fact compared. It
// only reads; linkJobToInvoice and confirmNoInvoice (ledger.js) write.
// Matching a Flow invoice to one in an accounting system is that
// integration's own work, not this page's.

// A job with no Flow invoice that should have one: ready, not held, and not
// tied to an accounting invoice by the earlier matcher.
const JOB_GAP = and(
  isNotNull(billingObligations.readyAt),
  isNull(billingObligations.invoiceId),
  isNull(billingObligations.accountingRef),
  ne(billingObligations.holdState, 'held'),
);

const hasJob = sql`exists (select 1 from billing_obligations o
  where o.organisation_id = ${invoices.organisationId} and o.invoice_id = ${invoices.id})`;

const SAME = 'same';
const DIFFERS = 'differs';
const daysApart = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const norm = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const WINDOW_DAYS = 60;
// An invoice's date: its issue date, or the day a draft was made.
const dateOf = (i) => i.issueDate ?? (i.createdAt ? new Date(i.createdAt).toISOString().slice(0, 10) : null);
const SHOWN = 3;
const SEARCHED = 8;

// One fact against the other side's: `same`, `differs`, or null when either
// side does not know.
function compare(ours, theirs) {
  if (ours == null || ours === '' || theirs == null || theirs === '') return null;
  return norm(ours) === norm(theirs) ? SAME : DIFFERS;
}

// Two sets of lines, the same price items and amounts in any order.
function compareLines(a, b) {
  if (!a.length || !b.length) return null;
  const key = (l) => `${l.priceItemId ?? norm(l.code)}|${l.amountCents ?? ''}`;
  return a.map(key).sort().join(',') === b.map(key).sort().join(',') ? SAME : DIFFERS;
}

// A job line's amount before tax.
function lineCents(line) {
  if (line.lineAmountCents != null) return line.lineAmountCents;
  if (line.unitAmountCents == null) return null;
  return line.unitAmountCents * (line.quantity ?? 1);
}

// Every fact of one candidate against the record it may belong to. `a` and
// `b` are { contactId, reference, date, lines, totalCents }.
function checksOf(a, b, otherCount) {
  return {
    client: a.contactId && b.contactId ? (a.contactId === b.contactId ? SAME : DIFFERS) : null,
    reference: compare(a.reference, b.reference),
    date: a.date && b.date ? { days: daysApart(a.date, b.date) } : null,
    lines: compareLines(a.lines, b.lines),
    total: a.totalCents == null || b.totalCents == null ? null : a.totalCents === b.totalCents ? SAME : DIFFERS,
    others: otherCount,
  };
}

// Higher is a better match: the total, the lines, the Reference, the date,
// and not taken by another record.
function scoreOf(c) {
  return (c.total === SAME ? 4 : 0) + (c.lines === SAME ? 3 : 0) + (c.reference === SAME ? 3 : 0) + (c.client === SAME ? 2 : 0)
    + (c.date && Math.abs(c.date.days) <= 3 ? 1 : 0) - (c.others ? 2 : 0);
}

async function codesFor(db, organisationId, ids) {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: priceItems.id, code: priceItems.code }).from(priceItems)
    .where(and(eq(priceItems.organisationId, organisationId), inArray(priceItems.id, ids)));
  return new Map(rows.map((r) => [r.id, r.code]));
}

function jobLines(o, codes) {
  return (o.lines ?? []).map((l) => ({
    priceItemId: l.priceItemId ?? null, code: l.itemCode ?? codes.get(l.priceItemId) ?? null, description: l.description ?? null, amountCents: lineCents(l),
  }));
}

// The two queues, oldest first. jobs: { id, clientName, practitioner,
// jobDate, totalCents, possible }; invoices: { id, number, clientName,
// issueDate, status, totalCents, possible }. `possible` counts the other
// side with the same client and total.
export async function listReconcile(db, organisationId) {
  const jobs = await db.select({
    id: billingObligations.id,
    clientName: contacts.name,
    practitioner: billingObligations.practitioner,
    jobDate: billingObligations.jobDate,
    totalCents: billingObligations.totalCents,
    // An unclear accounting match: "Make invoice" settles it first.
    unclear: sql`${billingObligations.accountingState} = 'ambiguous'`.mapWith(Boolean),
    possible: sql`(select count(*) from invoices i
      where i.organisation_id = ${billingObligations.organisationId} and i.contact_id = ${billingObligations.contactId}
        and i.status <> 'void' and i.total_cents = ${billingObligations.totalCents}
        and not exists (select 1 from billing_obligations x where x.organisation_id = i.organisation_id and x.invoice_id = i.id))`.mapWith(Number),
  }).from(billingObligations)
    .leftJoin(contacts, eq(contacts.id, billingObligations.contactId))
    .where(and(eq(billingObligations.organisationId, organisationId), JOB_GAP))
    .orderBy(sql`${billingObligations.jobDate} asc nulls last`, asc(billingObligations.createdAt));
  const lonely = await db.select({
    id: invoices.id,
    number: invoices.number,
    clientName: contacts.name,
    issueDate: sql`coalesce(${invoices.issueDate}, ${invoices.createdAt}::date)::text`,
    status: invoices.status,
    totalCents: invoices.totalCents,
    possible: sql`(select count(*) from billing_obligations o
      where o.organisation_id = ${invoices.organisationId} and o.contact_id = ${invoices.contactId}
        and o.invoice_id is null and o.accounting_ref is null and o.total_cents = ${invoices.totalCents})`.mapWith(Number),
  }).from(invoices)
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .where(and(eq(invoices.organisationId, organisationId), ne(invoices.status, 'void'), sql`not ${hasJob}`))
    .orderBy(sql`${invoices.issueDate} asc nulls last`, asc(invoices.createdAt));
  return { jobs, invoices: lonely };
}

// One job and the Flow invoices that may be its own, best first. With `q`,
// any Flow invoice whose number, client, Reference or total matches.
// `reference` is the Reference Flow would give the job's invoice.
export async function jobMatchDetail(db, organisationId, obligationId, { reference = null, q = '' } = {}) {
  const [row] = await db.select({ obligation: billingObligations, clientName: contacts.name })
    .from(billingObligations)
    .leftJoin(contacts, eq(contacts.id, billingObligations.contactId))
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId)));
  if (!row) throw notFound('job');
  const o = row.obligation;
  const codes = await codesFor(db, organisationId, (o.lines ?? []).map((l) => l.priceItemId).filter(Boolean));
  const job = {
    id: o.id,
    clientName: row.clientName,
    practitioner: o.practitioner,
    reference,
    jobDate: o.jobDate,
    sourceSystem: o.sourceSystem,
    sourceJobRef: o.sourceJobRef,
    caseRef: o.caseRef,
    sourceStatus: o.sourceStatus,
    lines: jobLines(o, codes),
    totalCents: o.totalCents,
    open: !o.invoiceId && !o.accountingRef,
    // An unclear accounting match: "Make invoice" settles it first.
    unclear: o.accountingState === 'ambiguous',
  };

  const search = String(q ?? '').trim();
  const where = [eq(invoices.organisationId, organisationId), ne(invoices.status, 'void')];
  if (search) where.push(searchInvoices(search));
  else {
    if (!o.contactId) return { job, invoices: [] };
    where.push(eq(invoices.contactId, o.contactId));
    if (o.jobDate) where.push(sql`abs(coalesce(${invoices.issueDate}, ${invoices.createdAt}::date) - ${o.jobDate}::date) <= ${WINDOW_DAYS}`);
  }
  const found = await db.select({ invoice: invoices, clientName: contacts.name }).from(invoices)
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .where(and(...where)).orderBy(desc(invoices.createdAt)).limit(50);
  const detail = await invoiceFacts(db, organisationId, found.map((f) => f.invoice));
  const ours = { contactId: o.contactId, reference, date: o.jobDate, lines: job.lines, totalCents: o.totalCents };
  const ranked = found.map(({ invoice, clientName }) => {
    const d = detail.get(invoice.id);
    const checks = checksOf(ours, { contactId: invoice.contactId, reference: invoice.reference, date: dateOf(invoice), lines: d.lines, totalCents: invoice.totalCents }, d.jobs.length);
    return {
      id: invoice.id, number: invoice.number, clientName, issueDate: invoice.issueDate, date: dateOf(invoice), status: invoice.status,
      reference: invoice.reference, lines: d.lines, totalCents: invoice.totalCents, jobs: d.jobs, checks, score: scoreOf(checks),
    };
  }).sort((a, b) => b.score - a.score).slice(0, search ? SEARCHED : SHOWN);
  return { job, invoices: ranked.map((c, index) => ({ ...c, best: index === 0 && c.score > 0 })) };
}

// One Flow invoice with no job, and the jobs with no invoice that may be its
// own, best first.
export async function invoiceMatchDetail(db, organisationId, invoiceId, { q = '' } = {}) {
  const [row] = await db.select({ invoice: invoices, clientName: contacts.name }).from(invoices)
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)));
  if (!row) throw notFound('invoice');
  const i = row.invoice;
  const d = (await invoiceFacts(db, organisationId, [i])).get(i.id);
  const invoice = {
    id: i.id, number: i.number, clientName: row.clientName, issueDate: i.issueDate, date: dateOf(i), status: i.status, reference: i.reference,
    lines: d.lines, totalCents: i.totalCents, jobs: d.jobs, open: d.jobs.length === 0 && i.status !== 'void',
  };
  const search = String(q ?? '').trim();
  const where = [eq(billingObligations.organisationId, organisationId), isNull(billingObligations.invoiceId), isNull(billingObligations.accountingRef)];
  if (search) {
    const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
    where.push(or(ilike(contacts.name, like), ilike(billingObligations.practitioner, like), ilike(billingObligations.caseRef, like), ilike(billingObligations.sourceJobRef, like)));
  } else {
    where.push(eq(billingObligations.contactId, i.contactId));
    if (invoice.date) where.push(sql`abs(coalesce(${billingObligations.jobDate}, ${billingObligations.createdAt}::date) - ${invoice.date}::date) <= ${WINDOW_DAYS}`);
  }
  const found = await db.select({ obligation: billingObligations, clientName: contacts.name }).from(billingObligations)
    .leftJoin(contacts, eq(contacts.id, billingObligations.contactId))
    .where(and(...where)).orderBy(desc(billingObligations.createdAt)).limit(50);
  const codes = await codesFor(db, organisationId, found.flatMap((f) => (f.obligation.lines ?? []).map((l) => l.priceItemId)).filter(Boolean));
  const theirs = { contactId: i.contactId, reference: i.reference, date: invoice.date, lines: d.lines, totalCents: i.totalCents };
  const ranked = found.map(({ obligation: o, clientName }) => {
    const lines = jobLines(o, codes);
    const checks = checksOf(theirs, { contactId: o.contactId, reference: null, date: o.jobDate, lines, totalCents: o.totalCents }, 0);
    return {
      id: o.id, clientName, practitioner: o.practitioner, jobDate: o.jobDate, caseRef: o.caseRef, sourceStatus: o.sourceStatus,
      sourceSystem: o.sourceSystem, lines, totalCents: o.totalCents, ready: Boolean(o.readyAt), checks, score: scoreOf(checks),
    };
  }).sort((a, b) => b.score - a.score).slice(0, search ? SEARCHED : SHOWN);
  return { invoice, jobs: ranked.map((c, index) => ({ ...c, best: index === 0 && c.score > 0 })) };
}

// A search box's words against Flow invoices: number, client, Reference, or
// a total in dollars ("150" or "$150.00").
function searchInvoices(search) {
  const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
  const terms = [ilike(invoices.number, like), ilike(contacts.name, like), ilike(invoices.reference, like)];
  const amount = /^\$?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)$/.exec(search);
  if (amount) terms.push(eq(invoices.totalCents, Math.round(Number(amount[1].replace(/,/g, '')) * 100)));
  return or(...terms);
}

// Each invoice's lines (code and amount before tax) and the jobs linked to it.
async function invoiceFacts(db, organisationId, rows) {
  const ids = rows.map((r) => r.id);
  const facts = new Map(ids.map((id) => [id, { lines: [], jobs: [] }]));
  if (!ids.length) return facts;
  const lines = await db.select({ invoiceId: invoiceLines.invoiceId, priceItemId: invoiceLines.priceItemId, code: priceItems.code, description: invoiceLines.description, amountCents: invoiceLines.lineAmountCents })
    .from(invoiceLines)
    .leftJoin(priceItems, eq(priceItems.id, invoiceLines.priceItemId))
    .where(and(eq(invoiceLines.organisationId, organisationId), inArray(invoiceLines.invoiceId, ids)))
    .orderBy(asc(invoiceLines.position));
  for (const { invoiceId, ...line } of lines) facts.get(invoiceId).lines.push(line);
  const jobs = await db.select({ id: billingObligations.id, invoiceId: billingObligations.invoiceId, jobDate: billingObligations.jobDate, practitioner: billingObligations.practitioner })
    .from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), inArray(billingObligations.invoiceId, ids)));
  for (const { invoiceId, ...job } of jobs) facts.get(invoiceId).jobs.push(job);
  return facts;
}
