import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { invoiceLines, invoices } from '../db/schema.js';
import { FlowError } from './errors.js';
import { issueInvoice } from './invoices.js';
import { soleOrganisation } from './pipeline.js';
import { enqueueJob, runNextJob } from './queue.js';

// Ready, Problem and Send all ready (docs/INVOICE_SENDING.md).
//
// Every draft is either ready or has a problem. Flow checks its own data
// first: the draft has lines, a total above zero, and a price item on every
// line. When an accounting system is connected, its own checks are added (for
// Xero: the customer matches one Xero contact, every item is in Xero).
//
// Send all ready issues every ready draft (each gets its number) and, when an
// accounting system is connected, queues it to go there. The send worker
// sends the queue in the background on the job queue, so a long send never
// holds a person's request and two Flow processes never send at once. An
// issued invoice the accounting system refused has a problem until a person
// sends it again.

export const SEND_KIND = 'invoices.send';
// Drafts one press issues; the rest wait for the next press.
export const SEND_BATCH = 100;
// Drafts checked for Ready and Problem, oldest first.
export const CHECK_LIMIT = 500;
const WORKER_BATCH = 25;
const WORKER_EVERY_MS = 30 * 1000;
const LEASE_MS = 15 * 60 * 1000;
// Outcomes that mean the accounting system holds the invoice.
const SENT = new Set(['created', 'reconciled', 'existing', 'already_in_xero']);

const problem = (code, message) => ({ code, message });

// Flow's own checks of one draft. `lines` are its invoice lines.
export function draftProblems(invoice, lines) {
  const problems = [];
  if (!lines.length) problems.push(problem('no_lines', 'The invoice has no lines.'));
  else if (invoice.totalCents <= 0) problems.push(problem('no_amount', 'The total is $0.00 or less.'));
  for (const line of lines) {
    if (!line.priceItemId) problems.push(problem('line_no_item', `Line ${line.position} has no price item.`));
  }
  return problems;
}

// The Ready and Problem views. `accounting` is the connected accounting
// adapter, or null. Answers { ready: [ids], problems: Map(id -> problems),
// sending: Set(ids) }.
export async function invoiceViews(db, organisationId, { accounting = null } = {}) {
  const drafts = await db.select({ id: invoices.id, totalCents: invoices.totalCents }).from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'draft')))
    .orderBy(asc(invoices.createdAt), asc(invoices.id))
    .limit(CHECK_LIMIT);
  const ids = drafts.map((d) => d.id);
  const lines = ids.length
    ? await db.select({ invoiceId: invoiceLines.invoiceId, position: invoiceLines.position, priceItemId: invoiceLines.priceItemId })
      .from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)).orderBy(asc(invoiceLines.position))
    : [];
  const linesOf = Map.groupBy(lines, (l) => l.invoiceId);
  const problems = new Map();
  for (const draft of drafts) {
    const found = draftProblems(draft, linesOf.get(draft.id) ?? []);
    if (found.length) problems.set(draft.id, found);
  }
  if (accounting && ids.length) {
    const outside = await accounting.capabilities.checkDrafts({ organisationId, invoiceIds: ids });
    for (const [id, found] of outside ?? []) {
      if (found.length) problems.set(id, [...(problems.get(id) ?? []), ...found]);
    }
  }
  const sending = new Set();
  const issued = await db.select({ id: invoices.id, sendState: invoices.sendState, sendError: invoices.sendError }).from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'issued'), inArray(invoices.sendState, ['queued', 'failed'])))
    .orderBy(desc(invoices.sendUpdatedAt));
  for (const row of issued) {
    if (row.sendState === 'queued') sending.add(row.id);
    else problems.set(row.id, [row.sendError ?? problem('send_failed', 'Sending failed.')]);
  }
  return { ready: ids.filter((id) => !problems.has(id)), problems, sending };
}

// Before Flow issues anything: an accounting system that is on must be
// connected and take writes, or the invoices would be issued and stuck.
async function assertCanSend(accounting, organisationId) {
  if (!accounting) return;
  const status = await accounting.capabilities.sendStatus({ organisationId });
  if (!status.connected) {
    throw new FlowError('accounting_not_connected', `${accounting.name} is not connected. Connect it in Integrations, then send.`);
  }
  if (!status.writesAllowed) {
    throw new FlowError('accounting_writes_off', `${accounting.name} does not take invoices from this installation yet (writes are off). Nothing was issued.`);
  }
}

// Send all ready: issues each ready draft, then queues it for the accounting
// system. Answers { issued, queued, remaining }.
export async function sendAllReady(db, organisationId, { accounting = null, personId, issueDate }) {
  await assertCanSend(accounting, organisationId);
  const { ready } = await invoiceViews(db, organisationId, { accounting });
  const batch = ready.slice(0, SEND_BATCH);
  let issued = 0;
  for (const invoiceId of batch) {
    // Queued first: the worker sends only issued invoices, so a stop between
    // the two steps leaves a queued draft, never an issued invoice nobody sends.
    if (accounting) await queue(db, organisationId, [invoiceId], personId);
    try {
      await issueInvoice(db, organisationId, invoiceId, { issuedBy: `person:${personId}`, issueDate });
    } catch (error) {
      if (accounting) await unqueue(db, organisationId, invoiceId);
      // Someone issued or changed it a moment ago: leave it to them.
      if (error.code === 'not_draft' || error.code === 'not_found' || error.code === 'invalid') continue;
      throw error;
    }
    issued += 1;
  }
  return { issued, queued: accounting ? issued : 0, remaining: ready.length - batch.length };
}

