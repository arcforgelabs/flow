import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  billingObligations, obligationEvents, obligationPayments, obligationWritebacks, priceItems,
} from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { createDraftInvoice } from './invoices.js';
import { invoiceTotals, lineTotals } from './money.js';

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
    normalised.push({ itemCode, priceItemId, description, quantity, unitAmountCents, taxCode, ...totals });
  }
  return normalised;
}

function fingerprint(lines) {
  const keys = lines
    .map((l) => [l.itemCode ?? l.description.toLowerCase(), l.quantity, l.unitAmountCents, l.taxCode])
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
      mappingComplete: lines.every((l) => l.priceItemId),
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
      return update(tx, existing, {
        sourceSeenAt: seenAt, mappingComplete: facts.mappingComplete, lines, jobDate: facts.jobDate, sourceStatus: facts.sourceStatus,
      });
    }
    const fields = { ...facts, sourceSeenAt: seenAt };
    if (existing.invoiceId && changed.some((key) => ['lineFingerprint', 'totalCents', 'contactId'].includes(key))) {
      fields.holdState = 'review';
      fields.holdReason = 'the job changed after its invoice was made';
    }
    const row = await update(tx, existing, fields);
    await addEvent(tx, row, 'source_changed', actor, {
      changed,
      before: { lineFingerprint: existing.lineFingerprint, totalCents: existing.totalCents },
      after: { lineFingerprint: row.lineFingerprint, totalCents: row.totalCents },
      ...(fields.holdState ? { holdReason: fields.holdReason } : {}),
    });
    return row;
  });
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
  liveCheck, actor, now = new Date(), sourceMaxAgeMs = SOURCE_MAX_AGE_MS, dueDate = null,
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
      reference: obligation.caseRef ?? obligation.sourceJobRef,
      dueDate,
      lines: obligation.lines.map(({ priceItemId, description, quantity, unitAmountCents, taxCode }) => (
        { priceItemId, description, quantity, unitAmountCents, taxCode }
      )),
    });
    // Drafting the invoice says the job is ready, whoever asked.
    const row = await update(tx, obligation, {
      invoiceId: invoice.id, accountingCheckedAt: now, ...(obligation.readyAt ? {} : { readyAt: now, readyBy: actor }),
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
