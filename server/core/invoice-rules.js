import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { billingObligations, contacts, invoiceRuleExceptions, invoiceRules, invoicingSettings, obligationEvents, priceItems } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { getInvoice, updateDraftInvoice } from './invoices.js';

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
//         real practitioner); non_chargeable: Flow drafts it and keeps it on
//         the Non-chargeable tab. The work is done but never billed (Xero's
//         word for such work), so the draft is never sent. Its value stays
//         in Flow, for the lab's output.
//
// The rules read only Flow's own records, so they work with or without an
// accounting integration. The earlier fixed settings (old job limit, required
// practitioner, rush share) become starter rules, once per organisation.

const MAX_RULES = 100;
const MAX_CONDITIONS = 10;
const invalid = (message) => new FlowError('invalid', message);

const MAX_NOTE = 200;
// A rule's own icon: any Lucide name (the icon picker, server/ui/kit.js).
// Null shows the mark of what the rule does.
const ICON_DIR = join(dirname(createRequire(import.meta.url).resolve('lucide-static/package.json')), 'icons');
const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
    tests: ['is', 'is_not', 'is_one_of', 'is_not_one_of', 'contains', 'does_not_contain', 'is_empty'],
    read: (j) => j.contactId,
  },
  customer_billable: { label: 'Customer is billable', kind: 'boolean', read: (j, { customer }) => customer.billable !== false },
  // The work system marks the job a remake (Seazona's remake flag).
  remake: { label: 'Remake', kind: 'boolean', read: (j) => j.remake === true },
  line_item: { label: 'Line item', kind: 'items', options: 'items', read: (j) => (j.lines ?? []).flatMap((l) => [norm(l.itemCode), norm(l.label)].filter(Boolean)) },
  line_share: { label: 'Line share of other lines (%)', kind: 'share', options: 'items', read: (j) => j.lines ?? [] },
  // Each line with a price item sends as an item of the accounting system
  // (Xero: a linked item that sells, else the item with the same code). A
  // line booked to an account has no item, so it does not count. `items` is
  // the Flow codes that send (accountingItemsFor). It is null when no
  // accounting system is on or its list was never read: then the field has
  // no value and no rule on it matches.
  accounting_item: {
    label: 'Every item is in accounting', kind: 'boolean', accounting: true,
    read: (j, { items }) => (items ? !missingItems(j, items).length : null),
    detail: (j, { items }) => (items && missingItems(j, items).length ? `not in accounting: ${missingItems(j, items).join(', ')}` : null),
  },
});

// The codes on a job's lines that do not send as an accounting item.
function missingItems(job, items) {
  return [...new Set((job.lines ?? []).map((l) => l.itemCode).filter((c) => c && !items.has(c)))];
}

// The Flow codes that send as an item in the accounting system, for the rules
// that read `accounting_item`. Null when no enabled rule reads it, or when no
// accounting system answers (not connected, or its list was never read).
// `jobs` are the jobs the rules will read, so one call serves a whole run.
export async function accountingItemsFor(accounting, organisationId, rules, jobs) {
  if (typeof accounting?.capabilities?.itemMatches !== 'function') return null;
  if (!rules.some((r) => r.enabled && r.conditions.some((c) => FIELDS[c.field]?.accounting))) return null;
  const codes = [...new Set(jobs.flatMap((j) => (j.lines ?? []).map((l) => l.itemCode).filter(Boolean)))];
  const matched = await accounting.capabilities.itemMatches({ organisationId, codes });
  return matched ? new Set(matched) : null;
}

// What a matched rule's fields say about this job, such as the codes not in
// accounting, so the note names the line to fix.
function detailOf(rule, job, context) {
  const parts = [...new Set(rule.conditions.map((c) => FIELDS[c.field].detail?.(job, context)).filter(Boolean))];
  return parts.length ? ` (${parts.join('; ')})` : '';
}

