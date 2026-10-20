import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { billingObligations, contacts } from '../db/schema.js';
import { notFound } from './errors.js';
import { linkSuggestionsFor } from './ledger.js';

// The Reconcile page (docs/JOB_INVOICE_LINKS.md, "A person settles it"): the
// jobs with no invoice whose match is unclear, and for one job its possible
// invoices beside it, each fact compared. It only reads. Linking and "no
// invoice" are confirmNoInvoice and linkJobInvoice (ledger.js).

const UNLINKED = and(
  eq(billingObligations.accountingState, 'ambiguous'),
  isNull(billingObligations.invoiceId),
  isNull(billingObligations.accountingRef),
);

// The queue, oldest job first: { id, clientName, practitioner, jobDate,
// totalCents, possible }.
export async function listUnlinkedJobs(db, organisationId) {
  const rows = await db.select({
    id: billingObligations.id,
    clientName: contacts.name,
    practitioner: billingObligations.practitioner,
    jobDate: billingObligations.jobDate,
    totalCents: billingObligations.totalCents,
    possible: sql`(select count(*) from link_suggestions s
      where s.organisation_id = ${billingObligations.organisationId} and s.obligation_id = ${billingObligations.id} and s.state = 'open')`.mapWith(Number),
  }).from(billingObligations)
    .leftJoin(contacts, eq(contacts.id, billingObligations.contactId))
    .where(and(eq(billingObligations.organisationId, organisationId), UNLINKED))
    .orderBy(sql`${billingObligations.jobDate} asc nulls last`, asc(billingObligations.createdAt));
  return rows;
}

const SAME = 'same';
const DIFFERS = 'differs';
const daysApart = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const norm = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// One fact of a candidate against the job: `same`, `differs`, or null when
// either side does not know.
function compare(ours, theirs) {
  if (ours == null || ours === '' || theirs == null || theirs === '') return null;
  return norm(ours) === norm(theirs) ? SAME : DIFFERS;
}

// The job's lines and an invoice's as one comparison: same codes and amounts,
// in any order.
function compareLines(jobLines, invoiceLines) {
  const key = (l) => `${String(l.code ?? l.itemCode ?? '').toUpperCase()}|${l.amountCents ?? ''}`;
  if (!jobLines.length || !invoiceLines.length) return null;
  const ours = jobLines.map(key).sort().join(',');
  const theirs = invoiceLines.filter((l) => l.amountCents).map(key).sort().join(',');
  return ours === theirs ? SAME : DIFFERS;
}

// One job and its possible invoices, best first, each fact compared with the
// job's. `accounting` is the accounting adapter (findInvoices); `reference`
// is the Reference Flow would give the job's invoice (references.js).
export async function jobMatchDetail(db, organisationId, obligationId, { accounting, reference = null }) {
  const [row] = await db.select({ obligation: billingObligations, clientName: contacts.name })
    .from(billingObligations)
    .leftJoin(contacts, eq(contacts.id, billingObligations.contactId))
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId)));
  if (!row) throw notFound('job');
  const o = row.obligation;
  const lines = (o.lines ?? []).map((l) => ({ code: l.itemCode ?? null, description: l.description ?? null, amountCents: lineCents(l) }));
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
    lines,
    totalCents: o.totalCents,
    open: o.accountingState === 'ambiguous' && !o.invoiceId && !o.accountingRef,
  };
  const suggestions = (await linkSuggestionsFor(db, organisationId, o.id)).filter((s) => s.system === accounting.id);
  if (!suggestions.length) return { job, invoices: [] };
  const ids = suggestions.map((s) => s.externalId);
  const { invoices } = await accounting.capabilities.findInvoices({ organisationId, invoiceIds: ids });
  const byId = new Map(invoices.map((i) => [i.id, i]));
  // Other jobs already linked to each invoice.
  const linked = await db.select({ ref: billingObligations.accountingRef, id: billingObligations.id, jobDate: billingObligations.jobDate, totalCents: billingObligations.totalCents })
    .from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), inArray(billingObligations.accountingRef, ids)));
  const linkedTo = Map.groupBy(linked, (l) => l.ref);
  const contactName = row.clientName;
  return {
    job,
    invoices: suggestions.filter((s) => byId.has(s.externalId)).map((s, index) => {
      const i = byId.get(s.externalId);
      const signals = (s.signals ?? []).map((x) => x.signal);
      return {
        id: i.id,
        number: i.number,
        issuedOn: i.issuedOn,
        status: i.status,
        state: i.state,
        reference: i.reference,
        lines: i.lines ?? [],
        totalCents: i.totalCents,
        amountDueCents: i.amountDueCents,
        url: i.url ?? null,
        best: index === 0,
        // The facts, each against the job's.
        checks: {
          client: contactName ? SAME : null,
          reference: compare(reference, i.reference),
          date: o.jobDate && i.issuedOn ? { days: daysApart(o.jobDate, i.issuedOn) } : null,
          lines: compareLines(lines, i.lines ?? []),
          total: o.totalCents == null || i.totalCents == null ? null
            : i.totalCents === o.totalCents || signals.includes('total_gst') ? SAME : DIFFERS,
          otherJobs: (linkedTo.get(i.id) ?? []).map((l) => ({ id: l.id, jobDate: l.jobDate, totalCents: l.totalCents })),
          closerJob: signals.includes('closer_job'),
        },
      };
    }),
  };
}

// A job line's amount before tax, as an accounting line holds it.
function lineCents(line) {
  if (line.lineAmountCents != null) return line.lineAmountCents;
  if (line.unitAmountCents == null) return null;
  return line.unitAmountCents * (line.quantity ?? 1);
}

