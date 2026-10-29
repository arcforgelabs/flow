import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  billingObligations, invoices, linkRejections, linkSuggestions, obligationEvents, obligationPayments, obligationWritebacks, priceItems,
} from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { createDraftInvoice, getInvoice, updateDraftInvoice } from './invoices.js';
import { invoiceTotals, lineTotals } from './money.js';
import { isHistoryHeld } from './history.js';
import { openReview, resolveReviewFor } from './review.js';

// The billing obligation ledger. One billable job in a work system is one
// obligation. Its view (In work, Ready, Pending, Held, Drafted, Invoiced,
// Paid, Review required) comes only from the evidence stored on it, never from a fresh
// guess, and each change of evidence is an event. To make a draft invoice is a
// guarded transition that fails closed.

// How old the work system's report of a job may be when Flow drafts its invoice.
export const SOURCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Ways to tie accounting evidence to a job that are exact, not a guess:
// `prior_link` is a link the earlier installation held, checked against the
// accounting mirror; `person` is a link a person chose.
export const EXACT_MATCHES = ['flow_invoice', 'source_invoice_ref', 'accounting_ref', 'prior_link', 'person'];

const LINKED_STATES = ['drafted', 'authorised', 'part_paid', 'paid', 'voided', 'deleted'];

// Which system owns each fact about a billed job (docs/DATA_SPINE.md, "Who
// owns each field"). The work system owns the work; Flow owns its invoice
// and the send; the accounting system owns approval and payment. Only the
// work fields are compared when a job changes after its invoice was made.
export const FIELD_OWNERS = {
  lines: 'work',
  contactId: 'work',
  sourceStatus: 'work',
  reference: 'flow',
  dueDate: 'flow',
  send: 'flow',
  approval: 'accounting',
  payment: 'accounting',
};
const COMPARED = Object.keys(FIELD_OWNERS).filter((field) => FIELD_OWNERS[field] === 'work' && field !== 'sourceStatus');

export const CHANGED_REASON = 'the job changed after its invoice was made';
export const STATUS_BACK_REASON = 'the job status moved back after its invoice was made';
// Review queue kinds (server/core/review.js). An item only alerts.
export const REVIEW_CHANGED = 'job.changed';
export const REVIEW_STATUS_BACK = 'job.status_back';
export const REVIEW_DELETED = 'job.deleted';

async function loadObligation(tx, organisationId, obligationId, { lock = false } = {}) {
  let query = tx.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId)));
  if (lock) query = query.for('update');
  const [row] = await query;
  if (!row) throw notFound('obligation');
  return row;
}

// clock_timestamp, not now(): events written in one transaction keep their
// order when they are read back by time.
async function addEvent(tx, obligation, kind, actor, evidence = {}) {
  await tx.insert(obligationEvents).values({
    createdAt: sql`clock_timestamp()`,
    organisationId: obligation.organisationId,
    obligationId: obligation.id,
    kind,
    actor,
    evidence,
  });
}

async function update(tx, obligation, fields) {
  const [row] = await tx.update(billingObligations)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(eq(billingObligations.id, obligation.id))
    .returning();
  return row;
}

function requireActor(actor) {
  if (!actor) throw new FlowError('invalid', 'actor is required');
}

async function normaliseLines(tx, organisationId, lines) {
  if (!Array.isArray(lines) || !lines.length) throw new FlowError('invalid', 'a job needs at least one line');
  const normalised = [];
  for (const [index, line] of lines.entries()) {
    const itemCode = line.itemCode?.trim() || null;
    let priceItemId = line.priceItemId ?? null;
    let { description, unitAmountCents, taxCode } = line;
    // A line maps to a price item by its exact code only.
    const [item] = priceItemId
      ? await tx.select().from(priceItems)
        .where(and(eq(priceItems.organisationId, organisationId), eq(priceItems.id, priceItemId)))
      : itemCode
        ? await tx.select().from(priceItems)
          .where(and(eq(priceItems.organisationId, organisationId), eq(priceItems.code, itemCode)))
        : [];
    if (priceItemId && !item) throw new FlowError('invalid', `line ${index + 1}: price item not found`);
    priceItemId = item?.archivedAt ? null : (item?.id ?? null);
    description = (description ?? item?.name ?? '').trim();
    unitAmountCents ??= item?.unitAmountCents;
    taxCode ??= item?.taxCode ?? 'GST';
    const quantity = line.quantity ?? 1;
    if (!description) throw new FlowError('invalid', `line ${index + 1}: description is required`);
    let totals;
    try {
      totals = lineTotals({ quantity, unitAmountCents, taxCode });
    } catch (error) {
      throw new FlowError('invalid', `line ${index + 1}: ${error.message}`);
    }
    // A line mapped to an account (line-mapping.js) needs no price item.
    const accountCode = priceItemId ? null : (line.accountCode?.trim() || null);
    const extra = {
      ...(accountCode ? { accountCode } : {}),
      ...(line.label ? { label: line.label } : {}),
      ...(line.mappedBy ? { mappedBy: line.mappedBy } : {}),
    };
    normalised.push({ itemCode, priceItemId, description, quantity, unitAmountCents, taxCode, ...extra, ...totals });
  }
  return normalised;
}

function fingerprint(lines) {
  const keys = lines
    .map((l) => [l.itemCode ?? l.accountCode ?? l.description.toLowerCase(), l.quantity, l.unitAmountCents, l.taxCode])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(keys)).digest('hex');
}

