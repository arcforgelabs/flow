import { and, eq, sql } from 'drizzle-orm';
import { createContact } from '../../core/contacts.js';
import { FlowError } from '../../core/errors.js';
import { mirrorWrite, removeImportedInvoice, removeUnsentInvoice } from '../../core/invoices.js';
import { recordAccountingEvidence } from '../../core/ledger.js';
import { invoices, invoiceVersions } from '../../db/schema.js';
import { normaliseName } from './catalogue.js';
import { forgetXeroInvoice } from './delete-invoice.js';
import { IMPORTED_STATUSES as IMPORTED, oddLineReasons } from './import-plan.js';
import { readImportSettings } from './links.js';
import { findInvoices, mirrorState } from './lookup.js';

// The history import (docs/XERO_IMPORT.md, "The full ledger"): Flow keeps a
// full ledger, so each Xero sales invoice a customer saw becomes a Flow
// invoice of origin 'xero'. It keeps the Xero number and Xero's totals, and
// its first version holds the Xero document as Xero gave it. Xero owns it:
// Flow never changes or sends it (server/core/invoices.js, requireOwn), and
// follows Xero when the copy changes (followImports).
//
// It runs in batches, by year or for every year, so each can be checked and
// released (releaseImportBatch removes what the batch imported). It reads
// Flow's copy of Xero only: no Xero call. It changes no job: a job is tied
// to an imported invoice by its accounting reference, as the matcher ties it.
//
//   AUTHORISED, PAID   an issued Flow invoice; its tab follows the copy
//   VOIDED             a void Flow invoice (a customer saw it)
//   DRAFT, SUBMITTED   not imported: no customer saw it. It imports when Xero
//                      approves it.
//   DELETED            never an invoice: left out

export const IMPORT_ACTOR = 'automation:xero-import';
const num = (value) => (value === null || value === undefined ? null : Number(value));
const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null);
const flowStatus = (xeroStatus) => (xeroStatus === 'VOIDED' ? 'void' : 'issued');
const refused = (code, message) => Object.assign(new FlowError(code, message), { status: 409 });

// The Xero invoice as a Flow document. Lines stay as Xero gave them: a
// quantity of 0, a part quantity, a discount or another tax type is kept, not
// refused (import-plan.js, oddLineReasons). Header totals are Xero's.
function documentOf(x, contact, version) {
  const lines = (x.lines ?? []).map((l, index) => ({
    position: index + 1,
    itemCode: l.itemCode ?? null,
    ...(l.accountCode ? { accountCode: l.accountCode } : {}),
    description: l.description ?? l.itemCode ?? 'Line from Xero',
    quantity: l.quantity ?? null,
    unitAmountCents: l.unitAmount === null || l.unitAmount === undefined ? null : Math.round(Number(l.unitAmount) * 100),
    taxCode: num(l.taxAmountCents) ? 'GST' : 'GST_FREE',
    taxType: l.taxType ?? null,
    ...(l.discountRate ? { discountRate: l.discountRate } : {}),
    lineAmountCents: num(l.lineAmountCents) ?? 0,
    taxCents: num(l.taxAmountCents) ?? 0,
  }));
  // Xero's lines include GST when they add up to the total, not the subtotal.
  const sum = lines.reduce((total, l) => total + l.lineAmountCents, 0);
  const inclusive = num(x.tax_cents) > 0 && sum === num(x.total_cents);
  return {
    number: x.invoice_number,
    version,
    issueDate: day(x.issued_on),
    dueDate: day(x.due_on),
    reference: x.reference ?? null,
    currency: x.currency ?? 'AUD',
    contact: { id: contact.id, name: contact.name, email: contact.email ?? null },
    lines,
    subtotalCents: num(x.subtotal_cents) ?? 0,
    taxCents: num(x.tax_cents) ?? 0,
    totalCents: num(x.total_cents) ?? 0,
    ...(inclusive ? { amountsIncludeTax: true } : {}),
    source: { system: 'xero', invoiceId: x.xero_invoice_id, contactId: x.xero_contact_id ?? null },
  };
}

// What a later change in Xero must match to need no new version. A stored
// document comes back with its keys in another order, so keys are sorted.
const sorted = (value) => (Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
    : value);
