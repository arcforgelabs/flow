import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import express from 'express';
import { FlowError } from '../core/errors.js';
import {
  createDraftInvoice, getInvoice, issueInvoice, listInvoiceVersions, reviseInvoice, updateDraftInvoice, voidInvoice,
} from '../core/invoices.js';
import { listAutomations, saveAutomation, workStatuses } from '../core/automations.js';
import {
  ACTIONS, createRule, deleteRule, FIELDS, listRules, TESTS, updateRule,
} from '../core/invoice-rules.js';
import {
  createMapping, deleteMapping, listMappings, STEP_LABELS, STEPS, updateMapping,
} from '../core/line-mapping.js';
import {
  effectiveSettings, INVOICING_DEFAULTS, readCustomerBilling, readInvoicingSettings,
  saveCustomerBilling, saveInvoicingSettings, sendModeFor, sendModeSummary,
} from '../core/invoicing-rules.js';
import { boardJobs, describeObligations } from '../core/job-board.js';
import { readBeforeAct } from '../core/read-before-act.js';
import { jobReference } from '../core/references.js';
import {
  acceptFindings, archivePriceItem, checkPrices, createPriceItem, linkPriceItem, readCatalogues, readPriceList, unlinkPriceItem, updatePriceItem,
} from '../core/price-list.js';
import { draftInvoiceForObligation, explainObligation, listObligations, setReady, useSourceLines } from '../core/ledger.js';
import { isHistoryHeld } from '../core/history.js';
import { invoicePdfDocument, pdfFields, pdfFilename, renderInvoicePdf } from '../core/invoice-pdf.js';
import { invoiceView, invoiceViews, markNotReady, markReady, sendAgain, sendAllReady } from '../core/sending.js';
import {
  billingObligations, contacts, invoices, INVOICE_STATUSES, organisations, priceItems, TAX_CODES,
} from '../db/schema.js';

// Invoicing for people signed in to Flow, mounted at /api/invoicing. The web
// UI's invoices, customers, price list and jobs pages read and write here.
//
//   GET   /context                    the organisations, and whether this person may issue
//   GET   /invoices?organisationId=&status=&q=&limit=   newest first, with counts by status;
//                                     status to_check, ready or problem lists those views (server/core/sending.js)
//   POST  /invoices/mark-ready        { invoiceIds }: a person checked these drafts; one with a problem stays
//   POST  /invoices/mark-not-ready    { invoiceIds }: back to To check
//   POST  /invoices/send-ready        owner or admin: issue every ready draft and queue it for the
//                                     accounting system { issueDate, invoiceIds? (only these, each ready) }
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
//   GET   /contacts?q=&limit=         customers, by name
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
//   POST  /rules                      owner or admin: a new rule { name, enabled, conditions, action }
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
//   GET   /automations?place=         Flow's routines, each on or off (server/core/automations.js)
//   PUT   /automations/:key           owner or admin: { enabled, config }
//   GET   /work-statuses              the work system's job statuses, with job counts
//   GET   /contacts/:id/billing       one customer's own invoicing settings
//   PUT   /contacts/:id/billing       owner or admin: change them (null takes the organisation's)
//   POST  /jobs/:id/ready             { ready }: mark a job ready to invoice, or back in work
//   GET   /jobs/:id/activity          what happened to a job, newest first
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
const VIEWS_OF_INVOICES = ['to_check', 'ready', 'problem'];
const VIEWS = ['in_work', 'ready', 'pending', 'drafted', 'invoiced', 'paid', 'held', 'review_required'];
const MAX_LINES = 200;
const MAX_TEXT = 500;
// Each line's amount must fit the database's integer columns with room for
// the invoice total.
const MAX_QUANTITY = 100_000;
const MAX_UNIT_CENTS = 100_000_000;

const ERROR_STATUS = {
  invalid: 400, organisation_required: 400, not_found: 404, not_draft: 409, not_issued: 409,
  never_issued: 409, not_ready: 409, live_check_unavailable: 409, conflict: 409,
  accounting_not_connected: 409, accounting_writes_off: 409,
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
  id: o.id, sourceSystem: o.sourceSystem, sourceJobRef: o.sourceJobRef, caseRef: o.caseRef, practitioner: o.practitioner, shippedOn: o.shippedOn,
} : null);

async function jobsByInvoice(db, organisationId, invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const rows = await db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), inArray(billingObligations.invoiceId, invoiceIds)));
  return new Map(rows.map((o) => [o.invoiceId, jobOf(o)]));
}