// Send again: issued invoices that failed go back on the queue. With no ids,
// every failed one.
export async function sendAgain(db, organisationId, { accounting = null, personId, invoiceIds = null }) {
  await assertCanSend(accounting, organisationId);
  if (!accounting) throw new FlowError('accounting_not_connected', 'No accounting system is on. Nothing to send.');
  const where = [eq(invoices.organisationId, organisationId), eq(invoices.status, 'issued'), eq(invoices.sendState, 'failed')];
  if (invoiceIds) where.push(inArray(invoices.id, invoiceIds));
  const rows = await db.select({ id: invoices.id }).from(invoices).where(and(...where));
  await queue(db, organisationId, rows.map((r) => r.id), personId);
  return { queued: rows.length };
}

async function queue(db, organisationId, invoiceIds, personId) {
  if (!invoiceIds.length) return;
  await db.update(invoices)
    .set({ sendState: 'queued', sendError: null, sendRequestedBy: personId ?? null, sendUpdatedAt: sql`now()` })
    .where(and(eq(invoices.organisationId, organisationId), inArray(invoices.id, invoiceIds)));
}

function unqueue(db, organisationId, invoiceId) {
  return db.update(invoices).set({ sendState: null, sendRequestedBy: null, sendUpdatedAt: sql`now()` })
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId), eq(invoices.status, 'draft')));
}

// One pass of the send worker: up to `limit` queued invoices, oldest first.
export async function sendQueued(db, organisationId, { accounting, limit = WORKER_BATCH }) {
  const rows = await db.select({ id: invoices.id, by: invoices.sendRequestedBy }).from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'issued'), eq(invoices.sendState, 'queued')))
    .orderBy(asc(invoices.sendUpdatedAt), asc(invoices.id))
    .limit(limit);
  const summary = { sent: 0, failed: 0, waiting: 0 };
  for (const [by, group] of Map.groupBy(rows, (r) => r.by ?? null)) {
    const { invoices: results } = await accounting.capabilities.pushInvoices({
      organisationId, invoiceIds: group.map((r) => r.id), pushedBy: by,
    });
    for (const result of results) {
      if (SENT.has(result.outcome)) {
        await settle(db, organisationId, result.invoiceId, { sendState: 'sent', sendError: null });
        summary.sent += 1;
      } else if (result.outcome === 'not_tried' && result.error?.code === 'xero_rate_limited') {
        // The day's or minute's calls ran out: it stays queued for a later pass.
        summary.waiting += 1;
      } else {
        const error = result.error ?? { code: `send_${result.outcome}`, message: `Sending ended as ${result.outcome}.` };
        await settle(db, organisationId, result.invoiceId, { sendState: 'failed', sendError: { code: error.code, message: error.message } });
        summary.failed += 1;
      }
    }
  }
  return summary;
}

function settle(db, organisationId, invoiceId, fields) {
  return db.update(invoices).set({ ...fields, sendUpdatedAt: sql`now()` })
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId), eq(invoices.sendState, 'queued')));
}

// The send worker: every 30 seconds, when invoices are queued, one pass on
// the job queue.
export function createSendWorker({ db, integrations, log = console, timers = { setTimeout, clearTimeout }, everyMs = WORKER_EVERY_MS }) {
  const workerId = `send-${randomUUID()}`;
  let timer = null;
  let running = null;
  let stopped = true;

  function schedule() {
    if (stopped) return;
    timer = timers.setTimeout(tick, everyMs);
    timer?.unref?.();
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    running = (async () => {
      try {
        const [accounting] = integrations.with('pushInvoices');
        if (!accounting) return;
        const organisationId = await soleOrganisation(db);
        if (!organisationId) return;
        const [waiting] = await db.select({ id: invoices.id }).from(invoices)
          .where(and(eq(invoices.organisationId, organisationId), eq(invoices.sendState, 'queued'))).limit(1);
        if (!waiting) return;
        await enqueueJob(db, organisationId, { kind: SEND_KIND, dedupeKey: 'all' });
        const ran = await runNextJob(db, {
          workerId,
          leaseMs: LEASE_MS,
          handlers: { [SEND_KIND]: () => sendQueued(db, organisationId, { accounting }) },
        });
        if (ran) log.info?.(`[sending] ${ran.outcome}: ${JSON.stringify(ran.job.result ?? ran.job.lastError ?? {})}`);
      } catch (error) {
        log.error?.(`[sending] ${error?.code ?? 'error'}: ${error?.message ?? error}`);
      }
    })();
    await running;
    running = null;
    schedule();
  }

  return {
    start() {
      stopped = false;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
