import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { billingObligations, invoiceLines, invoices } from '../db/schema.js';
import { FlowError } from './errors.js';
import { issueInvoice } from './invoices.js';
import { CHANGED_REASON, diffJobLines, STATUS_BACK_REASON } from './ledger.js';
import { soleOrganisation } from './pipeline.js';
import { needsRead, readAccountingFirst, readBeforeAct, READS_PER_PASS } from './read-before-act.js';
import { deadHoldSince, deadSince, enqueueJob, runNextJob } from './queue.js';

// Drafts, Problem, Ready and Send all ready (docs/INVOICE_SENDING.md).
//
// Flow checks every draft. It checks its own data first: the draft has lines,
// a total above zero, and a price item (or, for a line such as a rush
// charge, an account) on every line. When an accounting
// system is connected, its own checks are added (for Xero: the customer
// matches one Xero contact, every item is in Xero). A draft with a problem is
// in Problem. A person marks a draft without one ready. A saved change keeps
// it ready; only Move to Drafts (markNotReady) takes it back.
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

// `short` is the few words the Invoices list shows; `message` says how to fix it.
const problem = (code, message, short = null) => ({ code, message, ...(short ? { short } : {}) });

// Flow's own checks of one draft. `lines` are its invoice lines.
export function draftProblems(invoice, lines) {
  const problems = [];
  if (!lines.length) problems.push(problem('no_lines', 'The invoice has no lines.', 'No lines'));
  else if (invoice.totalCents <= 0) problems.push(problem('no_amount', 'The total is $0.00 or less.', 'Total $0'));
  for (const line of lines) {
    if (!line.priceItemId && !line.accountCode) problems.push(problem('line_no_item', `Line ${line.position} has no price item.`, `Line ${line.position}: no item`));
  }
  return problems;
}

// The few words for a job in review: what changed, for this job.
export function reviewShort(obligation) {
  if (obligation.holdReason === STATUS_BACK_REASON) return 'Status moved back';
  if (obligation.holdReason !== CHANGED_REASON) return /deleted/.test(obligation.holdReason ?? '') ? 'Job deleted' : 'Job needs a look';
  const basis = obligation.draftBasis;
  if (!basis) return 'Job changed';
  const changes = diffJobLines(basis.lines ?? [], obligation.lines ?? []);
  const words = changes.map((c) => (['added', 'removed'].includes(c.change)
    ? `Line ${c.position} ${c.change}`
    : `Line ${c.position} ${{ item: 'item', description: 'text', quantity: 'qty', price: 'price' }[c.fields[0]] ?? 'changed'}`));
  if ((basis.contactId ?? null) !== (obligation.contactId ?? null)) words.unshift('Client changed');
  if (!words.length) return 'Job changed';
  return words.length > 1 ? `${words[0]} +${words.length - 1}` : words[0];
}

// Flow's checks, and the accounting system's, for some drafts. Answers
// Map(id -> problems) holding only the drafts that have one.
async function checkDrafts(db, organisationId, drafts, accounting) {
  const ids = drafts.map((d) => d.id);
  const problems = new Map();
  if (!ids.length) return problems;
  const lines = await db.select({ invoiceId: invoiceLines.invoiceId, position: invoiceLines.position, priceItemId: invoiceLines.priceItemId, accountCode: invoiceLines.accountCode })
    .from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)).orderBy(asc(invoiceLines.position));
  const linesOf = Map.groupBy(lines, (l) => l.invoiceId);
  for (const draft of drafts) {
    const found = draftProblems(draft, linesOf.get(draft.id) ?? []);
    if (found.length) problems.set(draft.id, found);
  }
  // A draft whose job the ledger sent to review (the job changed after the
  // draft was made, or the work system deleted it) waits for a person.
  const reviewed = await db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), inArray(billingObligations.invoiceId, ids), eq(billingObligations.holdState, 'review')));
  for (const obligation of reviewed) {
    const { invoiceId, holdReason: reason } = obligation;
    const found = problem('job_review', `The job needs a look before this invoice goes: ${reason ?? 'it was sent to review'}.`, reviewShort(obligation));
    problems.set(invoiceId, [...(problems.get(invoiceId) ?? []), found]);
  }
  if (accounting) {
    const outside = await accounting.capabilities.checkDrafts({ organisationId, invoiceIds: ids });
    for (const [id, found] of outside ?? []) {
      if (found.length) problems.set(id, [...(problems.get(id) ?? []), ...found]);
    }
  }
  return problems;
}

