import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  billingObligations, contacts, customerBillingSettings, invoiceRules, invoices, invoicingSettings, obligationEvents,
} from '../db/schema.js';
import { FlowError, notFound } from './errors.js';

// Invoice rules (docs/INVOICE_RULES.md): a lab's own checks on a job before
// Flow drafts its invoice. Each rule is When, If and Then, and a lab owner
// builds it from menus, so no lab's checks are fixed in Flow's code.
//
//   When  job_ready: the job is ready to invoice and has no invoice yet.
//   If    every condition matches: a field of the job, its customer or its
//         lines, a test, and a value.
//   Then  wait: the job waits for a person; skip: rules never draft it;
//         pending: Flow drafts it, and the draft is Pending with the rule's
//         note, which says what to fix (for example a Reference with no
//         real practitioner); non_chargeable: Flow drafts it with status
//         non_chargeable (lines and prices as a normal draft, no number,
//         never sent). An existing never-issued draft moves there too.
//
// The rules read only Flow's own records, so they work with or without an
// accounting integration. The earlier fixed settings (old job limit, required
// practitioner, rush share) become starter rules, once per organisation.

const MAX_RULES = 100;
const MAX_CONDITIONS = 10;
const invalid = (message) => new FlowError('invalid', message);

const MAX_NOTE = 200;
const day = (date) => new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
const norm = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
// A line's key: its price item code, else the label line mapping gave it (a
// line booked to an account, such as a surcharge, has no code).
const code = (line) => norm(line.itemCode || line.label);
const cents = (lines) => lines.reduce((sum, l) => sum + (l.lineAmountCents ?? 0), 0);

// The share of the item's lines in the job's other lines, as the charged and
// the expected cents for `percent`.
function share(lines, item, percent) {
  const own = lines.filter((l) => code(l) === norm(item));
  if (!own.length) return null;
  const others = cents(lines.filter((l) => code(l) !== norm(item)));
  return { charged: cents(own), others, expected: Math.round((others * percent) / 100) };
}

// Each field: what it reads from a job, its kind, and the tests it allows.
export const FIELDS = Object.freeze({
  job_age_days: { label: 'Job age (days)', kind: 'number', read: (j, { now }) => (j.jobDate ? Math.floor((now - day(j.jobDate)) / 86_400_000) : null) },
  job_total: { label: 'Job total', kind: 'money', read: (j) => (j.totalCents ?? 0) / 100 },
  job_status: { label: 'Job status', kind: 'choice', options: 'statuses', read: (j) => norm(j.sourceStatus) || null },
  practitioner: { label: 'Practitioner', kind: 'text', options: 'practitioners', read: (j, { customer }) => j.practitioner || customer.defaultPractitioner || null },
  // Only a draft has a Reference, so only a pending rule may read it.
  reference: { label: 'Reference', kind: 'text', draftOnly: true, read: (j) => j.reference || null },
  // Menu tests read the contact id. Contains and does not contain read the
  // customer's name (matches): a lab can exclude every name that contains
  // one marker, so a new branch needs no new rule.
  customer: {
    label: 'Customer', kind: 'choice', options: 'customers',
    tests: ['is', 'is_not', 'is_one_of', 'contains', 'does_not_contain', 'is_empty'],
    read: (j) => j.contactId,
  },
  customer_billable: { label: 'Customer is billable', kind: 'boolean', read: (j, { customer }) => customer.billable !== false },
  line_item: { label: 'Line item', kind: 'items', options: 'items', read: (j) => (j.lines ?? []).flatMap((l) => [norm(l.itemCode), norm(l.label)].filter(Boolean)) },
  line_share: { label: 'Line share of other lines (%)', kind: 'share', options: 'items', read: (j) => j.lines ?? [] },
});

export const TESTS = Object.freeze({
  number: ['more_than', 'at_most', 'is', 'is_not', 'is_empty'],
  money: ['more_than', 'at_most', 'is', 'is_not'],
  choice: ['is', 'is_not', 'is_one_of', 'is_empty'],
  text: ['is', 'is_not', 'is_one_of', 'is_not_one_of', 'contains', 'does_not_contain', 'starts_with', 'does_not_start_with', 'has_number', 'number_in_words', 'one_word', 'is_empty', 'is_not_empty'],
  boolean: ['is'],
  items: ['has', 'has_not'],
  share: ['is', 'is_not'],
});

