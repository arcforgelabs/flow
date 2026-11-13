import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { billingObligations, contacts, invoices, invoiceVersions, people, reviewItems, sendOverrides } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { recordOverrideEvent } from './ledger.js';
import { openReview, resolveReview, resolveReviewFor } from './review.js';

// Override (docs/INVOICE_SENDING.md, "Override"): an owner or admin sends one
// invoice although it has a warning. This file holds what an override may
// pass, its record, and how its open item on Reconcile closes. The press
// itself is `sendAnyway` in sending.js.

// The warnings an override may pass. A code that is not here always blocks,
// and so does a code Flow does not know. A new code is one line and one test.
//
// xero_tax_differs: Xero takes the line. Flow sends its own tax on the line
// with the item code, reads the Xero invoice back and compares tax and total.
export const OVERRIDABLE = Object.freeze(['xero_tax_differs']);

// The pick list of the dialog. "Other" needs a note.
export const OVERRIDE_REASONS = Object.freeze({
  xero_item_wrong: 'Xero item is wrong',
  one_off: 'One-off for this invoice',
  client_tax: 'Client tax treatment',
  other: 'Other',
});

// Overrides one person may make in 24 hours. Counted from the records, so it
// holds across processes.
export const OVERRIDES_PER_DAY = 10;
export const OVERRIDE_NOTE_LIMIT = 200;
export const REVIEW_OVERRIDE = 'send.override';
const ENTITY = 'send_override';
const SYSTEM_ACTOR = 'system:send-override';

// One warning, named so that a tick belongs to one line: the adapter's key
// (`code:line:itemCode`), or the code for a problem with no line.
export const problemKey = (problem) => problem.key ?? problem.code;

// May an override pass these problems? Only when there is one, and each one
// is on the list.
export function overridable(problems) {
  return problems.length > 0 && problems.every((p) => OVERRIDABLE.includes(p.code));
}

// What the record keeps of one warning: its code, key and words then.
function kept(problem) {
  const { code, message, short, line, itemCode, flowTax, xeroTax } = problem;
  const out = { code, key: problemKey(problem), message };
  if (short) out.short = short;
  if (line != null) out.line = line;
  if (itemCode) out.itemCode = itemCode;
  if (flowTax) out.flowTax = flowTax;
  if (xeroTax) out.xeroTax = xeroTax;
  return out;
}

export function readReason(reasonCode, note) {
  if (!Object.hasOwn(OVERRIDE_REASONS, reasonCode ?? '')) {
    throw new FlowError('invalid', `reasonCode must be one of: ${Object.keys(OVERRIDE_REASONS).join(', ')}`);
  }
  if (note != null && typeof note !== 'string') throw new FlowError('invalid', 'note must be text');
  const text = note?.trim() || null;
  if (text && text.length > OVERRIDE_NOTE_LIMIT) throw new FlowError('invalid', `note must be ${OVERRIDE_NOTE_LIMIT} characters or fewer`);
  if (reasonCode === 'other' && !text) throw new FlowError('invalid', 'Give a note for the reason "Other".');
  return { reasonCode, note: text };
}

// The daily limit: refuses when the person made OVERRIDES_PER_DAY in the
// last 24 hours.
export async function assertUnderLimit(db, personId, now = new Date()) {
  const since = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000);
  const [{ count }] = await db.select({ count: sql`count(*)::int` }).from(sendOverrides)
    .where(and(eq(sendOverrides.personId, personId), gt(sendOverrides.createdAt, since)));
  if (count >= OVERRIDES_PER_DAY) {
    const error = new FlowError('override_limit', `You made ${OVERRIDES_PER_DAY} overrides in the last 24 hours. Correct the cause of the warning, or try again tomorrow.`);
    error.status = 429;
    throw error;
  }
}

