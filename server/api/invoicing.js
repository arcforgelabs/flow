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
  customerBillingByContact, effectiveSettings, INVOICING_DEFAULTS, readCustomerBilling, readInvoicingSettings, ruleBlockers,
  saveCustomerBilling, saveInvoicingSettings,
} from '../core/invoicing-rules.js';
import { draftInvoiceForObligation, listObligations, setReady } from '../core/ledger.js';
import { invoiceViews, sendAgain, sendAllReady } from '../core/sending.js';
import {
  billingObligations, contacts, invoices, INVOICE_STATUSES, organisations, priceItems, TAX_CODES,
} from '../db/schema.js';

// Invoicing for people signed in to Flow, mounted at /api/invoicing. The web
// UI's invoices, customers, price list and jobs pages read and write here.
//
//   GET   /context                    the organisations, and whether this person may issue
//   GET   /invoices?organisationId=&status=&q=&limit=   newest first, with counts by status;
//                                     status ready or problem lists those views (server/core/sending.js)
//   POST  /invoices/send-ready        owner or admin: issue every ready draft and queue it for the
//                                     accounting system { issueDate }
//   POST  /invoices/send-again        owner or admin: queue failed sends again { invoiceIds? }
//   GET   /invoices/:id               one invoice: lines, contact, job, issued versions
//   POST  /invoices                   a new draft
//   PATCH /invoices/:id               change a draft
//   POST  /invoices/:id/issue         owner or admin: number it and keep the document as sent
//   POST  /invoices/:id/revise        owner or admin: an issued invoice back to a draft
//   POST  /invoices/:id/void          owner or admin
//   GET   /contacts?q=&limit=         customers, by name
//   GET   /price-items?q=             the price list, by code
//   GET   /jobs?view=&limit=          billable jobs (the obligation ledger), with counts by view;
//                                     a job with no invoice lists the invoicing rules it waits on
//   GET   /settings                   the invoicing settings (server/core/invoicing-rules.js)
//   PUT   /settings                   owner or admin: change some of them
//   GET   /rules                      the lab's invoice rules, in order (server/core/invoice-rules.js)
//   GET   /rule-fields                what a rule can name, and the menus of values
//   POST  /rules                      owner or admin: a new rule { name, enabled, conditions, action }
//   PUT   /rules/:id                  owner or admin: change some of a rule
//   DELETE /rules/:id                 owner or admin
//   GET   /automations?place=         Flow's routines, each on or off (server/core/automations.js)
//   PUT   /automations/:key           owner or admin: { enabled, config }
//   GET   /work-statuses              the work system's job statuses, with job counts
//   GET   /contacts/:id/billing       one customer's own invoicing settings
//   PUT   /contacts/:id/billing       owner or admin: change them (null takes the organisation's)
//   POST  /jobs/:id/ready             { ready }: mark a job ready to invoice, or back in work
//   POST  /jobs/:id/draft             owner or admin: a job's draft invoice, after a live
//                                     check that the accounting system holds none
//
// Every route needs a signed-in, active person; reading and drafting are open
// to every role. `organisationId` (query or body) names the organisation; it
// may be left out while the installation has exactly one. Money is integer
// cents. `liveCheckFor(organisationId)` returns the ledger's live check for
// that organisation, or null when no accounting integration offers one.
// `accounting()` is the accounting adapter that sends invoices, or null.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VIEWS_OF_INVOICES = ['ready', 'problem'];
const VIEWS = ['in_work', 'ready', 'pending', 'drafted', 'invoiced', 'paid', 'held', 'review_required'];
const MAX_LINES = 200;
const MAX_TEXT = 500;
// Each line's amount must fit the database's integer columns with room for
// the invoice total.
const MAX_QUANTITY = 100_000;
const MAX_UNIT_CENTS = 100_000_000;

const ERROR_STATUS = {
  invalid: 400, organisation_required: 400, not_found: 404, not_draft: 409, not_issued: 409,
  never_issued: 409, not_ready: 409, live_check_unavailable: 409,
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

async function invoiceDetail(db, organisationId, invoiceId) {
  const invoice = await getInvoice(db, organisationId, invoiceId);
  const [[contact], versions, jobs] = await Promise.all([
    db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts)
      .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, invoice.contactId))),
    listInvoiceVersions(db, organisationId, invoiceId),
    jobsByInvoice(db, organisationId, [invoiceId]),
  ]);
  return {
    ...invoice,
    contact: contact ?? null,
    job: jobs.get(invoiceId) ?? null,
    versions: versions.map(({ version, issuedAt, issuedBy }) => ({ version, issuedAt, issuedBy })),
  };
}