export const ACTIONS = Object.freeze(['wait', 'skip', 'pending', 'non_chargeable']);
// Send, Send all ready and Approve say this. The invoice stays as it is.
export const NON_CHARGEABLE_REFUSAL = 'This invoice is non-chargeable. Make it chargeable first.';
// Tests that take no value.
const NO_VALUE = new Set(['is_empty', 'is_not_empty', 'has_number', 'number_in_words', 'one_word']);

function readCondition(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`condition ${index + 1} must be an object`);
  const field = FIELDS[raw.field];
  if (!field) throw invalid(`condition ${index + 1}: unknown field ${raw.field}`);
  const allowed = field.tests ?? TESTS[field.kind];
  if (!allowed.includes(raw.test)) throw invalid(`condition ${index + 1}: ${field.label} takes ${allowed.join(', ')}`);
  const out = { field: raw.field, test: raw.test };
  if (NO_VALUE.has(raw.test)) return out;
  const { value } = raw;
  if (field.kind === 'boolean') {
    if (typeof value !== 'boolean') throw invalid(`condition ${index + 1}: the value must be true or false`);
  } else if (['number', 'money', 'share'].includes(field.kind)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) throw invalid(`condition ${index + 1}: the value must be a number`);
  } else if (['is_one_of', 'is_not_one_of'].includes(raw.test)) {
    if (!Array.isArray(value) || !value.length || value.length > 50 || value.some((v) => typeof v !== 'string' || !v.trim() || v.length > 200)) {
      throw invalid(`condition ${index + 1}: pick 1 to 50 values`);
    }
  } else if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw invalid(`condition ${index + 1}: the value must be short text`);
  }
  out.value = typeof value === 'string' ? value.trim() : value;
  if (field.kind === 'share') {
    if (typeof raw.item !== 'string' || !raw.item.trim() || raw.item.length > 100) throw invalid(`condition ${index + 1}: pick the line item`);
    out.item = raw.item.trim();
  }
  return out;
}

export function readRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('the rule must be an object');
  const unknown = Object.keys(raw).filter((k) => !['name', 'enabled', 'conditions', 'action'].includes(k));
  if (unknown.length) throw invalid(`unknown field: ${unknown[0]}`);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 120) throw invalid('the rule needs a name of 120 characters at most');
  const enabled = raw.enabled ?? true;
  if (typeof enabled !== 'boolean') throw invalid('enabled must be true or false');
  if (!Array.isArray(raw.conditions) || !raw.conditions.length || raw.conditions.length > MAX_CONDITIONS) {
    throw invalid(`the rule needs 1 to ${MAX_CONDITIONS} conditions`);
  }
  if (!ACTIONS.includes(raw.action?.kind)) throw invalid(`the action must be one of ${ACTIONS.join(', ')}`);
  const conditions = raw.conditions.map(readCondition);
  const action = { kind: raw.action.kind };
  if (action.kind === 'pending') {
    const note = typeof raw.action.note === 'string' ? raw.action.note.trim() : '';
    if (!note || note.length > MAX_NOTE) throw invalid(`a pending rule needs a note of ${MAX_NOTE} characters at most: what a person must fix`);
    action.note = note;
  } else {
    const early = conditions.find((c) => FIELDS[c.field].draftOnly);
    if (early) throw invalid(`${FIELDS[early.field].label} is on the draft only: use Then "Pending, with a note"`);
  }
  return { name, enabled, conditions, action };
}

function matches(condition, job, context) {
  const field = FIELDS[condition.field];
  const have = field.read(job, context);
  const { test, value } = condition;
  if (test === 'is_empty') return have === null || have === '' || have === undefined;
  if (test === 'is_not_empty') return !(have === null || have === '' || have === undefined);
  // Customer contains reads the contact's name, in any case and with the
  // spaces trimmed, the same way a practitioner's name is read. is, is not
  // and is one of still compare the contact id. `customer.name` is that name.
  const named = condition.field === 'customer' && (test === 'contains' || test === 'does_not_contain');
  if ((field.kind === 'text' || named) && !['is', 'is_not', 'is_one_of'].includes(test)) {
    // An empty text matches no test that reads its words; is_empty finds it.
    const left = norm(named ? (context.customer?.name ?? job.customerName ?? null) : have);
    if (!left) return false;
    if (test === 'is_not_one_of') return !value.some((v) => norm(v) === left);
    if (test === 'has_number') return /\d/.test(left);
    // A part (between " - ") that is only a number is a client's reference,
    // such as a patient number, so only a number beside words matches.
    if (test === 'number_in_words') return left.split(' - ').some((part) => /\d/.test(part) && /\p{L}/u.test(part));
    if (test === 'one_word') return !left.includes(' ');
    if (test === 'contains') return left.includes(norm(value));
    if (test === 'does_not_contain') return !left.includes(norm(value));
    if (test === 'starts_with') return left.startsWith(norm(value));
    if (test === 'does_not_start_with') return !left.startsWith(norm(value));
  }
  switch (field.kind) {
    case 'items': {
      const found = have.includes(norm(value));
      return test === 'has' ? found : !found;
    }
    case 'share': {
      const s = share(have, condition.item, value);
      if (!s) return false;
      const right = Math.abs(s.charged - s.expected) <= 1;
      return test === 'is' ? right : !right;
    }
    case 'number':
    case 'money':
      if (have === null) return false;
      if (test === 'more_than') return have > value;
      if (test === 'at_most') return have <= value;
      if (test === 'is') return have === value;
      return have !== value;
    case 'boolean':
      return have === value;
    default: {
      const left = norm(have);
      if (test === 'is_one_of') return value.some((v) => norm(v) === left);
      return test === 'is' ? left === norm(value) : left !== norm(value);
    }
  }
}

