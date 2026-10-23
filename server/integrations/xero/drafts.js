import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { isCallsStopped } from '../call-guard.js';
import { getInvoice, listInvoiceVersions } from '../../core/invoices.js';
import { sendModeFor } from '../../core/invoicing-rules.js';
import { contacts as flowContacts, invoices as flowInvoices, priceItems } from '../../db/schema.js';
import { readConnection } from './connections.js';
import { itemsByCode, lastSuccessfulSyncAt, matchContactFor, normaliseName } from './catalogue.js';
import { writesAllowed } from './settings.js';
import { xeroError } from './client.js';
import { withXeroLane } from './governor.js';
import { mirrorState } from './lookup.js';

// Issued Flow invoices go to Xero. How depends on the customer's send mode
// (server/core/invoicing-rules.js):
// - accounting_draft (the default): a Xero draft (ACCREC, DRAFT). The lab
//   approves and sends it in Xero.
// - approve_and_email: issuing in Flow was the approval. Flow sends it
//   approved (AUTHORISED), then asks Xero to email it to the contact with the
//   organisation's own template.
// Either way the mirror (mirror.js) reads Xero's status back to Flow.
//
// The rules, as in the earlier codebase:
// - What Flow sends is the issued version's document, exactly. A sent
//   version is never changed, here or in Xero: Flow never updates a Xero
//   invoice. A revised invoice (version 2) goes to Xero only after the
//   earlier version's Xero invoice is deleted or voided there.
// - The customer must match one Xero contact, by the identity-map link or by
//   name (the synced copy, catalogue.js). When Create missing clients is on,
//   a missing contact can be created from the Flow contact (create-contact.js).
// - Before it creates, Flow asks Xero for invoices with the same reference.
//   One for the same contact and total is the same work: Flow records it and
//   creates nothing. One for the same contact at another total within 90
//   days is held for a person, unless they chose to send it anyway. Flow skips
//   this call for an invoice it drafted from a job when its complete, fresh
//   copy of Xero showed no invoice for that job (docs/JOB_INVOICE_LINKS.md).
// - Xero's email action is not idempotent. Flow records `sending` before it
//   calls, and calls again only after Xero refused (`failed`), never after an
//   unknown outcome: a person checks Xero then.
// - The request, with its Idempotency-Key, is stored before it leaves. An
//   uncertain outcome (timeout, 5xx) is resolved later: within Xero's
//   six-minute idempotency window Flow repeats the same request with the same
//   key; after it Flow looks for the draft in Xero, and sends again only when
//   it has shown that no matching draft exists.
// - After a create Flow reads the draft back and compares it with the
//   document. A difference is recorded as `mismatch` for a person to check.

export const IDEMPOTENCY_WINDOW_MS = 6 * 60 * 1000;
export const SAME_REFERENCE_WINDOW_DAYS = 90;
export const MAX_BATCH = 100;

const SETTLED = new Set(['created', 'existing']);
const GONE = new Set(['DELETED', 'VOIDED']);
const cents = (amount) => (typeof amount === 'number' && Number.isFinite(amount) ? Math.round(amount * 100) : null);
const amount = (value) => value / 100;

