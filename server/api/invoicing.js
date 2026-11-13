import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import express from 'express';
import { invoiceKindOf, invoicePage, INVOICE_SORTS, normaliseInvoicesView } from '../ui/list-views.js';
import { fieldIdOf, filterRows } from '../ui/job-view.js';
import { listFields, listJobFieldValues } from '../core/custom-fields.js';
import { FlowError } from '../core/errors.js';
import { listReview } from '../core/review.js';
import { createActionGuard } from '../integrations/call-guard.js';
import {
  createDraftInvoice, deleteDraft, getInvoice, issueInvoice, listInvoiceVersions, reviseInvoice, updateDraftInvoice, voidInvoice,
} from '../core/invoices.js';
import { listAutomations, saveAutomation, workStatuses } from '../core/automations.js';
import {
  ACTIONS, addRuleItem, createRule, deleteRule, exceptDraft, exceptJob, FIELDS, jobRuleExceptions, listRuleExceptions, listRules, removeRuleException, TESTS, updateRule,
} from '../core/invoice-rules.js';
import {
  createMapping, deleteMapping, listMappings, STEP_LABELS, STEPS, updateMapping,
} from '../core/line-mapping.js';
import {
  effectiveSettings, INVOICING_DEFAULTS, readCustomerBilling, readInvoicingSettings, renameNoChargeReason,
  saveCustomerBilling, saveInvoicingSettings, sendModeFor, sendModeSummary,
} from '../core/invoicing-rules.js';
import { boardJobs, describeObligations } from '../core/job-board.js';
import { readBeforeAct } from '../core/read-before-act.js';
import { invoiceMatchDetail, jobMatchDetail, listReconcile } from '../core/job-match.js';
import { jobReference } from '../core/references.js';
import {
  acceptFindings, archivePriceItem, checkPrices, createPriceItem, linkPriceItem, linkPriceItems, MAX_LINKS_AT_ONCE, readCatalogues, readPriceList, unlinkPriceItem, updatePriceItem,
} from '../core/price-list.js';
import {
  confirmNoInvoice, draftInvoiceForObligation, freeVoidedJob, setHold, explainObligation, jobChangeFor, linkJobToInvoice, listObligations, unlinkJobInvoice,
  setNoCharge, setReady, settleJobChange, useSourceLines,
} from '../core/ledger.js';
import { isHistoryHeld } from '../core/history.js';
import { invoicePdfDocument, pdfFields, pdfFilename, renderInvoicePdf } from '../core/invoice-pdf.js';
import { emailedStage, INVOICE_TABS, invoiceTab, OLD_TABS } from '../core/invoice-status.js';
import { invoiceView, invoiceViews, markNotReady, markReady, sendAgain, sendAllReady, sendAnyway } from '../core/sending.js';
import { overridable, overridesOfInvoice, OVERRIDE_REASONS, problemKey } from '../core/send-override.js';
import { createContact, getContact, listContacts, presentContact, updateContact } from '../core/contacts.js';
import { mergeContacts } from '../core/merge-contacts.js';
import {
  billingObligations, contacts, invoiceListTabs, invoices, INVOICE_STATUSES, organisations, priceItems, TAX_CODES,
} from '../db/schema.js';

// Invoicing for people signed in to Flow, mounted at /api/invoicing. The web
// UI's invoices, customers, price list and jobs pages read and write here.
//
//   GET   /context                    the organisations, and whether this person may issue
//   GET   /invoices?organisationId=&status=&q=&limit=   newest first, with counts by tab;
//                                     status is a tab: pending, ready, draft, awaiting_payment, paid, non_chargeable or void (TABS,
//                                     server/core/invoice-status.js); approved and sent read as awaiting_payment
//   POST  /invoices/mark-ready        { invoiceIds }: a person checked these drafts; one with a problem stays
//   POST  /invoices/mark-not-ready    { invoiceIds }: back to To check
//   POST  /invoices/send-ready        owner or admin: issue every ready draft and queue it for the
//                                     accounting system { issueDate, invoiceIds? (only these; one that fails
//                                     a check now stays on Pending and counts as held; one id is all or
//                                     nothing when its job cannot be confirmed, more than one id sends the
//                                     rest and counts the unconfirmed in waiting), sendMode? (this press
//                                     only: 'approve_and_email' or 'accounting_draft'; default each
//                                     customer's mode) }
//   POST  /invoices/send-again        owner or admin: queue failed sends again { invoiceIds? }
//   GET   /invoices/:id               one invoice: lines, contact, job, issued versions, and where it sends
//   GET   /invoices/:id/pdf?version=  the invoice as a PDF, drawn by Flow (server/core/invoice-pdf.js),
//                                     with the accounting system's number and dates once it holds it;
//                                     no accounting system calls
//   POST  /invoices                   a new draft
//   PATCH /invoices/:id               change a draft
//   POST  /invoices/:id/issue         owner or admin: number it and keep the document as sent
//   POST  /invoices/:id/revise        owner or admin: an issued invoice back to a draft
//   POST  /invoices/:id/void          owner or admin
//   DELETE /invoices/:id              owner or admin: a draft that was never issued.
//                                     Frees its job, and the lab's rules then decide.
//   GET   /contacts?q=&limit=         customers, by name (hidden=true: the contacts that are not clients)
//   GET   /price-items?q=             the price list, by code
//   GET   /jobs?view=&limit=          billable jobs (the obligation ledger), with counts by view;
//                                     a job with no invoice lists the invoicing rules it waits on;
//                                     a job with an invoice has its Invoices page view and problems
//   GET   /board                      the Jobs board: the work system's jobs by its own statuses,
//                                     each with its billing obligation (server/core/job-board.js)
//   GET   /settings                  the invoicing settings (server/core/invoicing-rules.js)
//   PUT   /settings                   owner or admin: change some of them
//   GET   /rules                      the lab's invoice rules, in order (server/core/invoice-rules.js)
//   GET   /rule-fields                what a rule can name, and the menus of values
//   POST  /rules                      owner or admin: a new rule { name, icon, enabled, conditions, action }
//   PUT   /rules/:id                  owner or admin: change some of a rule
//   DELETE /rules/:id                 owner or admin
//   GET   /line-mappings              the lab's line mappings and the mapping steps (server/core/line-mapping.js)
//   GET   /line-labels                the line labels on jobs, with counts and how each mapped
//   POST  /line-mappings              owner or admin: a new mapping
//   PUT   /line-mappings/:id          owner or admin: change some of a mapping
//   DELETE /line-mappings/:id         owner or admin
//   GET   /price-list                 the price list with its links, the connected systems' records with
//                                     no link, and what differs (server/core/price-list.js)
//   POST  /price-list/check           owner or admin: run the price check now (no calls to other systems)
//   POST  /price-items                owner or admin: a new price item { code, name, unitAmountCents, taxCode, ... }
//   PUT   /price-items/:id            owner or admin: change some of a price item
//   POST  /price-items/:id/archive    owner or admin: { archived } archive it, or bring it back
//   POST  /price-items/:id/links      owner or admin: { system, externalId } link a record of a system's list
//   POST  /price-items/:id/resolve    owner or admin: Mark resolved: check again, accept what still differs
//   DELETE /price-links/:id           owner or admin: remove a link
//   POST  /price-links                owner or admin: { links: [{ priceItemId, system, externalId }] } many links at once
//   GET   /automations?place=         Flow's routines, each on or off (server/core/automations.js)
//   PUT   /automations/:key           owner or admin: { enabled, config }
//   GET   /work-statuses              the work system's job statuses, with job counts
//   GET   /contacts/:id/billing       one customer's own invoicing settings
//   PUT   /contacts/:id/billing       owner or admin: change them (null takes the organisation's)
//   POST  /jobs/:id/ready             { ready }: mark a job ready to invoice, or back in work
//   GET   /jobs/:id/activity          what happened to a job, newest first
//   POST  /jobs/:id/hold              owner or admin: { state: none|held|review, reason }
//   POST  /jobs/:id/free              owner or admin: { reason }: let go of a void invoice, then hold
//   POST  /jobs/:id/no-charge         owner or admin: { reason }: No Charge with one of the lab's
//                                     reasons, a new reason, or null to charge it again
//   POST  /no-charge-reasons/rename   owner or admin: { from, to }: rename a reason everywhere
//   POST  /jobs/:id/draft             owner or admin: a job's draft invoice, after a live
//                                     check that the accounting system holds none
//
// Every route needs a signed-in, active person; reading and drafting are open
// to every role. `organisationId` (query or body) names the organisation; it
// may be left out while the installation has exactly one. Money is integer
// cents. `liveCheckFor(organisationId)` returns the ledger's live check for
// that organisation, or null when no accounting integration offers one.
// `accounting()` is the accounting adapter that sends invoices, or null.
// `work()` is the work system adapters that offer listWork (the Jobs board).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The Invoices page tabs, left to right: one status rule puts each invoice
// on one (server/core/invoice-status.js).
const TABS = INVOICE_TABS;
const VIEWS = ['in_work', 'ready', 'pending', 'drafted', 'invoiced', 'paid', 'held', 'review_required'];
const MAX_LINES = 200;
const MAX_TEXT = 500;
// Each line's amount must fit the database's integer columns with room for
// the invoice total.
const MAX_QUANTITY = 100_000;
const MAX_UNIT_CENTS = 100_000_000;