// The reasons the enabled rules give for one job, in rule order. An empty list
// means no rule stops its draft. `customer` is the customer's own billing
// settings (invoicing-rules.js).
export function ruleReasons(rules, job, { customer = {}, now = new Date() } = {}) {
  const context = { customer, now };
  const reasons = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger !== 'job_ready' || rule.action.kind === 'pending' || rule.action.kind === 'non_chargeable') continue;
    if (!rule.conditions.every((c) => matches(c, job, context))) continue;
    reasons.push(rule.action.kind === 'skip' ? `rule "${rule.name}": not drafted by rule` : `rule "${rule.name}": waits for a person`);
  }
  return reasons;
}

// The notes of the enabled pending rules that match one draft, as problems:
// they put the draft on Pending (sending.js). `job` is the draft's job with
// `reference`, the draft's Reference. A pending rule never stops a draft.
// `fields` names the fields the rule reads, so the invoice page marks the
// one to fix (the Reference box goes red).
export function rulePending(rules, job, { customer = {}, now = new Date() } = {}) {
  const context = { customer, now };
  return rules
    .filter((r) => r.enabled && r.trigger === 'job_ready' && r.action.kind === 'pending')
    .filter((r) => r.conditions.every((c) => matches(c, job, context)))
    .map((r) => ({ code: 'rule', message: r.action.note, short: r.name.slice(0, 40), rule: r.id ?? null, fields: [...new Set(r.conditions.map((c) => c.field))] }));
}

// Enabled non-chargeable rules that match one job. The draft is made on the
// normal path; only its status differs (settleNonChargeable). A pending or
// skip rule does not apply here.
export function ruleNonChargeable(rules, job, { customer = {}, now = new Date() } = {}) {
  const context = { customer, now };
  return rules
    .filter((r) => r.enabled && r.trigger === 'job_ready' && r.action.kind === 'non_chargeable')
    .filter((r) => r.conditions.every((c) => matches(c, job, context)));
}

// The job facts "Make chargeable" remembers. The rule moves the invoice
// again only when one of these changes.
export function chargeableStamp(obligation) {
  return {
    lineFingerprint: obligation.lineFingerprint,
    contactId: obligation.contactId ?? null,
    practitioner: obligation.practitioner ?? null,
    sourceStatus: obligation.sourceStatus ?? null,
    totalCents: obligation.totalCents,
    jobDate: obligation.jobDate ?? null,
  };
}

// Field by field: jsonb does not keep key order, so a string compare of the
// whole object would miss a stamp Flow itself wrote.
const sameStamp = (stamp, obligation) => {
  if (!stamp || typeof stamp !== 'object') return false;
  const current = chargeableStamp(obligation);
  const dayKey = (value) => (value == null || value === '' ? '' : String(value).slice(0, 10));
  return stamp.lineFingerprint === current.lineFingerprint
    && (stamp.contactId ?? null) === current.contactId
    && (stamp.practitioner ?? null) === current.practitioner
    && (stamp.sourceStatus ?? null) === current.sourceStatus
    && Number(stamp.totalCents) === Number(current.totalCents)
    && dayKey(stamp.jobDate) === dayKey(current.jobDate);
};