export const TESTS = Object.freeze({
  number: ['more_than', 'at_most', 'is', 'is_not', 'is_empty'],
  money: ['more_than', 'at_most', 'is', 'is_not'],
  choice: ['is', 'is_not', 'is_one_of', 'is_not_one_of', 'is_empty'],
  text: ['is', 'is_not', 'is_one_of', 'is_not_one_of', 'contains', 'does_not_contain', 'starts_with', 'does_not_start_with', 'has_number', 'number_in_words', 'one_word', 'is_empty', 'is_not_empty'],
  boolean: ['is'],
  items: ['has', 'has_not'],
  share: ['is', 'is_not'],
});

export const ACTIONS = Object.freeze(['wait', 'skip', 'pending', 'non_chargeable']);
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
  const unknown = Object.keys(raw).filter((k) => !['name', 'icon', 'enabled', 'conditions', 'action'].includes(k));
  if (unknown.length) throw invalid(`unknown field: ${unknown[0]}`);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 120) throw invalid('the rule needs a name of 120 characters at most');
  const icon = raw.icon ?? null;
  if (icon !== null && (typeof icon !== 'string' || icon.length > 64 || !ICON_NAME.test(icon) || !existsSync(join(ICON_DIR, `${icon}.svg`)))) {
    throw invalid('the icon must be a Lucide icon name');
  }
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
    // The fix a person can take with one press: add this price list item to
    // the draft (for example a shipping line the work system left off).
    if (raw.action.addItem !== undefined && raw.action.addItem !== null) {
      const item = typeof raw.action.addItem === 'string' ? raw.action.addItem.trim() : '';
      if (!item || item.length > 40) throw invalid('addItem must be a price list code of 40 characters at most');
      action.addItem = item;
    }
  } else {
    const early = conditions.find((c) => FIELDS[c.field].draftOnly);
    if (early) throw invalid(`${FIELDS[early.field].label} is on the draft only: use Then "Pending, with a note"`);
  }
  return { name, icon, enabled, conditions, action };
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
      if (test === 'is_not_one_of') return !value.some((v) => norm(v) === left);
      return test === 'is' ? left === norm(value) : left !== norm(value);
    }
  }
}

// The reasons the enabled rules give for one job, in rule order. An empty list
// means no rule stops its draft. `customer` is the customer's own billing
// settings (invoicing-rules.js).
// `items`: the Flow codes that send as accounting items (accountingItemsFor).
const contextOf = ({ customer = {}, now = new Date(), items = null } = {}) => ({ customer, now, items });
// A non-chargeable rule that matches wins over the wait rules (a $0 remake
// is never billed, so "No amount" must not hold it), and over the skip rules
// below it in the list. Rules are in the lab's order.
const waitingRules = (rules, job, context) => {
  const live = rules.filter((rule) => rule.enabled && rule.trigger === 'job_ready');
  const hit = (rule) => rule.conditions.every((c) => matches(c, job, context));
  const free = live.findIndex((rule) => rule.action.kind === 'non_chargeable' && hit(rule));
  return live
    .filter((rule, at) => (free < 0 ? ['wait', 'skip'].includes(rule.action.kind) : rule.action.kind === 'skip' && at < free))
    .filter(hit);
};
const waitMessage = (rule, job, context) => (rule.action.kind === 'skip'
  ? `rule "${rule.name}": not drafted by rule` : `rule "${rule.name}": waits for a person`) + detailOf(rule, job, context);

// Keep the text-only reason API for draft checks, including evaluation of
// starter rules before they are saved. Selection/text have one owner here.
export function ruleReasons(rules, job, options) {
  const context = contextOf(options);
  return waitingRules(rules, job, context).map((rule) => waitMessage(rule, job, context));
}

// Pending work needs the saved rule identity, just as a Pending invoice does.
export function ruleWait(rules, job, options) {
  const context = contextOf(options);
  return waitingRules(rules, job, context).map((rule) => ({ code: 'rule',
    message: waitMessage(rule, job, context), short: rule.name.slice(0, 40), rule: rule.id,
    resolution: ruleResolution(rule),
  }));
}