// Records what the work system reports about a billable job. The first report
// makes the obligation; a later report with other lines or totals changes it.
// If the job changes after Flow made its invoice, the obligation goes to review.
export async function observeJob(db, organisationId, job) {
  const { sourceSystem, sourceJobRef, actor = sourceSystem } = job;
  if (!sourceSystem || !sourceJobRef) throw new FlowError('invalid', 'sourceSystem and sourceJobRef are required');
  const seenAt = job.observedAt ? new Date(job.observedAt) : new Date();
  return db.transaction(async (tx) => {
    const lines = await normaliseLines(tx, organisationId, job.lines);
    const facts = {
      sourceInvoiceRef: job.sourceInvoiceRef ?? null,
      caseRef: job.caseRef ?? null,
      contactId: job.contactId ?? null,
      practitioner: job.practitioner ?? null,
      shippedOn: job.shippedOn ?? null,
      jobDate: job.jobDate ?? null,
      sourceStatus: job.sourceStatus ?? null,
      lines,
      lineFingerprint: fingerprint(lines),
      ...invoiceTotals(lines),
      mappingComplete: lines.every((l) => l.priceItemId || l.accountCode),
    };
    const [existing] = await tx.select().from(billingObligations)
      .where(and(
        eq(billingObligations.organisationId, organisationId),
        eq(billingObligations.sourceSystem, sourceSystem),
        eq(billingObligations.sourceJobRef, sourceJobRef),
      ))
      .for('update');

    if (!existing) {
      const [row] = await tx.insert(billingObligations)
        .values({ organisationId, sourceSystem, sourceJobRef, sourceSeenAt: seenAt, ...facts })
        .returning();
      await addEvent(tx, row, 'observed', actor, {
        lineFingerprint: row.lineFingerprint, totalCents: row.totalCents, mappingComplete: row.mappingComplete,
      });
      return row;
    }

    // An older report never replaces a newer one.
    if (seenAt < existing.sourceSeenAt) return existing;
    const changed = ['sourceInvoiceRef', 'caseRef', 'contactId', 'practitioner', 'shippedOn', 'lineFingerprint', 'totalCents']
      .filter((key) => String(existing[key] ?? '') !== String(facts[key] ?? ''));
    if (!changed.length) {
      const row = await update(tx, existing, {
        sourceSeenAt: seenAt, mappingComplete: facts.mappingComplete, lines, jobDate: facts.jobDate, sourceStatus: facts.sourceStatus,
      });
      await statusBillableAgain(tx, organisationId, existing, row, actor);
      return row;
    }
    const fields = { ...facts, sourceSeenAt: seenAt };
    let compare = null;
    if (!isHistoryHeld(existing) && existing.invoiceId && changed.some((key) => ['lineFingerprint', 'totalCents', 'contactId'].includes(key))) {
      compare = await compareWithDraft(tx, organisationId, existing, facts);
      if (compare.outcome !== 'none') {
        fields.holdState = 'review';
        fields.holdReason = CHANGED_REASON;
      } else if (existing.holdState === 'review' && existing.holdReason === CHANGED_REASON) {
        // The job is back to what the invoice was built from.
        Object.assign(fields, { holdState: 'none', holdReason: null });
      }
    }
    const row = await update(tx, existing, fields);
    await addEvent(tx, row, 'source_changed', actor, {
      changed,
      before: { lineFingerprint: existing.lineFingerprint, totalCents: existing.totalCents },
      after: { lineFingerprint: row.lineFingerprint, totalCents: row.totalCents },
      ...(compare ? { compare: { outcome: compare.outcome, fields: compare.fields.map(({ field, changedIn }) => ({ field, changedIn })) } } : {}),
      ...(fields.holdState === 'review' ? { holdReason: fields.holdReason } : {}),
    });
    if (compare?.outcome === 'none') {
      await resolveReviewFor(tx, organisationId, { kind: REVIEW_CHANGED, entity: 'obligation', flowId: row.id, resolution: 'job_matches_invoice', actor });
    } else if (compare) {
      await openReview(tx, organisationId, changedReview(row, compare));
    }
    await statusBillableAgain(tx, organisationId, existing, row, actor);
    return row;
  });
}

// A job billable again after its status moved back (observeWithdrawn): the
// alert is over when no invoice was made in the meantime.
async function statusBillableAgain(tx, organisationId, before, row, actor) {
  if (row.invoiceId || String(before.sourceStatus ?? '') === String(row.sourceStatus ?? '')) return;
  await resolveReviewFor(tx, organisationId, { kind: REVIEW_STATUS_BACK, entity: 'obligation', flowId: row.id, resolution: 'status_billable_again', actor });
}

// The job facts an invoice is built from, kept on the obligation when Flow
// drafts the invoice: the merge base of the three-way compare.
function basisOf(o) {
  return {
    lines: o.lines.map(({ itemCode = null, priceItemId = null, accountCode = null, description, quantity, unitAmountCents, taxCode }) => (
      { itemCode, priceItemId, accountCode, description, quantity, unitAmountCents, taxCode }
    )),
    contactId: o.contactId ?? null,
    subtotalCents: o.subtotalCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    sourceStatus: o.sourceStatus ?? null,
    sourceSeenAt: o.sourceSeenAt ? new Date(o.sourceSeenAt).toISOString() : null,
  };
}

// One key for a set of lines, the same for the job's lines and the invoice's.
function linesKey(lines) {
  const keys = (lines ?? [])
    .map((l) => [l.priceItemId ?? l.accountCode ?? String(l.description ?? '').trim().toLowerCase(), l.quantity, l.unitAmountCents, l.taxCode])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(keys)).digest('hex');
}

const sideValue = (side, field) => (field === 'lines' ? linesKey(side.lines) : (side[field] ?? null));

