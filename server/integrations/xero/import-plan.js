import { sql } from 'drizzle-orm';
import { classify, readImportSettings } from './links.js';
import { mirrorState } from './lookup.js';
import { normaliseName } from './catalogue.js';

// The dry run of the history import (docs/XERO_IMPORT.md, "The full ledger"),
// and reconcile cover. Both read Flow's database only: no Xero call, no work
// system call, and nothing is written. An agent reads them the same way a
// person's page does.
//
//   importPlan      what importing every Xero sales invoice would do: how many
//                   by status and year, what blocks one (a number another
//                   invoice holds, no number, no contact), what a person
//                   looks at afterwards (odd lines, credited invoices), and
//                   the money each tab would show.
//   reconcileCover  for each side, how many records are tied, fit, or wait
//                   for a person: the measure before and after each batch.

// A removed draft in Xero was never an invoice: the import leaves it out.
const LEFT_OUT = ['DELETED'];
// The tab an imported invoice shows in, from its Xero status. A draft no
// customer saw is a draft, never a void (owner rule, 14 November 2026).
export const TAB_OF_STATUS = Object.freeze({ PAID: 'paid', AUTHORISED: 'awaiting', VOIDED: 'void', DRAFT: 'draft', SUBMITTED: 'draft' });
// Xero's sales tax types Flow's own lines can hold (GST and GST free).
const PLAIN_TAX = new Set(['OUTPUT', 'EXEMPTOUTPUT']);
const SAMPLE = 20;
const num = (value) => Number(value ?? 0);

