import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  billingObligations, contacts, customerBillingSettings, externalLinks, invoiceRules, invoicingSettings, obligationEvents, SEND_MODES,
} from '../db/schema.js';
import { payersOf } from './contacts.js';
import { FlowError, notFound } from './errors.js';
import { HISTORY_HOLD_REASON } from './history.js';
import { accountingItemsFor, listRules, ruleNonChargeable, rulePricesFor, ruleReasons } from './invoice-rules.js';
import { draftInvoiceForObligation, setHold, setReady } from './ledger.js';
import { needsRead, readAccountingFirst, readBeforeAct, READS_PER_PASS } from './read-before-act.js';
import { checkReferenceTemplate, DEFAULT_REFERENCE, jobReference } from './references.js';

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
// recent. A job a non-chargeable rule matches needs only the hold, the customer
// and the accounting checks: it is never sent. The lab's own checks are invoice rules it builds (invoice-rules.js);
// the old job limit, practitioner and rush settings here only seed them.

export const ACTOR = 'system:rules';
const DRAFT_BATCH = 200;

// The reasons a lab gives for work it does not charge, for its reports. The
// lab can rename, add or remove them (Settings, Invoicing).
export const NO_CHARGE_REASONS = Object.freeze(['Promotion', 'Internal', 'Remake', 'Rework', 'Warranty', 'Goodwill']);
const MAX_REASONS = 20;
const MAX_REASON = 40;

export const INVOICING_DEFAULTS = Object.freeze({
  sendMode: 'accounting_draft',
  staleDays: 90,
  paymentTermsDays: 30,
  requirePractitioner: false,
  rushItemCode: null,
  rushPercent: 20,
  referenceTemplate: DEFAULT_REFERENCE,
  noChargeReasons: NO_CHARGE_REASONS,
  // Prices include GST: new invoices send tax-inclusive lines.
  amountsIncludeTax: false,
});