async function customerOf(db, organisationId, contactId, name = null) {
  if (!contactId) return { billable: true, name };
  const [billing] = await db.select({
    billable: customerBillingSettings.billable,
    defaultPractitioner: customerBillingSettings.defaultPractitioner,
  }).from(customerBillingSettings).where(and(
    eq(customerBillingSettings.organisationId, organisationId),
    eq(customerBillingSettings.contactId, contactId),
  ));
  let customerName = name;
  if (customerName === null) {
    const [contact] = await db.select({ name: contacts.name }).from(contacts).where(and(
      eq(contacts.organisationId, organisationId),
      eq(contacts.id, contactId),
    ));
    customerName = contact?.name ?? null;
  }
  return {
    billable: billing ? billing.billable !== false : true,
    defaultPractitioner: billing?.defaultPractitioner ?? null,
    name: customerName,
  };
}

// The latest "Make chargeable" for this invoice still matches the job.
async function keptChargeable(db, obligation, invoiceId) {
  const [event] = await db.select({ evidence: obligationEvents.evidence }).from(obligationEvents).where(and(
    eq(obligationEvents.organisationId, obligation.organisationId),
    eq(obligationEvents.obligationId, obligation.id),
    eq(obligationEvents.kind, 'made_chargeable'),
  )).orderBy(desc(obligationEvents.createdAt)).limit(1);
  if (!event || event.evidence?.invoiceId !== invoiceId) return false;
  return sameStamp(event.evidence.stamp, obligation);
}

async function priorAccountingState(db, organisationId, obligationId) {
  const [event] = await db.select({ evidence: obligationEvents.evidence }).from(obligationEvents).where(and(
    eq(obligationEvents.organisationId, organisationId),
    eq(obligationEvents.obligationId, obligationId),
    eq(obligationEvents.kind, 'non_chargeable'),
  )).orderBy(desc(obligationEvents.createdAt)).limit(1);
  const prior = event?.evidence?.priorAccountingState;
  return typeof prior === 'string' && prior !== 'non_chargeable' ? prior : 'not_found';
}

// The accounting state before this invoice was non-chargeable, so a delete
// or "Make chargeable" leaves the job able to draft again.
export async function accountingStateBeforeNonChargeable(db, organisationId, obligationId) {
  return priorAccountingState(db, organisationId, obligationId);
}

async function markNonChargeable(tx, organisationId, { invoice, obligation, actor }) {
  const prior = obligation.accountingState === 'non_chargeable'
    ? await priorAccountingState(tx, organisationId, obligation.id)
    : obligation.accountingState;
  await tx.update(invoices).set({
    status: 'non_chargeable', readyAt: null, readyBy: null, sendState: null, sendError: null, updatedAt: sql`now()`,
  }).where(eq(invoices.id, invoice.id));
  await tx.update(billingObligations).set({ accountingState: 'non_chargeable', updatedAt: sql`now()` })
    .where(eq(billingObligations.id, obligation.id));
  await tx.insert(obligationEvents).values({
    createdAt: sql`clock_timestamp()`,
    organisationId,
    obligationId: obligation.id,
    kind: 'non_chargeable',
    actor,
    evidence: { invoiceId: invoice.id, priorAccountingState: prior },
  });
}

// After the normal draft: a matching non-chargeable rule sets the status and
// the obligation's accounting state. `rules` is the organisation's list.
// Returns the invoice and obligation when it moved them, else null.
export async function settleNonChargeable(tx, organisationId, {
  invoice, obligation, rules, actor, now = new Date(),
}) {
  if (!ruleNonChargeable(rules, { ...obligation, reference: invoice.reference ?? null }, {
    customer: await customerOf(tx, organisationId, obligation.contactId), now,
  }).length) return null;
  if (await keptChargeable(tx, obligation, invoice.id)) return null;
  await markNonChargeable(tx, organisationId, { invoice, obligation, actor });
  const [freshInvoice] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id));
  const [freshObligation] = await tx.select().from(billingObligations).where(eq(billingObligations.id, obligation.id));
  return { invoice: freshInvoice, obligation: freshObligation };
}

