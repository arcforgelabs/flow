import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  billingObligations, contacts, customerBillingSettings, invoicingSettings, SEND_MODES,
} from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { listRules, ruleReasons } from './invoice-rules.js';
import { draftInvoiceForObligation } from './ledger.js';

// Invoicing rules (docs/INVOICING_RULES.md). They are the checks a job that
// is ready to invoice passes before Flow drafts its invoice, and how a checked
// draft goes to the accounting system. Each rule is a setting of the
// organisation; a customer can override some of them. The rules come from
// the earlier lab app, where they were fixed in its code. When Flow drafts is
// an automation (automations.js): Flow's own "ready to invoice" stage
// triggers it, never another system's status.
//
// The ledger's own checks (ledger.js, draftBlockers) still guard every draft:
// the job is not held, every line maps to a price item, it has a customer, the
// accounting copy holds no invoice for it, and the work system's report is
// recent. The lab's own checks are invoice rules it builds (invoice-rules.js);
// the old job limit, practitioner and rush settings here only seed them.

export const ACTOR = 'system:rules';
const DRAFT_BATCH = 200;

export const INVOICING_DEFAULTS = Object.freeze({
  sendMode: 'accounting_draft',
  staleDays: 90,
  paymentTermsDays: 30,
  requirePractitioner: false,
  rushItemCode: null,
  rushPercent: 20,
});

const CUSTOMER_DEFAULTS = Object.freeze({
  billable: true, defaultPractitioner: null, autoDraft: null, sendMode: null, paymentTermsDays: null,
});

const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k]]));
const SETTING_KEYS = Object.keys(INVOICING_DEFAULTS);
const CUSTOMER_KEYS = Object.keys(CUSTOMER_DEFAULTS);

const invalid = (message) => new FlowError('invalid', message);

function wholeNumber(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

function flag(value, name) {
  if (typeof value !== 'boolean') throw invalid(`${name} must be true or false`);
  return value;
}

function shortText(value, name) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200) throw invalid(`${name} must be text of 200 characters at most`);
  return value.trim() || null;
}

function sendMode(value, name) {
  if (!SEND_MODES.includes(value)) throw invalid(`${name} must be one of ${SEND_MODES.join(', ')}`);
  return value;
}

// The organisation's settings as stored, or the defaults.
export async function readInvoicingSettings(db, organisationId) {
  const [row] = await db.select().from(invoicingSettings).where(eq(invoicingSettings.organisationId, organisationId));
  return row ? pick(row, SETTING_KEYS) : { ...INVOICING_DEFAULTS };
}

function readSettingChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('the settings must be an object');
  const out = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'requirePractitioner') out[key] = flag(value, key);
    else if (key === 'sendMode') out[key] = sendMode(value, key);
    else if (key === 'staleDays') out[key] = wholeNumber(value, key, 1, 3650);
    else if (key === 'paymentTermsDays') out[key] = wholeNumber(value, key, 0, 365);
    else if (key === 'rushPercent') out[key] = wholeNumber(value, key, 0, 100);
    else if (key === 'rushItemCode') out[key] = shortText(value, key);
    else throw invalid(`unknown setting: ${key}`);
  }
  return out;
}

export async function saveInvoicingSettings(db, organisationId, changes, { personId = null } = {}) {
  const fields = readSettingChanges(changes);
  await db.insert(invoicingSettings)
    .values({ organisationId, ...fields, updatedBy: personId })
    .onConflictDoUpdate({ target: invoicingSettings.organisationId, set: { ...fields, updatedBy: personId, updatedAt: sql`now()` } });
  return readInvoicingSettings(db, organisationId);
}

async function requireCustomer(db, organisationId, contactId) {
  const [contact] = await db.select({ id: contacts.id, kind: contacts.kind }).from(contacts)
    .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, contactId)));
  if (!contact) throw notFound('customer');
  if (contact.kind !== 'customer') throw invalid('invoicing settings are for a customer contact');
}