// The notes of the enabled pending rules that match one draft, as problems:
// they put the draft on Pending (sending.js). `job` is the draft's job with
// `reference`, the draft's Reference. A pending rule never stops a draft.
// `fields` names the fields the rule reads, so the invoice page marks the
// one to fix (the Reference box goes red).
const ruleResolution = (rule) => {
  if (!rule.id) throw new FlowError('warning_resolution_required', 'A Pending rule needs its saved rule to resolve it.');
  return { kind: 'rule_review' };
};

// A rule leaves a job alone when a person made an exception for it
// (`job.ruleExceptions`, rule ids), or, for a rule with `addItem`, when the
// draft already has that item (`job.draftItems`, codes): the fix was taken.
export function rulePending(rules, job, options) {
  const context = contextOf(options);
  const excepted = new Set(job.ruleExceptions ?? []);
  const onDraft = new Set((job.draftItems ?? []).map(norm));
  return rules
    .filter((r) => r.enabled && r.trigger === 'job_ready' && r.action.kind === 'pending')
    .filter((r) => !excepted.has(r.id) && !(r.action.addItem && onDraft.has(norm(r.action.addItem))))
    .filter((r) => r.conditions.every((c) => matches(c, job, context)))
    .map((r) => ({
      code: 'rule', message: r.action.note + detailOf(r, job, context), short: r.name.slice(0, 40), rule: r.id ?? null, fields: [...new Set(r.conditions.map((c) => c.field))],
      resolution: ruleResolution(r), ...(r.action.addItem ? { addItem: r.action.addItem } : {}),
    }));
}

// Drafts an enabled skip rule matches stay on Pending at Send (sending.js).
// A person drafted the job by hand, or the rule was made after the draft.
// The list shows the rule's name. The note says to void the draft or change
// the rule. A wait rule does not hold a draft: a person may still send one.
export function ruleSkip(rules, job, options) {
  const context = contextOf(options);
  return rules
    .filter((r) => r.enabled && r.trigger === 'job_ready' && r.action.kind === 'skip')
    .filter((r) => r.conditions.every((c) => matches(c, job, context)))
    .map((r) => ({
      code: 'rule',
      message: `Rule "${r.name}": not invoiced. Void this draft or change the rule.`,
      short: r.name.slice(0, 40),
      rule: r.id ?? null,
      fields: [...new Set(r.conditions.map((c) => c.field))],
      resolution: ruleResolution(r),
    }));
}