// The views of the Invoices page. `accounting` is the accounting adapter, or
// null. Every draft is in one view: Problem (a check failed), Ready (a person
// marked it ready) or To check (the rest). An issued invoice is Sending while
// queued, and a Problem when the accounting system refused it. Answers
// { toCheck: [ids], ready: [ids], problems: Map(id -> problems), sending: Set(ids) }.
export async function invoiceViews(db, organisationId, { accounting = null } = {}) {
  const drafts = await db.select({ id: invoices.id, totalCents: invoices.totalCents, readyAt: invoices.readyAt }).from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'draft')))
    .orderBy(asc(invoices.createdAt), asc(invoices.id))
    .limit(CHECK_LIMIT);
  const problems = await checkDrafts(db, organisationId, drafts, accounting);
  const sending = new Set();
  const issued = await db.select({ id: invoices.id, sendState: invoices.sendState, sendError: invoices.sendError }).from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'issued'), inArray(invoices.sendState, ['queued', 'failed'])))
    .orderBy(desc(invoices.sendUpdatedAt));
  for (const row of issued) {
    if (row.sendState === 'queued') sending.add(row.id);
    else problems.set(row.id, [row.sendError ?? problem('send_failed', 'Sending failed.', 'Send failed')]);
  }
  const clean = drafts.filter((d) => !problems.has(d.id));
  return {
    toCheck: clean.filter((d) => !d.readyAt).map((d) => d.id),
    ready: clean.filter((d) => d.readyAt).map((d) => d.id),
    problems,
    sending,
  };
}

// The view of one invoice, with its problems, for the invoice page.
export async function invoiceView(db, organisationId, invoice, { accounting = null } = {}) {
  if (invoice.status === 'void') return { view: null, problems: [] };
  if (invoice.status === 'issued') {
    if (invoice.sendState === 'queued') return { view: 'sending', problems: [] };
    if (invoice.sendState === 'failed') return { view: 'problem', problems: [invoice.sendError ?? problem('send_failed', 'Sending failed.', 'Send failed')] };
    return { view: null, problems: [] };
  }
  const found = (await checkDrafts(db, organisationId, [invoice], accounting)).get(invoice.id) ?? [];
  return { view: found.length ? 'problem' : invoice.readyAt ? 'ready' : 'to_check', problems: found };
}

// Mark ready: a person checked these drafts. A draft with a problem stays
// where it is. Answers { marked, refused: [{ invoiceId, problems }] }.
export async function markReady(db, organisationId, invoiceIds, { personId, accounting = null }) {
  const drafts = await db.select({ id: invoices.id, totalCents: invoices.totalCents }).from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'draft'), inArray(invoices.id, invoiceIds)));
  if (drafts.length !== new Set(invoiceIds).size) throw new FlowError('not_draft', 'only a draft can be marked ready');
  const problems = await checkDrafts(db, organisationId, drafts, accounting);
  const good = drafts.filter((d) => !problems.has(d.id)).map((d) => d.id);
  if (good.length) {
    await db.update(invoices).set({ readyAt: sql`now()`, readyBy: personId ?? null })
      .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'draft'), inArray(invoices.id, good)));
  }
  return { marked: good.length, refused: [...problems].map(([invoiceId, found]) => ({ invoiceId, problems: found })) };
}

// Back to drafts: the drafts need another look before they go. The new
// updatedAt keeps "Ready when drafted" (automations.js) off them.
export async function markNotReady(db, organisationId, invoiceIds) {
  const rows = await db.update(invoices).set({ readyAt: null, readyBy: null, updatedAt: sql`now()` })
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'draft'), inArray(invoices.id, invoiceIds)))
    .returning({ id: invoices.id });
  return { moved: rows.length };
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