const CUSTOMER_DEFAULTS = Object.freeze({
  billable: true, defaultPractitioner: null, autoDraft: null, sendMode: null, paymentTermsDays: null, billToContactId: null,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// An empty rule gives no Reference: the accounting system shows the number.
function referenceTemplate(value) {
  if (value === null) return '';
  if (typeof value !== 'string' || value.length > 200) throw invalid('referenceTemplate must be text of 200 characters at most');
  const problem = checkReferenceTemplate(value);
  if (problem) throw invalid(`referenceTemplate: ${problem}`);
  return value.trim();
}

// A reason is one name of 40 characters at most; names are not repeated.
function noChargeReasons(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_REASONS) throw invalid(`noChargeReasons must be a list of 1 to ${MAX_REASONS} names`);
  const names = value.map((v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''));
  if (names.some((n) => !n || n.length > MAX_REASON)) throw invalid(`each No Charge reason is a name of ${MAX_REASON} characters at most`);
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw invalid('each No Charge reason must be different');
  return names;
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
    if (key === 'requirePractitioner' || key === 'amountsIncludeTax') out[key] = flag(value, key);
    else if (key === 'sendMode') out[key] = sendMode(value, key);
    else if (key === 'staleDays') out[key] = wholeNumber(value, key, 1, 3650);
    else if (key === 'paymentTermsDays') out[key] = wholeNumber(value, key, 0, 365);
    else if (key === 'rushPercent') out[key] = wholeNumber(value, key, 0, 100);
    else if (key === 'rushItemCode') out[key] = shortText(value, key);
    else if (key === 'referenceTemplate') out[key] = referenceTemplate(value);
    else if (key === 'noChargeReasons') out[key] = noChargeReasons(value);
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

// A lab renames one No Charge reason, or folds it into another: the list,
// every job that has it, and every rule that gives it change together. Each
// job keeps an event with the earlier reason. Answers { settings, jobs }.
export async function renameNoChargeReason(db, organisationId, { from, to }, { personId = null } = {}) {
  const old = typeof from === 'string' ? from.trim() : '';
  const [name] = noChargeReasons([to]);
  if (!old) throw invalid('from must be a No Charge reason');
  const settings = await readInvoicingSettings(db, organisationId);
  const at = settings.noChargeReasons.findIndex((r) => r.toLowerCase() === old.toLowerCase());
  if (at < 0) throw invalid(`"${old}" is not one of the No Charge reasons`);
  const list = settings.noChargeReasons.filter((r, i) => i === at || r.toLowerCase() !== name.toLowerCase());
  list[list.indexOf(settings.noChargeReasons[at])] = name;
  const actor = personId ? `person:${personId}` : 'system';
  return db.transaction(async (tx) => {
    await tx.insert(invoicingSettings).values({ organisationId, noChargeReasons: list, updatedBy: personId })
      .onConflictDoUpdate({ target: invoicingSettings.organisationId, set: { noChargeReasons: list, updatedBy: personId, updatedAt: sql`now()` } });
    const jobs = await tx.update(billingObligations).set({ noChargeReason: name, updatedAt: sql`now()` })
      .where(and(eq(billingObligations.organisationId, organisationId), sql`lower(${billingObligations.noChargeReason}) = lower(${old})`))
      .returning({ id: billingObligations.id });
    if (jobs.length) {
      await tx.insert(obligationEvents).values(jobs.map((j) => ({
        organisationId, obligationId: j.id, kind: 'no_charge', actor, evidence: { from: old, to: name, renamed: true },
      })));
    }
    await tx.update(invoiceRules).set({ action: sql`jsonb_set(${invoiceRules.action}, '{reason}', to_jsonb(${name}::text))`, updatedAt: sql`now()` })
      .where(and(eq(invoiceRules.organisationId, organisationId), sql`lower(${invoiceRules.action}->>'reason') = lower(${old})`));
    return { settings: { ...settings, noChargeReasons: list }, jobs: jobs.length };
  });
}

async function requireCustomer(db, organisationId, contactId) {
  const [contact] = await db.select({ id: contacts.id, kind: contacts.kind, mergedIntoId: contacts.mergedIntoId }).from(contacts)
    .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, contactId)));
  if (!contact) throw notFound('customer');
  if (contact.kind !== 'customer') throw invalid('invoicing settings are for a customer contact');
  return contact;
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
  const customer = await requireCustomer(db, organisationId, contactId);
  if (customer.mergedIntoId) throw invalid('this customer was merged into another; change that one');
  // Bill to is checked and saved under one lock per organisation, so two
  // saves at once never make a chain of payers.
  if (Object.prototype.hasOwnProperty.call(changes, 'billToContactId')) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bill_to:${organisationId}`}))`);
      // A merge takes the same lock: read again inside it.
      if ((await requireCustomer(tx, organisationId, contactId)).mergedIntoId) throw invalid('this customer was merged into another; change that one');
      return saveBilling(tx, organisationId, contactId, changes, personId);
    });
  }
  return saveBilling(db, organisationId, contactId, changes, personId);
}

async function saveBilling(db, organisationId, contactId, changes, personId) {
  const before = (await readCustomerBilling(db, organisationId, contactId)).billToContactId;
  const fields = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'billable') fields[key] = flag(value, key);
    else if (key === 'defaultPractitioner') fields[key] = shortText(value, key);
    else if (key === 'autoDraft') fields[key] = value === null ? null : flag(value, key);
    else if (key === 'sendMode') fields[key] = value === null ? null : sendMode(value, key);
    else if (key === 'paymentTermsDays') fields[key] = value === null ? null : wholeNumber(value, key, 0, 365);
    else if (key === 'billToContactId') fields[key] = await billTo(db, organisationId, contactId, value);
    else throw invalid(`unknown setting: ${key}`);
  }
  await db.insert(customerBillingSettings)
    .values({ organisationId, contactId, ...fields, updatedBy: personId })
    .onConflictDoUpdate({
      target: [customerBillingSettings.organisationId, customerBillingSettings.contactId],
      set: { ...fields, updatedBy: personId, updatedAt: sql`now()` },
    });
  // A new payer is a new place to look: the matcher checks this customer's
  // unbilled jobs again on its next pass.
  if ('billToContactId' in fields && fields.billToContactId !== before) {
    await db.update(billingObligations).set({ accountingCheckedAt: null, updatedAt: sql`now()` }).where(and(
      eq(billingObligations.organisationId, organisationId), eq(billingObligations.contactId, contactId),
      isNull(billingObligations.accountingRef), isNull(billingObligations.invoiceId),
    ));
  }
  return readCustomerBilling(db, organisationId, contactId);
}