// Writes the record of one override, in the caller's transaction: the row,
// the event on the job and the open item on Reconcile. `invoice` is the
// invoice as issued (its issuedVersion is the version this override allows).
export async function recordOverride(tx, organisationId, invoice, { problems, reasonCode, note, personId }) {
  const [version] = await tx.select({ document: invoiceVersions.document }).from(invoiceVersions)
    .where(and(eq(invoiceVersions.invoiceId, invoice.id), eq(invoiceVersions.version, invoice.issuedVersion)));
  if (!version) throw new FlowError('conflict', 'the issued version was not found');
  const document = version.document;
  // The hash of the document as the database holds it (jsonb gives one key order).
  const documentHash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
  const recorded = problems.map(kept);
  const [override] = await tx.insert(sendOverrides).values({
    organisationId, invoiceId: invoice.id, version: invoice.issuedVersion, documentHash, problems: recorded, reasonCode, note, personId,
  }).returning();
  const lines = new Set(recorded.map((p) => p.line).filter((line) => line != null));
  const moneyAtRiskCents = (document.lines ?? []).filter((l) => lines.has(l.position))
    .reduce((sum, l) => sum + Math.abs(l.lineAmountCents ?? 0), 0);
  const codes = [...new Set(recorded.map((p) => p.code))];
  const [job] = await tx.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, invoice.id)));
  if (job) {
    await recordOverrideEvent(tx, job, 'send.override', `person:${personId}`, {
      overrideId: override.id, invoiceId: invoice.id, version: invoice.issuedVersion, codes, reasonCode,
    });
  }
  // The evidence holds no note and no customer name (docs/INVOICE_SENDING.md).
  await openReview(tx, organisationId, {
    kind: REVIEW_OVERRIDE, entity: ENTITY, flowId: override.id, systems: ['flow', 'xero'], moneyAtRiskCents,
    evidence: {
      invoiceId: invoice.id, number: invoice.number, version: invoice.issuedVersion, documentHash,
      problems: recorded.map(({ message, ...rest }) => rest), reasonCode, personId, overriddenAt: override.createdAt,
    },
  });
  return override;
}

// The warnings a queued invoice's override passes: Map(invoiceId -> keys),
// for the invoices whose current version has an override.
export async function acceptedKeysFor(db, organisationId, invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const rows = await db.select({ invoiceId: sendOverrides.invoiceId, problems: sendOverrides.problems }).from(sendOverrides)
    .innerJoin(invoices, and(eq(invoices.id, sendOverrides.invoiceId), eq(invoices.issuedVersion, sendOverrides.version)))
    .where(and(eq(sendOverrides.organisationId, organisationId), inArray(sendOverrides.invoiceId, invoiceIds)));
  return new Map(rows.map((row) => [row.invoiceId, row.problems.map(problemKey)]));
}

const shown = (row) => ({
  id: row.override.id,
  invoiceId: row.override.invoiceId,
  version: row.override.version,
  documentHash: row.override.documentHash,
  problems: row.override.problems,
  reasonCode: row.override.reasonCode,
  reason: OVERRIDE_REASONS[row.override.reasonCode] ?? row.override.reasonCode,
  note: row.override.note,
  person: { id: row.override.personId, name: row.personName ?? null },
  createdAt: row.override.createdAt,
  invoice: row.invoice ? { ...row.invoice, clientName: row.clientName ?? null } : null,
  review: row.review ? {
    id: row.review.id, state: row.review.state, moneyAtRiskCents: row.review.moneyAtRiskCents,
    resolution: row.review.resolution, note: row.review.note, resolvedBy: row.review.resolvedBy, resolvedAt: row.review.resolvedAt,
  } : null,
});

function overrideRows(db, where) {
  return db.select({
    override: sendOverrides,
    personName: people.name,
    clientName: contacts.name,
    invoice: { id: invoices.id, number: invoices.number, status: invoices.status, issuedVersion: invoices.issuedVersion, totalCents: invoices.totalCents, reference: invoices.reference, contactId: invoices.contactId },
    review: reviewItems,
  }).from(sendOverrides)
    .innerJoin(invoices, eq(invoices.id, sendOverrides.invoiceId))
    .leftJoin(people, eq(people.id, sendOverrides.personId))
    .leftJoin(contacts, eq(contacts.id, invoices.contactId))
    .leftJoin(reviewItems, and(eq(reviewItems.organisationId, sendOverrides.organisationId), eq(reviewItems.kind, REVIEW_OVERRIDE), eq(reviewItems.entity, ENTITY), eq(reviewItems.flowId, sendOverrides.id)))
    .where(where)
    .orderBy(desc(sendOverrides.createdAt));
}