// The enabled non-chargeable rules that match one draft's job (sending.js):
// the draft is on the Non-chargeable tab, never on Pending or Ready, and
// Send never sends it.
export function ruleNonChargeable(rules, job, options) {
  const context = contextOf(options);
  return rules
    .filter((r) => r.enabled && r.trigger === 'job_ready' && r.action.kind === 'non_chargeable')
    .filter((r) => r.conditions.every((c) => matches(c, job, context)))
    .map((r) => ({ code: 'non_chargeable', message: `Rule "${r.name}": non-chargeable. Flow keeps it and never sends it.`, short: r.name.slice(0, 40), rule: r.id ?? null }));
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

const shape = (r, exceptions = 0) => ({
  id: r.id, name: r.name, icon: r.icon, position: r.position, enabled: r.enabled, trigger: r.trigger,
  conditions: r.conditions, action: r.action, starter: Boolean(r.starterKey), updatedAt: r.updatedAt, exceptions,
});

// The organisation's rules, in order. The first read makes the starter rules.
export async function listRules(db, organisationId) {
  const [settings] = await db.select({ seeded: invoicingSettings.rulesSeeded }).from(invoicingSettings)
    .where(eq(invoicingSettings.organisationId, organisationId));
  if (!settings?.seeded) await seed(db, organisationId);
  const rows = await db.select().from(invoiceRules).where(eq(invoiceRules.organisationId, organisationId))
    .orderBy(asc(invoiceRules.position), asc(invoiceRules.createdAt));
  const counts = await db.select({ ruleId: invoiceRuleExceptions.ruleId, count: sql`count(*)::int` }).from(invoiceRuleExceptions)
    .where(eq(invoiceRuleExceptions.organisationId, organisationId)).groupBy(invoiceRuleExceptions.ruleId);
  const byRule = new Map(counts.map((c) => [c.ruleId, Number(c.count)]));
  return rows.map((r) => shape(r, byRule.get(r.id) ?? 0));
}

// ── Exceptions ─────────────────────────────────────────────────────────────

// A person says one job is fine although a rule matches it. The rule then
// leaves the job alone. Only a rule with an item to add takes one: its Skip.
// Each exception keeps who, when and why, stays listed on the rule, and is
// in the job's history. It holds while the rule's item and the job's lines
// stay as they were; a change to either ends it, so a person looks again.
export async function addRuleException(db, organisationId, ruleId, obligationId, { reason, actor }) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why || why.length > 200) throw invalid('an exception needs a reason of 1 to 200 characters');
  if (!actor) throw invalid('actor is required');
  const rule = await loadRule(db, organisationId, ruleId);
  if (rule.action?.kind !== 'pending' || !rule.action.addItem) throw invalid('only a pending rule with an item to add takes an exception; change or turn off the rule');
  return db.transaction(async (tx) => {
    const [job] = await tx.select({ id: billingObligations.id, lineFingerprint: billingObligations.lineFingerprint }).from(billingObligations)
      .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId))).for('update');
    if (!job) throw notFound('job');
    const values = { reason: why, actor, itemCode: rule.action.addItem, lineFingerprint: job.lineFingerprint, createdAt: sql`now()` };
    const [row] = await tx.insert(invoiceRuleExceptions).values({ organisationId, ruleId, obligationId, ...values })
      .onConflictDoUpdate({ target: [invoiceRuleExceptions.ruleId, invoiceRuleExceptions.obligationId], set: values })
      .returning();
    await tx.insert(obligationEvents).values({ organisationId, obligationId, kind: 'rule_exception_added', actor,
      evidence: { ruleId, rule: rule.name, item: rule.action.addItem, reason: why } });
    return row;
  });
}

// The rule ids each job has a current exception for, by job.
export async function ruleExceptionsFor(db, organisationId, obligationIds) {
  if (!obligationIds.length) return new Map();
  const rows = await db.select({ ruleId: invoiceRuleExceptions.ruleId, obligationId: invoiceRuleExceptions.obligationId }).from(invoiceRuleExceptions)
    .innerJoin(invoiceRules, eq(invoiceRules.id, invoiceRuleExceptions.ruleId))
    .innerJoin(billingObligations, eq(billingObligations.id, invoiceRuleExceptions.obligationId))
    .where(and(eq(invoiceRuleExceptions.organisationId, organisationId), inArray(invoiceRuleExceptions.obligationId, obligationIds), CURRENT));
  const out = new Map();
  for (const r of rows) out.set(r.obligationId, [...(out.get(r.obligationId) ?? []), r.ruleId]);
  return out;
}
const CURRENT = sql`(${invoiceRuleExceptions.itemCode} is not distinct from (${invoiceRules.action} ->> 'addItem')
  and ${invoiceRuleExceptions.lineFingerprint} is not distinct from ${billingObligations.lineFingerprint})`;