// The three-way compare, field by field, of the facts the invoice was built
// from (base), the work system now (source) and Flow's invoice now (flow).
// Only work fields are compared (FIELD_OWNERS). The outcome:
//   none     the work system is as it was, or as the invoice is: nothing to do
//   offer    only the work system changed and the draft is not sent: a person
//            can take the new lines into Flow's own draft (useSourceLines)
//   conflict both changed, or the invoice left Flow: an alert only
export function compareThreeWays(base, source, flow, { sent = false } = {}) {
  const fields = COMPARED.map((field) => {
    const [b, s, f] = [base, source, flow].map((side) => sideValue(side, field));
    const changedIn = s === b ? (f === b ? 'none' : 'flow') : (f === b ? 'work' : (f === s ? 'same' : 'both'));
    return { field, owner: FIELD_OWNERS[field], changedIn };
  });
  const work = fields.filter((f) => ['work', 'both'].includes(f.changedIn));
  let outcome = 'none';
  if (work.length) outcome = sent || work.some((f) => f.changedIn === 'both') ? 'conflict' : 'offer';
  return { outcome, sent, fields };
}

// The invoice has left Flow's hands: issued, queued or sent, or the
// accounting system holds it.
function invoiceSent(invoice, obligation) {
  return invoice.status !== 'draft' || ['queued', 'sent'].includes(invoice.sendState)
    || LINKED_STATES.includes(obligation.accountingState);
}

async function compareWithDraft(tx, organisationId, obligation, facts) {
  // An invoice drafted before the basis was kept: the last report stands in.
  const base = obligation.draftBasis ?? basisOf(obligation);
  let invoice;
  try {
    invoice = await getInvoice(tx, organisationId, obligation.invoiceId);
  } catch (error) {
    if (error?.code !== 'not_found') throw error;
    return { outcome: 'conflict', sent: false, fields: [], base, missing: true };
  }
  const flow = { lines: invoice.lines, contactId: invoice.contactId };
  const compare = compareThreeWays(base, facts, flow, { sent: invoiceSent(invoice, obligation) });
  return { ...compare, base, flow, invoiceStatus: invoice.status };
}

function changedReview(obligation, compare) {
  return {
    kind: REVIEW_CHANGED,
    entity: 'obligation',
    flowId: obligation.id,
    systems: [obligation.sourceSystem, 'flow'],
    moneyAtRiskCents: Math.max(0, obligation.totalCents ?? 0),
    evidence: {
      outcome: compare.outcome,
      sent: compare.sent,
      invoiceId: obligation.invoiceId,
      fields: compare.fields,
      basis: compare.base,
      job: basisOf(obligation),
      invoice: compare.flow ? { contactId: compare.flow.contactId, lines: compare.flow.lines.map(({ priceItemId, accountCode, description, quantity, unitAmountCents, taxCode }) => ({ priceItemId, accountCode, description, quantity, unitAmountCents, taxCode })) } : null,
      canUseNewLines: compare.outcome === 'offer',
    },
  };
}

// "Use new lines": a person takes the work system's new lines (and its
// customer, when that changed) into Flow's own unsent draft. Flow writes only
// its own draft, never another system. Refused when the invoice has left
// Flow. When the draft changed too, `accept` (a person's "Accept change")
// takes the work system's value over the draft's; without it, refused.
export async function useSourceLines(db, organisationId, obligationId, { actor, accept = false }) {
  requireActor(actor);
  return db.transaction(async (tx) => {
    const obligation = await loadObligation(tx, organisationId, obligationId, { lock: true });
    if (!obligation.invoiceId) throw new FlowError('invalid', 'the job has no invoice');
    const compare = await compareWithDraft(tx, organisationId, obligation, obligation);
    if (compare.outcome === 'conflict' && (compare.sent || compare.missing || !accept)) {
      throw new FlowError('conflict', compare.missing ? 'the invoice was not found' : compare.sent ? 'the invoice has left Flow; change it where it is now' : 'the draft changed in Flow too; a person must compare them', { fields: compare.fields });
    }
    const changes = {};
    for (const { field, changedIn } of compare.fields) {
      if (changedIn !== 'work' && !(accept && changedIn === 'both')) continue;
      if (field === 'lines') {
        changes.lines = obligation.lines.map(({ priceItemId, accountCode, description, quantity, unitAmountCents, taxCode }) => (
          { priceItemId, accountCode, description, quantity, unitAmountCents, taxCode }
        ));
      } else changes[field] = obligation[field];
    }
    let invoice = Object.keys(changes).length
      ? await updateDraftInvoice(tx, organisationId, obligation.invoiceId, changes)
      : await getInvoice(tx, organisationId, obligation.invoiceId);
    // The draft now matches a job that is ready to invoice, so it goes to
    // Ready on its own; Flow's checks still hold it in Problem if one fails.
    if (obligation.readyAt && !invoice.readyAt) {
      await tx.update(invoices).set({ readyAt: sql`now()`, readyBy: null })
        .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoice.id), eq(invoices.status, 'draft')));
      invoice = await getInvoice(tx, organisationId, invoice.id);
    }
    const fields = { draftBasis: basisOf(obligation) };
    if (obligation.holdState === 'review' && obligation.holdReason === CHANGED_REASON) Object.assign(fields, { holdState: 'none', holdReason: null });
    const row = await update(tx, obligation, fields);
    await addEvent(tx, row, 'source_lines_used', actor, { invoiceId: invoice.id, changed: Object.keys(changes), totalCents: invoice.totalCents, ...(accept ? { accepted: compare.outcome } : {}) });
    await resolveReviewFor(tx, organisationId, { kind: REVIEW_CHANGED, entity: 'obligation', flowId: row.id, resolution: 'used_new_lines', actor });
    return { obligation: row, invoice };
  });
}