// One customer's own settings. A null value takes the organisation's setting.
export async function readCustomerBilling(db, organisationId, contactId) {
  await requireCustomer(db, organisationId, contactId);
  const [row] = await db.select().from(customerBillingSettings)
    .where(and(eq(customerBillingSettings.organisationId, organisationId), eq(customerBillingSettings.contactId, contactId)));
  return row ? pick(row, CUSTOMER_KEYS) : { ...CUSTOMER_DEFAULTS };
}

export async function saveCustomerBilling(db, organisationId, contactId, changes, { personId = null } = {}) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('the settings must be an object');
  await requireCustomer(db, organisationId, contactId);
  const fields = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'billable') fields[key] = flag(value, key);
    else if (key === 'defaultPractitioner') fields[key] = shortText(value, key);
    else if (key === 'autoDraft') fields[key] = value === null ? null : flag(value, key);
    else if (key === 'sendMode') fields[key] = value === null ? null : sendMode(value, key);
    else if (key === 'paymentTermsDays') fields[key] = value === null ? null : wholeNumber(value, key, 0, 365);
    else throw invalid(`unknown setting: ${key}`);
  }
  await db.insert(customerBillingSettings)
    .values({ organisationId, contactId, ...fields, updatedBy: personId })
    .onConflictDoUpdate({
      target: [customerBillingSettings.organisationId, customerBillingSettings.contactId],
      set: { ...fields, updatedBy: personId, updatedAt: sql`now()` },
    });
  return readCustomerBilling(db, organisationId, contactId);
}

// The customers' own settings, by contact id.
export async function customerBillingByContact(db, organisationId, contactIds) {
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.select().from(customerBillingSettings)
    .where(and(eq(customerBillingSettings.organisationId, organisationId), inArray(customerBillingSettings.contactId, ids)));
  return new Map(rows.map((r) => [r.contactId, pick(r, CUSTOMER_KEYS)]));
}

// The settings that apply to one customer: its own, else the organisation's.
// `autoDraft` is the customer's own switch for the draft automation.
export function effectiveSettings(settings, customer = CUSTOMER_DEFAULTS) {
  const own = { ...CUSTOMER_DEFAULTS, ...customer };
  return {
    ...settings,
    billable: own.billable,
    defaultPractitioner: own.defaultPractitioner,
    autoDraft: own.autoDraft ?? true,
    sendMode: own.sendMode ?? settings.sendMode,
    paymentTermsDays: own.paymentTermsDays ?? settings.paymentTermsDays,
  };
}

// How one customer's checked drafts go to the accounting system.
export async function sendModeFor(db, organisationId, contactId) {
  const settings = await readInvoicingSettings(db, organisationId);
  const customers = await customerBillingByContact(db, organisationId, [contactId]);
  return effectiveSettings(settings, customers.get(contactId)).sendMode;
}

// How Flow sends invoices to the accounting system: the organisation's mode,
// and how many customers have a mode of their own that differs from it.
export async function sendModeSummary(db, organisationId) {
  const settings = await readInvoicingSettings(db, organisationId);
  const [row] = await db.select({ n: sql`count(*)::int` }).from(customerBillingSettings).where(and(
    eq(customerBillingSettings.organisationId, organisationId),
    sql`${customerBillingSettings.sendMode} is not null`,
    sql`${customerBillingSettings.sendMode} <> ${settings.sendMode}`,
  ));
  return { mode: settings.sendMode, otherCustomers: row?.n ?? 0 };
}

// What a job still waits on before Flow drafts it, as reasons a person can
// read: Flow's own ready stage, then the lab's invoice rules (invoice-rules.js)
// in their order. An empty list means the job may be drafted. `rules` is the
// organisation's rules, read once per run with listRules.
export function ruleBlockers(obligation, effective, { now = new Date(), rules = [] } = {}) {
  const reasons = [];
  if (!obligation.readyAt) reasons.push('the job is not marked ready to invoice');
  return [...reasons, ...ruleReasons(rules, obligation, { customer: effective, now })];
}