// The overrides for the Reconcile page: the open ones, or every one.
export async function listOverrides(db, organisationId, { state = 'open', limit = 200 } = {}) {
  const where = [eq(sendOverrides.organisationId, organisationId)];
  if (state === 'open') where.push(eq(reviewItems.state, 'open'));
  return (await overrideRows(db, and(...where)).limit(limit)).map(shown);
}

export async function getOverride(db, organisationId, overrideId) {
  const [row] = await overrideRows(db, and(eq(sendOverrides.organisationId, organisationId), eq(sendOverrides.id, overrideId))).limit(1);
  if (!row) throw notFound('override');
  return shown(row);
}

// The overrides of one invoice, newest first, for the invoice page.
export async function overridesOfInvoice(db, organisationId, invoiceId) {
  return (await overrideRows(db, and(eq(sendOverrides.organisationId, organisationId), eq(sendOverrides.invoiceId, invoiceId)))).map(shown);
}

async function closed(db, organisationId, override, resolution, actor) {
  const [job] = await db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, override.invoiceId)));
  if (job) await recordOverrideEvent(db, job, 'send.override.closed', actor, { overrideId: override.id, invoiceId: override.invoiceId, resolution });
}

// Recheck: closes the open item when its cause is gone. The invoice is void
// (`invoice_void`), a later version went with no override (`replaced`), or
// the accounting adapter's own check no longer finds the recorded warnings
// (`agrees`). That check reads Flow's copy of the accounting system: no call.
// Answers { closed, resolution } or { closed: false, reason }.
export async function recheckOverride(db, organisationId, overrideId, { accounting = null, actor = SYSTEM_ACTOR } = {}) {
  const override = await getOverride(db, organisationId, overrideId);
  if (override.review?.state !== 'open') return { closed: false, reason: 'not_open' };
  const close = async (resolution) => {
    const row = await resolveReviewFor(db, organisationId, { kind: REVIEW_OVERRIDE, entity: ENTITY, flowId: override.id, resolution, actor });
    if (row) await closed(db, organisationId, override, resolution, actor);
    return { closed: Boolean(row), resolution };
  };
  const { invoice } = override;
  if (invoice.status === 'void') return close('invoice_void');
  // Open for revision: the new version decides when it goes.
  if (invoice.status === 'draft') return { closed: false, reason: 'revising' };
  if (invoice.issuedVersion > override.version) {
    const [newer] = await db.select({ id: sendOverrides.id }).from(sendOverrides)
      .where(and(eq(sendOverrides.invoiceId, invoice.id), eq(sendOverrides.version, invoice.issuedVersion)));
    return newer ? close('replaced_by_override') : close('replaced');
  }
  const found = await accounting?.capabilities?.checkDrafts?.({ organisationId, invoiceIds: [invoice.id] });
  if (!found) return { closed: false, reason: 'accounting_not_connected' };
  const now = new Set((found.get(invoice.id) ?? []).map(problemKey));
  if (override.problems.some((p) => now.has(problemKey(p)))) return { closed: false, reason: 'still_differs' };
  return close('agrees');
}

// The daily pass and the void path: every open override, checked again.
export async function recheckOpenOverrides(db, organisationId, { accounting = null, invoiceId = null } = {}) {
  const open = (await listOverrides(db, organisationId, { state: 'open' })).filter((o) => !invoiceId || o.invoiceId === invoiceId);
  let closedCount = 0;
  for (const override of open) {
    if ((await recheckOverride(db, organisationId, override.id, { accounting })).closed) closedCount += 1;
  }
  return { open: open.length - closedCount, closed: closedCount };
}

// Accept: an owner or admin accepts the difference, with a note.
export async function acceptOverride(db, organisationId, overrideId, { personId, note }) {
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text) throw new FlowError('invalid', 'Give a note to accept an override.');
  if (text.length > OVERRIDE_NOTE_LIMIT) throw new FlowError('invalid', `note must be ${OVERRIDE_NOTE_LIMIT} characters or fewer`);
  const override = await getOverride(db, organisationId, overrideId);
  if (!override.review) throw notFound('review item');
  const actor = `person:${personId}`;
  await resolveReview(db, organisationId, override.review.id, { resolution: 'accepted', note: text, actor });
  await closed(db, organisationId, override, 'accepted', actor);
  return getOverride(db, organisationId, overrideId);
}