async function invoiceDetail(db, organisationId, invoiceId, accounting = null) {
  const invoice = await getInvoice(db, organisationId, invoiceId);
  const [[contact], versions, jobs] = await Promise.all([
    db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts)
      .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, invoice.contactId))),
    listInvoiceVersions(db, organisationId, invoiceId),
    jobsByInvoice(db, organisationId, [invoiceId]),
  ]);
  return {
    ...invoice,
    ...(await invoiceView(db, organisationId, invoice, { accounting })),
    // Where a draft goes when it is sent, and how: this customer's send mode.
    sendsTo: accounting?.name ?? null,
    sendMode: accounting && invoice.status === 'draft'
      ? { mode: await sendModeFor(db, organisationId, invoice.contactId), otherCustomers: 0, ...(await accounting.capabilities.sendStatus({ organisationId })) }
      : null,
    contact: contact ?? null,
    job: jobs.get(invoiceId) ?? null,
    versions: versions.map(({ version, issuedAt, issuedBy }) => ({ version, issuedAt, issuedBy })),
  };
}

export function createInvoicingRouter({
  db, personAuth, log = console, liveCheckFor = () => null, accounting = () => null, work = () => [], priceSystems = () => [],
}) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  const signedIn = [personAuth.requireSession];
  const manager = [...signedIn, personAuth.requireRole('owner', 'admin')];
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
    const status = text(req.query.status);
    if (status && ![...INVOICE_STATUSES, ...VIEWS_OF_INVOICES].includes(status)) {
      throw invalid(`status must be one of ${[...INVOICE_STATUSES, ...VIEWS_OF_INVOICES].join(', ')}`);
    }
    const q = text(req.query.q);
    const limit = limitOf(req.query.limit, 200, 500);
    // Each tab switch runs this, so the independent reads run side by side;
    // only the to-check, ready and problem lists wait on the draft checks.
    const system = accounting();
    const checking = invoiceViews(db, organisationId, { accounting: system });
    const counting = db.select({ status: invoices.status, n: sql`count(*)::int` }).from(invoices)
      .where(eq(invoices.organisationId, organisationId)).groupBy(invoices.status);
    const sendMode = system
      ? Promise.all([sendModeSummary(db, organisationId), system.capabilities.sendStatus({ organisationId })])
        .then(([summary, sendStatus]) => ({ ...summary, ...sendStatus }))
      : null;
    const listing = (async () => {
      const views = VIEWS_OF_INVOICES.includes(status) ? await checking : null;
      const where = [eq(invoices.organisationId, organisationId)];
      const only = (ids) => (ids.length ? inArray(invoices.id, ids) : sql`false`);
      if (status === 'to_check') where.push(only(views.toCheck));
      else if (status === 'ready') where.push(only(views.ready));
      else if (status === 'problem') where.push(only([...views.problems.keys()]));
      else if (status) where.push(eq(invoices.status, status));
      if (q) {
        const pattern = containing(q);
        where.push(or(ilike(invoices.number, pattern), ilike(invoices.reference, pattern), ilike(contacts.name, pattern)));
      }
      const rows = await db.select({ invoice: invoices, contactName: contacts.name }).from(invoices)
        .leftJoin(contacts, eq(contacts.id, invoices.contactId))
        .where(and(...where))
        .orderBy(desc(invoices.createdAt), desc(invoices.id))
        .limit(limit);
      return { rows, jobs: await jobsByInvoice(db, organisationId, rows.map((r) => r.invoice.id)) };
    })();
    const [views, counted, { rows, jobs }, mode] = await Promise.all([checking, counting, listing, sendMode]);
    const counts = Object.fromEntries(INVOICE_STATUSES.map((s) => [s, 0]));
    for (const { status: s, n } of counted) counts[s] = n;
    counts.to_check = views.toCheck.length;
    counts.ready = views.ready.length;
    counts.problem = views.problems.size;
    const ready = new Set(views.ready);
    const toCheck = new Set(views.toCheck);
    res.json({
      ok: true,
      invoices: rows.map(({ invoice, contactName }) => ({
        ...invoice,
        contactName,
        job: jobs.get(invoice.id) ?? null,
        view: views.problems.has(invoice.id) ? 'problem' : ready.has(invoice.id) ? 'ready' : toCheck.has(invoice.id) ? 'to_check'
          : views.sending.has(invoice.id) ? 'sending' : null,
        problems: views.problems.get(invoice.id) ?? [],
      })),
      counts,
      sendsTo: system?.name ?? null,
      sendMode: mode,
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

  router.post('/invoices/send-ready', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const issueDate = optionalDate(req.body?.issueDate, 'issueDate') ?? today();
    const ids = req.body?.invoiceIds === undefined ? null : invoiceIdsOf(req.body);
    // Read before act (issue #141) reads each old job from the work system that can.
    const reader = work().find((a) => typeof a.capabilities.readWorkItem === 'function') ?? null;
    const result = await sendAllReady(db, organisationId, { accounting: accounting(), work: reader, personId: req.person.id, issueDate, invoiceIds: ids });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} sent all ready: ${JSON.stringify(result)}`);
    res.json({ ok: true, ...result });
  }));

  router.post('/invoices/send-again', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const ids = req.body?.invoiceIds === undefined ? null : invoiceIdsOf(req.body);
    const result = await sendAgain(db, organisationId, { accounting: accounting(), personId: req.person.id, invoiceIds: ids });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} sent again: ${JSON.stringify(result)}`);
    res.json({ ok: true, ...result });
  }));

  router.get('/invoices/:id', ...signedIn, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting()) });
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
    res.status(201).json({ ok: true, invoice: await invoiceDetail(db, organisationId, draft.id, accounting()) });
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
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting()) });
  }));

  router.post('/invoices/:id/issue', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    const issueDate = optionalDate(req.body?.issueDate, 'issueDate') ?? today();
    const issued = await issueInvoice(db, organisationId, invoiceId, { issuedBy: `person:${req.person.id}`, issueDate });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} issued invoice ${issued.number} (version ${issued.issuedVersion})`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting()) });
  }));

  router.post('/invoices/:id/revise', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    await reviseInvoice(db, organisationId, invoiceId);
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} opened invoice ${invoiceId} for revision`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting()) });
  }));

  router.post('/invoices/:id/void', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    await voidInvoice(db, organisationId, invoiceId);
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} voided invoice ${invoiceId}`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId, accounting()) });
  }));

  router.get('/contacts', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const q = text(req.query.q);
    const where = [eq(contacts.organisationId, organisationId), eq(contacts.kind, 'customer')];
    if (q) where.push(ilike(contacts.name, containing(q)));
    const rows = await db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts)
      .where(and(...where)).orderBy(asc(contacts.name), asc(contacts.id)).limit(limitOf(req.query.limit, 50, 500));
    res.json({ ok: true, contacts: rows });
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

  router.post('/jobs/:id/draft', ...manager, handle(log, async (req, res) => {
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
    res.status(201).json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoice.id) });
  }));

  // "Use new lines": the job changed in the work system after its draft was
  // made, and only there. Flow changes its own draft; no other system.
  router.post('/jobs/:id/use-new-lines', ...manager, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const { invoice } = await useSourceLines(db, organisationId, obligationId, { actor: `person:${req.person.id}` });
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoice.id) });
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
    const [statuses, customers, items] = await Promise.all([
      workStatuses(db, organisationId),
      db.select({ value: contacts.id, label: contacts.name }).from(contacts)
        .where(and(eq(contacts.organisationId, organisationId), eq(contacts.kind, 'customer')))
        .orderBy(asc(contacts.name)).limit(1000),
      db.select({ value: priceItems.code, label: priceItems.name }).from(priceItems)
        .where(and(eq(priceItems.organisationId, organisationId), isNull(priceItems.archivedAt)))
        .orderBy(asc(priceItems.code)).limit(1000),
    ]);
    res.json({
      ok: true,
      fields: Object.entries(FIELDS).map(([key, f]) => ({ key, label: f.label, kind: f.kind, options: f.options ?? null, tests: TESTS[f.kind] })),
      actions: ACTIONS,
      options: {
        statuses: statuses.map((s) => ({ value: s.value, label: s.label })),
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
        count(*) filter (where l->>'priceItemId' is null and l->>'accountCode' is null)::int as unmapped,
        min(l->>'description') as sample, min((l->>'unitAmountCents')::int) as "unitAmountCents",
        min(l->>'mappedBy') as "mappedBy", min(l->>'itemCode') as "itemCode"
      from billing_obligations o, jsonb_array_elements(o.lines) l
      where o.organisation_id = ${organisationId} and l->>'label' is not null
      group by 1 order by 3 desc, 2 desc, 1 limit 1000`)).rows ?? [];
    res.json({ ok: true, labels: rows });
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
    res.status(201).json({ ok: true, link: { id: link.id, system: link.system, externalId: link.externalId, externalCode: link.externalCode, matchedBy: link.matchedBy } });
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