export function createInvoicingRouter({ db, personAuth, log = console, liveCheckFor = () => null, accounting = () => null }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  const signedIn = [personAuth.requireSession];
  const manager = [...signedIn, personAuth.requireRole('owner', 'admin')];
  const organisationOf = (req) => resolveOrganisation(db, req.method === 'GET' ? req.query.organisationId : (req.body?.organisationId ?? req.query.organisationId));

  router.get('/context', ...signedIn, handle(log, async (req, res) => {
    const rows = await db.select({
      id: organisations.id, name: organisations.name, invoicePrefix: organisations.invoicePrefix, nextInvoiceNumber: organisations.nextInvoiceNumber,
    }).from(organisations).orderBy(asc(organisations.name));
    res.json({ ok: true, organisations: rows, canIssue: ['owner', 'admin'].includes(req.person.role) });
  }));

  router.get('/invoices', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const status = text(req.query.status);
    if (status && ![...INVOICE_STATUSES, ...VIEWS_OF_INVOICES].includes(status)) {
      throw invalid(`status must be one of ${[...INVOICE_STATUSES, ...VIEWS_OF_INVOICES].join(', ')}`);
    }
    const q = text(req.query.q);
    const limit = limitOf(req.query.limit, 200, 500);
    const views = await invoiceViews(db, organisationId, { accounting: accounting() });
    const where = [eq(invoices.organisationId, organisationId)];
    if (status === 'ready') where.push(views.ready.length ? inArray(invoices.id, views.ready) : sql`false`);
    else if (status === 'problem') where.push(views.problems.size ? inArray(invoices.id, [...views.problems.keys()]) : sql`false`);
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
    const jobs = await jobsByInvoice(db, organisationId, rows.map((r) => r.invoice.id));
    const counted = await db.select({ status: invoices.status, n: sql`count(*)::int` }).from(invoices)
      .where(eq(invoices.organisationId, organisationId)).groupBy(invoices.status);
    const counts = Object.fromEntries(INVOICE_STATUSES.map((s) => [s, 0]));
    for (const { status: s, n } of counted) counts[s] = n;
    counts.ready = views.ready.length;
    counts.problem = views.problems.size;
    const ready = new Set(views.ready);
    res.json({
      ok: true,
      invoices: rows.map(({ invoice, contactName }) => ({
        ...invoice,
        contactName,
        job: jobs.get(invoice.id) ?? null,
        view: views.problems.has(invoice.id) ? 'problem' : ready.has(invoice.id) ? 'ready' : views.sending.has(invoice.id) ? 'sending' : null,
        problems: views.problems.get(invoice.id) ?? [],
      })),
      counts,
      sendsTo: accounting()?.name ?? null,
    });
  }));

  router.post('/invoices/send-ready', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const issueDate = optionalDate(req.body?.issueDate, 'issueDate') ?? today();
    const result = await sendAllReady(db, organisationId, { accounting: accounting(), personId: req.person.id, issueDate });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} sent all ready: ${JSON.stringify(result)}`);
    res.json({ ok: true, ...result });
  }));

  router.post('/invoices/send-again', ...manager, handle(log, async (req, res) => {
    const organisationId = await organisationOf(req);
    const ids = req.body?.invoiceIds;
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((id) => UUID.test(String(id))))) {
      throw invalid('invoiceIds must list 1 to 500 invoice ids');
    }
    const result = await sendAgain(db, organisationId, { accounting: accounting(), personId: req.person.id, invoiceIds: ids ?? null });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} sent again: ${JSON.stringify(result)}`);
    res.json({ ok: true, ...result });
  }));

  router.get('/invoices/:id', ...signedIn, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId) });
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
    res.status(201).json({ ok: true, invoice: await invoiceDetail(db, organisationId, draft.id) });
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
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId) });
  }));

  router.post('/invoices/:id/issue', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    const issueDate = optionalDate(req.body?.issueDate, 'issueDate') ?? today();
    const issued = await issueInvoice(db, organisationId, invoiceId, { issuedBy: `person:${req.person.id}`, issueDate });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} issued invoice ${issued.number} (version ${issued.issuedVersion})`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId) });
  }));

  router.post('/invoices/:id/revise', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    await reviseInvoice(db, organisationId, invoiceId);
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} opened invoice ${invoiceId} for revision`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId) });
  }));

  router.post('/invoices/:id/void', ...manager, handle(log, async (req, res) => {
    const invoiceId = pathId(req.params.id, 'invoice');
    const organisationId = await organisationOf(req);
    await voidInvoice(db, organisationId, invoiceId);
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} voided invoice ${invoiceId}`);
    res.json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoiceId) });
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
    const all = await listObligations(db, organisationId, { accounting: Boolean(liveCheckFor(organisationId)) });
    const counts = Object.fromEntries(VIEWS.map((v) => [v, 0]));
    for (const entry of all) counts[entry.view] += 1;
    const listed = (view ? all.filter((entry) => entry.view === view) : all).slice(0, limit);
    const contactIds = [...new Set(listed.map((e) => e.obligation.contactId).filter(Boolean))];
    const invoiceIds = [...new Set(listed.map((e) => e.obligation.invoiceId).filter(Boolean))];
    const [names, numbers] = await Promise.all([
      contactIds.length
        ? db.select({ id: contacts.id, name: contacts.name }).from(contacts)
          .where(and(eq(contacts.organisationId, organisationId), inArray(contacts.id, contactIds)))
        : [],
      invoiceIds.length
        ? db.select({ id: invoices.id, number: invoices.number, status: invoices.status }).from(invoices)
          .where(and(eq(invoices.organisationId, organisationId), inArray(invoices.id, invoiceIds)))
        : [],
    ]);
    const nameOf = new Map(names.map((c) => [c.id, c.name]));
    const invoiceOf = new Map(numbers.map((i) => [i.id, i]));
    const settings = await readInvoicingSettings(db, organisationId);
    const customers = await customerBillingByContact(db, organisationId, contactIds);
    const rules = await listRules(db, organisationId);
    // The invoicing rules a job with no invoice waits on, for every view a
    // draft can still come from.
    const waitingFor = (o, v) => (o.invoiceId || !['in_work', 'ready', 'pending', 'held'].includes(v)
      ? [] : ruleBlockers(o, effectiveSettings(settings, customers.get(o.contactId)), { rules }));
    res.json({
      ok: true,
      jobs: listed.map(({ obligation: { lineFingerprint: _fingerprint, organisationId: _org, ...o }, view: v, reasons }) => ({
        ...o,
        contactName: nameOf.get(o.contactId) ?? null,
        invoiceNumber: invoiceOf.get(o.invoiceId)?.number ?? null,
        invoiceStatus: invoiceOf.get(o.invoiceId)?.status ?? null,
        view: v,
        reasons,
        waitingFor: waitingFor(o, v),
      })),
      counts,
    });
  }));

  router.post('/jobs/:id/draft', ...manager, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    // With no accounting system connected, Flow's own records are the check.
    const liveCheck = liveCheckFor(organisationId) ?? null;
    const { invoice } = await draftInvoiceForObligation(db, organisationId, obligationId, { liveCheck, actor: `person:${req.person.id}` });
    log.info?.(`[invoicing] organisation ${organisationId}: person ${req.person.id} drafted invoice ${invoice.id} from job ${obligationId}`);
    res.status(201).json({ ok: true, invoice: await invoiceDetail(db, organisationId, invoice.id) });
  }));

  router.post('/jobs/:id/ready', ...signedIn, handle(log, async (req, res) => {
    const obligationId = pathId(req.params.id, 'job');
    const organisationId = await organisationOf(req);
    const ready = req.body?.ready ?? true;
    if (typeof ready !== 'boolean') throw invalid('ready must be true or false');
    const job = await setReady(db, organisationId, obligationId, { ready, actor: `person:${req.person.id}` });
    res.json({ ok: true, job: { id: job.id, readyAt: job.readyAt, readyBy: job.readyBy } });
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
        items: items.map((i) => ({ value: i.value, label: `${i.value} · ${i.label}` })),
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