// Why a Xero line does not fit Flow's own line table. The import stores the
// Xero document as it is and never refuses; these lines go to a person.
export function oddLineReasons(lines) {
  const reasons = new Set();
  if (!Array.isArray(lines) || !lines.length) return ['no_lines'];
  for (const line of lines) {
    const quantity = line.quantity;
    if (quantity === null || quantity === undefined || Number(quantity) <= 0) reasons.add('quantity');
    else if (!Number.isInteger(Number(quantity))) reasons.add('part_quantity');
    if (num(line.lineAmountCents) < 0) reasons.add('negative');
    if (line.discountRate) reasons.add('discount');
    if (line.taxType && !PLAIN_TAX.has(line.taxType)) reasons.add('tax_type');
  }
  return [...reasons];
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function importPlan(db, organisationId, { now = new Date() } = {}) {
  const copy = await mirrorState(db, organisationId, { now });
  const settings = await readImportSettings(db, organisationId);
  const { rows } = await db.execute(sql`
    select x.xero_invoice_id as id, x.invoice_number as number, x.status, x.issued_on, x.total_cents, x.amount_due_cents, x.amount_paid_cents,
      x.amount_credited_cents, x.xero_contact_id, x.lines, c.name as contact_name,
      coalesce(p.invoice_id, l.invoice_id) as flow_invoice_id, l.matched_by, i.number as flow_number
    from xero_invoices x
    left join xero_contacts c on c.organisation_id = x.organisation_id and c.xero_contact_id = x.xero_contact_id
    left join lateral (select invoice_id from xero_invoice_pushes where organisation_id = x.organisation_id and xero_invoice_id = x.xero_invoice_id limit 1) p on true
    left join xero_invoice_links l on l.organisation_id = x.organisation_id and l.xero_invoice_id = x.xero_invoice_id and l.released_at is null
    left join invoices i on i.organisation_id = x.organisation_id and i.id = coalesce(p.invoice_id, l.invoice_id)
    where x.organisation_id = ${organisationId} and x.type = 'ACCREC'
    order by x.issued_on nulls last, x.invoice_number`);
  const all = rows.filter((r) => !LEFT_OUT.includes(r.status));
  const pending = all.filter((r) => !r.flow_invoice_id);

  // Status and year.
  const byStatus = {};
  const years = new Map();
  for (const r of all) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const year = r.issued_on ? String(r.issued_on instanceof Date ? r.issued_on.toISOString() : r.issued_on).slice(0, 4) : 'none';
    const y = years.get(year) ?? { year, total: 0, toImport: 0, inFlow: 0, void: 0 };
    y.total += 1;
    y[r.flow_invoice_id ? 'inFlow' : 'toImport'] += 1;
    if (r.status === 'VOIDED') y.void += 1;
    years.set(year, y);
  }

  // Money per tab, as the copy has it: what each tab must show after the import.
  const money = {};
  for (const r of all) {
    const tab = TAB_OF_STATUS[r.status] ?? 'other';
    const m = money[tab] ??= { count: 0, totalCents: 0, dueCents: 0 };
    m.count += 1;
    m.totalCents += num(r.total_cents);
    m.dueCents += num(r.amount_due_cents);
  }

  // Numbers. An imported invoice keeps its Xero number, so each must be free
  // in Flow and held by one Xero invoice only.
  const { rows: flowNumbers } = await db.execute(sql`select id, number from invoices where organisation_id = ${organisationId} and number is not null`);
  const flowByNumber = new Map(flowNumbers.map((i) => [i.number, i.id]));
  const seen = new Map();
  for (const r of all) if (r.number) seen.set(r.number, (seen.get(r.number) ?? 0) + 1);
  const taken = all.filter((r) => r.number && flowByNumber.has(r.number) && flowByNumber.get(r.number) !== r.flow_invoice_id);
  const twice = [...seen].filter(([, n]) => n > 1).map(([number]) => number);
  const { rows: [org] } = await db.execute(sql`select invoice_prefix as prefix, next_invoice_number as next from organisations where id = ${organisationId}`);
  const pattern = new RegExp(`^${escapeRegex(org.prefix)}(\\d{1,9})$`);
  const highest = all.reduce((top, r) => Math.max(top, Number(pattern.exec(r.number ?? '')?.[1] ?? 0)), 0);

  // Contacts: Flow's customer by the identity link, then by a name one
  // customer holds; the rest are made by the import.
  const { rows: links } = await db.execute(sql`select external_id from external_links
    where organisation_id = ${organisationId} and system = 'xero' and entity = 'contact' and state = 'active'`);
  const linked = new Set(links.map((l) => l.external_id));
  const { rows: customers } = await db.execute(sql`select name, aliases from contacts
    where organisation_id = ${organisationId} and kind = 'customer' and merged_into_id is null`);
  const names = new Map();
  for (const c of customers) for (const name of new Set([c.name, ...(c.aliases ?? [])].map(normaliseName))) names.set(name, (names.get(name) ?? 0) + 1);
  const contacts = { linked: new Set(), byName: new Set(), toCreate: new Set(), unknown: 0 };
  for (const r of pending) {
    if (!r.xero_contact_id || !r.contact_name) contacts.unknown += 1;
    else if (linked.has(r.xero_contact_id)) contacts.linked.add(r.xero_contact_id);
    else if (names.get(normaliseName(r.contact_name)) === 1) contacts.byName.add(r.xero_contact_id);
    else contacts.toCreate.add(r.xero_contact_id);
  }

  // Lines that do not fit Flow's own line table: a person looks at these.
  const odd = { invoices: 0, byReason: {}, sample: [] };
  for (const r of pending) {
    const reasons = oddLineReasons(r.lines);
    if (!reasons.length) continue;
    odd.invoices += 1;
    for (const reason of reasons) odd.byReason[reason] = (odd.byReason[reason] ?? 0) + 1;
    if (odd.sample.length < SAMPLE) odd.sample.push({ xeroInvoiceId: r.id, number: r.number, reasons });
  }

  const credited = all.filter((r) => num(r.amount_credited_cents) > 0);
  const made = all.filter((r) => r.matched_by === 'made');

  // Jobs tied by their accounting reference: the import changes none of them.
  const { rows: tied } = await db.execute(sql`select accounting_ref, count(*)::int as n from billing_obligations
    where organisation_id = ${organisationId} and accounting_ref is not null group by accounting_ref`);
  const jobsOf = new Map(tied.map((t) => [t.accounting_ref, t.n]));
  const withJobs = pending.filter((r) => jobsOf.has(r.id));

  const blocked = {
    noNumber: pending.filter((r) => !r.number).length,
    numberTaken: taken.filter((r) => !r.flow_invoice_id).length,
    numberTwice: pending.filter((r) => r.number && seen.get(r.number) > 1).length,
    noContact: contacts.unknown,
  };
  return {
    writes: false,
    copy: { complete: copy.complete, fresh: copy.fresh, lastPassAt: copy.lastPassAt },
    // The import refuses to run on a copy that is not complete and fresh.
    canRun: copy.complete && copy.fresh,
    switchOn: settings.makeUnmatched,
    invoices: { total: all.length, inFlow: all.length - pending.length, toImport: pending.length, leftOut: rows.length - all.length, byStatus, byYear: [...years.values()] },
    blocked,
    numbers: {
      taken: { count: taken.length, sample: taken.slice(0, SAMPLE).map((r) => ({ xeroInvoiceId: r.id, number: r.number, linkedFlowNumber: r.flow_number ?? null })) },
      twiceInXero: { count: twice.length, sample: twice.slice(0, SAMPLE) },
      next: { now: Number(org.next), after: Math.max(Number(org.next), highest + 1) },
    },
    contacts: { linked: contacts.linked.size, byName: contacts.byName.size, toCreate: contacts.toCreate.size, invoicesWithNoContact: contacts.unknown },
    oddLines: odd,
    credited: { invoices: credited.length, creditedCents: credited.reduce((sum, r) => sum + num(r.amount_credited_cents), 0) },
    // Flow invoices made earlier from a Xero invoice, with a Flow number: the
    // import converts each to the Xero number.
    madeEarlier: { count: made.length, otherNumber: made.filter((r) => r.flow_number !== r.number).length },
    jobs: { invoicesWithJobs: withJobs.length, jobs: withJobs.reduce((sum, r) => sum + jobsOf.get(r.id), 0), invoicesWithSeveralJobs: withJobs.filter((r) => jobsOf.get(r.id) > 1).length },
    money,
  };
}

