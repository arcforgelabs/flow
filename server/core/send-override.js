import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { billingObligations, invoices, invoiceVersions, people, sendOverrides } from '../db/schema.js';
import { FlowError } from './errors.js';
import { recordOverrideEvent } from './ledger.js';

// Override (docs/INVOICE_SENDING.md, "Override"): an owner or admin sends one
// invoice although it has a warning. It goes straight through: no second
// step follows. This file holds what an override may pass and its record.
// The press itself is `sendAnyway` in sending.js.

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

export const OVERRIDE_NOTE_LIMIT = 200;

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

// Writes the record of one override, in the caller's transaction: the row
// and the event on the job. `invoice` is the
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
  const codes = [...new Set(recorded.map((p) => p.code))];
  const [job] = await tx.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, invoice.id)));
  if (job) {
    await recordOverrideEvent(tx, job, 'send.override', `person:${personId}`, {
      overrideId: override.id, invoiceId: invoice.id, version: invoice.issuedVersion, codes, reasonCode,
    });
  }
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

// The overrides of one invoice, newest first, for the invoice page.
export async function overridesOfInvoice(db, organisationId, invoiceId) {
  const rows = await db.select({ override: sendOverrides, personName: people.name }).from(sendOverrides)
    .leftJoin(people, eq(people.id, sendOverrides.personId))
    .where(and(eq(sendOverrides.organisationId, organisationId), eq(sendOverrides.invoiceId, invoiceId)))
    .orderBy(desc(sendOverrides.createdAt));
  return rows.map(({ override, personName }) => ({
    id: override.id, version: override.version, problems: override.problems,
    reasonCode: override.reasonCode, reason: OVERRIDE_REASONS[override.reasonCode] ?? override.reasonCode, note: override.note,
    person: { id: override.personId, name: personName ?? null }, createdAt: override.createdAt,
  }));
}
