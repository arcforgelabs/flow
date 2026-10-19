import { and, asc, eq, sql } from 'drizzle-orm';
import { invoiceRules, invoicingSettings } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';

// Invoice rules (docs/INVOICE_RULES.md): a lab's own checks on a job before
// Flow drafts its invoice. Each rule is When, If and Then, and a lab owner
// builds it from menus, so no lab's checks are fixed in Flow's code.
//
//   When  job_ready: the job is ready to invoice and has no invoice yet.
//   If    every condition matches: a field of the job, its customer or its
//         lines, a test, and a value.
//   Then  wait: the job waits for a person; skip: rules never draft it.
//
// The rules read only Flow's own records, so they work with or without an
// accounting integration. The earlier fixed settings (old job limit, required
// practitioner, rush share) become starter rules, once per organisation.

const MAX_RULES = 100;
const MAX_CONDITIONS = 10;
const invalid = (message) => new FlowError('invalid', message);

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
  practitioner: { label: 'Practitioner', kind: 'text', read: (j, { customer }) => j.practitioner || customer.defaultPractitioner || null },
  customer: { label: 'Customer', kind: 'choice', options: 'customers', read: (j) => j.contactId },
  customer_billable: { label: 'Customer is billable', kind: 'boolean', read: (j, { customer }) => customer.billable !== false },
  line_item: { label: 'Line item', kind: 'items', options: 'items', read: (j) => (j.lines ?? []).flatMap((l) => [norm(l.itemCode), norm(l.label)].filter(Boolean)) },
  line_share: { label: 'Line share of other lines (%)', kind: 'share', options: 'items', read: (j) => j.lines ?? [] },
});

export const TESTS = Object.freeze({
  number: ['more_than', 'at_most', 'is', 'is_not', 'is_empty'],
  money: ['more_than', 'at_most', 'is', 'is_not'],
  choice: ['is', 'is_not', 'is_one_of', 'is_empty'],
  text: ['is', 'is_not', 'is_empty', 'is_not_empty'],
  boolean: ['is'],
  items: ['has', 'has_not'],
  share: ['is', 'is_not'],
});

export const ACTIONS = Object.freeze(['wait', 'skip']);

function readCondition(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`condition ${index + 1} must be an object`);
  const field = FIELDS[raw.field];
  if (!field) throw invalid(`condition ${index + 1}: unknown field ${raw.field}`);
  if (!TESTS[field.kind].includes(raw.test)) throw invalid(`condition ${index + 1}: ${field.label} takes ${TESTS[field.kind].join(', ')}`);
  const out = { field: raw.field, test: raw.test };
  if (['is_empty', 'is_not_empty'].includes(raw.test)) return out;
  const { value } = raw;
  if (field.kind === 'boolean') {
    if (typeof value !== 'boolean') throw invalid(`condition ${index + 1}: the value must be true or false`);
  } else if (['number', 'money', 'share'].includes(field.kind)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) throw invalid(`condition ${index + 1}: the value must be a number`);
  } else if (raw.test === 'is_one_of') {
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
  return { name, enabled, conditions: raw.conditions.map(readCondition), action: { kind: raw.action.kind } };
}

function matches(condition, job, context) {
  const field = FIELDS[condition.field];
  const have = field.read(job, context);
  const { test, value } = condition;
  if (test === 'is_empty') return have === null || have === '' || have === undefined;
  if (test === 'is_not_empty') return !(have === null || have === '' || have === undefined);
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
    if (!rule.enabled || rule.trigger !== 'job_ready') continue;
    if (!rule.conditions.every((c) => matches(c, job, context))) continue;
    reasons.push(rule.action.kind === 'skip' ? `rule "${rule.name}": not drafted by rule` : `rule "${rule.name}": waits for a person`);
  }
  return reasons;
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

// The organisation's rules, in order. The first read makes the starter rules.
export async function listRules(db, organisationId) {
  const [settings] = await db.select({ seeded: invoicingSettings.rulesSeeded }).from(invoicingSettings)
    .where(eq(invoicingSettings.organisationId, organisationId));
  if (!settings?.seeded) await seed(db, organisationId);
  const rows = await db.select().from(invoiceRules).where(eq(invoiceRules.organisationId, organisationId))
    .orderBy(asc(invoiceRules.position), asc(invoiceRules.createdAt));
  return rows.map(shape);
}

export async function createRule(db, organisationId, raw, { personId = null } = {}) {
  const rule = readRule(raw);
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

// Changes a rule. `changes` holds any of name, enabled, conditions, action;
// the result must be a whole valid rule.
export async function updateRule(db, organisationId, ruleId, changes, { personId = null } = {}) {
  const row = await loadRule(db, organisationId, ruleId);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('the change must be an object');
  const rule = readRule({ name: row.name, enabled: row.enabled, conditions: row.conditions, action: row.action, ...changes });
  const [saved] = await db.update(invoiceRules).set({ ...rule, updatedBy: personId, updatedAt: sql`now()` })
    .where(eq(invoiceRules.id, row.id)).returning();
  return shape(saved);
}

export async function deleteRule(db, organisationId, ruleId) {
  const row = await loadRule(db, organisationId, ruleId);
  await db.delete(invoiceRules).where(eq(invoiceRules.id, row.id));
}