const ERROR_STATUS = {
  invalid: 400, organisation_required: 400, not_found: 404, not_draft: 409, not_issued: 409,
  never_issued: 409, was_issued: 409, not_ready: 409, live_check_unavailable: 409, conflict: 409,
  accounting_not_connected: 409, accounting_writes_off: 409, accounting_unavailable: 409, accounting_approved: 409,
  not_overridable: 409, override_stale: 409,
  conflict: 409,
};

function sendError(res, error, log) {
  // A value PostgreSQL refuses (a number out of range, a date that does not
  // exist) is the caller's mistake, not a server fault.
  const pgCode = error.code ?? error.cause?.code;
  if (!(error instanceof FlowError) && ['22003', '22008', '22007', '22P02'].includes(pgCode)) {
    return res.status(400).json({ ok: false, code: 'invalid', error: 'a value is out of range or not valid' });
  }
  if (!(error instanceof FlowError)) {
    log.error?.(`[invoicing] ${error.message}`);
    return res.status(500).json({ ok: false, code: 'internal', error: 'Something went wrong.' });
  }
  const body = { ok: false, code: error.code, error: error.message };
  if (error.details !== undefined) body.details = error.details;
  return res.status(error.status ?? ERROR_STATUS[error.code] ?? 400).json(body);
}

const handle = (log, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    sendError(res, error, log);
  }
};

const invalid = (message) => new FlowError('invalid', message);
const text = (raw) => (typeof raw === 'string' ? raw.trim() : '');
const pathId = (raw, what) => {
  if (!UUID.test(raw ?? '')) throw new FlowError('not_found', `${what} not found`);
  return raw;
};

function limitOf(raw, fallback, max) {
  if (raw === undefined) return fallback;
  const n = Number(text(raw));
  if (!Number.isInteger(n) || n < 1) throw invalid(`limit must be a whole number from 1 to ${max}`);
  return Math.min(n, max);
}

function offsetOf(raw) {
  if (raw === undefined) return 0;
  const n = Number(text(raw));
  if (!Number.isInteger(n) || n < 0) throw invalid('offset must be a whole number from 0');
  return n;
}

// The Filter chip's view, sent as JSON (list-views.js keeps only what it knows).
function filterViewOf(raw) {
  if (raw === undefined || text(raw) === '') return normaliseInvoicesView({});
  let value;
  try { value = JSON.parse(String(raw)); } catch { throw invalid('filter must be JSON'); }
  return normaliseInvoicesView(value);
}

// A LIKE pattern that matches the text anywhere, with its wildcards escaped.
const containing = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function isRealDate(value) {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function optionalText(raw, name) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw invalid(`${name} must be text`);
  if (raw.length > MAX_TEXT) throw invalid(`${name} is too long (${MAX_TEXT} characters at most)`);
  return raw.trim() || null;
}

function optionalDate(raw, name) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !isRealDate(raw)) throw invalid(`${name} must be a date, YYYY-MM-DD`);
  return raw;
}

function requireBodyId(raw, name) {
  if (typeof raw !== 'string' || !UUID.test(raw)) throw invalid(`${name} must be a Flow id`);
  return raw;
}

function readLines(raw) {
  if (!Array.isArray(raw)) throw invalid('lines must be a list');
  if (raw.length > MAX_LINES) throw invalid(`an invoice has ${MAX_LINES} lines at most`);
  return raw.map((line, index) => {
    const at = `line ${index + 1}`;
    if (!line || typeof line !== 'object' || Array.isArray(line)) throw invalid(`${at} must be an object`);
    const out = {};
    if (line.priceItemId !== undefined && line.priceItemId !== null) out.priceItemId = requireBodyId(line.priceItemId, `${at}: priceItemId`);
    // A blank description takes the price item's name.
    const description = optionalText(line.description, `${at}: description`);
    if (description) out.description = description;
    if (line.quantity !== undefined) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) {
        throw invalid(`${at}: quantity must be a whole number from 1 to ${MAX_QUANTITY}`);
      }
      out.quantity = line.quantity;
    }
    if (line.unitAmountCents !== undefined && line.unitAmountCents !== null) {
      if (!Number.isInteger(line.unitAmountCents) || Math.abs(line.unitAmountCents) > MAX_UNIT_CENTS) {
        throw invalid(`${at}: unitAmountCents must be whole cents`);
      }
      out.unitAmountCents = line.unitAmountCents;
    }
    if (line.taxCode !== undefined && line.taxCode !== null) {
      if (!TAX_CODES.includes(line.taxCode)) throw invalid(`${at}: taxCode must be one of ${TAX_CODES.join(', ')}`);
      out.taxCode = line.taxCode;
    }
    return out;
  });
}

// The server's own calendar date.
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The organisation a request is about: the one it names, or the only one.
export async function resolveOrganisation(db, raw) {
  if (raw !== undefined && raw !== null && raw !== '') {
    const organisationId = text(raw);
    if (!UUID.test(organisationId)) throw invalid('organisationId must be a Flow organisation id');
    const [row] = await db.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, organisationId));
    if (!row) throw new FlowError('not_found', 'organisation not found');
    return organisationId;
  }
  const rows = await db.select({ id: organisations.id }).from(organisations).limit(2);
  if (rows.length === 1) return rows[0].id;
  throw new FlowError('organisation_required', rows.length
    ? 'This installation has more than one organisation: say which one (organisationId).'
    : 'This installation has no organisation yet.');
}

const jobOf = (o) => (o ? {
  id: o.id, sourceSystem: o.sourceSystem, sourceJobRef: o.sourceJobRef, sourceInvoiceRef: o.sourceInvoiceRef, caseRef: o.caseRef, practitioner: o.practitioner, shippedOn: o.shippedOn,
  noChargeReason: o.noChargeReason ?? null, accountingRef: o.accountingRef ?? null, jobDate: o.jobDate ?? null,
} : null);

// A job with its work system's name and its link in that system's web app
// (jobLink: no live call), for the Linked column.
function withLink(job, systems) {
  if (!job) return null;
  const source = systems.find((a) => a.id === job.sourceSystem) ?? null;
  const link = typeof source?.capabilities.jobLink === 'function' ? source.capabilities.jobLink({ sourceJobRef: job.sourceJobRef }) : null;
  return { ...job, systemName: source?.name ?? job.sourceSystem, link: link ?? null };
}

// The connected systems an invoice can link to: work systems, then the
// accounting system.
const linkedSystems = (work, accounting) => [
  ...work.map((a) => ({ id: a.id, name: a.name, kind: 'work' })),
  ...(accounting ? [{ id: accounting.id, name: accounting.name, kind: 'accounting' }] : []),
];

async function jobsByInvoice(db, organisationId, invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const rows = await db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), inArray(billingObligations.invoiceId, invoiceIds)));
  return new Map(rows.map((o) => [o.invoiceId, jobOf(o)]));
}

// The job changed after its invoice was made (ledger.js, jobChangeFor): what
// changed, with customer names, and the work system's link to the job.
async function jobChangeDetail(db, organisationId, invoiceId, work) {
  const change = await jobChangeFor(db, organisationId, invoiceId);
  if (!change) return null;
  let contact = null;
  if (change.contact) {
    const ids = [change.contact.was, change.contact.now].filter(Boolean);
    const rows = ids.length ? await db.select({ id: contacts.id, name: contacts.name }).from(contacts)
      .where(and(eq(contacts.organisationId, organisationId), inArray(contacts.id, ids))) : [];
    const nameOf = (id) => rows.find((r) => r.id === id)?.name ?? null;
    contact = { was: nameOf(change.contact.was), now: nameOf(change.contact.now) };
  }
  const source = work.find((a) => a.id === change.sourceSystem) ?? null;
  const link = typeof source?.capabilities.jobLink === 'function'
    ? source.capabilities.jobLink({ sourceJobRef: change.sourceJobRef, sourceInvoiceRef: change.sourceInvoiceRef })
    : null;
  return { ...change, contact, systemName: source?.name ?? change.sourceSystem, link: link ?? null, canRecheck: typeof source?.capabilities?.readWorkItem === 'function' };
}