// Never-issued drafts a non-chargeable rule matches move off Pending and
// Ready. A person who pressed Make chargeable stays a draft until the job
// changes. On save of such a rule, and at each check run (invoiceViews).
export async function moveNonChargeableDrafts(db, organisationId, { actor = 'system:invoice-rules', now = new Date() } = {}) {
  const applicable = (await listRules(db, organisationId)).filter((r) => r.enabled && r.action.kind === 'non_chargeable');
  if (!applicable.length) return { moved: 0 };
  const rows = await db.select({
    invoice: invoices,
    obligation: billingObligations,
    customerName: contacts.name,
  }).from(invoices)
    .innerJoin(billingObligations, and(
      eq(billingObligations.organisationId, invoices.organisationId),
      eq(billingObligations.invoiceId, invoices.id),
    ))
    .leftJoin(contacts, and(
      eq(contacts.organisationId, invoices.organisationId),
      eq(contacts.id, billingObligations.contactId),
    ))
    .where(and(
      eq(invoices.organisationId, organisationId),
      eq(invoices.status, 'draft'),
      eq(invoices.issuedVersion, 0),
      isNull(invoices.sendState),
    ));
  let moved = 0;
  for (const { invoice, obligation, customerName } of rows) {
    const customer = await customerOf(db, organisationId, obligation.contactId, customerName);
    if (!ruleNonChargeable(applicable, { ...obligation, reference: invoice.reference }, { customer, now }).length) continue;
    if (await keptChargeable(db, obligation, invoice.id)) continue;
    const did = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(invoices).where(and(
        eq(invoices.organisationId, organisationId), eq(invoices.id, invoice.id),
      )).for('update');
      if (!current || current.status !== 'draft' || current.issuedVersion !== 0 || current.sendState) return false;
      const [locked] = await tx.select().from(billingObligations).where(eq(billingObligations.id, obligation.id)).for('update');
      if (!locked || locked.invoiceId !== invoice.id) return false;
      if (await keptChargeable(tx, locked, invoice.id)) return false;
      await markNonChargeable(tx, organisationId, { invoice: current, obligation: locked, actor });
      return true;
    });
    if (did) moved += 1;
  }
  return { moved };
}

// A person says the rule was wrong. The invoice is a draft again, and the
// rule leaves it there until the job changes.
export async function makeChargeable(db, organisationId, invoiceId, { actor }) {
  if (!actor) throw new FlowError('invalid', 'actor is required');
  return db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(and(
      eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId),
    )).for('update');
    if (!invoice) throw notFound('invoice');
    if (invoice.status !== 'non_chargeable') {
      throw new FlowError('not_non_chargeable', 'Only a non-chargeable invoice can be made chargeable.');
    }
    const [obligation] = await tx.select().from(billingObligations).where(and(
      eq(billingObligations.organisationId, organisationId),
      eq(billingObligations.invoiceId, invoice.id),
    )).for('update');
    const [row] = await tx.update(invoices).set({
      status: 'draft', readyAt: null, readyBy: null, updatedAt: sql`now()`,
    }).where(eq(invoices.id, invoice.id)).returning();
    if (obligation) {
      const accountingState = await priorAccountingState(tx, organisationId, obligation.id);
      await tx.update(billingObligations).set({ accountingState, updatedAt: sql`now()` })
        .where(eq(billingObligations.id, obligation.id));
      await tx.insert(obligationEvents).values({
        createdAt: sql`clock_timestamp()`,
        organisationId,
        obligationId: obligation.id,
        kind: 'made_chargeable',
        actor,
        evidence: { invoiceId: invoice.id, stamp: chargeableStamp(obligation) },
      });
    }
    return row;
  });
}

// Drafts an enabled skip rule matches stay on Pending at Send (sending.js).
// A person drafted the job by hand, or the rule was made after the draft.
// The list shows the rule's name. The note says to void the draft or change
// the rule. A wait rule does not hold a draft: a person may still send one.
export function ruleSkip(rules, job, { customer = {}, now = new Date() } = {}) {
  const context = { customer, now };
  return rules
    .filter((r) => r.enabled && r.trigger === 'job_ready' && r.action.kind === 'skip')
    .filter((r) => r.conditions.every((c) => matches(c, job, context)))
    .map((r) => ({
      code: 'rule',
      message: `Rule "${r.name}": not invoiced. Void this draft or change the rule.`,
      short: r.name.slice(0, 40),
      rule: r.id ?? null,
      fields: [...new Set(r.conditions.map((c) => c.field))],
    }));
}