// After a person rechecks a job (POST /jobs/:id/recheck): a "job changed"
// hold whose job now matches the draft again (the work system was fixed, or
// the draft was) is over. Answers the obligation.
export async function settleJobChange(db, organisationId, obligationId, { actor }) {
  requireActor(actor);
  return db.transaction(async (tx) => {
    const obligation = await loadObligation(tx, organisationId, obligationId, { lock: true });
    if (!obligation.invoiceId || obligation.holdState !== 'review' || obligation.holdReason !== CHANGED_REASON) return obligation;
    const compare = await compareWithDraft(tx, organisationId, obligation, obligation);
    const settled = compare.fields.every(({ changedIn }) => ['none', 'same', 'flow'].includes(changedIn)) && !compare.missing;
    if (!settled) return obligation;
    const row = await update(tx, obligation, { holdState: 'none', holdReason: null, draftBasis: basisOf(obligation) });
    await addEvent(tx, row, 'review_settled', actor, { invoiceId: obligation.invoiceId });
    await resolveReviewFor(tx, organisationId, { kind: REVIEW_CHANGED, entity: 'obligation', flowId: row.id, resolution: 'job_matches_invoice', actor });
    return row;
  });
}

// What changed in a job after its invoice was made, for the invoice page:
// each line as it was (the draft basis) and as the work system has it now.
// Lines pair by price item, else item code, account or description; an
// unpaired old line and an unpaired new line at the same place pair as a
// replaced item. Answers [{ change, position, was, now, fields }], where
// `change` is changed, replaced, added or removed and `fields` names what
// differs on a changed or replaced line (item, description, quantity, price).
export function diffJobLines(wasLines = [], nowLines = []) {
  const keyOf = (l) => l.priceItemId ?? l.itemCode ?? l.accountCode ?? String(l.description ?? '').trim().toLowerCase();
  const show = (l) => ({
    code: l.itemCode ?? l.accountCode ?? null, description: l.description ?? '', quantity: Number(l.quantity), unitAmountCents: l.unitAmountCents ?? null,
  });
  const differs = (a, b) => [
    keyOf(a) !== keyOf(b) ? 'item' : null,
    String(a.description ?? '').trim() !== String(b.description ?? '').trim() && keyOf(a) === keyOf(b) ? 'description' : null,
    Number(a.quantity) !== Number(b.quantity) ? 'quantity' : null,
    (a.unitAmountCents ?? null) !== (b.unitAmountCents ?? null) ? 'price' : null,
  ].filter(Boolean);
  const wasLeft = wasLines.map((line, index) => ({ line, index }));
  const pairs = [];
  const added = [];
  nowLines.forEach((line, index) => {
    const at = wasLeft.findIndex((w) => keyOf(w.line) === keyOf(line));
    if (at === -1) { added.push({ line, index }); return; }
    pairs.push({ was: wasLeft.splice(at, 1)[0], now: { line, index } });
  });
  // What is left over: an old line and a new line in the same place are one
  // replaced item; the rest were added or removed.
  for (const now of [...added]) {
    const at = wasLeft.findIndex((w) => w.index === now.index);
    if (at === -1) continue;
    pairs.push({ was: wasLeft.splice(at, 1)[0], now });
    added.splice(added.indexOf(now), 1);
  }
  const changes = [];
  for (const { was, now } of pairs) {
    const fields = differs(was.line, now.line);
    if (!fields.length) continue;
    changes.push({ change: fields.includes('item') ? 'replaced' : 'changed', position: now.index + 1, was: show(was.line), now: show(now.line), fields });
  }
  for (const { line, index } of added) changes.push({ change: 'added', position: index + 1, was: null, now: show(line), fields: [] });
  for (const { line, index } of wasLeft) changes.push({ change: 'removed', position: index + 1, was: show(line), now: null, fields: [] });
  return changes.sort((a, b) => a.position - b.position || (a.change === 'removed' ? -1 : 1));
}

// The open "job changed" problem of an invoice, for the invoice page, or
// null: the job as it was when the invoice was made, as the work system has
// it now, and whether a person can adopt the change into Flow's own draft
// ("Adopt changes", useSourceLines). An invoice drafted before the basis was
// kept compares with the invoice's own lines.
export async function jobChangeFor(db, organisationId, invoiceId) {
  const [obligation] = await db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, invoiceId),
      eq(billingObligations.holdState, 'review'), eq(billingObligations.holdReason, CHANGED_REASON)));
  if (!obligation) return null;
  const compare = await compareWithDraft(db, organisationId, obligation, obligation);
  const was = obligation.draftBasis
    ?? (compare.flow ? { lines: compare.flow.lines, contactId: compare.flow.contactId, totalCents: null } : basisOf(obligation));
  return {
    jobId: obligation.id,
    sourceSystem: obligation.sourceSystem,
    sourceJobRef: obligation.sourceJobRef,
    sourceInvoiceRef: obligation.sourceInvoiceRef,
    seenAt: obligation.sourceSeenAt,
    outcome: compare.outcome,
    sent: compare.sent,
    canAdopt: compare.outcome === 'offer',
    // "Accept change": the draft takes the work system's values, even when
    // the draft changed too. Not once the invoice has left Flow.
    canAccept: !compare.sent && !compare.missing,
    lines: diffJobLines(was.lines ?? [], obligation.lines ?? []),
    contact: (was.contactId ?? null) === (obligation.contactId ?? null) ? null : { was: was.contactId ?? null, now: obligation.contactId ?? null },
    total: { was: was.totalCents ?? null, now: obligation.totalCents },
  };
}