// Bill to (docs/CONTACTS.md): another customer, the payer, whose accounting
// contact this customer's work is billed to. One level only: a payer bills
// to itself, and a customer that is a payer names no payer.
async function billTo(db, organisationId, contactId, value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('billToContactId must name a customer');
  if (value === contactId) throw invalid('a customer cannot bill to itself; clear Bill to instead');
  const [payer] = await db.select({ id: contacts.id, kind: contacts.kind, name: contacts.name, mergedIntoId: contacts.mergedIntoId }).from(contacts)
    .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, value)));
  if (!payer) throw notFound('customer');
  if (payer.kind !== 'customer') throw invalid('the payer must be a customer');
  if (payer.mergedIntoId) throw invalid(`${payer.name} was merged into another customer; pick that one`);
  const [payerOwn] = await db.select({ billTo: customerBillingSettings.billToContactId }).from(customerBillingSettings)
    .where(and(eq(customerBillingSettings.organisationId, organisationId), eq(customerBillingSettings.contactId, value)));
  if (payerOwn?.billTo) throw invalid(`${payer.name} bills to another customer; pick that one`);
  const [billed] = await db.select({ id: customerBillingSettings.contactId }).from(customerBillingSettings)
    .where(and(eq(customerBillingSettings.organisationId, organisationId), eq(customerBillingSettings.billToContactId, contactId))).limit(1);
  if (billed) throw invalid('other customers bill to this customer, so it cannot bill to another');
  return value;
}

// The customers' own settings, by contact id.
export async function customerBillingByContact(db, organisationId, contactIds) {
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.select().from(customerBillingSettings)
    .where(and(eq(customerBillingSettings.organisationId, organisationId), inArray(customerBillingSettings.contactId, ids)));
  return new Map(rows.map((r) => [r.contactId, pick(r, CUSTOMER_KEYS)]));
}