// The starter rules made from the earlier fixed settings.
export function starterRules(settings) {
  const rules = [
    { starterKey: 'not_billable', name: 'Customer not billable', enabled: true, conditions: [{ field: 'customer_billable', test: 'is', value: false }], action: { kind: 'skip' } },
    { starterKey: 'zero_total', name: 'No amount', enabled: true, conditions: [{ field: 'job_total', test: 'at_most', value: 0 }], action: { kind: 'wait' } },
    { starterKey: 'old_job', name: 'Old job', enabled: true, conditions: [{ field: 'job_age_days', test: 'more_than', value: settings.staleDays ?? 90 }], action: { kind: 'wait' } },
    { starterKey: 'practitioner', name: 'Practitioner required', enabled: Boolean(settings.requirePractitioner), conditions: [{ field: 'practitioner', test: 'is_empty' }], action: { kind: 'wait' } },
  ];
  if (settings.rushItemCode) {
    rules.push({
      starterKey: 'rush_share', name: 'Rush charge share', enabled: true,
      conditions: [{ field: 'line_share', item: settings.rushItemCode, test: 'is_not', value: settings.rushPercent ?? 20 }],
      action: { kind: 'wait' },
    });
  }
  return rules.map((r) => ({ trigger: 'job_ready', ...r }));
}

// Makes this organisation's starter rules once, from its fixed settings.
async function seed(db, organisationId) {
  await db.transaction(async (tx) => {
    await tx.insert(invoicingSettings).values({ organisationId }).onConflictDoNothing();
    const [settings] = await tx.select().from(invoicingSettings).where(eq(invoicingSettings.organisationId, organisationId)).for('update');
    if (settings.rulesSeeded) return;
    const rules = starterRules(settings);
    await tx.insert(invoiceRules).values(rules.map((r, position) => ({ organisationId, position, ...r }))).onConflictDoNothing();
    await tx.update(invoicingSettings).set({ rulesSeeded: true }).where(eq(invoicingSettings.organisationId, organisationId));
  });
}

const shape = (r) => ({
  id: r.id, name: r.name, position: r.position, enabled: r.enabled, trigger: r.trigger,
  conditions: r.conditions, action: r.action, starter: Boolean(r.starterKey), updatedAt: r.updatedAt,
});

// The organisation's rules, in order, without making starter rules. Drafting
// reads this so a draft does not seed rules as a side effect.
export async function readStoredRules(db, organisationId) {
  const rows = await db.select().from(invoiceRules).where(eq(invoiceRules.organisationId, organisationId))
    .orderBy(asc(invoiceRules.position), asc(invoiceRules.createdAt));
  return rows.map(shape);
}

// The organisation's rules, in order. The first read makes the starter rules.
export async function listRules(db, organisationId) {
  const [settings] = await db.select({ seeded: invoicingSettings.rulesSeeded }).from(invoicingSettings)
    .where(eq(invoicingSettings.organisationId, organisationId));
  if (!settings?.seeded) await seed(db, organisationId);
  return readStoredRules(db, organisationId);
}

export async function createRule(db, organisationId, raw, { personId = null } = {}) {
  const rule = readRule(raw);
  const existing = await listRules(db, organisationId);
  if (existing.length >= MAX_RULES) throw invalid(`an organisation can have ${MAX_RULES} rules at most`);
  const position = existing.length ? Math.max(...existing.map((r) => r.position)) + 1 : 0;
  const [row] = await db.insert(invoiceRules).values({ organisationId, position, ...rule, updatedBy: personId }).returning();
  if (rule.enabled && rule.action.kind === 'non_chargeable') {
    await moveNonChargeableDrafts(db, organisationId, { actor: personId ? `person:${personId}` : 'system:invoice-rules' });
  }
  return shape(row);
}

async function loadRule(db, organisationId, ruleId) {
  const [row] = await db.select().from(invoiceRules).where(and(eq(invoiceRules.organisationId, organisationId), eq(invoiceRules.id, ruleId)));
  if (!row) throw notFound('rule');
  return row;
}

// Changes a rule. `changes` holds any of name, enabled, conditions, action;
// the result must be a whole valid rule.
export async function updateRule(db, organisationId, ruleId, changes, { personId = null } = {}) {
  const row = await loadRule(db, organisationId, ruleId);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('the change must be an object');
  const rule = readRule({ name: row.name, enabled: row.enabled, conditions: row.conditions, action: row.action, ...changes });
  const [saved] = await db.update(invoiceRules).set({ ...rule, updatedBy: personId, updatedAt: sql`now()` })
    .where(eq(invoiceRules.id, row.id)).returning();
  if (rule.enabled && rule.action.kind === 'non_chargeable') {
    await moveNonChargeableDrafts(db, organisationId, { actor: personId ? `person:${personId}` : 'system:invoice-rules' });
  }
  return shape(saved);
}

export async function deleteRule(db, organisationId, ruleId) {
  const row = await loadRule(db, organisationId, ruleId);
  await db.delete(invoiceRules).where(eq(invoiceRules.id, row.id));
}