function addDays(date, days) {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

const isoDay = (at) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

// The ledger's live check, answered from the accounting system's copy in Flow
// instead of a call for each job: the copy is complete and was read lately,
// the matcher checked the job after the copy last changed, and the copy holds
// no invoice with the job's own invoice number.
export function copyCheck(accounting, organisationId) {
  return async (obligation) => {
    const { complete, fresh, changedAt, invoices } = await accounting.capabilities.findInvoices({
      organisationId,
      numbers: obligation.sourceInvoiceRef ? [obligation.sourceInvoiceRef] : [],
    });
    if (!complete || !fresh) throw new Error('the accounting copy is not complete or not fresh');
    if (obligation.accountingState !== 'not_found') return { state: obligation.accountingState, matchedBy: 'copy' };
    if (changedAt && (!obligation.accountingCheckedAt || new Date(obligation.accountingCheckedAt) < changedAt)) {
      throw new Error('the accounting copy changed after the job was last matched');
    }
    const sales = invoices.filter((i) => !['voided', 'deleted'].includes(i.state));
    if (sales.length) return { state: sales[0].state, accountingRef: sales[0].id, matchedBy: 'copy' };
    return { state: 'not_found', matchedBy: 'copy' };
  };
}

// Drafts the invoice of each job that is ready to invoice and passes the
// ledger's checks and every rule, except for customers whose drafting is off.
// It writes only Flow's own records: the drafts wait in Flow for a person.
// The draft automation (automations.js) runs it. Answers counts.
// With `accounting` null no accounting system is connected: Flow's own records
// are the only check, as for a person's draft (ledger.js, ledgerView).
export async function autoDraftJobs(db, organisationId, { accounting = null, now = new Date(), limit = DRAFT_BATCH, actor = ACTOR }) {
  const result = { drafted: 0, waiting: 0, off: 0, refused: 0 };
  const settings = await readInvoicingSettings(db, organisationId);
  const rules = await listRules(db, organisationId);
  if (accounting) {
    const mirror = await accounting.capabilities.findInvoices({ organisationId });
    if (!mirror.complete || !mirror.fresh) return { ...result, skipped: 'the accounting copy is not complete or not fresh' };
  }

  const candidates = await db.select().from(billingObligations).where(and(
    eq(billingObligations.organisationId, organisationId),
    isNull(billingObligations.invoiceId),
    sql`${billingObligations.readyAt} is not null`,
    eq(billingObligations.holdState, 'none'),
    accounting
      ? eq(billingObligations.accountingState, 'not_found')
      : inArray(billingObligations.accountingState, ['not_found', 'unknown']),
    eq(billingObligations.mappingComplete, true),
    sql`${billingObligations.contactId} is not null`,
    // Newest first: a backlog of jobs that wait on a rule never hides new work.
  )).orderBy(sql`${billingObligations.jobDate} desc nulls last`, billingObligations.id).limit(limit);
  const customers = await customerBillingByContact(db, organisationId, candidates.map((o) => o.contactId));
  const liveCheck = accounting ? copyCheck(accounting, organisationId) : null;
  const invoiceDate = isoDay(now);

  for (const obligation of candidates) {
    const effective = effectiveSettings(settings, customers.get(obligation.contactId));
    if (!effective.autoDraft) {
      result.off += 1;
      continue;
    }
    if (ruleBlockers(obligation, effective, { now, rules }).length) {
      result.waiting += 1;
      continue;
    }
    try {
      await draftInvoiceForObligation(db, organisationId, obligation.id, {
        liveCheck,
        actor,
        now,
        dueDate: addDays(invoiceDate, effective.paymentTermsDays),
      });
      result.drafted += 1;
    } catch (error) {
      if (error.code !== 'not_ready') throw error;
      result.refused += 1;
    }
  }
  return result;
}