function addDays(date, days) {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function xeroDate(value) {
  const legacy = /^\/Date\((-?\d+)/.exec(String(value ?? ''));
  if (legacy) return new Date(Number(legacy[1])).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(String(value ?? '')) ? String(value).slice(0, 10) : null;
}

const problem = (code, message, extra = {}) => ({ code, message, ...extra });

function missingContact(name, { offerCreate }) {
  const message = offerCreate
    ? `No Xero contact is named "${name}". Create the client in Xero from this contact.`
    : `No Xero contact is named "${name}". Add it in Xero, then sync.`;
  return problem('xero_contact_missing', message, { short: 'Client not in Xero', ...(offerCreate ? { offerCreate: true } : {}) });
}

// ---------------------------------------------------------------------------
// The document to send

// The document a preview or a push works from: the latest issued version, or
// for a draft that was never issued, what issuing it now would store.
async function documentFor(db, organisationId, invoiceId) {
  const invoice = await getInvoice(db, organisationId, invoiceId);
  if (invoice.status !== 'draft') {
    const latest = (await listInvoiceVersions(db, organisationId, invoiceId)).at(-1);
    return { invoice, version: latest.version, document: latest.document };
  }
  const [contact] = await db.select().from(flowContacts).where(eq(flowContacts.id, invoice.contactId));
  const ids = invoice.lines.map((l) => l.priceItemId).filter(Boolean);
  const codes = new Map(ids.length
    ? (await db.select({ id: priceItems.id, code: priceItems.code }).from(priceItems)
      .where(and(eq(priceItems.organisationId, organisationId), inArray(priceItems.id, ids)))).map((r) => [r.id, r.code])
    : []);
  return {
    invoice,
    version: null,
    document: {
      number: invoice.number,
      version: invoice.issuedVersion + 1,
      issueDate: null,
      dueDate: invoice.dueDate,
      reference: invoice.reference,
      currency: invoice.currency,
      contact: { id: contact.id, name: contact.name, email: contact.email },
      lines: invoice.lines.map((l) => ({
        position: l.position, itemCode: codes.get(l.priceItemId) ?? null, ...(l.accountCode ? { accountCode: l.accountCode } : {}), description: l.description, quantity: l.quantity,
        unitAmountCents: l.unitAmountCents, taxCode: l.taxCode, lineAmountCents: l.lineAmountCents, taxCents: l.taxCents,
      })),
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
    },
  };
}

export function xeroReference(document) {
  return document.reference || document.number || null;
}

// The tracking for a contact's lines: the contact's own sales tracking option
// in the configured category, or the configured option.
function trackingFor(settings, contact) {
  if (!settings.tracking) return null;
  const own = (contact?.salesTracking ?? []).find((t) => normaliseName(t.category) === normaliseName(settings.tracking.category));
  return { Name: settings.tracking.category, Option: own?.option || settings.tracking.option };
}

// The Xero draft for a document, and what stops it.
export function buildDraft(document, { settings, contact, items, sendMode = 'accounting_draft' }) {
  const problems = [];
  const tracking = trackingFor(settings, contact);
  const lines = document.lines.map((line) => {
    const out = {
      Description: line.description,
      Quantity: line.quantity,
      UnitAmount: amount(line.unitAmountCents),
      LineAmount: amount(line.lineAmountCents),
      TaxType: settings.taxTypes[line.taxCode],
    };
    if (line.itemCode) {
      if (items.has(line.itemCode)) out.ItemCode = line.itemCode;
      else problems.push(problem('xero_item_missing', `Line ${line.position}: item ${line.itemCode} is not in Xero. Add it in Xero, then sync.`, { itemCode: line.itemCode, short: `${line.itemCode} not in Xero` }));
    } else if (line.accountCode) {
      // A line with no item books to its own account, such as a surcharge.
      out.AccountCode = line.accountCode;
    }
    if (tracking) out.Tracking = [tracking];
    return out;
  });
  const issueDate = document.issueDate;
  const draft = {
    Type: 'ACCREC',
    Status: sendMode === 'approve_and_email' ? 'AUTHORISED' : 'DRAFT',
    Contact: contact ? { ContactID: contact.xeroContactId } : { Name: document.contact.name },
    ...(issueDate ? { Date: issueDate, DueDate: document.dueDate ?? addDays(issueDate, settings.defaultDueDays) } : {}),
    Reference: xeroReference(document),
    CurrencyCode: document.currency,
    LineAmountTypes: 'Exclusive',
    ...(settings.invoiceNumber === 'flow' && document.number ? { InvoiceNumber: document.number } : {}),
    LineItems: lines,
  };
  return { draft, problems };
}

// What differs between a Xero invoice and the document Flow sent.
export function differences(xeroInvoice, draft, document) {
  const found = [];
  if (xeroInvoice?.Contact?.ContactID !== draft.Contact.ContactID) found.push('contact');
  if (cents(xeroInvoice?.SubTotal) !== document.subtotalCents) found.push('subtotal');
  if (cents(xeroInvoice?.TotalTax) !== document.taxCents) found.push('tax');
  if (cents(xeroInvoice?.Total) !== document.totalCents) found.push('total');
  if ((xeroInvoice?.LineItems ?? []).length !== draft.LineItems.length) found.push('line count');
  if (normaliseName(xeroInvoice?.Reference) !== normaliseName(draft.Reference)) found.push('reference');
  if (draft.Date && xeroDate(xeroInvoice?.DateString ?? xeroInvoice?.Date) !== draft.Date) found.push('date');
  return found;
}

// ---------------------------------------------------------------------------
// Stored pushes

function mapPush(row) {
  if (!row) return null;
  return {
    id: row.id,
    organisationId: row.organisation_id,
    invoiceId: row.invoice_id,
    version: row.version,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    requestBody: row.request_body,
    bodyHash: row.body_hash,
    preExistingIds: row.pre_existing_ids ?? [],
    xero: row.xero_invoice_id ? { invoiceId: row.xero_invoice_id, number: row.xero_invoice_number, status: row.xero_status } : null,
    verified: row.verified,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    attempts: row.attempts,
    sendMode: row.send_mode ?? 'accounting_draft',
    email: row.email_state ? { state: row.email_state, error: row.email_error ?? null, at: row.emailed_at ?? null } : null,
    pushedBy: row.pushed_by,
    firstDispatchedAt: row.first_dispatched_at,
    lastDispatchedAt: row.last_dispatched_at,
  };
}

// A push as it may be shown: no request body.
export function describePush(push) {
  if (!push) return null;
  const { requestBody, bodyHash, idempotencyKey: key, organisationId, ...shown } = push;
  return shown;
}

export async function listPushes(db, organisationId, invoiceId) {
  const { rows } = await db.execute(sql`select * from xero_invoice_pushes
    where organisation_id = ${organisationId} and invoice_id = ${invoiceId} order by version`);
  return rows.map(mapPush);
}

// What the customer's Xero copy of one Flow invoice version says, from Flow's
// copy of Xero (no calls): the stored push, and the mirror row when the
// mirror has it. Before the version is in Xero, only who numbers it and the
// default due days are known.
export async function documentFacts(db, runtime, { organisationId, invoiceId, version = null }) {
  const { settings } = runtime;
  const facts = { system: 'Xero', sent: false, numberedBy: settings.invoiceNumber, defaultDueDays: settings.defaultDueDays };
  if (!version) return facts;
  const { rows: [push] } = await db.execute(sql`select xero_invoice_id, xero_invoice_number, xero_status, request_body
    from xero_invoice_pushes
    where organisation_id = ${organisationId} and invoice_id = ${invoiceId} and version = ${version} and xero_invoice_id is not null`);
  if (!push) return facts;
  const { rows: [copy] } = await db.execute(sql`select invoice_number, reference, status,
      to_char(issued_on, 'YYYY-MM-DD') as issued_on, to_char(due_on, 'YYYY-MM-DD') as due_on
    from xero_invoices where organisation_id = ${organisationId} and xero_invoice_id = ${push.xero_invoice_id}`);
  let sent = {};
  try {
    sent = JSON.parse(push.request_body) ?? {};
  } catch {
    // An unreadable body leaves only the mirror and the push's own columns.
  }
  return {
    ...facts,
    sent: true,
    number: copy?.invoice_number || push.xero_invoice_number || sent.InvoiceNumber || null,
    reference: copy?.reference || sent.Reference || null,
    issueDate: copy?.issued_on || sent.Date || null,
    dueDate: copy?.due_on || sent.DueDate || null,
    status: copy?.status || push.xero_status || null,
  };
}

async function settle(db, id, fields) {
  const { rows } = await db.execute(sql`update xero_invoice_pushes set
      state = ${fields.state},
      xero_invoice_id = coalesce(${fields.xeroInvoiceId ?? null}, xero_invoice_id),
      xero_invoice_number = coalesce(${fields.xeroNumber ?? null}, xero_invoice_number),
      xero_status = coalesce(${fields.xeroStatus ?? null}, xero_status),
      verified = ${fields.verified ?? false},
      error_code = ${fields.errorCode ?? null},
      error_message = ${fields.errorMessage ?? null},
      updated_at = now()
    where id = ${id} returning *`);
  return mapPush(rows[0]);
}

function idempotencyKey(organisationId, invoiceId, version, attempt, bodyHash) {
  const digest = createHash('sha256').update([organisationId, invoiceId, version, attempt, bodyHash].join('\u0000')).digest('hex');
  return `flow-xero-${digest.slice(0, 48)}`;
}

// ---------------------------------------------------------------------------
// Preview: no Xero calls. It reads Flow's copy of Xero contacts and items and
// the stored pushes, so it costs none of the day's budget.

export async function previewDrafts(db, runtime, organisationId, invoiceIds) {
  if (!Array.isArray(invoiceIds) || !invoiceIds.length || invoiceIds.length > MAX_BATCH) {
    throw xeroError('invalid', `invoiceIds must list 1 to ${MAX_BATCH} invoices`, { status: 400 });
  }
  const syncedAt = await lastSuccessfulSyncAt(db, organisationId);
  const warnings = [];
  if (!syncedAt) warnings.push(problem('xero_not_synced', 'Xero contacts and items were never copied to Flow. Sync first.'));
  else if (runtime.now() - new Date(syncedAt).getTime() > 24 * 60 * 60 * 1000) {
    warnings.push(problem('xero_sync_stale', `Xero contacts and items were last copied ${new Date(syncedAt).toISOString().slice(0, 10)}. Sync for current names and items.`));
  }
  const results = [];
  for (const invoiceId of invoiceIds) {
    try {
      results.push(await previewOne(db, runtime, organisationId, invoiceId));
    } catch (error) {
      results.push({ invoiceId, state: 'blocked', problems: [problem(error.code ?? 'xero_preview_failed', error.message)] });
    }
  }
  return { syncedAt, warnings, invoices: results };
}

async function previewOne(db, runtime, organisationId, invoiceId) {
  const { invoice, version, document } = await documentFor(db, organisationId, invoiceId);
  const problems = [];
  if (invoice.status === 'void') problems.push(problem('invoice_void', 'This invoice is void. Flow does not send it to Xero.'));
  if (invoice.status === 'draft') problems.push(problem('invoice_not_issued', 'This invoice is a draft. Issue it, then send it to Xero.'));
  const match = await matchContactFor(db, organisationId, { contactId: invoice.contactId, name: document.contact.name });
  const offerCreate = match.state === 'missing' && runtime.settings.createContacts && writesAllowed(runtime.settings);
  if (match.state === 'missing') problems.push(missingContact(document.contact.name, { offerCreate }));
  if (match.state === 'ambiguous') problems.push(problem('xero_contact_ambiguous', `More than one Xero contact is named "${document.contact.name}". Merge or rename them in Xero, then sync.`, { short: 'Client twice in Xero' }));
  const items = await itemsByCode(db, organisationId, document.lines.map((l) => l.itemCode));
  const sendMode = await sendModeFor(db, organisationId, invoice.contactId);
  const { draft, problems: lineProblems } = buildDraft(document, { settings: runtime.settings, contact: match.contact, items, sendMode });
  problems.push(...lineProblems);
  if (sendMode === 'approve_and_email' && match.state === 'matched' && !match.contact.email) {
    problems.push(problem('xero_contact_no_email', `The Xero contact "${match.contact.name}" has no email address, so Xero cannot email the invoice. Add one in Xero, then sync.`, { blocking: false }));
  }

  const pushes = await listPushes(db, organisationId, invoiceId);
  const current = version ? pushes.find((p) => p.version === version) : null;
  const earlier = pushes.filter((p) => version && p.version < version);
  if (earlier.length) {
    const shown = earlier.at(-1);
    problems.push(problem('xero_earlier_version_in_xero',
      `Version ${shown.version} of this invoice is in Xero${shown.xero?.number ? ` as ${shown.xero.number}` : ''}. Flow never changes it: delete or void it in Xero, then send this version.`,
      { blocking: false, xero: shown.xero }));
  }
  let state = problems.some((p) => p.blocking !== false) ? 'blocked' : 'ready';
  if (current && SETTLED.has(current.state)) state = 'in_xero';
  else if (current) state = current.state; // dispatching, ambiguous or mismatch
  return {
    invoiceId,
    number: document.number,
    version,
    sendMode,
    state,
    problems,
    contact: { state: match.state, xeroContactId: match.contact?.xeroContactId ?? null, name: match.contact?.name ?? null },
    totalCents: document.totalCents,
    draft,
    push: describePush(current),
  };
}

// ---------------------------------------------------------------------------
// Push

// Sends issued invoices to Xero as drafts, one at a time, on the writes lane.
// `allowExistingReference` lists invoice ids a person chose to send although
// Xero holds an invoice with the same reference.
export async function pushDrafts(db, runtime, organisationId, invoiceIds, { pushedBy = null, allowExistingReference = [] } = {}) {
  if (!Array.isArray(invoiceIds) || !invoiceIds.length || invoiceIds.length > MAX_BATCH) {
    throw xeroError('invalid', `invoiceIds must list 1 to ${MAX_BATCH} invoices`, { status: 400 });
  }
  runtime.assertWritesAllowed();
  return runtime.serial(organisationId, () => withXeroLane('writes', async () => {
    const { client } = await runtime.clientFor(db, organisationId);
    await runtime.assertEnvironment(client);
    if (runtime.settings.tracking) await assertTracking(client, runtime.settings.tracking);
    const allowed = new Set(allowExistingReference);
    const results = [];
    for (const invoiceId of invoiceIds) {
      try {
        results.push(await pushOne(db, runtime, client, organisationId, invoiceId, { pushedBy, allowExisting: allowed.has(invoiceId) }));
      } catch (error) {
        if (stopsTheBatch(error)) {
          // Every later invoice would fail the same way: stop and say so.
          results.push(failed(invoiceId, error));
          for (const rest of invoiceIds.slice(invoiceIds.indexOf(invoiceId) + 1)) results.push(failed(rest, error, 'not_tried'));
          break;
        }
        results.push(failed(invoiceId, error));
      }
    }
    await keepSendState(db, organisationId, results);
    return summarise(results);
  }));
}

// Flow's Problem view (server/core/sending.js) shows an issued invoice that
// failed to send. Once Xero holds it, by any path, that problem is gone.
async function keepSendState(db, organisationId, results) {
  const held = results.filter((r) => ['created', 'reconciled', 'existing', 'already_in_xero'].includes(r.outcome)).map((r) => r.invoiceId);
  if (!held.length) return;
  await db.update(flowInvoices).set({ sendState: 'sent', sendError: null, sendUpdatedAt: sql`now()` })
    .where(and(eq(flowInvoices.organisationId, organisationId), inArray(flowInvoices.id, held), sql`${flowInvoices.sendState} is not null`));
}

// Send all ready (server/core/sending.js): issued invoices in batches.
export async function pushInvoices(db, runtime, { organisationId, invoiceIds, pushedBy = null }) {
  const invoices = [];
  for (let at = 0; at < invoiceIds.length; at += MAX_BATCH) {
    invoices.push(...(await pushDrafts(db, runtime, organisationId, invoiceIds.slice(at, at + MAX_BATCH), { pushedBy })).invoices);
  }
  return { invoices };
}

// What would stop each Flow draft in Xero, from Flow's copy of Xero (no
// calls). Null while Xero is not connected: then Flow's own checks decide.
export async function checkDrafts(db, runtime, { organisationId, invoiceIds }) {
  const connection = await readConnection(db, organisationId);
  if (!connection || connection.mode !== runtime.settings.mode) return null;
  const found = new Map();
  for (let at = 0; at < invoiceIds.length; at += MAX_BATCH) {
    const { invoices } = await previewDrafts(db, runtime, organisationId, invoiceIds.slice(at, at + MAX_BATCH));
    for (const preview of invoices) {
      found.set(preview.invoiceId, preview.problems
        .filter((p) => p.blocking !== false && p.code !== 'invoice_not_issued')
        .map(({ code, message, short, offerCreate }) => ({ code, message, ...(short ? { short } : {}), ...(offerCreate ? { offerCreate: true } : {}) })));
    }
  }
  return found;
}

function failed(invoiceId, error, outcome = 'failed') {
  return { invoiceId, outcome, error: { code: error.code ?? 'xero_push_failed', message: error.message, ...(error.details ? { details: error.details } : {}) } };
}

function summarise(results) {
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  return {
    summary: {
      created: count('created') + count('reconciled'),
      existing: count('existing'),
      alreadyInXero: count('already_in_xero'),
      mismatched: count('mismatch'),
      ambiguous: count('ambiguous'),
      failed: count('failed') + count('not_tried'),
      emailed: results.filter((r) => r.email?.state === 'sent').length,
      emailProblems: results.filter((r) => r.email && ['failed', 'unknown'].includes(r.email.state)).length,
    },
    invoices: results,
  };
}

async function assertTracking(client, tracking) {
  const categories = await client.getTrackingCategories();
  const category = categories.find((c) => normaliseName(c.Name) === normaliseName(tracking.category) && c.Status !== 'ARCHIVED');
  if (!category) throw xeroError('xero_tracking_missing', `Xero has no tracking category "${tracking.category}" (XERO_TRACKING_CATEGORY).`, { status: 409 });
  if (!(category.Options ?? []).some((o) => normaliseName(o.Name) === normaliseName(tracking.option) && o.Status !== 'ARCHIVED')) {
    throw xeroError('xero_tracking_missing', `Xero tracking category "${tracking.category}" has no option "${tracking.option}" (XERO_TRACKING_OPTION).`, { status: 409 });
  }
}

// Errors after which every later call would fail the same way: stop the batch.
const stopsTheBatch = (error) => error.code === 'xero_rate_limited' || error.code === 'xero_reconnect_needed' || isCallsStopped(error);

// Xero errors that prove no invoice was made: Xero refused the request, or
// the call guard stopped it before it went.
function provesNothingCreated(error) {
  return isCallsStopped(error) || error.code === 'xero_validation_failed' || error.code === 'xero_rate_limited'
    || error.code === 'xero_unauthorized' || error.code === 'xero_reconnect_needed'
    || (error.code === 'xero_api_error' && error.status >= 400 && error.status < 500);
}

const shownXero = (inv) => ({ invoiceId: inv.InvoiceID, number: inv.InvoiceNumber ?? null, status: inv.Status ?? null });

async function pushOne(db, runtime, client, organisationId, invoiceId, { pushedBy, allowExisting }) {
  const { invoice, version, document } = await documentFor(db, organisationId, invoiceId);
  if (invoice.status === 'void') throw xeroError('invoice_void', 'This invoice is void. Flow does not send it to Xero.', { status: 409 });
  if (invoice.status !== 'issued') throw xeroError('invoice_not_issued', 'Only an issued invoice goes to Xero. Issue it first.', { status: 409 });

  const pushes = await listPushes(db, organisationId, invoiceId);
  const current = pushes.find((p) => p.version === version);
  if (current && SETTLED.has(current.state)) {
    const email = await emailIfDue(db, client, current);
    return { invoiceId, version, outcome: 'already_in_xero', xero: current.xero, ...(email ? { email } : {}) };
  }
  if (current?.state === 'mismatch') {
    return { invoiceId, version, outcome: 'mismatch', xero: current.xero, error: current.error };
  }
  if (current) return resume(db, runtime, client, current, document);

  // A revision goes to Xero only once each earlier version's Xero invoice is
  // gone, because Flow never changes an invoice Xero already has.
  for (const earlier of pushes.filter((p) => p.version < version)) {
    if (!earlier.xero) {
      throw xeroError('xero_earlier_version_unresolved', `Version ${earlier.version} of this invoice may be in Xero; push it again to settle that first.`, { status: 409 });
    }
    const live = await client.getInvoice(earlier.xero.invoiceId);
    if (live && !GONE.has(live.Status)) {
      throw xeroError('xero_earlier_version_in_xero',
        `Version ${earlier.version} of this invoice is in Xero as ${live.InvoiceNumber || 'a draft'} (${live.Status}). Flow never changes it: delete or void it in Xero, then send this version.`,
        { status: 409, details: { xero: shownXero(live) } });
    }
  }

  const match = await matchContactFor(db, organisationId, { contactId: invoice.contactId, name: document.contact.name });
  if (match.state !== 'matched') {
    const offerCreate = match.state === 'missing' && runtime.settings.createContacts && writesAllowed(runtime.settings);
    throw xeroError(match.state === 'missing' ? 'xero_contact_missing' : 'xero_contact_ambiguous',
      match.state === 'missing'
        ? missingContact(document.contact.name, { offerCreate }).message
        : `More than one Xero contact is named "${document.contact.name}". Merge or rename them in Xero, then sync.`,
      { status: 409 });
  }
  const items = await itemsByCode(db, organisationId, document.lines.map((l) => l.itemCode));
  const sendMode = await sendModeFor(db, organisationId, invoice.contactId);
  const { draft, problems } = buildDraft(document, { settings: runtime.settings, contact: match.contact, items, sendMode });
  if (problems.length) throw xeroError(problems[0].code, problems.map((p) => p.message).join(' '), { status: 409 });

  // Live duplicate check: invoices in Xero with this reference, made by Flow
  // or by hand. Not needed when Flow's own copy of Xero already answered it
  // for the job this invoice bills.
  const earlierIds = new Set(pushes.map((p) => p.xero?.invoiceId).filter(Boolean));
  const sameReference = (await copyShowsNoInvoice(db, runtime, organisationId, invoiceId))
    ? []
    : (await client.findInvoicesByReference(draft.Reference))
      .filter((inv) => !GONE.has(inv.Status) && !earlierIds.has(inv.InvoiceID));
  const sameContact = sameReference.filter((inv) => inv.Contact?.ContactID === match.contact.xeroContactId);
  if (!allowExisting) {
    const same = sameContact.find((inv) => cents(inv.Total) === document.totalCents);
    if (same) return recordExisting(db, { organisationId, invoiceId, version, draft, same, pushedBy });
    const recent = sameContact.find((inv) => {
      const date = xeroDate(inv.DateString ?? inv.Date);
      return date && Math.abs(runtime.now() - Date.parse(`${date}T00:00:00Z`)) <= SAME_REFERENCE_WINDOW_DAYS * 86_400_000;
    });
    if (recent) {
      throw xeroError('xero_same_reference_different_amount',
        `Possible duplicate: Xero ${recent.InvoiceNumber || 'invoice'} (${recent.Status}, ${(cents(recent.Total) / 100).toFixed(2)}) has this contact and reference "${draft.Reference}" at another amount. Nothing was sent. Check it, then send again choosing to send anyway.`,
        { status: 409, details: { xero: shownXero(recent) } });
    }
  }

  const body = JSON.stringify(draft);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const key = idempotencyKey(organisationId, invoiceId, version, 1, bodyHash);
  const preExisting = sameReference.map((inv) => inv.InvoiceID);
  const { rows } = await db.execute(sql`
    insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash, pre_existing_ids, pushed_by,
      first_dispatched_at, last_dispatched_at, send_mode, email_state)
    values (${organisationId}, ${invoiceId}, ${version}, 'dispatching', ${key}, ${body}, ${bodyHash}, ${JSON.stringify(preExisting)}::jsonb, ${pushedBy},
      ${new Date(runtime.now())}, ${new Date(runtime.now())}, ${sendMode}, ${sendMode === 'approve_and_email' ? 'pending' : null})
    on conflict (invoice_id, version) do nothing returning *`);
  if (!rows.length) throw xeroError('xero_push_in_progress', 'This invoice is being sent to Xero already. Check again shortly.', { status: 409 });
  return dispatch(db, client, mapPush(rows[0]), document, { fresh: true });
}

async function recordExisting(db, { organisationId, invoiceId, version, draft, same, pushedBy }) {
  const body = JSON.stringify(draft);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  await db.execute(sql`
    insert into xero_invoice_pushes (organisation_id, invoice_id, version, state, idempotency_key, request_body, body_hash, pushed_by,
      xero_invoice_id, xero_invoice_number, xero_status, verified)
    values (${organisationId}, ${invoiceId}, ${version}, 'existing', ${idempotencyKey(organisationId, invoiceId, version, 0, bodyHash)},
      ${body}, ${bodyHash}, ${pushedBy}, ${same.InvoiceID}, ${same.InvoiceNumber ?? null}, ${same.Status ?? null}, false)
    on conflict (invoice_id, version) do nothing`);
  return { invoiceId, version, outcome: 'existing', xero: shownXero(same) };
}

// Sends the stored request once and settles the push from the answer.
// `fresh`: this push's first request. If Xero refuses that one, nothing was
// made and the attempt is forgotten, so a person can fix the cause and send
// again. A refusal of a repeated request proves nothing about the first one,
// so the push stays unsettled.
async function dispatch(db, client, push, document, { fresh = false } = {}) {
  const draft = JSON.parse(push.requestBody);
  let created;
  try {
    created = await client.createInvoice(draft, { idempotencyKey: push.idempotencyKey });
  } catch (error) {
    if (fresh && provesNothingCreated(error)) {
      await db.execute(sql`delete from xero_invoice_pushes where id = ${push.id} and state = 'dispatching'`);
      throw error;
    }
    await settle(db, push.id, { state: 'ambiguous', errorCode: error.code ?? 'xero_uncertain', errorMessage: error.message });
    if (stopsTheBatch(error)) throw error;
    return {
      invoiceId: push.invoiceId,
      version: push.version,
      outcome: 'ambiguous',
      error: { code: 'xero_outcome_unknown', message: 'Xero did not say whether it made the draft. Send again: Flow repeats the same request within six minutes, and after that looks in Xero first, so no second invoice is made.' },
    };
  }
  if (!created?.InvoiceID) {
    await settle(db, push.id, { state: 'ambiguous', errorCode: 'xero_no_invoice_id', errorMessage: 'Xero answered without an invoice id.' });
    return { invoiceId: push.invoiceId, version: push.version, outcome: 'ambiguous', error: { code: 'xero_outcome_unknown', message: 'Xero answered without an invoice id. Send again to settle it.' } };
  }
  return verify(db, client, push, draft, document, created, 'created');
}

// Reads the draft back and records whether Xero holds what Flow sent.
async function verify(db, client, push, draft, document, created, outcome) {
  let live = null;
  try {
    live = await client.getInvoice(created.InvoiceID);
  } catch {
    live = null;
  }
  if (!live) {
    const settled = await settle(db, push.id, {
      state: 'created', xeroInvoiceId: created.InvoiceID, xeroNumber: created.InvoiceNumber, xeroStatus: created.Status, verified: false,
      errorCode: 'xero_not_verified', errorMessage: 'Xero made the draft, but Flow could not read it back to check it.',
    });
    return { invoiceId: push.invoiceId, version: push.version, outcome, verified: false, xero: settled.xero };
  }
  const found = differences(live, draft, document);
  if (found.length) {
    const settled = await settle(db, push.id, {
      state: 'mismatch', xeroInvoiceId: live.InvoiceID, xeroNumber: live.InvoiceNumber, xeroStatus: live.Status,
      errorCode: 'xero_draft_differs', errorMessage: `The Xero draft differs from the Flow invoice in: ${found.join(', ')}. Check it in Xero.`,
    });
    return { invoiceId: push.invoiceId, version: push.version, outcome: 'mismatch', xero: settled.xero, error: settled.error };
  }
  const settled = await settle(db, push.id, { state: 'created', xeroInvoiceId: live.InvoiceID, xeroNumber: live.InvoiceNumber, xeroStatus: live.Status, verified: true });
  const email = await emailIfDue(db, client, settled);
  return { invoiceId: push.invoiceId, version: push.version, outcome, verified: true, xero: settled.xero, ...(email ? { email } : {}) };
}

// ---------------------------------------------------------------------------
// Email

// Xero errors that prove it sent no email: it refused the request, or the
// call guard stopped it before it went.
const emailRefused = (error) => isCallsStopped(error) || error.code === 'xero_validation_failed'
  || (error.code === 'xero_api_error' && error.status >= 400 && error.status < 500);

// Asks Xero to email an approved invoice that Flow sent and checked, once.
// Answers the email's state, or null when the push sends no email.
async function emailIfDue(db, client, push) {
  if (push.sendMode !== 'approve_and_email' || !push.email) return null;
  if (!push.verified || !push.xero?.invoiceId || !['pending', 'failed'].includes(push.email.state)) return push.email;
  // Claim the email, so two pushes never both send it.
  const { rows } = await db.execute(sql`update xero_invoice_pushes set email_state = 'sending', updated_at = now()
    where id = ${push.id} and email_state in ('pending', 'failed') returning id`);
  if (!rows.length) return { state: 'sending', error: null, at: null };
  try {
    await client.emailInvoice(push.xero.invoiceId);
  } catch (error) {
    const state = emailRefused(error) ? 'failed' : 'unknown';
    const message = state === 'failed'
      ? `Xero did not email the invoice: ${error.message}`
      : 'Flow does not know whether Xero emailed the invoice. Check the invoice in Xero before you send it again.';
    await db.execute(sql`update xero_invoice_pushes set email_state = ${state}, email_error = ${message}, updated_at = now() where id = ${push.id}`);
    if (stopsTheBatch(error)) throw error;
    return { state, error: message, at: null };
  }
  const { rows: [done] } = await db.execute(sql`update xero_invoice_pushes set email_state = 'sent', email_error = null, emailed_at = now(), updated_at = now()
    where id = ${push.id} returning emailed_at`);
  return { state: 'sent', error: null, at: done.emailed_at };
}

// Flow drafted this invoice from a job, and its complete, fresh copy of Xero
// showed no invoice for that job: Xero needs no live duplicate check.
async function copyShowsNoInvoice(db, runtime, organisationId, invoiceId) {
  const { rows: [job] } = await db.execute(sql`select accounting_state from billing_obligations
    where organisation_id = ${organisationId} and invoice_id = ${invoiceId}`);
  if (job?.accounting_state !== 'not_found') return false;
  const mirror = await mirrorState(db, organisationId, { now: new Date(runtime.now()) });
  return mirror.complete && mirror.fresh;
}

// An earlier attempt whose outcome is unknown.
async function resume(db, runtime, client, push, document) {
  const draft = JSON.parse(push.requestBody);
  // last_dispatched_at is when the current key was first sent.
  const sinceKey = runtime.now() - new Date(push.lastDispatchedAt).getTime();
  if (sinceKey < IDEMPOTENCY_WINDOW_MS) {
    // Inside Xero's window the same key returns the first result, if there
    // was one, instead of making a second invoice.
    await db.execute(sql`update xero_invoice_pushes set attempts = attempts + 1, updated_at = now() where id = ${push.id}`);
    return dispatch(db, client, push, document);
  }
  // Outside it, look for the draft first. Only proof that none exists allows
  // a new key.
  let candidates;
  try {
    candidates = (await client.findInvoicesByReference(draft.Reference))
      .filter((inv) => !GONE.has(inv.Status) && !push.preExistingIds.includes(inv.InvoiceID)
        && differences(inv, draft, document).filter((d) => d !== 'date').length === 0);
  } catch (error) {
    if (error.code === 'xero_rate_limited' || isCallsStopped(error)) throw error;
    return { invoiceId: push.invoiceId, version: push.version, outcome: 'ambiguous', error: { code: 'xero_outcome_unknown', message: 'Flow could not look in Xero to settle an earlier attempt. Send again later.' } };
  }
  if (candidates.length === 1) return verify(db, client, push, draft, document, candidates[0], 'reconciled');
  if (candidates.length > 1) {
    return { invoiceId: push.invoiceId, version: push.version, outcome: 'ambiguous', error: { code: 'xero_outcome_unknown', message: `Xero holds ${candidates.length} drafts that match this invoice. Delete the extra ones in Xero, then send again.` } };
  }
  const attempt = push.attempts + 1;
  const key = idempotencyKey(push.organisationId, push.invoiceId, push.version, attempt, push.bodyHash);
  const { rows } = await db.execute(sql`update xero_invoice_pushes set idempotency_key = ${key}, attempts = ${attempt},
      state = 'dispatching', last_dispatched_at = ${new Date(runtime.now())}, updated_at = now()
    where id = ${push.id} returning *`);
  return dispatch(db, client, mapPush(rows[0]), document);
}

// The port's pushInvoice: one issued invoice.
export async function pushInvoice(db, runtime, { organisationId, invoiceId, pushedBy = null }) {
  const { invoices: [result] } = await pushDrafts(db, runtime, organisationId, [invoiceId], { pushedBy });
  return result;
}