// Read before act (issue #141): the jobs behind these drafts whose work
// system report is old are read again first. Answers the drafts that may go
// now; a draft whose job went to review, or could not be read, waits.
async function readJobsFirst(db, organisationId, invoiceIds, { work, now, personId }) {
  if (!invoiceIds.length || typeof work?.capabilities?.readWorkItem !== 'function') return { go: invoiceIds, waiting: [] };
  const jobs = await db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), inArray(billingObligations.invoiceId, invoiceIds)));
  const old = jobs.filter((job) => needsRead(job, { work, now }));
  const outcomes = await readBeforeAct(db, organisationId, old.slice(0, READS_PER_PASS), { work, now, actor: `person:${personId}` });
  const held = new Set(old.slice(READS_PER_PASS).map((job) => job.invoiceId));
  for (const { outcome, obligation } of outcomes.values()) {
    if (outcome === 'waiting' || outcome === 'review') held.add(obligation.invoiceId);
  }
  return { go: invoiceIds.filter((id) => !held.has(id)), waiting: invoiceIds.filter((id) => held.has(id)) };
}

// Send all ready: issues each ready draft, then queues it for the accounting
// system. With `invoiceIds`, only those drafts, and each must be ready (the
// Send button on one invoice). `work` is the work integration, for the read
// before act. Answers { issued, queued, remaining, waiting }.
export async function sendAllReady(db, organisationId, { accounting = null, work = null, personId, issueDate, invoiceIds = null, now = new Date() }) {
  await assertCanSend(accounting, organisationId);
  // Issue #45: the accounting copy reads its latest changes first, so the
  // draft checks below see an invoice someone made there meanwhile.
  let views = await invoiceViews(db, organisationId, { accounting });
  const accountingRead = views.ready.length ? await readAccountingFirst(db, organisationId, { accounting, now }) : { outcome: 'fresh' };
  if (accountingRead.changed) views = await invoiceViews(db, organisationId, { accounting });
  let { ready } = views;
  if (invoiceIds) {
    const wanted = new Set(invoiceIds);
    ready = ready.filter((id) => wanted.has(id));
    if (ready.length !== wanted.size) throw new FlowError('not_ready', 'Only a ready invoice can be sent. Mark it ready first.');
  }
  const { go, waiting } = accountingRead.outcome === 'waiting'
    ? { go: [], waiting: ready.slice(0, SEND_BATCH) }
    : await readJobsFirst(db, organisationId, ready.slice(0, SEND_BATCH), { work, now, personId });
  if (invoiceIds && waiting.length) {
    throw new FlowError('not_ready', 'Flow could not confirm the job with the work system or the accounting system just now, or the job changed. Nothing was sent. Look at the invoice, then try again.');
  }
  const batch = go;
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
  return { issued, queued: accounting ? issued : 0, remaining: Math.max(0, ready.length - SEND_BATCH), waiting: waiting.length };
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
        summary.refused = [...new Set([...(summary.refused ?? []), error.code])];
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
  const startedAtMs = Date.now();
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
        // Issue #101: a send run that gave up waits for a person, a restart or
        // the next day; the timer never starts it again by itself.
        if (await deadSince(db, organisationId, { kind: SEND_KIND, dedupeKey: 'all', since: deadHoldSince(startedAtMs) })) return;
        await enqueueJob(db, organisationId, { kind: SEND_KIND, dedupeKey: 'all' });
        const ran = await runNextJob(db, {
          workerId,
          leaseMs: LEASE_MS,
          handlers: { [SEND_KIND]: () => sendQueued(db, organisationId, { accounting }) },
        });
        if (!ran) return;
        const line = `[sending] ${ran.outcome}: ${JSON.stringify(ran.job.result ?? ran.job.lastError ?? {})}`;
        // An invoice the accounting system refused waits in Problem for a
        // person; it is reported once, when it is refused.
        if (ran.outcome === 'dead') log.error?.('[sending] the send run gave up after its last attempt');
        if (ran.job.result?.failed) log.error?.('[sending] the accounting system refused an invoice');
        (ran.outcome === 'succeeded' && !ran.job.result?.failed ? log.info : log.warn)?.(line);
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