const contentOf = (document) => JSON.stringify(sorted([document.number, document.issueDate, document.dueDate, document.reference ?? null, document.source?.contactId ?? null,
  document.subtotalCents, document.taxCents, document.totalCents, document.lines ?? []]));

const headerOf = (x, document) => ({
  number: x.invoice_number,
  reference: document.reference,
  currency: document.currency,
  issueDate: document.issueDate,
  dueDate: document.dueDate,
  subtotalCents: document.subtotalCents,
  taxCents: document.taxCents,
  totalCents: document.totalCents,
  amountsIncludeTax: Boolean(document.amountsIncludeTax),
});

// Flow's customer for each Xero contact: the identity link, then a name one
// customer holds, then a new customer (`made`). Answers a function
// (tx, row) -> contact, or null when the copy has no contact for the invoice
// or two customers hold the name. `remember` keeps a customer the caller's
// transaction made, once it commits.
async function contactResolver(db, organisationId) {
  const { rows: links } = await db.execute(sql`select l.external_id, c.id, c.name, c.email from external_links l
    join contacts c on c.organisation_id = l.organisation_id and c.id = l.flow_id and c.kind = 'customer' and c.merged_into_id is null
    where l.organisation_id = ${organisationId} and l.system = 'xero' and l.entity = 'contact' and l.state = 'active'`);
  const known = new Map(links.map((l) => [l.external_id, { id: l.id, name: l.name, email: l.email }]));
  const { rows: customers } = await db.execute(sql`select id, name, email, aliases from contacts
    where organisation_id = ${organisationId} and kind = 'customer' and merged_into_id is null`);
  const byName = new Map();
  for (const c of customers) {
    for (const name of new Set([c.name, ...(c.aliases ?? [])].map(normaliseName))) byName.set(name, byName.has(name) ? null : { id: c.id, name: c.name, email: c.email });
  }
  const resolve = async (tx, x) => {
    if (!x.xero_contact_id || !x.contact_name) return null;
    if (known.has(x.xero_contact_id)) return known.get(x.xero_contact_id);
    const contact = byName.get(normaliseName(x.contact_name));
    // Two customers hold the name: a person says which one, on the Import page.
    if (contact !== undefined) return contact;
    const made = await createContact(tx, organisationId, { kind: 'customer', name: x.contact_name, email: x.contact_email ?? null });
    return { id: made.id, name: made.name, email: made.email, made: true };
  };
  resolve.remember = (x, contact) => byName.set(normaliseName(x.contact_name), { id: contact.id, name: contact.name, email: contact.email });
  return resolve;
}

const CANDIDATES = (organisationId, where) => sql`
  select x.xero_invoice_id, x.invoice_number, x.reference, x.status, x.issued_on, x.due_on, x.currency, x.subtotal_cents, x.tax_cents, x.total_cents,
    x.xero_contact_id, x.lines, x.record_hash, c.name as contact_name, c.email as contact_email
  from xero_invoices x
  left join xero_contacts c on c.organisation_id = x.organisation_id and c.xero_contact_id = x.xero_contact_id
  where x.organisation_id = ${organisationId} and x.type = 'ACCREC' and x.status = any(${sql.param(IMPORTED)}::text[])
    and not exists (select 1 from xero_invoice_pushes p where p.organisation_id = x.organisation_id and p.xero_invoice_id = x.xero_invoice_id)
    and not exists (select 1 from xero_invoice_links l where l.organisation_id = x.organisation_id and l.xero_invoice_id = x.xero_invoice_id and l.released_at is null)
    ${where}
  order by x.issued_on nulls last, x.invoice_number`;

const emptyCounts = () => ({ imported: 0, void: 0, oddLines: 0, contactsMade: 0, blocked: { noNumber: 0, numberTaken: 0, noContact: 0 } });