// One rule's exceptions, newest first. `current` is false when the rule's
// item or the job's lines changed since: the rule applies to that job again.
export async function listRuleExceptions(db, organisationId, ruleId) {
  await loadRule(db, organisationId, ruleId);
  return db.select({ id: invoiceRuleExceptions.id, obligationId: invoiceRuleExceptions.obligationId, reason: invoiceRuleExceptions.reason,
    actor: invoiceRuleExceptions.actor, itemCode: invoiceRuleExceptions.itemCode, createdAt: invoiceRuleExceptions.createdAt, current: sql`${CURRENT}`.mapWith(Boolean) })
    .from(invoiceRuleExceptions)
    .innerJoin(invoiceRules, eq(invoiceRules.id, invoiceRuleExceptions.ruleId))
    .innerJoin(billingObligations, eq(billingObligations.id, invoiceRuleExceptions.obligationId))
    .where(and(eq(invoiceRuleExceptions.organisationId, organisationId), eq(invoiceRuleExceptions.ruleId, ruleId)))
    .orderBy(desc(invoiceRuleExceptions.createdAt));
}

// One job's exceptions, for its invoice page.
export async function jobRuleExceptions(db, organisationId, obligationId) {
  return db.select({ id: invoiceRuleExceptions.id, ruleId: invoiceRuleExceptions.ruleId, rule: invoiceRules.name, reason: invoiceRuleExceptions.reason,
    actor: invoiceRuleExceptions.actor, itemCode: invoiceRuleExceptions.itemCode, createdAt: invoiceRuleExceptions.createdAt, current: sql`${CURRENT}`.mapWith(Boolean) })
    .from(invoiceRuleExceptions)
    .innerJoin(invoiceRules, eq(invoiceRules.id, invoiceRuleExceptions.ruleId))
    .innerJoin(billingObligations, eq(billingObligations.id, invoiceRuleExceptions.obligationId))
    .where(and(eq(invoiceRuleExceptions.organisationId, organisationId), eq(invoiceRuleExceptions.obligationId, obligationId)))
    .orderBy(desc(invoiceRuleExceptions.createdAt));
}

// Takes an exception back: the rule applies to the job again.
export async function removeRuleException(db, organisationId, ruleId, exceptionId, { actor = 'system' } = {}) {
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(invoiceRuleExceptions).where(and(eq(invoiceRuleExceptions.organisationId, organisationId),
      eq(invoiceRuleExceptions.ruleId, ruleId), eq(invoiceRuleExceptions.id, exceptionId))).returning();
    if (!row) throw notFound('exception');
    await tx.insert(obligationEvents).values({ organisationId, obligationId: row.obligationId, kind: 'rule_exception_removed', actor,
      evidence: { ruleId, item: row.itemCode, reason: row.reason } });
  });
}

// A rule's item must be on the price list, and not archived.
async function checkRuleItem(db, organisationId, rule) {
  const code = rule.action.addItem;
  if (!code) return;
  const [item] = await db.select({ archivedAt: priceItems.archivedAt }).from(priceItems)
    .where(and(eq(priceItems.organisationId, organisationId), sql`upper(${priceItems.code}) = upper(${code})`));
  if (!item) throw invalid(`the price list has no item ${code}`);
  if (item.archivedAt) throw invalid(`price item ${code} is archived`);
}

// A rule never names a merged contact: it could never match
// (docs/CONTACTS.md, "Merge two contacts").
async function checkRuleCustomers(db, organisationId, rule) {
  const ids = rule.conditions.filter((c) => c.field === 'customer' && c.value != null && !['contains', 'does_not_contain'].includes(c.test))
    .flatMap((c) => (Array.isArray(c.value) ? c.value : [c.value])).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!ids.length) return;
  const [merged] = await db.select({ name: contacts.name }).from(contacts).where(and(eq(contacts.organisationId, organisationId),
    inArray(contacts.id, ids), sql`${contacts.mergedIntoId} is not null`)).limit(1);
  if (merged) throw invalid('a customer in this rule was merged into another; pick that one');
}

export async function createRule(db, organisationId, raw, { personId = null } = {}) {
  const rule = readRule(raw);
  await checkRuleItem(db, organisationId, rule);
  await checkRuleCustomers(db, organisationId, rule);
  const existing = await listRules(db, organisationId);
  if (existing.length >= MAX_RULES) throw invalid(`an organisation can have ${MAX_RULES} rules at most`);
  const position = existing.length ? Math.max(...existing.map((r) => r.position)) + 1 : 0;
  const [row] = await db.insert(invoiceRules).values({ organisationId, position, ...rule, updatedBy: personId }).returning();
  return shape(row);
}

