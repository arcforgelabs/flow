import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  billingObligations, contacts, externalLinks, linkRejections, linkSuggestions, obligationEvents, organisations, pipelineCursors,
} from '../db/schema.js';
import { FlowError } from './errors.js';
import { listAutomations, runAutomations } from './automations.js';
import { readInvoicingSettings } from './invoicing-rules.js';
import { observeJob, observeWithdrawn, recordAccountingEvidence, setHold } from './ledger.js';
import { loadMappingContext, mapLines } from './line-mapping.js';
import { checkPrices, readCatalogues } from './price-list.js';
import { linkRecord, priorLinkFor } from './links.js';
import { HISTORY_ACTOR, HISTORY_HOLD_REASON, isHistoryHeld } from './history.js';
import { deadHoldSince, deadSince, enqueueJob, runNextJob } from './queue.js';

// The pipeline (docs/DATA_SPINE.md, issue 58). It joins what the integrations
// copy into Flow, and never writes to another system:
//
// 1. Customers: a work system's client and an accounting contact link to the
//    Flow customer with the same name (`exact_name`), when exactly one record
//    on each side has it. Anything looser waits for a person.
// 2. Work: each billable job the work system reports becomes, or updates, its
//    billing obligation (ledger.js), with the Flow customer its client links to.
// 3. Matching: each job is compared with the accounting system's copy of its
//    sales invoices. Exact evidence links the job. A likely invoice is a
//    suggestion for a person. When the copy is complete and fresh and holds no
//    invoice that could bill the job, the job has none.
// 4. Automations (automations.js): the routines that are on, for example
//    marking a job ready to invoice from its work system status, and drafting
//    the invoice of a ready job. Drafts wait in Flow for a person.
//
// The matcher reads only Flow's copies, so matching years of history costs no
// API calls (docs/JOB_INVOICE_LINKS.md).

export const ACTOR = 'system:matcher';
export const PIPELINE_KIND = 'pipeline.run';
const RUN_EVERY_MS = 2 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;
const WORK_PAGES = 20;
const MATCH_BATCH = 500;
// A job older than this with no invoice found is held for a person: it may be
// work billed some other way, long ago.
export const STALE_DAYS = 90;
// How far an invoice date may be from the job date and still be a candidate.
const BEFORE_DAYS = 7;
const AFTER_DAYS = 45;
// A suggestion needs this score and this lead over the next candidate.
export const SUGGEST_SCORE = 8;
export const SUGGEST_LEAD = 3;

// A name with case, spacing, punctuation and a company suffix evened out, so
// "Example Dental Pty. Ltd." and "example dental" compare equal.
export function normaliseName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+(pty\s+)?(ltd|limited)$/u, '')
    .replace(/\s+/g, ' ');
}