// Records that a job the ledger knows is no longer billable in the work
// system: deleted there, or its status moved back (for example from Shipped
// to In production). Flow writes nothing to another system:
//   deleted                      review hold and an alert
//   status back, invoice made    review hold and an alert
//   status back, only ready      the ready mark is cleared and an alert opens;
//                                the alert closes when the job is billable again
// The status is stored, so a repeat report of the same status does nothing.
export async function observeWithdrawn(db, organisationId, entry) {
  const { sourceSystem, sourceJobRef, sourceStatus = null, deleted = false, reason = null, actor = `system:${sourceSystem}` } = entry;
  if (!sourceSystem || !sourceJobRef) throw new FlowError('invalid', 'sourceSystem and sourceJobRef are required');
  const seenAt = entry.observedAt ? new Date(entry.observedAt) : new Date();
  return db.transaction(async (tx) => {
    const [obligation] = await tx.select().from(billingObligations)
      .where(and(
        eq(billingObligations.organisationId, organisationId),
        eq(billingObligations.sourceSystem, sourceSystem),
        eq(billingObligations.sourceJobRef, sourceJobRef),
      ))
      .for('update');
    if (!obligation) return { obligation: null, action: 'none' };
    if (isHistoryHeld(obligation)) {
      if (seenAt < obligation.sourceSeenAt) return { obligation, action: 'none' };
      const row = await update(tx, obligation, { sourceStatus: deleted ? 'Deleted in Seazona' : sourceStatus, sourceSeenAt: seenAt });
      return { obligation: row, action: 'status' };
    }
    if (deleted) {
      if (obligation.holdState === 'review') return { obligation, action: 'none' };
      const holdReason = reason ?? 'the job was deleted in the work system';
      const row = await update(tx, obligation, { holdState: 'review', holdReason });
      await addEvent(tx, row, 'review', actor, { from: obligation.holdState, reason: holdReason });
      await openReview(tx, organisationId, statusReview(REVIEW_DELETED, row, { reason: holdReason }));
      return { obligation: row, action: 'review' };
    }
    if (seenAt < obligation.sourceSeenAt || String(obligation.sourceStatus ?? '') === String(sourceStatus ?? '')) {
      return { obligation, action: 'none' };
    }
    const fields = { sourceStatus, sourceSeenAt: seenAt };
    let action = 'status';
    if (obligation.invoiceId) {
      if (obligation.holdState !== 'review') Object.assign(fields, { holdState: 'review', holdReason: STATUS_BACK_REASON });
      action = 'review';
    } else if (obligation.readyAt) {
      // Not setReady's "in work": that marks a person's choice, and the ready
      // routine must mark the job again when its status is billable again.
      Object.assign(fields, { readyAt: null, readyBy: null });
      action = 'ready_cleared';
    }
    const row = await update(tx, obligation, fields);
    await addEvent(tx, row, 'status_moved_back', actor, {
      from: obligation.sourceStatus, to: sourceStatus, action, ...(fields.holdState ? { holdReason: fields.holdReason } : {}),
    });
    if (action !== 'status') {
      await openReview(tx, organisationId, statusReview(REVIEW_STATUS_BACK, row, { from: obligation.sourceStatus, to: sourceStatus, action }));
    }
    return { obligation: row, action };
  });
}

function statusReview(kind, obligation, evidence) {
  return {
    kind,
    entity: 'obligation',
    flowId: obligation.id,
    systems: [obligation.sourceSystem, 'flow'],
    moneyAtRiskCents: Math.max(0, obligation.totalCents ?? 0),
    evidence: { ...evidence, sourceJobRef: obligation.sourceJobRef, invoiceId: obligation.invoiceId ?? null },
  };
}

// Records what the accounting system says about the job's invoice. Evidence
// that is not tied to the job by an exact match never counts as found: it
// makes the obligation ambiguous, for a person to resolve.
export async function recordAccountingEvidence(db, organisationId, obligationId, evidence) {
  const { state, accountingRef = null, accountingUrl = null, matchedBy = null, actor } = evidence;
  requireActor(actor);
  if (!['not_found', ...LINKED_STATES].includes(state)) throw new FlowError('invalid', `unknown accounting state: ${state}`);
  const checkedAt = evidence.checkedAt ? new Date(evidence.checkedAt) : new Date();
  return db.transaction(async (tx) => {
    const obligation = await loadObligation(tx, organisationId, obligationId, { lock: true });
    let next = state;
    let reason = null;
    if (state !== 'not_found' && !EXACT_MATCHES.includes(matchedBy)) {
      next = 'ambiguous';
      reason = `matched by ${matchedBy ?? 'nothing'}, which is not an exact match`;
    } else if (state !== 'not_found' && !accountingRef) {
      throw new FlowError('invalid', 'accountingRef is required when an invoice was found');
    } else if (obligation.accountingRef && accountingRef && accountingRef !== obligation.accountingRef) {
      next = 'conflict';
      reason = `a second invoice ${accountingRef} answers for this job`;
    } else if (state === 'not_found' && obligation.accountingRef) {
      // The invoice Flow saw before is gone from the search. That needs a person.
      next = 'conflict';
      reason = `invoice ${obligation.accountingRef} was seen before and is now not found`;
    }
    const fields = { accountingState: next, accountingCheckedAt: checkedAt };
    if (next !== 'conflict' && next !== 'ambiguous' && state !== 'not_found') {
      fields.accountingRef = accountingRef;
      fields.accountingUrl = accountingUrl ?? obligation.accountingUrl;
      fields.accountingMatchedBy = matchedBy;
    }
    const row = await update(tx, obligation, fields);
    if (next !== obligation.accountingState || (fields.accountingRef && fields.accountingRef !== obligation.accountingRef)) {
      await addEvent(tx, row, 'accounting_checked', actor, {
        reported: state, state: next, accountingRef, accountingUrl, matchedBy, ...(reason ? { reason } : {}),
      });
    }
    return row;
  });
}