// One import step at a time for an organisation, in this process and every
// other: each step that writes an imported invoice, and the release of a
// batch, holds this lock to the end of its transaction. So a release sees
// every invoice its batch has, and a step that waited for a release reads
// the batch again.
const importLock = (tx, organisationId) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`xero_import:${organisationId}`}))`);
const SKIP = () => Object.assign(new Error('skipped'), { skip: true });

// One Xero invoice into Flow, in its own transaction: the invoice, its first
// version and its link commit together, or nothing does. A second caller
// finds the link and skips. A batch released since the caller read it takes
// no invoice.
async function importOne(db, organisationId, x, { batchId, actor, resolve, counts }) {
  if (!x.invoice_number) {
    counts.blocked.noNumber += 1;
    return null;
  }
  let contact = null;
  try {
    const invoice = await db.transaction(async (tx) => {
      await importLock(tx, organisationId);
      // The conversion of a made invoice has no batch.
      const { rows: [live] } = batchId ? await tx.execute(sql`select 1 from xero_import_batches where id = ${batchId} and released_at is null`) : { rows: [true] };
      if (!live) throw SKIP();
      contact = await resolve(tx, x);
      if (!contact) return null;
      const document = documentOf(x, contact, 1);
      const [invoice] = await tx.insert(invoices).values({
        organisationId, contactId: contact.id, origin: 'xero', status: flowStatus(x.status), issuedVersion: 1, ...headerOf(x, document),
      }).returning();
      await tx.insert(invoiceVersions).values({ organisationId, invoiceId: invoice.id, version: 1, issuedBy: actor, document });
      // A released link gives its row to the new one, as on the Import page.
      const { rows } = await tx.execute(sql`insert into xero_invoice_links (organisation_id, xero_invoice_id, invoice_id, matched_by, linked_by, batch_id, copy_hash)
        values (${organisationId}, ${x.xero_invoice_id}, ${invoice.id}, 'made', ${actor}, ${batchId}, ${x.record_hash})
        on conflict (organisation_id, xero_invoice_id) do update set invoice_id = excluded.invoice_id, matched_by = excluded.matched_by,
          linked_by = excluded.linked_by, batch_id = excluded.batch_id, copy_hash = excluded.copy_hash, created_at = now(),
          released_by = null, released_at = null, deleted_by = null, deleted_at = null
          where xero_invoice_links.released_at is not null
        returning xero_invoice_id`);
      if (!rows.length) throw SKIP();
      return invoice;
    });
    if (!invoice) {
      counts.blocked.noContact += 1;
      return null;
    }
    if (contact.made) {
      resolve.remember(x, contact);
      counts.contactsMade += 1;
    }
    counts.imported += 1;
    if (x.status === 'VOIDED') counts.void += 1;
    if (oddLineReasons(x.lines).length) counts.oddLines += 1;
    return invoice;
  } catch (error) {
    if (error?.skip) return null;
    const unique = (error?.code ?? error?.cause?.code) === '23505';
    // Flow refused the new customer (a name it cannot take).
    if (!contact && (unique || error instanceof FlowError)) {
      counts.blocked.noContact += 1;
      return null;
    }
    // Another Flow invoice holds this number.
    if (unique) {
      counts.blocked.numberTaken += 1;
      return null;
    }
    throw error;
  }
}

// Flow's next number moves above the highest Xero number of its own form, so
// a Flow invoice never takes a number Xero uses.
async function bumpNextNumber(db, organisationId) {
  const { rows: [org] } = await db.execute(sql`select invoice_prefix as prefix from organisations where id = ${organisationId}`);
  const pattern = `^${org.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9]{1,9}$`;
  await db.execute(sql`update organisations set next_invoice_number = greatest(next_invoice_number, coalesce((
      select max(substring(invoice_number from ${org.prefix.length + 1}::int)::bigint) + 1 from xero_invoices
      where organisation_id = ${organisationId} and type = 'ACCREC' and status <> 'DELETED' and invoice_number ~ ${pattern}), 1)::integer)
    where id = ${organisationId}`);
}

async function readyToImport(db, organisationId, now) {
  const settings = await readImportSettings(db, organisationId);
  if (!settings.makeUnmatched) throw refused('import_off', 'Import Xero history is off for this organisation. Turn it on in the Import settings.');
  const copy = await mirrorState(db, organisationId, { now });
  if (!copy.complete || !copy.fresh) throw refused('copy_not_ready', 'Flow\'s copy of Xero is not complete and fresh. Read Xero again, then import.');
}

const batchOf = (row) => ({
  id: row.id, year: row.year, startedBy: row.started_by, startedAt: row.started_at, finishedAt: row.finished_at, counts: row.counts,
  releasedBy: row.released_by, releasedAt: row.released_at,
});

// Imports every Xero sales invoice a customer saw that Flow does not have,
// for one year (`year`) or every year (null). Answers the batch.
export async function runImportBatch(db, organisationId, { year = null, actor, now = new Date() }) {
  if (!actor) throw new FlowError('invalid', 'actor is required');
  if (year !== null && !(Number.isInteger(year) && year >= 1990 && year <= 2100)) throw new FlowError('invalid', 'year must be a year, or left out for every year');
  await readyToImport(db, organisationId, now);
  // The database keeps one live batch for a year (xero_import_batches_one_live),
  // so of two requests at the same time one gets the batch.
  const { rows: [batch] } = await db.execute(sql`insert into xero_import_batches (organisation_id, year, started_by) values (${organisationId}, ${year}, ${actor})
    on conflict (organisation_id, coalesce(year, 0)) where released_at is null do nothing returning *`);
  if (!batch) throw refused('batch_exists', `${year ?? 'Every year'} is imported already. Release that batch first to import it again.`);
  await bumpNextNumber(db, organisationId);
  const counts = await importInto(db, organisationId, batch, { actor });
  const { rows: [done] } = await db.execute(sql`update xero_import_batches set finished_at = now(), counts = ${JSON.stringify(counts)}::jsonb where id = ${batch.id} returning *`);
  return batchOf(done);
}

async function importInto(db, organisationId, batch, { actor }) {
  const counts = emptyCounts();
  const inYear = batch.year === null ? sql`` : sql`and extract(year from x.issued_on) = ${batch.year}`;
  const { rows } = await db.execute(CANDIDATES(organisationId, inYear));
  if (!rows.length) return counts;
  const resolve = await contactResolver(db, organisationId);
  for (const x of rows) await importOne(db, organisationId, x, { batchId: batch.id, actor, resolve, counts });
  return counts;
}

// After each read of Xero. Each imported invoice whose copy changed follows
// it: a void in Xero voids it, and a change of number, date, contact, lines
// or totals adds a new version (the earlier ones stay). With the import on,
// each year a live batch covers also takes the invoices Xero made since.
// Answers counts. Flow's database only.
export async function followImports(db, organisationId, { actor = IMPORT_ACTOR } = {}) {
  const result = { changed: 0, voided: 0, removed: 0, imported: 0, failed: 0 };
  const { rows: moved } = await db.execute(sql`
    select l.xero_invoice_id, l.invoice_id, i.status as flow_status, i.issued_version, i.contact_id,
      x.invoice_number, x.reference, x.status, x.issued_on, x.due_on, x.currency, x.subtotal_cents, x.tax_cents, x.total_cents,
      x.xero_contact_id, x.lines, x.record_hash, c.name as contact_name, c.email as contact_email
    from xero_invoice_links l
    join invoices i on i.organisation_id = l.organisation_id and i.id = l.invoice_id and i.origin <> 'flow'
    join xero_invoices x on x.organisation_id = l.organisation_id and x.xero_invoice_id = l.xero_invoice_id
    left join xero_contacts c on c.organisation_id = x.organisation_id and c.xero_contact_id = x.xero_contact_id
    where l.organisation_id = ${organisationId} and l.released_at is null and l.copy_hash is distinct from x.record_hash`);
  const resolve = moved.length ? await contactResolver(db, organisationId) : null;
  for (const x of moved) {
    // One invoice Flow cannot follow (its new number is taken in Flow) does
    // not stop the rest. Its hash stays, so the next read tries it again.
    const before = { ...result };
    await db.transaction(async (tx) => {
      await importLock(tx, organisationId);
      // A release removed it since the list was read.
      const { rows: [held] } = await tx.execute(sql`select 1 from xero_invoice_links
        where organisation_id = ${organisationId} and xero_invoice_id = ${x.xero_invoice_id} and invoice_id = ${x.invoice_id} and released_at is null`);
      if (!held) return;
      const seen = () => tx.execute(sql`update xero_invoice_links set copy_hash = ${x.record_hash}
        where organisation_id = ${organisationId} and xero_invoice_id = ${x.xero_invoice_id}`);
      // Xero removed it (only a draft can be removed): Flow's copy goes too.
      if (x.status === 'DELETED') {
        await forgetXeroInvoice(tx, organisationId, x.invoice_id, { actor, reason: 'deleted_in_xero' });
        await removeImportedInvoice(tx, organisationId, x.invoice_id);
        result.removed += 1;
        return;
      }
      // A void invoice is final, in Xero and in Flow.
      if (x.flow_status === 'void' || !IMPORTED.includes(x.status)) return seen();
      const [latest] = await tx.select().from(invoiceVersions)
        .where(and(eq(invoiceVersions.invoiceId, x.invoice_id), eq(invoiceVersions.version, x.issued_version)));
      const contact = latest?.document?.source?.contactId === x.xero_contact_id ? latest.document.contact : await resolve(tx, x);
      // Flow cannot say whose invoice it is now (two customers hold the new
      // contact's name). Nothing of it changes and its hash stays, so the
      // read after a person links the contact follows it. A void in Xero
      // still voids it: a void is final, so it is seen.
      if (!contact && x.status !== 'VOIDED') {
        result.failed += 1;
        return;
      }
      const document = contact ? documentOf(x, contact, x.issued_version + 1) : null;
      const differs = document && contentOf(document) !== contentOf(latest?.document ?? {});
      await mirrorWrite(tx, x.invoice_id, async () => {
        if (differs) {
          await tx.insert(invoiceVersions).values({ organisationId, invoiceId: x.invoice_id, version: document.version, issuedBy: actor, document });
          await tx.update(invoices).set({ ...headerOf(x, document), contactId: contact.id, issuedVersion: document.version, updatedAt: sql`now()` })
            .where(eq(invoices.id, x.invoice_id));
          result.changed += 1;
        }
        if (x.status === 'VOIDED') {
          await tx.update(invoices).set({ status: 'void', updatedAt: sql`now()` }).where(eq(invoices.id, x.invoice_id));
          result.voided += 1;
        }
      });
      await seen();
    }).catch((error) => {
      if ((error?.code ?? error?.cause?.code) !== '23505') throw error;
      Object.assign(result, before, { failed: result.failed + 1 });
    });
  }
  const { makeUnmatched } = await readImportSettings(db, organisationId);
  if (!makeUnmatched) return result;
  const { rows: batches } = await db.execute(sql`select * from xero_import_batches
    where organisation_id = ${organisationId} and released_at is null and finished_at is not null order by year nulls first, started_at`);
  for (const batch of batches) {
    const counts = await importInto(db, organisationId, batch, { actor });
    result.imported += counts.imported;
    // Every year is covered: the year batches have nothing left.
    if (batch.year === null) break;
  }
  if (result.imported) await bumpNextNumber(db, organisationId);
  return result;
}

// Flow invoices made earlier from a Xero invoice (the Import page's Make,
// links.js) are Flow's own invoices with a Flow number. In a full ledger each
// is the Xero invoice itself, so each becomes an imported invoice with the
// Xero number: the made copy is removed (it was only Flow's copy, so nothing
// is voided), the pair stays as a record (xero_invoice_link_history, reason
// `converted_to_import`), and the Xero invoice is imported in its place. The
// job the copy billed stays tied to the Xero invoice by its accounting
// reference, so Flow does not draft it again.
//
// All in one transaction: every copy leaves before any import, because one
// copy's Flow number can be another copy's Xero number. A copy stays as it is
// (`skipped`) when Flow sent it, an owner's override holds it, it is not
// issued, it is void in Flow while Xero's is not, Xero's is not one the import
// takes, its job follows another Xero invoice, or a Flow invoice that stays
// holds its Xero number. Flow's database only; no Xero call. `dryRun` does the
// same work and keeps none of it.
const CONVERT_REASON = 'converted_to_import';
const DRY_RUN = Symbol('dry run');

function convertSkip(r) {
  if (r.sent) return 'sent';
  if (r.override) return 'override';
  if (!['issued', 'void'].includes(r.flow_status)) return 'notIssued';
  if (!IMPORTED.includes(r.status)) return 'notImported';
  if (r.flow_status === 'void' && r.status !== 'VOIDED') return 'voidInFlow';
  if (!r.invoice_number) return 'noNumber';
  if (r.job_ref && r.job_ref !== r.xero_invoice_id) return 'jobElsewhere';
  return null;
}

export async function convertMadeInvoices(db, organisationId, { actor, dryRun = false, now = new Date() }) {
  if (!actor) throw new FlowError('invalid', 'actor is required');
  await readyToImport(db, organisationId, now);
  const result = {
    dryRun: Boolean(dryRun), candidates: 0, converted: 0, void: 0, jobsKept: 0, contactsMade: 0,
    skipped: { sent: 0, override: 0, notIssued: 0, notImported: 0, voidInFlow: 0, noNumber: 0, jobElsewhere: 0, numberTaken: 0 },
    invoices: [],
  };
  const note = (r, extra) => result.invoices.push({ xeroInvoiceId: r.xero_invoice_id, number: r.invoice_number, flowNumber: r.flow_number, jobId: r.job_id ?? null, ...extra });
  try {
    await db.transaction(async (tx) => {
      await importLock(tx, organisationId);
      const { rows } = await tx.execute(sql`
        select l.xero_invoice_id, l.invoice_id, i.number as flow_number, i.status as flow_status, i.total_cents as flow_total_cents,
          k.id as flow_contact_id, k.name as flow_contact_name, k.email as flow_contact_email,
          x.invoice_number, x.reference, x.status, x.issued_on, x.due_on, x.currency, x.subtotal_cents, x.tax_cents, x.total_cents,
          x.xero_contact_id, x.lines, x.record_hash, c.name as contact_name, c.email as contact_email,
          exists (select 1 from xero_invoice_pushes p where p.organisation_id = l.organisation_id
            and (p.invoice_id = l.invoice_id or p.xero_invoice_id = l.xero_invoice_id)) as sent,
          exists (select 1 from send_overrides s where s.invoice_id = l.invoice_id) as override,
          j.id as job_id, j.accounting_ref as job_ref
        from xero_invoice_links l
        join invoices i on i.organisation_id = l.organisation_id and i.id = l.invoice_id and i.origin = 'flow'
        join contacts k on k.organisation_id = i.organisation_id and k.id = i.contact_id
        join xero_invoices x on x.organisation_id = l.organisation_id and x.xero_invoice_id = l.xero_invoice_id
        left join xero_contacts c on c.organisation_id = x.organisation_id and c.xero_contact_id = x.xero_contact_id
        left join billing_obligations j on j.organisation_id = l.organisation_id and j.invoice_id = l.invoice_id
        where l.organisation_id = ${organisationId} and l.matched_by = 'made' and l.released_at is null
        order by x.issued_on nulls last, x.invoice_number, l.xero_invoice_id
        for update of l, i`);
      result.candidates = rows.length;
      let set = [];
      for (const r of rows) {
        const reason = convertSkip(r);
        if (!reason) set.push(r);
        else {
          result.skipped[reason] += 1;
          note(r, { skipped: reason });
        }
      }
      // A copy that stays keeps its Flow number, which can be the Xero number
      // of another copy: that one stays too. So until nothing more drops.
      for (;;) {
        if (!set.length) break;
        const { rows: held } = await tx.execute(sql`select number from invoices where organisation_id = ${organisationId}
          and number = any(${sql.param(set.map((r) => r.invoice_number))}::text[]) and id <> all(${sql.param(set.map((r) => r.invoice_id))}::uuid[])`);
        const taken = new Set(held.map((h) => h.number));
        const next = set.filter((r) => {
          if (!taken.has(r.invoice_number)) return taken.add(r.invoice_number);
          result.skipped.numberTaken += 1;
          note(r, { skipped: 'numberTaken' });
          return false;
        });
        if (next.length === set.length) break;
        set = next;
      }
      if (!set.length) return;
      for (const r of set) {
        await forgetXeroInvoice(tx, organisationId, r.invoice_id, { actor, reason: CONVERT_REASON });
        await removeUnsentInvoice(tx, organisationId, { id: r.invoice_id, number: r.flow_number, totalCents: num(r.flow_total_cents), origin: 'flow' }, actor,
          { reason: CONVERT_REASON, xeroInvoiceId: r.xero_invoice_id });
      }
      // The customer is Flow's contact for the Xero contact, as for every
      // imported invoice; where that has no one answer, the customer the made
      // copy had (a person or Flow chose it for this Xero invoice).
      const resolve = await contactResolver(tx, organisationId);
      const had = new Map(set.map((r) => [r.xero_invoice_id, { id: r.flow_contact_id, name: r.flow_contact_name, email: r.flow_contact_email }]));
      const pick = async (inner, x) => (await resolve(inner, x)) ?? had.get(x.xero_invoice_id);
      pick.remember = resolve.remember;
      const counts = emptyCounts();
      for (const r of set) {
        const invoice = await importOne(tx, organisationId, r, { batchId: null, actor, resolve: pick, counts });
        // Nothing here is expected to block: the copies left first.
        if (!invoice) throw refused('convert_blocked', `Flow cannot import Xero invoice ${r.invoice_number} in place of ${r.flow_number}. Nothing was changed.`);
        note(r, { invoiceId: invoice.id });
      }
      // Each job keeps the Xero invoice as its accounting evidence, from the
      // copy, in the same step: it shows billed or paid, and is never drafted
      // again.
      const jobs = set.filter((r) => r.job_id);
      if (jobs.length) {
        const { invoices: copies } = await findInvoices(tx, organisationId, { invoiceIds: jobs.map((r) => r.xero_invoice_id) });
        const stateOf = new Map(copies.map((copy) => [copy.id, copy.state]));
        for (const r of jobs) {
          const state = stateOf.get(r.xero_invoice_id);
          if (state) await recordAccountingEvidence(tx, organisationId, r.job_id, { state, accountingRef: r.xero_invoice_id, matchedBy: 'accounting_ref', actor });
        }
      }
      await bumpNextNumber(tx, organisationId);
      Object.assign(result, { converted: counts.imported, void: counts.void, jobsKept: jobs.length, contactsMade: counts.contactsMade });
      if (dryRun) throw DRY_RUN;
    });
  } catch (error) {
    if (error !== DRY_RUN) throw error;
    // The invoices a dry run made are gone with it.
    for (const row of result.invoices) delete row.invoiceId;
  }
  return result;
}

export async function listImportBatches(db, organisationId) {
  const { rows } = await db.execute(sql`select b.*, (select count(*)::int from xero_invoice_links l
      where l.organisation_id = b.organisation_id and l.batch_id = b.id and l.released_at is null) as invoices
    from xero_import_batches b where b.organisation_id = ${organisationId} order by b.started_at desc`);
  return rows.map((row) => ({ ...batchOf(row), invoices: row.invoices }));
}

// Undo of one batch: each invoice it imported is removed, with its versions
// and its link. The pair stays as a record (xero_invoice_link_history).
// Nothing is voided and Xero is not called: these were only Flow's copies. No
// job changes. A customer the batch made stays.
export async function releaseImportBatch(db, organisationId, batchId, { actor }) {
  if (!actor) throw new FlowError('invalid', 'actor is required');
  return db.transaction(async (tx) => {
    // No import step runs while the batch is released (importLock), and all
    // of it commits together: the batch is released with nothing left in it.
    await importLock(tx, organisationId);
    const { rows: [batch] } = await tx.execute(sql`select * from xero_import_batches where organisation_id = ${organisationId} and id = ${batchId}`);
    if (!batch) throw Object.assign(new FlowError('not_found', 'import batch not found'), { status: 404 });
    if (batch.released_at) throw refused('batch_released', 'This batch was released already.');
    const { rows: links } = await tx.execute(sql`select l.invoice_id from xero_invoice_links l
      join invoices i on i.organisation_id = l.organisation_id and i.id = l.invoice_id and i.origin <> 'flow'
      where l.organisation_id = ${organisationId} and l.batch_id = ${batchId}`);
    for (const link of links) {
      await forgetXeroInvoice(tx, organisationId, link.invoice_id, { actor, reason: 'import_batch_released' });
      await removeImportedInvoice(tx, organisationId, link.invoice_id);
    }
    const { rows: [done] } = await tx.execute(sql`update xero_import_batches set released_by = ${actor}, released_at = now() where id = ${batchId} returning *`);
    return { ...batchOf(done), removed: links.length };
  });
}