// The one organisation of this installation, or null when there are none or
// several. The adapters' tables are installation-wide today (DATA_SPINE.md,
// phase 2), so the pipeline runs only for a single organisation.
export async function soleOrganisation(db) {
  const rows = await db.select({ id: organisations.id }).from(organisations).limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

async function activeLinks(db, organisationId, { system, entity }) {
  return db.select({ flowId: externalLinks.flowId, externalId: externalLinks.externalId }).from(externalLinks).where(and(
    eq(externalLinks.organisationId, organisationId),
    eq(externalLinks.system, system),
    eq(externalLinks.entity, entity),
    eq(externalLinks.state, 'active'),
  ));
}

function byName(records) {
  const map = new Map();
  for (const record of records) {
    const key = normaliseName(record.name);
    if (!key) continue;
    map.set(key, [...(map.get(key) ?? []), record]);
  }
  return map;
}

// Links each customer of one system to the Flow customer with the same name,
// when one record on each side has it and neither side is linked yet.
export async function linkCustomers(db, organisationId, { system, customers }) {
  const flow = await db.select({ id: contacts.id, name: contacts.name }).from(contacts)
    .where(and(eq(contacts.organisationId, organisationId), eq(contacts.kind, 'customer')));
  const links = await activeLinks(db, organisationId, { system, entity: 'contact' });
  const linkedFlow = new Set(links.map((l) => l.flowId));
  const linkedExternal = new Set(links.map((l) => l.externalId));
  const flowByName = byName(flow);
  const result = { linked: 0, alreadyLinked: 0, unmatched: 0, sameName: 0 };
  for (const [key, external] of byName(customers)) {
    const own = flowByName.get(key) ?? [];
    for (const customer of external) {
      if (linkedExternal.has(String(customer.id))) result.alreadyLinked += 1;
    }
    if (external.length !== 1 || own.length !== 1) {
      const waiting = external.filter((c) => !linkedExternal.has(String(c.id))).length;
      if (own.length === 0) result.unmatched += waiting;
      else result.sameName += waiting;
      continue;
    }
    const [customer] = external;
    const [contact] = own;
    if (linkedExternal.has(String(customer.id)) || linkedFlow.has(contact.id)) continue;
    const { outcome } = await linkRecord(db, organisationId, {
      entity: 'contact', flowId: contact.id, system, externalId: String(customer.id), matchedBy: 'exact_name',
    });
    if (outcome === 'linked') result.linked += 1;
  }
  return result;
}

async function readCursor(db, organisationId, name) {
  const [row] = await db.select().from(pipelineCursors)
    .where(and(eq(pipelineCursors.organisationId, organisationId), eq(pipelineCursors.name, name)));
  return row?.cursor ?? null;
}

async function writeCursor(db, organisationId, name, cursor) {
  await db.insert(pipelineCursors).values({ organisationId, name, cursor })
    .onConflictDoUpdate({ target: [pipelineCursors.organisationId, pipelineCursors.name], set: { cursor, updatedAt: sql`now()` } });
}

// Reads the work system's billable jobs since the last run into the ledger.
// `restart` reads every job again, for example after new customer links.
export async function ingestWork(db, organisationId, { adapter, restart = false, pages = WORK_PAGES }) {
  const name = `${adapter.id}.work`;
  let cursor = restart ? null : await readCursor(db, organisationId, name);
  const links = await activeLinks(db, organisationId, { system: adapter.id, entity: 'contact' });
  const contactOf = new Map(links.map((l) => [l.externalId, l.flowId]));
  const result = { observed: 0, withoutCustomer: 0, skipped: 0, sentToReview: 0, readyCleared: 0, unmappedLines: 0, more: false };
  // Line mapping (line-mapping.js): each line finds its price item first.
  const mapping = (await listAutomations(db, organisationId)).find((a) => a.key === 'map_lines');
  const context = mapping?.enabled ? await loadMappingContext(db, organisationId, mapping.config, { system: adapter.id }) : null;
  for (let page = 0; page < pages; page += 1) {
    const { items, withdrawn, cursor: next, more } = await adapter.capabilities.pullWorkItems(cursor, { limit: 200 });
    for (const item of items) {
      const contactId = contactOf.get(String(item.clientId ?? '')) ?? null;
      const job = context ? { ...item.ledgerJob, lines: mapLines(item.ledgerJob.lines ?? [], context) } : item.ledgerJob;
      if (context) result.unmappedLines += job.lines.filter((l) => !l.itemCode && !l.accountCode).length;
      try {
        await observeJob(db, organisationId, { ...job, contactId });
        result.observed += 1;
        if (!contactId) result.withoutCustomer += 1;
      } catch (error) {
        // A job with no lines cannot be billed; it comes back when it changes.
        if (!(error instanceof FlowError) || error.code !== 'invalid') throw error;
        result.skipped += 1;
      }
    }
    // A job no longer billable: deleted, or its status moved back (ledger.js).
    for (const entry of withdrawn) {
      if (!entry.ledgerWithdrawn) continue;
      const { action } = await observeWithdrawn(db, organisationId, { ...entry.ledgerWithdrawn, actor: `system:${adapter.id}` });
      if (action === 'review') result.sentToReview += 1;
      if (action === 'ready_cleared') result.readyCleared += 1;
    }
    cursor = next;
    await writeCursor(db, organisationId, name, cursor);
    if (!more) return result;
  }
  result.more = true;
  return result;
}

// Reads the work system's past jobs (a history import, docs/SEAZONA.md) into
// the ledger. A job new to the ledger is held with reason `history_import`:
// it is history, most likely invoiced long ago, so it never drafts until a
// person releases it, and the matcher still links it to its invoice. A job
// the ledger already has from the live feed is left as it is: its hold, ready
// mark and invoice never change here. A held history job that only history
// has reported takes a later import's changes.
export async function ingestHistory(db, organisationId, { adapter, pages = WORK_PAGES }) {
  const name = `${adapter.id}.history`;
  let cursor = await readCursor(db, organisationId, name);
  const links = await activeLinks(db, organisationId, { system: adapter.id, entity: 'contact' });
  const contactOf = new Map(links.map((l) => [l.externalId, l.flowId]));
  const result = { held: 0, updated: 0, alreadyLive: 0, skipped: 0, more: false };
  const mapping = (await listAutomations(db, organisationId)).find((a) => a.key === 'map_lines');
  const context = mapping?.enabled ? await loadMappingContext(db, organisationId, mapping.config) : null;
  for (let page = 0; page < pages; page += 1) {
    const { items, cursor: next, more } = await adapter.capabilities.pullHistoryJobs(cursor, { limit: 200 });
    for (const item of items) {
      const contactId = contactOf.get(String(item.clientId ?? '')) ?? null;
      const base = { ...item.ledgerJob, actor: HISTORY_ACTOR };
      const job = context ? { ...base, lines: mapLines(base.lines ?? [], context) } : base;
      const [existing] = await db.select().from(billingObligations).where(and(
        eq(billingObligations.organisationId, organisationId),
        eq(billingObligations.sourceSystem, job.sourceSystem),
        eq(billingObligations.sourceJobRef, job.sourceJobRef),
      ));
      if (existing) {
        const [live] = existing && isHistoryHeld(existing)
          ? await db.select({ id: obligationEvents.id }).from(obligationEvents).where(and(
            eq(obligationEvents.organisationId, organisationId),
            eq(obligationEvents.obligationId, existing.id),
            inArray(obligationEvents.kind, ['observed', 'source_changed']),
            sql`${obligationEvents.actor} <> ${HISTORY_ACTOR}`,
          )).limit(1)
          : [{ id: 'live' }];
        if (live) {
          result.alreadyLive += 1;
          continue;
        }
        await observeJob(db, organisationId, { ...job, contactId: contactId ?? existing.contactId });
        result.updated += 1;
        continue;
      }
      try {
        const row = await observeJob(db, organisationId, { ...job, contactId });
        await setHold(db, organisationId, row.id, { holdState: 'held', reason: HISTORY_HOLD_REASON, actor: HISTORY_ACTOR });
        result.held += 1;
      } catch (error) {
        if (!(error instanceof FlowError) || error.code !== 'invalid') throw error;
        result.skipped += 1;
      }
    }
    cursor = next;
    await writeCursor(db, organisationId, name, cursor);
    if (!more) return result;
  }
  result.more = true;
  return result;
}

const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
const addDays = (iso, days) => new Date(day(iso) + days * 86_400_000).toISOString().slice(0, 10);
const daysApart = (a, b) => Math.abs(day(a) - day(b)) / 86_400_000;
const withGst = (cents) => Math.round(cents * 1.1);

// The totals an invoice for the job could carry: with GST, without it, and
// the subtotal plus 10% when the work system reported no tax.
function totalsFor(obligation) {
  return new Set([obligation.totalCents, obligation.subtotalCents, withGst(obligation.subtotalCents)]);
}

// Scores one accounting invoice against one job. Answers the score and each
// signal that agreed, so a person can see why.
// `rivals` are the customer's other unlinked jobs: an invoice dated closer to
// one of them, at an amount that fits it, more likely bills that job.
export function scoreCandidate(obligation, invoice, { prior = null, rivals = [] } = {}) {
  const signals = [];
  if (invoice.totalCents === obligation.totalCents) signals.push({ signal: 'total', weight: 6 });
  else if (totalsFor(obligation).has(invoice.totalCents)) signals.push({ signal: 'total_gst', weight: 5 });
  const codes = new Set((obligation.lines ?? []).map((l) => l.itemCode).filter(Boolean));
  const theirs = new Set(invoice.itemCodes ?? []);
  if (codes.size && theirs.size) {
    const shared = [...codes].filter((c) => theirs.has(c)).length;
    if (shared === codes.size && shared === theirs.size) signals.push({ signal: 'items_same', weight: 3 });
    else if (shared) signals.push({ signal: 'items_overlap', weight: 1 });
  }
  if (obligation.jobDate && invoice.issuedOn) {
    const apart = daysApart(obligation.jobDate, invoice.issuedOn);
    if (apart <= 3) signals.push({ signal: 'date_close', weight: 2 });
    else if (apart <= 14) signals.push({ signal: 'date_near', weight: 1 });
  }
  if (prior && prior.externalId === invoice.id) signals.push({ signal: 'prior_link', weight: 4 });
  if (obligation.jobDate && invoice.issuedOn) {
    const ours = daysApart(obligation.jobDate, invoice.issuedOn);
    const closer = rivals.some((r) => r.id !== obligation.id && r.jobDate
      && totalsFor(r).has(invoice.totalCents) && daysApart(r.jobDate, invoice.issuedOn) < ours);
    if (closer) signals.push({ signal: 'closer_job', weight: -4 });
  }
  if (['voided', 'deleted'].includes(invoice.state)) signals.push({ signal: 'not_live', weight: -3 });
  return { score: signals.reduce((sum, s) => sum + s.weight, 0), signals };
}

// A candidate counts only when its total or an earlier link ties it to the
// job; an invoice for the same customer at another amount is other work.
const relevant = (scored) => scored.signals.some((s) => ['total', 'total_gst', 'prior_link'].includes(s.signal));

// Ranks the candidates and decides: `suggested` (one clear leader), `unsure`
// (several, or a weak one) or `none`.
export function rankCandidates(obligation, invoices, { prior = null, rivals = [] } = {}) {
  const ranked = invoices
    .map((invoice) => ({ invoice, ...scoreCandidate(obligation, invoice, { prior, rivals }) }))
    .filter(relevant)
    .sort((a, b) => b.score - a.score || String(a.invoice.issuedOn).localeCompare(String(b.invoice.issuedOn)));
  if (!ranked.length) return { decision: 'none', ranked };
  const [top, next] = ranked;
  const clear = top.score >= SUGGEST_SCORE && (!next || top.score - next.score >= SUGGEST_LEAD);
  return { decision: clear ? 'suggested' : 'unsure', ranked };
}

const amountsAgree = (obligation, invoice) => totalsFor(obligation).has(invoice.totalCents);
const withoutReissue = (ref) => String(ref).replace(/R$/i, '');

async function saveSuggestions(db, organisationId, obligationId, system, ranked) {
  const keep = ranked.slice(0, 5);
  await db.transaction(async (tx) => {
    await tx.update(linkSuggestions)
      .set({ state: 'stale', updatedAt: sql`now()` })
      .where(and(
        eq(linkSuggestions.organisationId, organisationId),
        eq(linkSuggestions.obligationId, obligationId),
        eq(linkSuggestions.state, 'open'),
      ));
    for (const [index, { invoice, score, signals }] of keep.entries()) {
      await tx.insert(linkSuggestions)
        .values({ organisationId, obligationId, system, externalId: invoice.id, externalNumber: invoice.number, score, rank: index + 1, signals })
        .onConflictDoUpdate({
          target: [linkSuggestions.organisationId, linkSuggestions.obligationId, linkSuggestions.system, linkSuggestions.externalId],
          // A person's decision stays.
          set: {
            score, rank: index + 1, signals, externalNumber: invoice.number,
            state: sql`case when ${linkSuggestions.state} in ('accepted', 'rejected') then ${linkSuggestions.state} else 'open' end`,
            updatedAt: sql`now()`,
          },
        });
    }
  });
}

// Decides one job's accounting evidence from the mirror. Answers what it found
// in the ledger's evidence shape (or null to change nothing), and the
// candidates to keep as suggestions.
export async function matchJob(db, organisationId, obligation, {
  accounting, xeroContactId, mirror, rejected = new Set(), taken = new Map(), rivals = [],
}) {
  const find = async (query) => (await accounting.capabilities.findInvoices({ organisationId, ...query })).invoices;
  const exact = (invoice, matchedBy) => ({ evidence: { state: invoice.state, accountingRef: invoice.id, matchedBy }, ranked: [] });

  // Linked already: follow the invoice through its life (lifecycle).
  if (obligation.accountingRef) {
    const [invoice] = await find({ invoiceIds: [obligation.accountingRef] });
    return invoice ? exact(invoice, 'accounting_ref') : { evidence: null, ranked: [] };
  }
  if (obligation.invoiceId) {
    const sent = await find({ flowInvoiceIds: [obligation.invoiceId] });
    if (sent.length === 1) return exact(sent[0], 'flow_invoice');
  }
  const prior = await priorLinkFor(db, organisationId, {
    sourceSystem: obligation.sourceSystem, sourceJobRef: obligation.sourceJobRef, system: accounting.id,
  });
  if (prior) {
    const [invoice] = await find({ invoiceIds: [prior.externalId] });
    if (invoice && !rejected.has(invoice.id) && (prior.matchedBy === 'person' || amountsAgree(obligation, invoice))) {
      return exact(invoice, 'prior_link');
    }
  }
  if (obligation.sourceInvoiceRef) {
    const numbers = [obligation.sourceInvoiceRef, withoutReissue(obligation.sourceInvoiceRef)];
    const same = (await find({ numbers }))
      .filter((i) => !rejected.has(i.id) && (!xeroContactId || i.contactId === xeroContactId));
    if (same.length === 1) return exact(same[0], 'source_invoice_ref');
  }
  // Without the customer's accounting contact there is nothing to compare.
  if (!xeroContactId) return { evidence: null, ranked: [], reason: 'no_contact' };
  const window = obligation.jobDate
    ? { from: addDays(obligation.jobDate, -BEFORE_DAYS), to: addDays(obligation.jobDate, AFTER_DAYS) }
    : {};
  const candidates = (await find({ contactId: xeroContactId, ...window }))
    // An invoice whose whole total other jobs already account for is theirs.
    .filter((i) => !rejected.has(i.id) && (taken.get(i.id) ?? 0) < (i.totalCents ?? 0));
  const { decision, ranked } = rankCandidates(obligation, candidates, { prior, rivals });
  if (decision === 'none') {
    // Only a complete, fresh copy proves that Xero holds no invoice.
    if (!obligation.jobDate || !mirror.complete || !mirror.fresh) return { evidence: null, ranked: [] };
    return { evidence: { state: 'not_found', accountingRef: null, matchedBy: null }, ranked: [] };
  }
  const [top] = ranked;
  return { evidence: { state: top.invoice.state, accountingRef: top.invoice.id, matchedBy: decision === 'suggested' ? 'scored' : 'candidates' }, ranked, decision };
}

async function holdIfStale(db, organisationId, obligation, { now, staleDays }) {
  if (!staleDays || !obligation.jobDate || obligation.holdState !== 'none') return false;
  if (now - day(obligation.jobDate) <= staleDays * 86_400_000) return false;
  // Once only: a person who releases the job has decided.
  const [held] = await db.select({ id: obligationEvents.id }).from(obligationEvents).where(and(
    eq(obligationEvents.organisationId, organisationId),
    eq(obligationEvents.obligationId, obligation.id),
    eq(obligationEvents.actor, ACTOR),
    eq(obligationEvents.kind, 'held'),
  )).limit(1);
  if (held) return false;
  await setHold(db, organisationId, obligation.id, {
    holdState: 'held',
    reason: `the job is more than ${staleDays} days old and no accounting invoice was found for it`,
    actor: ACTOR,
  });
  return true;
}

// Matches every job that changed, or whose candidates may have changed, since
// it was last checked. Answers counts by outcome.
export async function matchJobs(db, organisationId, { accounting, now = new Date(), staleDays = STALE_DAYS, limit = MATCH_BATCH }) {
  const mirror = await accounting.capabilities.findInvoices({ organisationId });
  const result = { checked: 0, linked: 0, followed: 0, suggested: 0, unsure: 0, notFound: 0, noContact: 0, held: 0, waiting: 0 };
  if (!mirror.complete) return { ...result, skipped: 'the accounting copy is still importing' };
  const contactLinks = await activeLinks(db, organisationId, { system: accounting.id, entity: 'contact' });
  const xeroContactOf = new Map(contactLinks.map((l) => [l.flowId, l.externalId]));
  const since = mirror.changedAt ?? new Date(0);
  const due = await db.select().from(billingObligations).where(and(
    eq(billingObligations.organisationId, organisationId),
    sql`${billingObligations.accountingState} <> 'conflict'`,
    sql`(${billingObligations.accountingCheckedAt} is null
      or ${billingObligations.accountingCheckedAt} < ${billingObligations.sourceSeenAt}
      or ${billingObligations.accountingCheckedAt} < ${since.toISOString()}::timestamptz)`,
  )).orderBy(sql`${billingObligations.accountingCheckedAt} asc nulls first`).limit(limit);
  if (!due.length) return result;
  const ids = due.map((o) => o.id);
  const rejections = await db.select().from(linkRejections).where(and(
    eq(linkRejections.organisationId, organisationId),
    eq(linkRejections.system, accounting.id),
    inArray(linkRejections.obligationId, ids),
  ));
  const rejectedFor = new Map();
  for (const r of rejections) rejectedFor.set(r.obligationId, (rejectedFor.get(r.obligationId) ?? new Set()).add(r.externalId));
  // How much of each invoice the jobs linked to it already account for.
  const { rows: linked } = await db.execute(sql`
    select accounting_ref, sum(total_cents)::bigint as cents from billing_obligations
    where organisation_id = ${organisationId} and accounting_ref is not null group by accounting_ref`);
  const taken = new Map(linked.map((r) => [r.accounting_ref, Number(r.cents)]));
  // Each customer's unlinked jobs, so two jobs at the same price share out
  // their invoices by date.
  const contactIds = [...new Set(due.map((o) => o.contactId).filter(Boolean))];
  const open = contactIds.length
    ? await db.select({
      id: billingObligations.id, contactId: billingObligations.contactId, jobDate: billingObligations.jobDate,
      totalCents: billingObligations.totalCents, subtotalCents: billingObligations.subtotalCents,
    }).from(billingObligations).where(and(
      eq(billingObligations.organisationId, organisationId),
      inArray(billingObligations.contactId, contactIds),
      sql`${billingObligations.accountingRef} is null`,
    ))
    : [];
  const rivalsOf = new Map();
  for (const o of open) rivalsOf.set(o.contactId, [...(rivalsOf.get(o.contactId) ?? []), o]);

  for (const obligation of due) {
    result.checked += 1;
    const { evidence, ranked, decision, reason } = await matchJob(db, organisationId, obligation, {
      accounting,
      xeroContactId: obligation.contactId ? xeroContactOf.get(obligation.contactId) ?? null : null,
      mirror,
      rejected: rejectedFor.get(obligation.id) ?? new Set(),
      taken,
      rivals: rivalsOf.get(obligation.contactId) ?? [],
    });
    await saveSuggestions(db, organisationId, obligation.id, accounting.id, ranked);
    if (!evidence) {
      if (reason === 'no_contact') result.noContact += 1;
      else result.waiting += 1;
      // Seen, so the next run waits for a change before it looks again.
      await db.update(billingObligations).set({ accountingCheckedAt: now })
        .where(eq(billingObligations.id, obligation.id));
      continue;
    }
    const before = obligation.accountingRef;
    await recordAccountingEvidence(db, organisationId, obligation.id, { ...evidence, checkedAt: now, actor: ACTOR });
    if (evidence.state === 'not_found') {
      result.notFound += 1;
      if (await holdIfStale(db, organisationId, obligation, { now, staleDays })) result.held += 1;
    } else if (decision === 'suggested') result.suggested += 1;
    else if (decision === 'unsure') result.unsure += 1;
    else if (before) result.followed += 1;
    else {
      result.linked += 1;
      taken.set(evidence.accountingRef, (taken.get(evidence.accountingRef) ?? 0) + obligation.totalCents);
    }
  }
  return result;
}

// One pass of the whole pipeline for the installation's organisation.
export async function runPipelineOnce(db, integrations, { now = new Date() } = {}) {
  const organisationId = await soleOrganisation(db);
  if (!organisationId) return { skipped: 'the installation needs exactly one organisation' };
  const summary = { organisationId };
  const [work] = integrations.with('pullWorkItems');
  const [accounting] = integrations.with('findInvoices');
  // The price check (price-list.js) links price lists by code first, so a
  // new product link maps the jobs read before it.
  const priceSystems = integrations.with('listPriceItems');
  if (priceSystems.length) {
    summary.prices = await checkPrices(db, organisationId, { catalogues: await readCatalogues(organisationId, priceSystems) });
  }
  if (work) {
    let restart = (summary.prices?.linked ?? 0) > 0;
    if (typeof work.capabilities.listCustomers === 'function') {
      summary.workCustomers = await linkCustomers(db, organisationId, { system: work.id, customers: await work.capabilities.listCustomers({ organisationId }) });
      // New customer links reach jobs read before them.
      restart ||= summary.workCustomers.linked > 0;
    }
    summary.work = await ingestWork(db, organisationId, { adapter: work, restart });
    // After the live feed, so a job both report is the live one.
    if (typeof work.capabilities.pullHistoryJobs === 'function') {
      summary.history = await ingestHistory(db, organisationId, { adapter: work });
    }
  }
  if (accounting) {
    if (typeof accounting.capabilities.listCustomers === 'function') {
      summary.accountingCustomers = await linkCustomers(db, organisationId, {
        system: accounting.id, customers: await accounting.capabilities.listCustomers({ organisationId }),
      });
    }
    const settings = await readInvoicingSettings(db, organisationId);
    summary.matching = await matchJobs(db, organisationId, { accounting, now, staleDays: settings.staleDays });
  }
  if (work || accounting) summary.automations = await runAutomations(db, organisationId, { accounting: accounting ?? null, work: work ?? null, now });
  return summary;
}

// The background worker: one pipeline run every two minutes, on the job
// queue, so two Flow processes never run it at once. It only reads other
// systems' copies and writes Flow's own records.
export function createPipelineWorker({ db, integrations, log = console, timers = { setTimeout, clearTimeout }, everyMs = RUN_EVERY_MS, firstDelayMs = 15_000 }) {
  const workerId = `pipeline-${randomUUID()}`;
  const startedAtMs = Date.now();
  let timer = null;
  let running = null;
  let stopped = true;
  let last = '';

  function schedule(delayMs) {
    if (stopped) return;
    timer = timers.setTimeout(tick, delayMs);
    timer?.unref?.();
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    running = (async () => {
      try {
        if (!integrations.with('pullWorkItems').length && !integrations.with('findInvoices').length) return;
        const organisationId = await soleOrganisation(db);
        if (!organisationId) return;
        // Issue #101: a run that gave up waits for a person, a restart or the
        // next day; the timer never starts it again by itself.
        if (await deadSince(db, organisationId, { kind: PIPELINE_KIND, dedupeKey: 'all', since: deadHoldSince(startedAtMs) })) return;
        await enqueueJob(db, organisationId, { kind: PIPELINE_KIND, dedupeKey: 'all' });
        const ran = await runNextJob(db, {
          workerId,
          leaseMs: LEASE_MS,
          handlers: { [PIPELINE_KIND]: () => runPipelineOnce(db, integrations) },
        });
        const line = ran ? `${ran.outcome}: ${JSON.stringify(ran.job.result ?? ran.job.lastError ?? {})}` : '';
        // Log a run only when its outcome differs from the last one. A run
        // that gave up is reported once to the error services.
        if (ran?.outcome === 'dead') log.error?.('[pipeline] the pipeline run gave up after its last attempt');
        if (line && line !== last) (ran.outcome === 'succeeded' ? log.info : log.warn)?.(`[pipeline] ${line}`);
        last = line || last;
      } catch (error) {
        log.error?.(`[pipeline] ${error?.code ?? 'error'}: ${error?.message ?? error}`);
      }
    })();
    await running;
    running = null;
    schedule(everyMs);
  }

  return {
    start() {
      stopped = false;
      schedule(firstDelayMs);
    },
    async stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