// Each invoice's tab (TABS): Map(id -> tab), the ids on each tab, the
// problems of each pending one and the ones on their way to the accounting
// system. Drafts come from the draft checks (sending.js); issued invoices
// from the accounting system's stages, read from Flow's copy (no calls).
// A draft the checks did not reach (sending.js, CHECK_LIMIT) gets no tab, so
// an unchecked draft never shows as Ready. Each answer is stored on its row
// (saveTabs), with the time it changed.
async function invoiceTabs(db, organisationId, system) {
  const [views, rows, stages] = await Promise.all([
    invoiceViews(db, organisationId, { accounting: system }),
    db.select({ id: invoices.id, status: invoices.status, listTab: invoiceListTabs.tab }).from(invoices)
      .leftJoin(invoiceListTabs, eq(invoiceListTabs.invoiceId, invoices.id))
      .where(eq(invoices.organisationId, organisationId)),
    typeof system?.capabilities?.invoiceStages === 'function' ? system.capabilities.invoiceStages({ organisationId }) : new Map(),
  ]);
  const checked = new Set([...views.toCheck, ...views.ready, ...views.problems.keys(), ...views.nonChargeable.keys()]);
  const tabOf = new Map();
  const emailed = new Set();
  for (const row of rows) {
    if (row.status === 'draft' && !checked.has(row.id)) continue;
    const stage = stages.get(row.id) ?? null;
    tabOf.set(row.id, invoiceTab({ status: row.status, view: viewOf(views, row.id), stage, connected: Boolean(system) }));
    if (emailedStage(stage)) emailed.add(row.id);
  }
  await saveTabs(db, organisationId, rows, tabOf);
  const ids = Object.fromEntries(TABS.map((t) => [t, []]));
  for (const [id, tab] of tabOf) ids[tab].push(id);
  // Each Non-chargeable invoice's reason: the person's, else its rule's.
  const reasonOf = new Map([...views.nonChargeable].map(([id, found]) => [id, found.find((f) => f.reason)?.reason ?? null]));
  return { tabOf, ids, problems: views.problems, sending: views.sending, reasonOf, emailed };
}

function viewOf(views, id) {
  if (views.nonChargeable.has(id)) return 'non_chargeable';
  if (views.problems.has(id)) return 'problem';
  if (views.sending.has(id)) return 'sending';
  return null;
}

// Stores each changed tab, and when it changed (invoice_list_tabs). A draft
// the checks did not reach keeps the tab it had.
async function saveTabs(db, organisationId, rows, tabOf) {
  const changed = rows
    .filter((row) => tabOf.has(row.id) && tabOf.get(row.id) !== (row.listTab ?? null))
    .map((row) => ({ invoiceId: row.id, organisationId, tab: tabOf.get(row.id) }));
  if (!changed.length) return;
  await db.insert(invoiceListTabs).values(changed).onConflictDoUpdate({
    target: invoiceListTabs.invoiceId,
    set: { tab: sql`excluded.tab`, changedAt: sql`now()` },
  });
}

// One invoice's tab, for its page (and its pager).
async function tabOfInvoice(db, organisationId, invoice, view, accounting) {
  const stages = accounting && invoice.status === 'issued' && typeof accounting.capabilities.invoiceStages === 'function'
    ? await accounting.capabilities.invoiceStages({ organisationId, invoiceIds: [invoice.id] }) : new Map();
  return invoiceTab({ status: invoice.status, view, stage: stages.get(invoice.id) ?? null, connected: Boolean(accounting) });
}

async function invoiceDetail(db, organisationId, invoiceId, accounting = null, work = []) {
  const invoice = await getInvoice(db, organisationId, invoiceId);
  const [[contact], versions, jobs, jobChange] = await Promise.all([
    db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts)
      .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, invoice.contactId))),
    listInvoiceVersions(db, organisationId, invoiceId),
    jobsByInvoice(db, organisationId, [invoiceId]),
    jobChangeDetail(db, organisationId, invoiceId, work),
  ]);
  const viewed = await invoiceView(db, organisationId, invoice, { accounting });
  return {
    jobChange,
    ...invoice,
    ...viewed,
    tab: await tabOfInvoice(db, organisationId, invoice, viewed.view, accounting),
    // Where a draft goes when it is sent, and how: this customer's send mode.
    sendsTo: accounting?.name ?? null,
    sendMode: accounting && invoice.status === 'draft'
      ? { mode: await sendModeFor(db, organisationId, invoice.contactId), otherCustomers: 0, ...(await accounting.capabilities.sendStatus({ organisationId })) }
      : null,
    contact: contact ?? null,
    job: withLink(jobs.get(invoiceId) ?? null, work),
    // Lines this invoice has and its job in the work system does not (a
    // rule's added shipping, for example). Flow cannot write lines to the
    // work system, so the page shows the gap until the work system has them.
    sourceGap: await sourceGap(db, organisationId, invoice),
    // Override: may an owner or admin send this draft with its warnings, and
    // the overrides this invoice went with (newest first).
    canOverride: Boolean(accounting) && invoice.status === 'draft' && viewed.view === 'problem' && overridable(viewed.problems),
    problems: viewed.problems.map((p) => ({ ...p, key: problemKey(p) })),
    overrides: await overridesOfInvoice(db, organisationId, invoiceId),
    overrideReasons: OVERRIDE_REASONS,
    // The exceptions people gave this invoice's job, current or ended.
    ruleExceptions: await exceptionsOfInvoice(db, organisationId, invoice),
    // The Linked card: each connected system, and this invoice's link there.
    linksTo: linkedSystems(work, accounting),
    versions: versions.map(({ version, issuedAt, issuedBy }) => ({ version, issuedAt, issuedBy })),
  };
}

async function exceptionsOfInvoice(db, organisationId, invoice) {
  const [job] = await db.select({ id: billingObligations.id }).from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, invoice.id)));
  return job ? jobRuleExceptions(db, organisationId, job.id) : [];
}

async function sourceGap(db, organisationId, invoice) {
  if (invoice.status === 'void') return [];
  const [job] = await db.select({ lines: billingObligations.lines }).from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.invoiceId, invoice.id)));
  if (!job) return [];
  const inSource = new Set((job.lines ?? []).map((l) => l.priceItemId).filter(Boolean));
  return invoice.lines.filter((l) => l.priceItemId && !inSource.has(l.priceItemId))
    .map((l) => ({ description: l.description, quantity: l.quantity, unitAmountCents: l.unitAmountCents }));
}

// A person's Recheck reads a job from its work system at most once in this
// time; a second click inside it answers from Flow's copy.
const RECHECK_GAP_MS = 10 * 1000;

// The buttons here that may call a connected system, and how long each waits
// before it runs again (the action guard, server/integrations/call-guard.js).
// A send or a draft is one at a time, and a draft waits per job, so ticking
// many jobs still works. Check prices reads Flow's copies only, so it has no
// wait.
export const INVOICING_ACTIONS = Object.freeze({
  sendReady: { cooldownMs: 0, budget: false },
  sendAgain: { cooldownMs: 0, budget: false },
  draftJob: { cooldownMs: 10_000, budget: false },
  // One invoice, one press: the wait is for that invoice.
});

