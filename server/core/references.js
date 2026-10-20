import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { billingObligations, invoices } from '../db/schema.js';

// The invoice Reference (docs/INVOICING_RULES.md, "Reference"). The lab writes it as a
// rule in Invoice rules, from tokens: {practitioner} is the job's
// practitioner, {patient} the patient name the work system gives (only when
// its integration keeps patient names). Flow
// never puts a work system's ids in the Reference: the customer reads it.

export const REFERENCE_TOKENS = Object.freeze(['practitioner', 'patient']);
export const DEFAULT_REFERENCE = '{practitioner} - {patient}';
const TOKEN = /\{([a-z]+)\}/g;
const MAX = 255;

// The template's parts: text and tokens, in order.
function parts(template) {
  const out = [];
  let at = 0;
  for (const match of String(template ?? '').matchAll(TOKEN)) {
    out.push({ text: template.slice(at, match.index) }, { token: match[1] });
    at = match.index + match[0].length;
  }
  out.push({ text: String(template ?? '').slice(at) });
  return out;
}

// Unknown tokens are refused, so a typing error shows when it is saved.
export function checkReferenceTemplate(template) {
  const unknown = parts(template).filter((p) => p.token && !REFERENCE_TOKENS.includes(p.token)).map((p) => `{${p.token}}`);
  return unknown.length ? `unknown token ${unknown[0]}: use ${REFERENCE_TOKENS.map((t) => `{${t}}`).join(', ')}` : null;
}

// The Reference for some fields. Text between two tokens is a spacer: it
// shows only when the tokens on both sides have a value, so
// "{practitioner} - {patient}" with no patient is the practitioner alone.
// Text before the first token and after the last always shows. Null when no
// token has a value.
export function renderReference(template, fields) {
  const list = parts(template);
  let out = list[0].text;
  let filled = false;
  for (let i = 1; i < list.length; i += 2) {
    const value = String(fields[list[i].token] ?? '').trim().replace(/\s+/g, ' ');
    if (!value) continue;
    if (filled) out += list[i - 1].text;
    out += value;
    filled = true;
  }
  if (!filled) return null;
  return `${out}${list.at(-1).text}`.trim().slice(0, MAX) || null;
}

// The fields of one job. `work` is the work system adapter; it gives the
// patient name when it keeps one. With `read`, it may ask the work system for
// a name it has not read yet.
export async function jobReferenceFields(db, organisationId, obligation, { work = null, read = false } = {}) {
  let found = {};
  if (work?.id === obligation.sourceSystem && typeof work.capabilities.jobReferenceFields === 'function') {
    // A work system that cannot answer gives no name; the rule still works.
    found = (await work.capabilities.jobReferenceFields({ organisationId, sourceJobRef: obligation.sourceJobRef, read }).catch(() => null)) ?? {};
  }
  return { fields: { practitioner: obligation.practitioner, patient: found.patient ?? null }, asked: Boolean(found.asked) };
}

// The Reference of a new draft for a job. `template` is the organisation's
// rule (invoicing settings, referenceTemplate).
export async function jobReference(db, organisationId, obligation, { template, ...options }) {
  return renderReference(template, (await jobReferenceFields(db, organisationId, obligation, options)).fields);
}

// Drafts Flow made from a job keep the Reference the rule gives, as the rule
// or the job's fields change. A Reference a person typed is never changed:
// only one that is empty, a work system id (as earlier releases wrote), or
// the rule's own text without a field it now has, is updated. The status of
// the draft does not change. `reads` caps how many jobs may ask the work
// system for a name in one pass. Answers { updated }.
export async function refreshReferences(db, organisationId, { template, work = null, reads = 10 }) {
  const rows = await db.select({ obligation: billingObligations, invoiceId: invoices.id, reference: invoices.reference })
    .from(billingObligations)
    .innerJoin(invoices, eq(invoices.id, billingObligations.invoiceId))
    .where(and(eq(billingObligations.organisationId, organisationId), isNotNull(billingObligations.invoiceId), eq(invoices.status, 'draft')));
  let updated = 0;
  let asked = 0;
  for (const { obligation, invoiceId, reference } of rows) {
    const found = await jobReferenceFields(db, organisationId, obligation, { work, read: asked < reads });
    const { fields } = found;
    if (found.asked) asked += 1;
    const wanted = renderReference(template, fields);
    if ((wanted ?? null) === (reference ?? null)) continue;
    const ours = [null, '', obligation.caseRef, obligation.sourceJobRef,
      renderReference(template, { ...fields, patient: null }), renderReference(DEFAULT_REFERENCE, { ...fields, patient: null }),
      renderReference(DEFAULT_REFERENCE, fields)];
    if (!ours.includes(reference)) continue;
    await db.update(invoices).set({ reference: wanted })
      .where(and(eq(invoices.organisationId, organisationId), inArray(invoices.id, [invoiceId]), eq(invoices.status, 'draft')));
    updated += 1;
  }
  return { updated };
}