// Records one payment against the job's invoice. Only a payment tied to the
// job by an exact match is accepted. When the payments cover the total, the
// job is paid and a "paid" status, with its evidence, waits to go back to the
// work system. A part payment shows as part paid.
export async function recordPayment(db, organisationId, obligationId, payment) {
  const { paymentRef, paidOn, amountCents, reference = null, reconciled = false, accountingUrl = null, matchedBy, actor } = payment;
  requireActor(actor);
  if (!EXACT_MATCHES.includes(matchedBy)) {
    throw new FlowError('unmatched_payment', 'a payment counts only when it matches the job exactly', { matchedBy });
  }
  if (!paymentRef) throw new FlowError('invalid', 'paymentRef is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn ?? '')) throw new FlowError('invalid', 'paidOn must be YYYY-MM-DD');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new FlowError('invalid', 'amountCents must be a positive whole number');
  return db.transaction(async (tx) => {
    const obligation = await loadObligation(tx, organisationId, obligationId, { lock: true });
    if (!obligation.accountingRef || !['authorised', 'part_paid', 'paid'].includes(obligation.accountingState)) {
      throw new FlowError('not_linked', 'the job has no confirmed invoice to take a payment', {
        accountingState: obligation.accountingState,
      });
    }
    const inserted = await tx.insert(obligationPayments)
      .values({
        organisationId, obligationId, paymentRef, paidOn, amountCents, reference, reconciled, accountingUrl,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) {
      // The same payment again: keep the newer reconciliation flag only.
      await tx.update(obligationPayments).set({ reconciled })
        .where(and(
          eq(obligationPayments.organisationId, organisationId),
          eq(obligationPayments.obligationId, obligationId),
          eq(obligationPayments.paymentRef, paymentRef),
        ));
      return obligation;
    }
    const payments = await tx.select().from(obligationPayments)
      .where(and(eq(obligationPayments.organisationId, organisationId), eq(obligationPayments.obligationId, obligationId)))
      .orderBy(asc(obligationPayments.paidOn), asc(obligationPayments.paymentRef));
    const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
    const accountingState = paidCents >= obligation.totalCents ? 'paid' : 'part_paid';
    const row = await update(tx, obligation, { paidCents, accountingState });
    await addEvent(tx, row, 'payment_recorded', actor, {
      paymentRef, paidOn, amountCents, reference, reconciled, matchedBy, paidCents, totalCents: row.totalCents,
    });
    if (accountingState === 'paid') {
      const queued = await tx.insert(obligationWritebacks).values({
        organisationId,
        obligationId,
        targetSystem: obligation.sourceSystem,
        status: 'paid',
        evidence: paidEvidence(row, payments),
      }).onConflictDoNothing().returning();
      if (queued.length) await addEvent(tx, row, 'paid', actor, { paidCents, totalCents: row.totalCents });
    }
    return row;
  });
}

function paidEvidence(obligation, payments) {
  return {
    sourceJobRef: obligation.sourceJobRef,
    accountingRef: obligation.accountingRef,
    accountingUrl: obligation.accountingUrl,
    totalCents: obligation.totalCents,
    paidCents: obligation.paidCents,
    payments: payments.map((p) => ({
      paymentRef: p.paymentRef,
      paidOn: p.paidOn,
      amountCents: p.amountCents,
      reference: p.reference,
      reconciled: p.reconciled,
      accountingUrl: p.accountingUrl,
    })),
  };
}

// The status write-backs that still have to reach a work system.
export async function listPendingWritebacks(db, organisationId, { targetSystem } = {}) {
  const where = [
    eq(obligationWritebacks.organisationId, organisationId),
    inArray(obligationWritebacks.state, ['pending', 'failed']),
  ];
  if (targetSystem) where.push(eq(obligationWritebacks.targetSystem, targetSystem));
  return db.select().from(obligationWritebacks).where(and(...where)).orderBy(asc(obligationWritebacks.createdAt));
}

// Records the result of one try to send a write-back.
export async function recordWritebackResult(db, organisationId, writebackId, { outcome, error = null, actor }) {
  requireActor(actor);
  if (!['sent', 'failed', 'not_supported'].includes(outcome)) throw new FlowError('invalid', `unknown outcome: ${outcome}`);
  return db.transaction(async (tx) => {
    const [writeback] = await tx.select().from(obligationWritebacks)
      .where(and(eq(obligationWritebacks.organisationId, organisationId), eq(obligationWritebacks.id, writebackId)))
      .for('update');
    if (!writeback) throw notFound('write-back');
    if (writeback.state === 'sent') return writeback;
    const [row] = await tx.update(obligationWritebacks)
      .set({
        state: outcome,
        attempts: sql`${obligationWritebacks.attempts} + 1`,
        lastError: outcome === 'sent' ? null : error,
        sentAt: outcome === 'sent' ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(eq(obligationWritebacks.id, writeback.id))
      .returning();
    const obligation = await loadObligation(tx, organisationId, writeback.obligationId);
    await addEvent(tx, obligation, `writeback_${outcome}`, actor, {
      writebackId: row.id, targetSystem: row.targetSystem, status: row.status, attempts: row.attempts,
      ...(error ? { error } : {}),
    });
    return row;
  });
}

// Marks a job ready to invoice, or back in work. `actor` is a person or the
// automation that decided. A job with an invoice stays as it is.
export async function setReady(db, organisationId, obligationId, { ready = true, actor }) {
  requireActor(actor);
  return db.transaction(async (tx) => {
    const obligation = await loadObligation(tx, organisationId, obligationId, { lock: true });
    if (Boolean(obligation.readyAt) === ready) return obligation;
    if (!ready && obligation.invoiceId) throw new FlowError('invalid', 'the job has an invoice already');
    const row = await update(tx, obligation, ready ? { readyAt: sql`now()`, readyBy: actor } : { readyAt: null, readyBy: null });
    await addEvent(tx, row, ready ? 'ready' : 'in_work', actor, {});
    return row;
  });
}

// Puts an obligation on hold, sends it to review, or releases it.
export async function setHold(db, organisationId, obligationId, { holdState, reason = null, actor }) {
  requireActor(actor);
  if (!['none', 'held', 'review'].includes(holdState)) throw new FlowError('invalid', `unknown hold state: ${holdState}`);
  if (holdState !== 'none' && !reason?.trim()) throw new FlowError('invalid', 'a hold needs a reason');
  return db.transaction(async (tx) => {
    const obligation = await loadObligation(tx, organisationId, obligationId, { lock: true });
    const row = await update(tx, obligation, { holdState, holdReason: holdState === 'none' ? null : reason.trim() });
    await addEvent(tx, row, holdState === 'none' ? 'released' : holdState, actor, {
      from: obligation.holdState, reason: row.holdReason,
    });
    return row;
  });
}

// A job with no invoice of its own whose accounting evidence is ambiguous:
// the matcher found accounting invoices that may be this job's, but none
// exactly. A person settles it on the Reconcile page: "Make invoice", or a
// link to a Flow invoice (linkJobToInvoice).
const unlinked = (o) => o.accountingState === 'ambiguous' && !o.invoiceId && !o.accountingRef;

// The matcher's open suggestions for one job, best first.
export async function linkSuggestionsFor(db, organisationId, obligationId) {
  return db.select({
    system: linkSuggestions.system, externalId: linkSuggestions.externalId, externalNumber: linkSuggestions.externalNumber,
    score: linkSuggestions.score, signals: linkSuggestions.signals,
  }).from(linkSuggestions).where(and(
    eq(linkSuggestions.organisationId, organisationId),
    eq(linkSuggestions.obligationId, obligationId),
    eq(linkSuggestions.state, 'open'),
  )).orderBy(asc(linkSuggestions.rank));
}

// Rejects every open suggestion for the job ("not this one"): the matcher
// never suggests those pairs again.
async function rejectSuggestions(tx, obligation, { actor }) {
  const open = await tx.select().from(linkSuggestions).where(and(
    eq(linkSuggestions.organisationId, obligation.organisationId),
    eq(linkSuggestions.obligationId, obligation.id),
    eq(linkSuggestions.state, 'open'),
  ));
  for (const suggestion of open) {
    await tx.update(linkSuggestions).set({ state: 'rejected', decidedBy: actor, decidedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(linkSuggestions.id, suggestion.id));
    await tx.insert(linkRejections)
      .values({ organisationId: obligation.organisationId, obligationId: obligation.id, system: suggestion.system, externalId: suggestion.externalId, actor })
      .onConflictDoNothing();
  }
  return open.map((s) => s.externalId);
}

// "Make invoice": a person says the job has no invoice yet. Every suggestion
// is rejected and the job is recorded as not found, so it can draft. The
// live check before the draft still runs (draftInvoiceForObligation).
export async function confirmNoInvoice(db, organisationId, obligationId, { actor }) {
  requireActor(actor);
  return db.transaction(async (tx) => {
    const obligation = await loadObligation(tx, organisationId, obligationId, { lock: true });
    if (!unlinked(obligation)) throw new FlowError('invalid', 'the job is not waiting for a person to settle its invoice');
    const rejected = await rejectSuggestions(tx, obligation, { actor });
    const row = await update(tx, obligation, { accountingState: 'not_found', accountingCheckedAt: sql`now()` });
    await addEvent(tx, row, 'accounting_checked', actor, { reported: 'not_found', state: 'not_found', matchedBy: 'person', rejected });
    return row;
  });
}

// A person links a job to a Flow invoice that already exists (Reconcile).
// The job then has its invoice: Flow drafts no other. A job held on unclear
// accounting evidence is settled by it; whether the Flow invoice matches one
// in the accounting system is that integration's own work, not the job's.
// `accountingRef` is given by an accounting integration that made the Flow
// invoice from the accounting invoice the job is tied to already.
export async function linkJobToInvoice(db, organisationId, obligationId, { invoiceId, accountingRef = null, actor }) {
  requireActor(actor);
  return db.transaction(async (tx) => {
    const obligation = await loadObligation(tx, organisationId, obligationId, { lock: true });
    if (obligation.invoiceId) throw new FlowError('invalid', 'the job has an invoice already');
    if (obligation.accountingRef && obligation.accountingRef !== accountingRef) throw new FlowError('invalid', 'the job is linked to an accounting invoice already');
    const [invoice] = await tx.select({ id: invoices.id, status: invoices.status, contactId: invoices.contactId }).from(invoices)
      .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)));
    if (!invoice) throw notFound('invoice');
    if (invoice.status === 'void') throw new FlowError('invalid', 'the invoice is void');
    const rejected = await rejectSuggestions(tx, obligation, { actor });
    const row = await update(tx, obligation, {
      invoiceId: invoice.id,
      draftBasis: basisOf(obligation),
      ...(obligation.accountingState === 'ambiguous' ? { accountingState: 'unknown' } : {}),
      ...(obligation.readyAt ? {} : { readyAt: sql`now()`, readyBy: actor }),
    });
    await addEvent(tx, row, 'invoice_linked', actor, { invoiceId: invoice.id, matchedBy: 'person', rejected });
    return row;
  });
}

// The obligation's view and the reasons for it, from its stored evidence only.
// `accounting` is false while no accounting system is connected: Flow's own
// records are then the only check, so a job nobody checked in one can draft.
export function ledgerView(obligation, { now = new Date(), sourceMaxAgeMs = SOURCE_MAX_AGE_MS, accounting = true } = {}) {
  const o = obligation;
  if (o.holdState === 'review') return { view: 'review_required', reasons: [o.holdReason ?? 'sent to review'] };
  if (['ambiguous', 'conflict'].includes(o.accountingState)) {
    return { view: 'review_required', reasons: [`the accounting evidence is ${o.accountingState}`] };
  }
  if (['voided', 'deleted'].includes(o.accountingState)) {
    return { view: 'review_required', reasons: [`invoice ${o.accountingRef} was ${o.accountingState}`] };
  }
  if (o.holdState === 'held') return { view: 'held', reasons: [o.holdReason ?? 'held'] };
  if (o.accountingState === 'paid') return { view: 'paid', reasons: [`invoice ${o.accountingRef} is paid`] };
  if (['authorised', 'part_paid'].includes(o.accountingState)) {
    return { view: 'invoiced', reasons: [`invoice ${o.accountingRef} is ${o.accountingState.replace('_', ' ')}`] };
  }
  if (o.invoiceId || o.accountingState === 'drafted') return { view: 'drafted', reasons: ['a draft invoice exists'] };
  const reasons = draftBlockers(o, { now, sourceMaxAgeMs, accounting });
  // Flow's own stage: a job is in work until a person or an automation marks
  // it ready to invoice (setReady).
  if (!o.readyAt) return { view: 'in_work', reasons: ['the job is not marked ready to invoice', ...reasons] };
  return reasons.length ? { view: 'pending', reasons } : { view: 'ready', reasons: ['all checks pass'] };
}

function draftBlockers(o, { now, sourceMaxAgeMs, accounting = true }) {
  const reasons = [];
  if (o.holdState !== 'none') reasons.push(`the job is ${o.holdState}`);
  if (o.invoiceId) reasons.push('the job already has an invoice');
  if (o.accountingState === 'unknown') {
    if (accounting) reasons.push('the accounting system was not checked');
  }
  else if (o.accountingState !== 'not_found') reasons.push(`the accounting system reports ${o.accountingState}`);
  if (!o.mappingComplete) reasons.push('a line does not map to a price item');
  if (!o.contactId) reasons.push('the job has no customer contact');
  if (now - new Date(o.sourceSeenAt) > sourceMaxAgeMs) reasons.push('the work system report is out of date');
  return reasons;
}

// The guarded transition to a draft invoice. It runs only when the stored
// evidence allows it AND a live check in the accounting system, just before
// the write, finds no invoice for the job. Any doubt refuses the draft, and
// the refusal is recorded.
export async function draftInvoiceForObligation(db, organisationId, obligationId, {
  liveCheck, actor, now = new Date(), sourceMaxAgeMs = SOURCE_MAX_AGE_MS, dueDate = null, reference = null,
}) {
  requireActor(actor);
  // A null liveCheck says no accounting system is connected (ledgerView).
  if (liveCheck !== null && typeof liveCheck !== 'function') throw new FlowError('invalid', 'liveCheck must be a function, or null with no accounting system');
  const accounting = liveCheck !== null;
  const outcome = await db.transaction(async (tx) => {
    const obligation = await loadObligation(tx, organisationId, obligationId, { lock: true });
    const reasons = draftBlockers(obligation, { now, sourceMaxAgeMs, accounting });
    let live = null;
    if (!reasons.length && accounting) {
      try {
        live = await liveCheck(obligation);
      } catch (error) {
        reasons.push(`the live accounting check failed: ${error.message}`);
      }
      if (live && live.state !== 'not_found') reasons.push(`the live accounting check reports ${live.state ?? 'nothing'}`);
    }
    if (reasons.length) {
      await addEvent(tx, obligation, 'draft_refused', actor, { reasons, live });
      return { refused: reasons };
    }
    const invoice = await createDraftInvoice(tx, organisationId, {
      contactId: obligation.contactId,
      // The Reference rule's text (references.js), never a work system id.
      reference,
      dueDate,
      lines: obligation.lines.map(({ priceItemId, accountCode, description, quantity, unitAmountCents, taxCode }) => (
        { priceItemId, accountCode, description, quantity, unitAmountCents, taxCode }
      )),
    });
    // Drafting the invoice says the job is ready, whoever asked.
    const row = await update(tx, obligation, {
      invoiceId: invoice.id,
      draftBasis: basisOf(obligation),
      accountingCheckedAt: now,
      ...(obligation.readyAt ? {} : { readyAt: now, readyBy: actor }),
    });
    await addEvent(tx, row, 'drafted', actor, { invoiceId: invoice.id, totalCents: invoice.totalCents, live });
    return { obligation: row, invoice };
  });
  if (outcome.refused) {
    throw new FlowError('not_ready', 'the draft invoice was refused', { reasons: outcome.refused });
  }
  return outcome;
}

// One obligation with all its evidence and the reason for its state.
export async function explainObligation(db, organisationId, obligationId, options) {
  const obligation = await loadObligation(db, organisationId, obligationId);
  const scope = (table) => and(eq(table.organisationId, organisationId), eq(table.obligationId, obligationId));
  const [events, payments, writebacks] = await Promise.all([
    db.select().from(obligationEvents).where(scope(obligationEvents)).orderBy(asc(obligationEvents.createdAt)),
    db.select().from(obligationPayments).where(scope(obligationPayments)).orderBy(asc(obligationPayments.paidOn)),
    db.select().from(obligationWritebacks).where(scope(obligationWritebacks)).orderBy(asc(obligationWritebacks.createdAt)),
  ]);
  return { obligation, ...ledgerView(obligation, options), events, payments, writebacks };
}

export async function listObligations(db, organisationId, { view, ...options } = {}) {
  const rows = await db.select().from(billingObligations)
    .where(eq(billingObligations.organisationId, organisationId))
    .orderBy(desc(billingObligations.sourceSeenAt));
  const listed = rows.map((obligation) => ({ obligation, ...ledgerView(obligation, options) }));
  return view ? listed.filter((entry) => entry.view === view) : listed;
}