export function createInvoicingRouter({
  db, personAuth, log = console, liveCheckFor = () => null, accounting = () => null, work = () => [], priceSystems = () => [],
  buttonCooldowns = true, actions = createActionGuard({ integration: 'invoicing', actions: INVOICING_ACTIONS, off: !buttonCooldowns }),
}) {
  const router = express.Router();
  const act = (name, key) => actions.route(name, { key });
  router.use(express.json({ limit: '64kb' }));
  const rechecked = new Map();

  const signedIn = [personAuth.requireSession];
  const manager = [...signedIn, personAuth.requireRole('owner', 'admin')];
  // An owner or admin in person: an assistant's key is refused.
  const managerInPerson = [...manager, personAuth.requirePerson];
  const organisationOf = (req) => resolveOrganisation(db, req.method === 'GET' ? req.query.organisationId : (req.body?.organisationId ?? req.query.organisationId));

  router.get('/context', ...signedIn, handle(log, async (req, res) => {
    const rows = await db.select({
      id: organisations.id, name: organisations.name, invoicePrefix: organisations.invoicePrefix, nextInvoiceNumber: organisations.nextInvoiceNumber,
    }).from(organisations).orderBy(asc(organisations.name));
    // sendsTo: the accounting system a sent invoice goes to, or null.
    res.json({ ok: true, organisations: rows, canIssue: ['owner', 'admin'].includes(req.person.role), sendsTo: accounting()?.name ?? null });
  }));

  router.get('/invoices', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const asked = text(req.query.status);
    const status = OLD_TABS[asked] ?? asked;
    if (status && !TABS.includes(status) && !INVOICE_STATUSES.includes(status)) {
      throw invalid(`status must be one of ${TABS.join(', ')}`);
    }
    const q = text(req.query.q);
    // The list pages on the server, so it works with any number of invoices:
    // the tab and the search pick rows, the Filter chip's view and the sort
    // (job-view.js, the page's own rules) run over all of them, and one page
    // goes back with the total.
    const limit = limitOf(req.query.limit, 200, 500);
    const offset = offsetOf(req.query.offset);
    const view = filterViewOf(req.query.filter);
    const sort = text(req.query.sort) || null;
    if (sort && !INVOICE_SORTS.includes(sort)) throw invalid(`sort must be one of ${INVOICE_SORTS.join(', ')}`);
    const dir = text(req.query.dir) || 'asc';
    if (!['asc', 'desc'].includes(dir)) throw invalid('dir must be asc or desc');
    // The person's own day, for date filters such as This week.
    const day = text(req.query.today) || new Date().toISOString().slice(0, 10);
    if (!isRealDate(day)) throw invalid('today must be a date (yyyy-mm-dd)');
    // Each tab switch runs this, so the independent reads run side by side.
    const system = accounting();
    const sendMode = system
      ? Promise.all([sendModeSummary(db, organisationId), system.capabilities.sendStatus({ organisationId })])
        .then(([summary, sendStatus]) => ({ ...summary, ...sendStatus }))
      : null;
    const [tabs, mode] = await Promise.all([invoiceTabs(db, organisationId, system), sendMode]);
    const where = [eq(invoices.organisationId, organisationId)];
    const only = (ids) => (ids.length ? inArray(invoices.id, ids) : sql`false`);
    if (TABS.includes(status)) where.push(only(tabs.ids[status]));
    else if (status) where.push(eq(invoices.status, status));
    if (q) {
      const pattern = containing(q);
      where.push(or(ilike(invoices.number, pattern), ilike(invoices.reference, pattern), ilike(contacts.name, pattern)));
    }
    // First the columns the filter and sort read, for every row; then the
    // whole rows of the one page. A job column and a custom field read the
    // invoice's job, so those values are on every row before the page is cut.
    const lightRows = await db.select({
      id: invoices.id, number: invoices.number, reference: invoices.reference, issueDate: invoices.issueDate,
      dueDate: invoices.dueDate, createdAt: invoices.createdAt, totalCents: invoices.totalCents, contactName: contacts.name,
    }).from(invoices)
      .leftJoin(contacts, eq(contacts.id, invoices.contactId))
      .where(and(...where))
      .orderBy(desc(invoices.createdAt), desc(invoices.id));
    const jobs = await jobsByInvoice(db, organisationId, lightRows.map((r) => r.id));
    const customOn = filterRows(view).some((f) => fieldIdOf(f.field));
    const [fieldDefs, fieldValues] = customOn
      ? await Promise.all([
        listFields(db, organisationId),
        listJobFieldValues(db, organisationId, { jobs: [...jobs.values()].filter(Boolean) }),
      ])
      : [[], []];
    const valuesOf = new Map();
    for (const v of fieldValues) {
      const key = `${v.sourceSystem}\u0000${v.sourceJobRef}`;
      const bag = valuesOf.get(key) ?? {};
      bag[v.fieldId] = v.value;
      valuesOf.set(key, bag);
    }
    const light = lightRows.map((row) => {
      const job = jobs.get(row.id) ?? null;
      return {
        ...row,
        problems: tabs.problems.get(row.id) ?? [],
        tab: tabs.tabOf.get(row.id) ?? null,
        sending: tabs.sending.has(row.id),
        noChargeReason: tabs.reasonOf.get(row.id) ?? null,
        job,
        fields: job ? valuesOf.get(`${job.sourceSystem}\u0000${job.sourceJobRef}`) ?? {} : {},
      };
    });
    const page = invoicePage(light, { view, sort, dir, offset, limit, today: day, kindOf: invoiceKindOf(fieldDefs), me: req.person.id });
    const pageIds = page.rows.map((r) => r.id);
    const full = pageIds.length
      ? await db.select({ invoice: invoices, contactName: contacts.name }).from(invoices)
        .leftJoin(contacts, eq(contacts.id, invoices.contactId))
        .where(and(eq(invoices.organisationId, organisationId), inArray(invoices.id, pageIds)))
      : [];
    const byId = new Map(full.map((r) => [r.invoice.id, r]));
    const rows = pageIds.map((id) => byId.get(id)).filter(Boolean);
    const systems = work();
    res.json({
      ok: true,
      invoices: rows.map(({ invoice, contactName }) => ({
        ...invoice,
        contactName,
        job: withLink(jobs.get(invoice.id) ?? null, systems),
        tab: tabs.tabOf.get(invoice.id) ?? null,
        // Awaiting payment: the accounting system emailed it to the customer.
        emailed: tabs.emailed.has(invoice.id),
        sending: tabs.sending.has(invoice.id),
        noChargeReason: tabs.reasonOf.get(invoice.id) ?? null,
        problems: tabs.problems.get(invoice.id) ?? [],
      })),
      counts: Object.fromEntries(TABS.map((t) => [t, tabs.ids[t].length])),
      // The page: where it starts, its size, and every row the filter keeps.
      offset,
      limit,
      total: page.total,
      totalCents: page.totalCents,
      // The Filter chip's choices, from every row of the tab.
      clients: [...new Set(light.map((r) => r.contactName).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      practitioners: [...new Set(light.map((r) => r.job?.practitioner).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      reasons: [...new Set(light.map((r) => r.noChargeReason).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      sendsTo: system?.name ?? null,
      sendMode: mode,
      // The Linked column: one icon for each connected system.
      linksTo: linkedSystems(systems, system),
    });
  }));

  const invoiceIdsOf = (body) => {
    const ids = body?.invoiceIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((id) => UUID.test(String(id)))) {
      throw invalid('invoiceIds must list 1 to 500 invoice ids');
    }
    return [...new Set(ids)];
  };

  // Anyone who drafts may say a draft is checked; issuing and sending stay
  // with an owner or admin.
  router.post('/invoices/mark-ready', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const result = await markReady(db, organisationId, invoiceIdsOf(req.body), { personId: req.person.id, accounting: accounting() });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} marked ${result.marked} invoice(s) ready`);
    res.json({ ok: true, ...result });
  }));

  router.post('/invoices/mark-not-ready', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    res.json({ ok: true, ...(await markNotReady(db, organisationId, invoiceIdsOf(req.body))) });
  }));

  router.post('/invoices/send-ready', ...manager, act('sendReady'), handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const issueDate = optionalDate(req.body?.issueDate, 'issueDate') ?? today();
    const ids = req.body?.invoiceIds === undefined ? null : invoiceIdsOf(req.body);
    // Read before act (issue #141) reads each old job from the work system that can.
    const reader = work().find((a) => typeof a.capabilities.readWorkItem === 'function') ?? null;
    // Optional: 'approve_and_email' or 'accounting_draft' for this press only.
    const sendMode = req.body?.sendMode ?? null;
    const result = await sendAllReady(db, organisationId, { accounting: accounting(), work: reader, personId: req.person.id, issueDate, invoiceIds: ids, sendMode });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} sent all ready${sendMode ? ` as ${sendMode}` : ''}: ${JSON.stringify(result)}`);
    res.json({ ok: true, ...result });
  }));

  router.post('/invoices/send-again', ...manager, act('sendAgain'), handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const ids = req.body?.invoiceIds === undefined ? null : invoiceIdsOf(req.body);
    const result = await sendAgain(db, organisationId, { accounting: accounting(), personId: req.person.id, invoiceIds: ids });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} sent again: ${JSON.stringify(result)}`);
    res.json({ ok: true, ...result });
  }));

  // Override (docs/INVOICE_SENDING.md, "Override"): one Pending draft goes
  // although it has a warning. One invoice a press, a person only.
  router.post('/invoices/:id/send-anyway', ...managerInPerson, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    const issueDate = optionalDate(req.body?.issueDate, 'issueDate') ?? today();
    const reader = work().find((a) => typeof a.capabilities.readWorkItem === 'function') ?? null;
    const { override } = await sendAnyway(db, organisationId, invoiceId, {
      accounting: accounting(), work: reader, personId: req.person.id, issueDate,
      acknowledged: req.body?.acknowledged, reasonCode: req.body?.reasonCode, note: req.body?.note ?? null,
    });
    // The log names ids and codes only: no note, no customer.
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} sent invoice ${invoiceId} with an override ${override.id}: ${override.problems.map((p) => p.code).join(', ')}`);
    res.json({ ok: true, override: { id: override.id }, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting(), work()) });
  }));

  router.get('/invoices/:id', ...signedIn, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting(), work()) });
  }));

  router.get('/invoices/:id/pdf', ...signedIn, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    const version = req.query.version === undefined ? null : Number(req.query.version);
    if (version !== null && !(Number.isSafeInteger(version) && version > 0)) throw invalid('version must be a whole number above 0');
    const source = await invoicePdfDocument(db, organisationId, invoiceId, { version, accounting: accounting() });
    const bytes = await renderInvoicePdf(source);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${pdfFilename(pdfFields(source))}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(bytes);
  }));

  router.post('/invoices', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const body = req.body ?? {};
    const draft = await createDraftInvoice(db, organisationId, {
      contactId: requireBodyId(body.contactId, 'contactId'),
      reference: optionalText(body.reference, 'reference'),
      dueDate: optionalDate(body.dueDate, 'dueDate'),
      lines: body.lines === undefined ? [] : readLines(body.lines),
    });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} made draft invoice ${draft.id}`);
    res.status(201).json({ ok: true, invoice: await invoiceDetail(db, organisationId, draft.id, accounting(), work()) });
  }));

  router.patch('/invoices/:id', ...signedIn, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    const body = req.body ?? {};
    const changes = {};
    if (body.contactId !== undefined) changes.contactId = requireBodyId(body.contactId, 'contactId');
    if (body.reference !== undefined) changes.reference = optionalText(body.reference, 'reference');
    if (body.dueDate !== undefined) changes.dueDate = optionalDate(body.dueDate, 'dueDate');
    if (body.lines !== undefined) changes.lines = readLines(body.lines);
    if (!Object.keys(changes).length) throw invalid('nothing to change: send contactId, reference, dueDate or lines');
    await updateDraftInvoice(db, organisationId, invoiceId, changes);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting(), work()) });
  }));

  router.post('/invoices/:id/issue', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    const issueDate = optionalDate(req.body?.issueDate, 'issueDate') ?? today();
    // A draft whose job changed after it was made waits for a person to fix
    // the job at its source or adopt the change (ledger.js), as Move to
    // Ready and Send do.
    const { problems, nonChargeable } = await invoiceView(db, organisationId, await getInvoice(db, organisationId, invoiceId));
    // A non-chargeable draft is never billed (invoice-rules.js).
    if (nonChargeable?.length) throw new FlowError('not_ready', `${nonChargeable[0].message} Nothing was approved.`);
    // A lab's pending rule, or a skip rule the job matches (invoice-rules.js),
    // is a gate too: fix its cause, void the draft, or turn the rule off.
    const held = problems.find((p) => p.code === 'job_review' || p.code === 'rule');
    if (held) throw new FlowError('not_ready', `${held.message.replace(/\.?$/, '.')} Nothing was approved.`);
    const issued = await issueInvoice(db, organisationId, invoiceId, { issuedBy: `person:${req.person.id}`, issueDate });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} issued invoice ${issued.number} (version ${issued.issuedVersion})`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting(), work()) });
  }));

  router.post('/invoices/:id/revise', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    await reviseInvoice(db, organisationId, invoiceId);
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} opened invoice ${invoiceId} for revision`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting(), work()) });
  }));

  router.post('/invoices/:id/void', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    await voidInvoice(db, organisationId, invoiceId);
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} voided invoice ${invoiceId}`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting(), work()) });
  }));

  router.delete('/invoices/:id', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    const removed = await deleteDraft(db, organisationId, invoiceId, { actor: `person:${req.person.id}`, accounting: accounting() });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} ${removed.removed ? `deleted invoice ${removed.number}, never sent,` : removed.status === 'void' ? 'voided invoice' : 'deleted draft invoice'} ${invoiceId}`);
    res.json({ ok: true });
  }));

  router.get('/contacts', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const kind = text(req.query.kind);
    if (kind && !['customer', 'supplier', 'all'].includes(kind)) throw invalid('kind must be customer, supplier or all');
    const active = text(req.query.active);
    if (active && !['true', 'false', 'all'].includes(active)) throw invalid('active must be true, false or all');
    const hidden = text(req.query.hidden);
    if (hidden && !['true', 'false', 'all'].includes(hidden)) throw invalid('hidden must be true, false or all');
    const rows = await listContacts(db, organisationId, {
      q: text(req.query.q),
      kind: kind === 'all' ? null : (kind || 'customer'),
      active: active === 'all' ? null : active === 'false' ? false : true,
      hidden: hidden === 'all' ? null : hidden === 'true',
      limit: limitOf(req.query.limit, 50, 500),
      offset: offsetOf(req.query.offset),
    });
    res.json({ ok: true, contacts: rows });
  }));

  router.post('/contacts', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const contact = presentContact(await createContact(db, organisationId, req.body ?? {}));
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} created contact ${contact.id}`);
    res.status(201).json({ ok: true, contact });
  }));

  router.get('/contacts/:id', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    res.json({ ok: true, contact: presentContact(await getContact(db, organisationId, pathId(req.params.id, 'contact'))) });
  }));

  router.patch('/contacts/:id', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const contact = presentContact(await updateContact(db, organisationId, pathId(req.params.id, 'contact'), req.body ?? {}));
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} updated contact ${contact.id}`);
    res.json({ ok: true, contact });
  }));

  // Merge two contacts: this one stays; `fromId` moves into it
  // (docs/CONTACTS.md, "Merge two contacts").
  router.post('/contacts/:id/merge', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const keepId = pathId(req.params.id, 'contact');
    const fromId = text(req.body?.fromId);
    if (!UUID.test(fromId)) throw invalid('fromId must name the contact to merge');
    const result = await mergeContacts(db, organisationId, { keepId, fromId, actor: `person:${req.person.id}` });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} merged contact ${fromId} into ${keepId}`);
    res.json({ ok: true, ...result, contact: presentContact(await getContact(db, organisationId, keepId)) });
  }));

  router.get('/price-items', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const q = text(req.query.q);
    const where = [eq(priceItems.organisationId, organisationId), isNull(priceItems.archivedAt)];
    if (q) where.push(or(ilike(priceItems.code, containing(q)), ilike(priceItems.name, containing(q))));
    const rows = await db.select({
      id: priceItems.id, code: priceItems.code, name: priceItems.name, unitAmountCents: priceItems.unitAmountCents, taxCode: priceItems.taxCode,
    }).from(priceItems).where(and(...where)).orderBy(asc(priceItems.code));
    res.json({ ok: true, priceItems: rows });
  }));

  router.get('/jobs', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const view = text(req.query.view);
    if (view && !VIEWS.includes(view)) throw invalid(`view must be one of ${VIEWS.join(', ')}`);
    const limit = limitOf(req.query.limit, 200, 500);
    const listedAll = await listObligations(db, organisationId, { accounting: Boolean(liveCheckFor(organisationId)) });
    // Held history jobs (core/history.js) are left out unless asked for: they
    // are past work, listed in the history import's own reconciliation.
    const withHistory = req.query.history === 'include';
    const all = withHistory ? listedAll : listedAll.filter((entry) => !isHistoryHeld(entry.obligation));
    const counts = Object.fromEntries(VIEWS.map((v) => [v, 0]));
    counts.history = listedAll.length - listedAll.filter((entry) => !isHistoryHeld(entry.obligation)).length;
    for (const entry of all) counts[entry.view] += 1;
    const listed = (view ? all.filter((entry) => entry.view === view) : all).slice(0, limit);
    res.json({ ok: true, jobs: await describeObligations(db, organisationId, listed, { accounting: accounting() }), counts });
  }));

  // The Jobs board: the work system's jobs, by its own statuses, each with
  // its billing obligation when it has one (server/core/job-board.js).
  router.get('/board', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const { jobs, statuses } = await boardJobs(db, organisationId, {
      work: work(), accounting: accounting(), live: Boolean(liveCheckFor(organisationId)), log,
    });
    res.json({ ok: true, jobs, statuses, accountingName: accounting()?.name ?? null });
  }));

  router.post('/jobs/:id/draft', ...manager, act('draftJob', (req) => req.params.id), handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    // With no accounting system connected, Flow's own records are the check.
    const liveCheck = liveCheckFor(organisationId) ?? null;
    let [obligation] = await db.select().from(billingObligations)
      .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId)));
    const source = obligation ? work().find((a) => a.id === obligation.sourceSystem) ?? null : null;
    if (obligation) {
      // Read before act (issue #141): an old job report is read again first.
      const read = (await readBeforeAct(db, organisationId, [obligation], { work: source, actor: `person:${req.person.id}` })).get(obligation.id);
      if (read.outcome === 'waiting' || read.outcome === 'review') {
        throw new FlowError('not_ready', 'the draft invoice was refused', { reasons: [read.reason ?? read.obligation.holdReason ?? 'the job needs a look'] });
      }
      obligation = read.obligation;
    }
    const { referenceTemplate: template } = await readInvoicingSettings(db, organisationId);
    const reference = obligation ? await jobReference(db, organisationId, obligation, { template, work: source }) : null;
    const { invoice } = await draftInvoiceForObligation(db, organisationId, obligationId, { liveCheck, actor: `person:${req.person.id}`, reference });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} drafted invoice ${invoice.id} from job ${obligationId}`);
    res.status(201).json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoice.id, accounting(), work()) });
  }));

  // "Use new lines": the job changed in the work system after its draft was
  // made, and only there. Flow changes its own draft; no other system.
  router.post('/jobs/:id/use-new-lines', ...manager, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const { invoice } = await useSourceLines(db, organisationId, obligationId, { actor: `person:${req.person.id}`, accept: req.body?.accept === true });
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoice.id, accounting(), work()) });
  }));

  // "Recheck": a person thinks the work system's copy of this job is old or
  // was wrong and has been fixed there. Flow reads this one job from the work
  // system now (one call, its readWorkItem) into the ledger, as read before
  // act does; a change hold whose job matches the draft again is over. Then
  // the invoice page reloads, so every check runs again. Reads only.
  router.post('/jobs/:id/recheck', ...signedIn, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const [obligation] = await db.select().from(billingObligations)
      .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId)));
    if (!obligation) throw new FlowError('not_found', 'job not found');
    const source = work().find((a) => a.id === obligation.sourceSystem) ?? null;
    if (typeof source?.capabilities?.readWorkItem !== 'function') throw new FlowError('not_ready', 'the work system cannot read one job');
    // One read for each job in RECHECK_GAP_MS, whatever the clicks.
    const last = rechecked.get(obligationId);
    const retryAfter = (entry) => Math.max(1, Math.ceil((RECHECK_GAP_MS - (Date.now() - entry.at)) / 1000));
    let outcome = 'fresh';
    if (last && (last.state === 'reading' || Date.now() - last.at < RECHECK_GAP_MS)) {
      if (last.state !== 'read') {
        const retryAfterSeconds = retryAfter(last);
        throw new FlowError('not_ready', last.state === 'reading'
          ? 'No new source read. The previous recheck is still running. Wait, then recheck again.'
          : 'No new source read. Wait ' + retryAfterSeconds + ' seconds, then recheck again. Previous error: ' + last.error,
        { outcome: last.state === 'reading' ? 'read_in_progress' : 'cached_failed', retryAfterSeconds });
      }
    } else {
      const entry = { at: Date.now(), state: 'reading', error: null };
      rechecked.set(obligationId, entry);
      const actor = 'person:' + req.person.id;
      try {
        const read = (await readBeforeAct(db, organisationId, [obligation], { work: source, actor, force: true })).get(obligationId);
        if (read.outcome === 'waiting') throw new FlowError('not_ready', source.name + ' could not be read: ' + (read.reason ?? 'the source is unavailable') + '. Wait, then recheck again.');
        await settleJobChange(db, organisationId, obligationId, { actor });
        entry.state = 'read';
        outcome = 'read';
      } catch (error) {
        entry.state = 'failed';
        entry.error = error instanceof FlowError ? error.message : 'The source recheck failed. Wait, then recheck again.';
        throw new FlowError('not_ready', entry.error, { retryAfterSeconds: retryAfter(entry) });
      }
    }
    const invoice = obligation.invoiceId ? await invoiceDetail(db, organisationId, obligation.invoiceId, accounting(), work()) : null;
    res.json({ ok: true, outcome, retryAfterSeconds: retryAfter(rechecked.get(obligationId)), invoice });
  }));

  // A job with no invoice whose match is unclear (ledger.js). The linking
  // tool lists the matcher's suggestions, read from the accounting copy;
  // "Make invoice" says there is none yet; "Link" picks one of them.
  // The Reconcile page: Flow's jobs with no Flow invoice, Flow invoices with
  // no job, and one of them beside its possible other side
  // (core/job-match.js). Flow's own records only; no integration is called.
  router.get('/reconcile', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    res.json({ ok: true, ...await listReconcile(db, organisationId) });
  }));

  // The open review queue (core/review.js): daily reconcile days, job
  // changes, links Flow could not prove, failed writes. Read only: each item
  // closes when its cause is fixed (or by the screen that owns it).
  router.get('/review', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const state = text(req.query.state) || 'open';
    if (!['open', 'resolved', 'dismissed'].includes(state)) throw new FlowError('invalid', 'state must be open, resolved or dismissed');
    const kind = text(req.query.kind) || undefined;
    const limit = Math.min(Math.max(Number.parseInt(text(req.query.limit) || '100', 10) || 100, 1), 500);
    const items = await listReview(db, organisationId, { state, kind, limit });
    res.json({ ok: true, items: items.map((r) => ({
      id: r.id, kind: r.kind, entity: r.entity, flowId: r.flowId, systems: r.systems, evidence: r.evidence,
      moneyAtRiskCents: r.moneyAtRiskCents, seenCount: r.seenCount, state: r.state, resolution: r.resolution,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })) });
  }));

  router.get('/jobs/:id/reconcile', ...signedIn, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const [obligation] = await db.select().from(billingObligations)
      .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId)));
    if (!obligation) throw new FlowError('not_found', 'job not found');
    // The Reference Flow would give its invoice, from Flow's own copy only.
    const { referenceTemplate: template } = await readInvoicingSettings(db, organisationId);
    const source = work().find((a) => a.id === obligation.sourceSystem) ?? null;
    const reference = await jobReference(db, organisationId, obligation, { template, work: source });
    const detail = await jobMatchDetail(db, organisationId, obligationId, { reference, q: text(req.query.q) ?? '' });
    res.json({ ok: true, ...detail, job: { ...detail.job, sourceName: source?.name ?? null } });
  }));

  router.get('/invoices/:id/reconcile', ...signedIn, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    res.json({ ok: true, ...await invoiceMatchDetail(db, organisationId, invoiceId, { q: text(req.query.q) ?? '' }) });
  }));

  router.post('/jobs/:id/no-invoice', ...manager, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const job = await confirmNoInvoice(db, organisationId, obligationId, { actor: `person:${req.person.id}`, system: accounting()?.id ?? null });
    res.json({ ok: true, job: { id: job.id, accountingState: job.accountingState } });
  }));

  // Holds a job, sends it to review, or releases it (state "none"). Every
  // change needs a reason, kept in the job's activity.
  router.post('/jobs/:id/hold', ...manager, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const state = text(req.body?.state);
    const reason = text(req.body?.reason);
    if (!['none', 'held', 'review'].includes(state)) throw invalid('state must be none, held or review');
    if (!reason) throw invalid('a reason is required');
    const [current] = await db.select({ holdState: billingObligations.holdState, holdReason: billingObligations.holdReason }).from(billingObligations)
      .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId)));
    if (state === 'none' && isHistoryHeld(current)) {
      throw invalid('this is a history-import hold: settle it with the history import decisions');
    }
    const job = await setHold(db, organisationId, obligationId, { holdState: state, reason, actor: `person:${req.person.id}` });
    res.json({ ok: true, job: { id: job.id, holdState: job.holdState, holdReason: job.holdReason } });
  }));

  // A person says the job's work is not charged, and why (setNoCharge): the
  // reason is one of the lab's No Charge reasons. Null charges it again.
  router.post('/jobs/:id/no-charge', ...manager, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const raw = req.body?.reason ?? null;
    if (raw !== null && typeof raw !== 'string') throw invalid('reason must be a No Charge reason or null');
    const { noChargeReasons } = await readInvoicingSettings(db, organisationId);
    const reason = raw === null || !raw.trim() ? null : noChargeReasons.find((r) => r.toLowerCase() === raw.trim().toLowerCase());
    if (raw !== null && raw.trim() && !reason) throw invalid(`reason must be one of: ${noChargeReasons.join(', ')}`);
    const job = await setNoCharge(db, organisationId, obligationId, { reason, actor: `person:${req.person.id}` });
    res.json({ ok: true, job: { id: job.id, noChargeReason: job.noChargeReason, holdState: job.holdState, readyAt: job.readyAt } });
  }));

  router.post('/no-charge-reasons/rename', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const result = await renameNoChargeReason(db, organisationId, { from: req.body?.from, to: req.body?.to }, { personId: req.person.id });
    res.json({ ok: true, ...result });
  }));

  // Frees a job stuck on a void Flow invoice, or on an accounting invoice that
  // was voided or deleted there. The job goes on hold until a person releases it.
  router.post('/jobs/:id/free', ...manager, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const reason = text(req.body?.reason);
    if (!reason) throw invalid('a reason is required');
    const job = await freeVoidedJob(db, organisationId, obligationId, { actor: `person:${req.person.id}`, reason, system: accounting()?.id ?? null });
    res.json({ ok: true, job: { id: job.id, invoiceId: job.invoiceId, accountingState: job.accountingState, holdState: job.holdState, holdReason: job.holdReason } });
  }));

  // Links a job to a Flow invoice that already exists.
  router.post('/jobs/:id/link', ...manager, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const invoiceId = pathId(text(req.body?.invoiceId) ?? '', 'invoice');
    const job = await linkJobToInvoice(db, organisationId, obligationId, { invoiceId, actor: `person:${req.person.id}` });
    res.json({ ok: true, job: { id: job.id, invoiceId: job.invoiceId } });
  }));

  // An owner or admin unlinks a wrong pair (unlinkJobInvoice). Nothing is
  // voided or written to the accounting system.
  router.post('/jobs/:id/unlink', ...manager, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const job = await unlinkJobInvoice(db, organisationId, obligationId, { reason: text(req.body?.reason), actor: `person:${req.person.id}` });
    res.json({ ok: true, job: { id: job.id, invoiceId: job.invoiceId, holdState: job.holdState } });
  }));

  router.post('/jobs/:id/ready', ...signedIn, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const ready = req.body?.ready ?? true;
    if (typeof ready !== 'boolean') throw invalid('ready must be true or false');
    const job = await setReady(db, organisationId, obligationId, { ready, actor: `person:${req.person.id}` });
    res.json({ ok: true, job: { id: job.id, readyAt: job.readyAt, readyBy: job.readyBy } });
  }));

  // A job's activity for its detail panel: what happened to it, newest
  // first, without the evidence each event keeps.
  router.get('/jobs/:id/activity', ...signedIn, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const { events } = await explainObligation(db, organisationId, obligationId);
    res.json({
      ok: true,
      events: events.slice(-50).reverse().map(({ kind, actor, createdAt }) => ({
        kind, by: actor.startsWith('person:') ? 'person' : actor.startsWith('automation:') ? 'automation' : actor.replace(/^system:/, ''), createdAt,
      })),
    });
  }));

  router.get('/automations', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const place = typeof req.query.place === 'string' ? req.query.place : null;
    const list = await listAutomations(db, organisationId);
    res.json({ ok: true, automations: place ? list.filter((a) => a.place === place) : list });
  }));

  router.get('/work-statuses', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    res.json({ ok: true, statuses: await workStatuses(db, organisationId) });
  }));

  router.put('/automations/:key', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const { organisationId: _named, ...changes } = req.body ?? {};
    const automation = await saveAutomation(db, organisationId, String(req.params.key), changes, { personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} changed automation ${automation.key}`);
    res.json({ ok: true, automation });
  }));

  // The lab's invoice rules (docs/INVOICE_RULES.md).
  router.get('/rules', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    res.json({ ok: true, rules: await listRules(db, organisationId) });
  }));

  // What a rule can name, so people pick every value from a menu: the fields
  // with their tests, and the values Flow already holds for each kind of menu.
  router.get('/rule-fields', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const [statuses, customers, items, practitioners] = await Promise.all([
      workStatuses(db, organisationId),
      db.select({ value: contacts.id, label: contacts.name }).from(contacts)
        .where(and(eq(contacts.organisationId, organisationId), eq(contacts.kind, 'customer'), isNull(contacts.mergedIntoId)))
        .orderBy(asc(contacts.name)).limit(1000),
      db.select({ value: priceItems.code, label: priceItems.name }).from(priceItems)
        .where(and(eq(priceItems.organisationId, organisationId), isNull(priceItems.archivedAt)))
        .orderBy(asc(priceItems.code)).limit(1000),
      // The practitioners on the jobs, as the work system wrote them, most used first.
      db.select({ value: billingObligations.practitioner, n: sql`count(*)::int` }).from(billingObligations)
        .where(and(eq(billingObligations.organisationId, organisationId), sql`coalesce(trim(${billingObligations.practitioner}), '') <> ''`))
        .groupBy(billingObligations.practitioner).orderBy(sql`count(*) desc`, asc(billingObligations.practitioner)).limit(500),
    ]);
    res.json({
      ok: true,
      fields: Object.entries(FIELDS).map(([key, f]) => ({
        key, label: f.label, kind: f.kind, options: f.options ?? null, tests: f.tests ?? TESTS[f.kind], draftOnly: Boolean(f.draftOnly),
      })),
      actions: ACTIONS,
      options: {
        statuses: statuses.map((s) => ({ value: s.value, label: s.label })),
        practitioners: practitioners.map((p) => ({ value: p.value, label: `${p.value} (${p.n})` })),
        customers,
        items: [
          ...items.map((i) => ({ value: i.value, label: `${i.value} · ${i.label}` })),
          ...(await listMappings(db, organisationId)).filter((m) => m.kind === 'account')
            .map((m) => ({ value: m.label, label: `${m.label} · ${m.description ?? `account ${m.accountCode}`}` })),
        ],
      },
    });
  }));

  router.post('/rules', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const { organisationId: _named, ...raw } = req.body ?? {};
    const rule = await createRule(db, organisationId, raw, { personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} added invoice rule ${rule.id}`);
    res.status(201).json({ ok: true, rule });
  }));

  router.put('/rules/:id', ...manager, handle(log, async (req, res) => {
    const ruleId = pathId(req.params.id, 'rule');
    const organisationId = await organisationOf(req);
    const { organisationId: _named, ...changes } = req.body ?? {};
    const rule = await updateRule(db, organisationId, ruleId, changes, { personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} changed invoice rule ${rule.id}`);
    res.json({ ok: true, rule });
  }));

  router.delete('/rules/:id', ...manager, handle(log, async (req, res) => {
    const ruleId = pathId(req.params.id, 'rule');
    const organisationId = await organisationOf(req);
    await deleteRule(db, organisationId, ruleId);
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} deleted invoice rule ${ruleId}`);
    res.json({ ok: true });
  }));

  // Exceptions (docs/INVOICE_RULES.md): each job a person let through although
  // the rule matched, with who, when and why.
  router.get('/rules/:id/exceptions', ...signedIn, handle(log, async (req, res) => {
    const ruleId = pathId(req.params.id, 'rule');
    const organisationId = await organisationOf(req);
    res.json({ ok: true, exceptions: await listRuleExceptions(db, organisationId, ruleId) });
  }));

  router.delete('/rules/:id/exceptions/:exceptionId', ...manager, handle(log, async (req, res) => {
    const ruleId = pathId(req.params.id, 'rule');
    const exceptionId = pathId(req.params.exceptionId, 'exception');
    const organisationId = await organisationOf(req);
    await removeRuleException(db, organisationId, ruleId, exceptionId, { actor: `person:${req.person.id}` });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} removed exception ${exceptionId} from rule ${ruleId}`);
    res.json({ ok: true });
  }));

  // A Pending draft's rule fix: add the rule's item, or skip with a reason.
  router.post('/invoices/:id/rules/:ruleId/add-item', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const ruleId = pathId(req.params.ruleId, 'rule');
    const organisationId = await organisationOf(req);
    await addRuleItem(db, organisationId, invoiceId, ruleId);
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} added rule ${ruleId}'s item to invoice ${invoiceId}`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting(), work()) });
  }));

  router.post('/invoices/:id/rules/:ruleId/exception', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const ruleId = pathId(req.params.ruleId, 'rule');
    const organisationId = await organisationOf(req);
    await exceptDraft(db, organisationId, invoiceId, ruleId, { reason: req.body?.reason, actor: `person:${req.person.id}` });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} made an exception to rule ${ruleId} for invoice ${invoiceId}`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting(), work()) });
  }));

  router.post('/jobs/:id/rules/:ruleId/exception', ...manager, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const ruleId = pathId(req.params.ruleId, 'rule');
    const organisationId = await organisationOf(req);
    const exception = await exceptJob(db, organisationId, obligationId, ruleId, { reason: req.body?.reason, actor: `person:${req.person.id}` });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} made an exception to rule ${ruleId} for job ${obligationId}`);
    res.json({ ok: true, exception });
  }));

  router.get('/line-mappings', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    res.json({ ok: true, mappings: await listMappings(db, organisationId), steps: STEPS.map((key) => ({ key, label: STEP_LABELS[key] })) });
  }));

  // Each label the line mapping saw on jobs, how many lines carry it, a
  // sample of the work system's text and price, and whether it mapped.
  router.get('/line-labels', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const rows = (await db.execute(sql`
      select l->>'label' as label, count(*)::int as lines,
        count(*) filter (where l->>'priceItemId' is null and l->>'accountCode' is null and l->>'mappedBy' is distinct from 'placeholder')::int as unmapped,
        min(l->>'description') as sample, min((l->>'unitAmountCents')::int) as "unitAmountCents",
        min(l->>'mappedBy') as "mappedBy", min(l->>'itemCode') as "itemCode"
      from billing_obligations o, jsonb_array_elements(o.lines) l
      where o.organisation_id = ${organisationId} and l->>'label' is not null
      group by 1 order by 3 desc, 2 desc, 1 limit 1000`)).rows ?? [];
    // The lines that wait, by their own label, price and work system code:
    // one label can wait at several prices, and its mapped lines do not count.
    const waiting = (await db.execute(sql`
      select l->>'label' as label, (l->>'unitAmountCents')::int as "unitAmountCents", l->>'workCode' as code,
        min(l->>'description') as sample, count(*)::int as lines, count(distinct o.id)::int as jobs,
        (count(distinct o.id) filter (where o.invoice_id is null))::int as "jobsToInvoice"
      from billing_obligations o, jsonb_array_elements(o.lines) l
      where o.organisation_id = ${organisationId} and l->>'label' is not null
        and l->>'priceItemId' is null and l->>'accountCode' is null and l->>'mappedBy' is distinct from 'placeholder'
      group by 1, 2, 3 order by 7 desc, 5 desc, 1, 2 limit 1000`)).rows ?? [];
    // A waiting code that is a product of a connected work system: linking the
    // product (the price list's link) maps its lines at every price.
    const products = new Map();
    if (waiting.some((row) => row.code)) {
      for (const catalogue of (await catalogues(organisationId)).values()) {
        if (catalogue.unread || catalogue.kind !== 'work') continue;
        for (const record of catalogue.items) {
          if (record.code && !products.has(String(record.code))) products.set(String(record.code), { system: catalogue.id, externalId: String(record.id), unitAmountCents: record.unitAmountCents ?? null });
        }
      }
    }
    res.json({ ok: true, labels: rows, waiting: waiting.map((row) => ({ ...row, product: (row.code && products.get(row.code)) || null })) });
  }));

  router.post('/line-mappings', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const { organisationId: _named, ...raw } = req.body ?? {};
    const mapping = await createMapping(db, organisationId, raw, { personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} added line mapping ${mapping.id}`);
    res.status(201).json({ ok: true, mapping });
  }));

  router.put('/line-mappings/:id', ...manager, handle(log, async (req, res) => {
    const mappingId = pathId(req.params.id, 'mapping');
    const organisationId = await organisationOf(req);
    const { organisationId: _named, ...changes } = req.body ?? {};
    const mapping = await updateMapping(db, organisationId, mappingId, changes, { personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} changed line mapping ${mapping.id}`);
    res.json({ ok: true, mapping });
  }));

  router.delete('/line-mappings/:id', ...manager, handle(log, async (req, res) => {
    const mappingId = pathId(req.params.id, 'mapping');
    const organisationId = await organisationOf(req);
    await deleteMapping(db, organisationId, mappingId);
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} deleted line mapping ${mappingId}`);
    res.json({ ok: true });
  }));

  // The price list (server/core/price-list.js). Every read is from Flow's own
  // copies of the connected systems' lists.
  const catalogues = (organisationId) => readCatalogues(organisationId, priceSystems(), { log });

  router.get('/price-list', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    res.json({ ok: true, ...(await readPriceList(db, organisationId, { catalogues: await catalogues(organisationId) })) });
  }));

  router.post('/price-list/check', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const summary = await checkPrices(db, organisationId, { catalogues: await catalogues(organisationId), actor: `person:${req.person.id}` });
    res.json({ ok: true, summary });
  }));

  router.post('/price-items', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const { organisationId: _named, ...raw } = req.body ?? {};
    const item = await createPriceItem(db, organisationId, raw, { personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} added price item ${item.id}`);
    res.status(201).json({ ok: true, item });
  }));

  router.put('/price-items/:id', ...manager, handle(log, async (req, res) => {
    const itemId = pathId(req.params.id, 'price item');
    const organisationId = await organisationOf(req);
    const { organisationId: _named, ...changes } = req.body ?? {};
    const item = await updatePriceItem(db, organisationId, itemId, changes, { personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} changed price item ${item.id}`);
    res.json({ ok: true, item });
  }));

  router.post('/price-items/:id/archive', ...manager, handle(log, async (req, res) => {
    const itemId = pathId(req.params.id, 'price item');
    const organisationId = await organisationOf(req);
    const archived = req.body?.archived ?? true;
    if (typeof archived !== 'boolean') throw invalid('archived must be true or false');
    const item = await archivePriceItem(db, organisationId, itemId, { archived, personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} ${archived ? 'archived' : 'restored'} price item ${item.id}`);
    res.json({ ok: true, item });
  }));

  router.post('/price-items/:id/links', ...manager, handle(log, async (req, res) => {
    const itemId = pathId(req.params.id, 'price item');
    const organisationId = await organisationOf(req);
    const system = text(req.body?.system);
    const externalId = text(req.body?.externalId);
    if (!system || !externalId) throw invalid('system and externalId are required');
    const link = await linkPriceItem(db, organisationId, itemId, { system, externalId }, { catalogues: await catalogues(organisationId), personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} linked price item ${itemId} to ${system}`);
    res.status(201).json({ ok: true, link: { id: link.id, system: link.system, externalId: link.externalId, externalCode: link.externalCode, matchedBy: link.matchedBy, ...(link.movedFrom ? { movedFrom: link.movedFrom } : {}) } });
  }));

  router.post('/price-links', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const raw = req.body?.links;
    if (!Array.isArray(raw) || !raw.length || raw.length > MAX_LINKS_AT_ONCE) throw invalid(`links must be a list of 1 to ${MAX_LINKS_AT_ONCE} links`);
    const links = raw.map((l, at) => {
      const system = text(l?.system);
      const externalId = text(l?.externalId);
      if (!system || !externalId) throw invalid(`links[${at}]: system and externalId are required`);
      return { priceItemId: pathId(l?.priceItemId, 'price item'), system, externalId };
    });
    const made = await linkPriceItems(db, organisationId, links, { catalogues: await catalogues(organisationId), personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} made ${made.length} price links`);
    // A link another code had moves; `moved` names each one, so the caller
    // can say which code lost it.
    const moved = made.filter((l) => l.movedFrom).map((l) => ({ priceItemId: l.priceItemId, system: l.system, externalId: l.externalId, movedFrom: l.movedFrom }));
    res.status(201).json({ ok: true, linked: made.length, ...(moved.length ? { moved } : {}) });
  }));

  router.post('/price-items/:id/resolve', ...manager, handle(log, async (req, res) => {
    const itemId = pathId(req.params.id, 'price item');
    const organisationId = await organisationOf(req);
    const result = await acceptFindings(db, organisationId, itemId, { catalogues: await catalogues(organisationId), actor: `person:${req.person.id}` });
    res.json({ ok: true, ...result });
  }));

  router.delete('/price-links/:id', ...manager, handle(log, async (req, res) => {
    const linkId = pathId(req.params.id, 'link');
    const organisationId = await organisationOf(req);
    await unlinkPriceItem(db, organisationId, linkId);
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} removed price link ${linkId}`);
    res.json({ ok: true });
  }));

  router.get('/settings', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    res.json({ ok: true, settings: await readInvoicingSettings(db, organisationId), defaults: INVOICING_DEFAULTS });
  }));

  router.put('/settings', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const { organisationId: _named, ...changes } = req.body ?? {};
    const settings = await saveInvoicingSettings(db, organisationId, changes, { personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} changed invoicing settings ${Object.keys(changes).join(', ')}`);
    res.json({ ok: true, settings, defaults: INVOICING_DEFAULTS });
  }));

  router.get('/contacts/:id/billing', ...signedIn, handle(log, async (req, res) => {
    const contactId = pathId(req.params.id, 'customer');
    const organisationId = await organisationOf(req);
    const [billing, settings] = await Promise.all([readCustomerBilling(db, organisationId, contactId), readInvoicingSettings(db, organisationId)]);
    res.json({ ok: true, billing, effective: effectiveSettings(settings, billing) });
  }));

  router.put('/contacts/:id/billing', ...manager, handle(log, async (req, res) => {
    const contactId = pathId(req.params.id, 'customer');
    const organisationId = await organisationOf(req);
    const { organisationId: _named, ...changes } = req.body ?? {};
    const billing = await saveCustomerBilling(db, organisationId, contactId, changes, { personId: req.person.id });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} changed billing settings of customer ${contactId}`);
    res.json({ ok: true, billing, effective: effectiveSettings(await readInvoicingSettings(db, organisationId), billing) });
  }));

  // A body that is not JSON, or too large, answers like every other refusal.
  router.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ ok: false, code: 'too_large', error: 'The request body is too large.' });
    if (error?.status === 400 || error?.type === 'entity.parse.failed') return res.status(400).json({ ok: false, code: 'invalid', error: 'The request body must be JSON.' });
    return next(error);
  });

  return router;
}