// For each side, where every record stands. Invoices: each Xero sales invoice
// (a removed draft is left out). Jobs: each job from the work system.
//   invoices  inFlow     a Flow invoice is this Xero invoice
//             tied       no Flow invoice, but a job holds its accounting reference
//             fits       something in Flow may fit: a person checks
//             none       nothing in Flow fits (the import still shows it, with a job built from it)
//             void       voided in Xero (counted here only)
//   jobs      invoiced   the job has its own Flow invoice
//             tied       no Flow invoice, but it holds an accounting reference
//             noCharge   a rule or a person said no charge
//             needsPerson  no invoice found, or more than one fits
//             open       not checked or not billed yet
export async function reconcileCover(db, organisationId) {
  const rows = await classify(db, organisationId);
  const invoices = { total: 0, inFlow: 0, tied: 0, fits: 0, none: 0, void: 0 };
  for (const r of rows) {
    invoices.total += 1;
    if (r.state === 'linked') invoices.inFlow += 1;
    else if (r.jobs.some((j) => j.tied)) invoices.tied += 1;
    else if (r.state === 'none') invoices.none += 1;
    else invoices.fits += 1;
  }
  const { rows: [voids] } = await db.execute(sql`select count(*)::int as n from xero_invoices
    where organisation_id = ${organisationId} and type = 'ACCREC' and status = 'VOIDED'`);
  invoices.void = voids.n;
  invoices.total += voids.n;
  const { rows: [j] } = await db.execute(sql`select count(*)::int as total,
      count(*) filter (where invoice_id is not null)::int as invoiced,
      count(*) filter (where invoice_id is null and accounting_ref is not null)::int as tied,
      count(*) filter (where invoice_id is null and accounting_ref is null and no_charge_reason is not null)::int as no_charge,
      count(*) filter (where invoice_id is null and accounting_ref is null and no_charge_reason is null
        and accounting_state in ('not_found', 'ambiguous', 'conflict'))::int as needs_person
    from billing_obligations where organisation_id = ${organisationId}`);
  const jobs = { total: j.total, invoiced: j.invoiced, tied: j.tied, noCharge: j.no_charge, needsPerson: j.needs_person };
  jobs.open = jobs.total - jobs.invoiced - jobs.tied - jobs.noCharge - jobs.needsPerson;
  return { invoices, jobs };
}