// The customers' names, by contact id. Customer "contains" reads the name
// (invoice-rules.js), not the contact id the menu tests use.
async function customerNames(db, organisationId, contactIds) {
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.select({ id: contacts.id, name: contacts.name }).from(contacts)
    .where(and(eq(contacts.organisationId, organisationId), inArray(contacts.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
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
export function ruleBlockers(obligation, effective, { now = new Date(), rules = [], items = null, prices = null } = {}) {
  const reasons = [];
  if (!obligation.readyAt) reasons.push('the job is not marked ready to invoice');
  return [...reasons, ...ruleReasons(rules, obligation, { customer: effective, now, items, prices })];
}

// Old jobs from the history import wait on hold, out of the rules' sight. A
// job that a non-chargeable rule matches (own clinics, remakes) needs no
// person: it is never billed. When no accounting invoice was found for it,
// the rule releases it and marks it ready, and the next draft run puts its
// draft on the Non-chargeable tab, never sent. A job with an accounting
// invoice, or one that is unclear, stays for a person. Answers counts.
export async function settleHistoryByRules(db, organisationId, { accounting = null, now = new Date(), limit = DRAFT_BATCH } = {}) {
  const result = { checked: 0, released: 0 };
  const rules = (await listRules(db, organisationId)).filter((r) => r.enabled && r.trigger === 'job_ready' && r.action.kind === 'non_chargeable');
  if (!rules.length) return result;
  const jobs = await db.select().from(billingObligations).where(and(
    eq(billingObligations.organisationId, organisationId),
    eq(billingObligations.holdState, 'held'),
    eq(billingObligations.holdReason, HISTORY_HOLD_REASON),
    isNull(billingObligations.invoiceId),
    sql`${billingObligations.contactId} is not null`,
    accounting
      ? eq(billingObligations.accountingState, 'not_found')
      : inArray(billingObligations.accountingState, ['not_found', 'unknown']),
  )).orderBy(sql`${billingObligations.jobDate} desc nulls last`, billingObligations.id).limit(limit);
  if (!jobs.length) return result;
  const settings = await readInvoicingSettings(db, organisationId);
  const prices = await rulePricesFor(db, organisationId, rules);
  const contactIds = [...new Set(jobs.map((j) => j.contactId))];
  const customers = await customerBillingByContact(db, organisationId, contactIds);
  const names = await customerNames(db, organisationId, contactIds);
  for (const job of jobs) {
    result.checked += 1;
    const customer = { ...effectiveSettings(settings, customers.get(job.contactId)), name: names.get(job.contactId) ?? null };
    const [rule] = ruleNonChargeable(rules, job, { customer, now, prices });
    if (!rule) continue;
    const actor = `rule:${rule.rule}`;
    await setHold(db, organisationId, job.id, { holdState: 'none', reason: `${rule.short}: non-chargeable`, actor });
    await setReady(db, organisationId, job.id, { actor });
    result.released += 1;
  }
  return result;
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
// no invoice with the job's own invoice number. Another customer's invoice
// with the same number is not this job's: when the job's customer is linked to
// an accounting contact (`db` given), only that contact's invoices count.
// Send's window for the same client and Reference (xero/drafts.js).
const SAME_REFERENCE_DAYS = 90;

export function copyCheck(accounting, organisationId, { db = null } = {}) {
  const contactOf = async (contactId) => {
    if (!db || !contactId) return null;
    // A customer with a payer is billed under the payer's contact (Bill to).
    const payer = (await payersOf(db, organisationId, [contactId])).get(contactId);
    const [link] = await db.select({ externalId: externalLinks.externalId }).from(externalLinks).where(and(
      eq(externalLinks.organisationId, organisationId), eq(externalLinks.system, accounting.id),
      eq(externalLinks.entity, 'contact'), eq(externalLinks.state, 'active'), eq(externalLinks.flowId, payer),
    ));
    return link?.externalId ?? null;
  };
  return async (obligation, { reference = null } = {}) => {
    const { complete, fresh, changedAt, invoices } = await accounting.capabilities.findInvoices({
      organisationId,
      numbers: obligation.sourceInvoiceRef ? [obligation.sourceInvoiceRef] : [],
      references: reference ? [reference] : [],
    });
    if (!complete || !fresh) throw new Error('the accounting copy is not complete or not fresh');
    if (obligation.accountingState !== 'not_found') return { state: obligation.accountingState, matchedBy: 'copy' };
    if (changedAt && (!obligation.accountingCheckedAt || new Date(obligation.accountingCheckedAt) < changedAt)) {
      throw new Error('the accounting copy changed after the job was last matched');
    }
    const xeroContactId = await contactOf(obligation.contactId);
    const live = invoices.filter((i) => !['voided', 'deleted'].includes(i.state));
    const sameNumber = (i) => obligation.sourceInvoiceRef && String(i.number ?? '').toUpperCase() === obligation.sourceInvoiceRef.toUpperCase();
    const sales = live.filter((i) => sameNumber(i) && (!xeroContactId || i.contactId === xeroContactId));
    if (sales.length) return { state: sales[0].state, accountingRef: sales[0].id, matchedBy: 'copy' };
    // The same client and Reference as this draft, within Send's window: Send
    // would stop it (xero/drafts.js), so the draft is not made. A person
    // links the job to that invoice, or says it is another job.
    const day = obligation.jobDate ? Date.parse(`${String(obligation.jobDate).slice(0, 10)}T00:00:00Z`) : Date.now();
    const sameReference = reference && xeroContactId ? live.filter((i) => i.contactId === xeroContactId
      && String(i.reference ?? '').toUpperCase() === reference.toUpperCase()
      && (!i.issuedOn || Math.abs(Date.parse(`${String(i.issuedOn).slice(0, 10)}T00:00:00Z`) - day) <= SAME_REFERENCE_DAYS * 86_400_000)) : [];
    if (sameReference.length) return { state: 'ambiguous', accountingRef: sameReference[0].id, matchedBy: 'reference' };
    return { state: 'not_found', matchedBy: 'copy' };
  };
}

async function reloadObligation(db, organisationId, id) {
  const [row] = await db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, id)));
  return row;
}

// Drafts the invoice of each job that is ready to invoice and passes the
// ledger's checks and every rule, except for customers whose drafting is off.
// It writes only Flow's own records: the drafts wait in Flow for a person.
// The draft automation (automations.js) runs it. Answers counts.
// With `accounting` null no accounting system is connected: Flow's own records
// are the only check, as for a person's draft (ledger.js, ledgerView).
export async function autoDraftJobs(db, organisationId, { accounting = null, work = null, now = new Date(), limit = DRAFT_BATCH, actor = ACTOR }) {
  const result = { drafted: 0, waiting: 0, off: 0, refused: 0, readFirst: 0 };
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
    sql`${billingObligations.contactId} is not null`,
    // Newest first: a backlog of jobs that wait on a rule never hides new work.
  )).orderBy(sql`${billingObligations.jobDate} desc nulls last`, billingObligations.id).limit(limit);
  const contactIds = candidates.map((o) => o.contactId);
  const customers = await customerBillingByContact(db, organisationId, contactIds);
  const names = await customerNames(db, organisationId, contactIds);
  const named = (contactId) => ({ ...effectiveSettings(settings, customers.get(contactId)), name: names.get(contactId) ?? null });
  const liveCheck = accounting ? copyCheck(accounting, organisationId, { db }) : null;
  const invoiceDate = isoDay(now);
  let accountingRead = null;
  // The codes that send as accounting items, for a rule that reads them.
  const items = await accountingItemsFor(accounting, organisationId, rules, candidates);
  const prices = await rulePricesFor(db, organisationId, rules);

  for (const candidate of candidates) {
    let effective = named(candidate.contactId);
    if (!effective.autoDraft) {
      result.off += 1;
      continue;
    }
    if (ruleBlockers(candidate, effective, { now, rules, items, prices }).length) {
      result.waiting += 1;
      continue;
    }
    // A job a non-chargeable rule matches (own clinics, remakes) is never
    // billed: its draft goes to the Non-chargeable tab whatever its price
    // items, tax or report age say. Any other job needs every line mapped.
    const noCharge = ruleNonChargeable(rules, candidate, { customer: effective, now, prices }).length > 0;
    if (!noCharge && !candidate.mappingComplete) {
      result.waiting += 1;
      continue;
    }
    // Issue #141: an old report is read again first. The rules then check
    // what the work system says now; the ledger checks the rest.
    if (!noCharge && result.readFirst >= READS_PER_PASS && needsRead(candidate, { work, now })) {
      result.waiting += 1;
      continue;
    }
    let { outcome, obligation } = noCharge
      ? { outcome: 'fresh', obligation: candidate }
      : (await readBeforeAct(db, organisationId, [candidate], { work, now, actor })).get(candidate.id);
    if (outcome !== 'fresh') result.readFirst += 1;
    if (outcome === 'waiting' || outcome === 'review') {
      result.waiting += 1;
      continue;
    }
    // Issue #45: the accounting copy reads its latest changes once, before
    // the first draft. When it changed, the matcher ran: this job may now
    // have its invoice.
    if (accounting) {
      if (!accountingRead) {
        accountingRead = await readAccountingFirst(db, organisationId, { accounting, work, now });
        // The summary says when the copy read or could not read.
        if (accountingRead.outcome !== 'fresh') result.accountingRead = accountingRead.outcome;
      }
      if (accountingRead.outcome === 'waiting') {
        result.waiting += 1;
        continue;
      }
      if (accountingRead.outcome === 'read') obligation = await reloadObligation(db, organisationId, obligation.id);
      if (obligation.accountingState !== 'not_found') {
        result.waiting += 1;
        continue;
      }
    }
    if (obligation !== candidate) {
      if (obligation.contactId && !names.has(obligation.contactId)) {
        const extra = await customerNames(db, organisationId, [obligation.contactId]);
        for (const [id, name] of extra) names.set(id, name);
      }
      effective = named(obligation.contactId);
      // The job read again may have new codes: read their accounting items too.
      const itemsNow = items && (obligation.lines ?? []).some((l) => l.itemCode && !items.has(l.itemCode))
        ? await accountingItemsFor(accounting, organisationId, rules, [obligation]) : items;
      if (!effective.autoDraft || ruleBlockers(obligation, effective, { now, rules, items: itemsNow, prices }).length) {
        result.waiting += 1;
        continue;
      }
    }
    try {
      await draftInvoiceForObligation(db, organisationId, obligation.id, {
        liveCheck,
        actor,
        now,
        reference: await jobReference(db, organisationId, obligation, { template: settings.referenceTemplate, work }),
        dueDate: addDays(invoiceDate, effective.paymentTermsDays),
        noCharge,
      });
      result.drafted += 1;
    } catch (error) {
      if (error.code !== 'not_ready') throw error;
      result.refused += 1;
    }
  }
  return result;
}