async function loadRule(db, organisationId, ruleId) {
  const [row] = await db.select().from(invoiceRules).where(and(eq(invoiceRules.organisationId, organisationId), eq(invoiceRules.id, ruleId)));
  if (!row) throw notFound('rule');
  return row;
}

// Changes a rule. `changes` holds any of name, icon, enabled, conditions, action;
// the result must be a whole valid rule.
export async function updateRule(db, organisationId, ruleId, changes, { personId = null } = {}) {
  const row = await loadRule(db, organisationId, ruleId);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('the change must be an object');
  const rule = readRule({ name: row.name, icon: row.icon, enabled: row.enabled, conditions: row.conditions, action: row.action, ...changes });
  if (rule.action.addItem && rule.action.addItem !== row.action?.addItem) await checkRuleItem(db, organisationId, rule);
  if (Object.prototype.hasOwnProperty.call(changes, 'conditions')) await checkRuleCustomers(db, organisationId, rule);
  const [saved] = await db.update(invoiceRules).set({ ...rule, updatedBy: personId, updatedAt: sql`now()` })
    .where(eq(invoiceRules.id, row.id)).returning();
  return shape(saved);
}

export async function deleteRule(db, organisationId, ruleId) {
  const row = await loadRule(db, organisationId, ruleId);
  await db.delete(invoiceRules).where(eq(invoiceRules.id, row.id));
}

// ── A rule's one-press fix ─────────────────────────────────────────────────

// "Add <item>" on a Pending draft: adds one of the rule's price list item to
// the draft, at the price list's price. The rule then leaves the draft alone.
// Flow never writes the line to the work system: the invoice page says the
// job and the work system differ until the work system has it too.
export async function addRuleItem(db, organisationId, invoiceId, ruleId) {
  const rule = await loadRule(db, organisationId, ruleId);
  const code = rule.action?.addItem;
  if (!code || rule.action.kind !== 'pending') throw invalid('this rule has no item to add');
  if (!rule.enabled) throw invalid('this rule is off');
  const [item] = await db.select().from(priceItems)
    .where(and(eq(priceItems.organisationId, organisationId), sql`upper(${priceItems.code}) = upper(${code})`));
  if (!item) throw invalid(`the price list has no item ${code}`);
  if (item.archivedAt) throw invalid(`price item ${code} is archived`);
  // The lines are read under the draft's lock: a second press, or an edit at
  // the same time, adds nothing twice and loses nothing.
  await updateDraftInvoice(db, organisationId, invoiceId, {
    lines: (current) => (current.some((l) => l.priceItemId === item.id) ? null : [
      ...current.map(({ priceItemId, accountCode, description, quantity, unitAmountCents, taxCode }) => (
        { priceItemId, accountCode, description, quantity, unitAmountCents, taxCode })),
      { priceItemId: item.id, quantity: 1 },
    ]),
  });
  return getInvoice(db, organisationId, invoiceId);
}

// "Skip" on a Pending draft: an exception for the draft's job, with a reason.
// The same, before the job has a draft: the job board shows the job needs an
// item, and the person knows it does not (picked up, for example).
export async function exceptJob(db, organisationId, obligationId, ruleId, { reason, actor }) {
  return addRuleException(db, organisationId, ruleId, obligationId, { reason, actor });
}

export async function exceptDraft(db, organisationId, invoiceId, ruleId, { reason, actor }) {
  const [job] = await db.select({ id: billingObligations.id }).from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, invoiceId)));
  if (!job) throw invalid('this invoice has no job; edit the invoice instead');
  return addRuleException(db, organisationId, ruleId, job.id, { reason, actor });
}
