import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { billingObligations, contacts, invoiceLines, invoices, people, priceItems, SEND_MODES } from '../db/schema.js';
import { FlowError } from './errors.js';
import { accountingItemsFor, listRules, ruleExceptionsFor, ruleNonChargeable, rulePending, rulePricesFor, ruleSkip } from './invoice-rules.js';
import { customerBillingByContact, effectiveSettings, readInvoicingSettings } from './invoicing-rules.js';
import { HISTORY_HOLD_REASON, isHistoryHeld, ruleReleasedHistory } from './history.js';
import { getInvoice, issueInvoice, requireOwn } from './invoices.js';
import { CHANGED_REASON, diffJobLines, sourceBillingProblems, STATUS_BACK_REASON } from './ledger.js';
import { soleOrganisation } from './pipeline.js';
import { needsRead, readAccountingFirst, readBeforeAct, READS_PER_PASS } from './read-before-act.js';
import { acceptedKeysFor, overridable, problemKey, readReason, recordOverride } from './send-override.js';
import { deadHoldSince, deadSince, enqueueJob, runNextJob } from './queue.js';

// Pending, Ready and Send all ready (docs/INVOICE_SENDING.md).
//
// Flow checks every draft. It checks its own data first: the draft has lines,
// a total above zero, and a price item (or, for a line such as a rush
// charge, an account) on every line. When an accounting
// system is connected, its own checks are added (for Xero: the customer
// matches one Xero contact, every item is in Xero), and the lab's pending
// rules (invoice-rules.js) add their notes. An enabled skip rule does too:
// a draft whose job it matches stays Pending, even when the draft was made
// by hand or before the rule existed. A draft with a problem is
// Pending (the "problem" view). A draft without one is Ready. A draft whose
// job a non-chargeable rule matches is neither: it is Non-chargeable, and
// nothing sends it.
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
// Flow readies, issues and sends only invoices it made. An imported invoice
// (server/core/invoices.js, isImported) is in none of these lists.
const OWN = eq(invoices.origin, 'flow');
const WORKER_EVERY_MS = 30 * 1000;
const LEASE_MS = 15 * 60 * 1000;
// One error report names this many refused invoices. The count still says
// how many the accounting system refused.
const REFUSAL_REPORT_CAP = 5;
const REFUSAL_MESSAGE_LIMIT = 160;
const INVOICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_NUMBER = /^[A-Za-z0-9-]{1,32}$/;
const REFUSAL_CODE = /^[a-z0-9_]{1,64}$/i;
// Outcomes that mean the accounting system holds the invoice.
const SENT = new Set(['created', 'reconciled', 'existing', 'already_in_xero']);

// `short` is the few words the Invoices list shows; `message` says how to fix
// it. Draft warnings must name their resolution UI at the owner, not in a
// separate warning-code inventory. The invoice page dispatches this intent.
const problem = (code, message, short, resolution, extra = {}) => {
  if (typeof resolution?.kind !== 'string' || !resolution.kind) throw new FlowError('warning_resolution_required', `Draft warning ${code} needs a resolution UI.`);
  return { code, message, ...(short ? { short } : {}), ...extra, resolution };
};

// An issued invoice the accounting system refused. A refusal stored without
// its few words (before 2026-10-28) shows "Not sent"; its message stays.
const refusal = (sendError) => (sendError ? { short: 'Not sent', ...sendError } : { code: 'send_failed', message: 'Sending failed.', short: 'Not sent' });

// Flow's own checks of one draft. `lines` are its invoice lines.
export function draftProblems(invoice, lines) {
  const problems = [];
  if (!lines.length) problems.push(problem('no_lines', 'The invoice has no lines.', 'No lines', { kind: 'invoice_edit' }));
  else if (invoice.totalCents <= 0) problems.push(problem('no_amount', 'The total is $0.00 or less.', 'Total $0', { kind: 'invoice_edit' }));
  for (const line of lines) {
    if (!line.priceItemId && !line.accountCode) problems.push(problem('line_no_item', `Line ${line.position} has no price item.`, `Line ${line.position}: no item`, { kind: 'invoice_edit' }, { fields: ['line_item'], line: line.position }));
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
  const jobs = await db.select({ obligation: billingObligations, reference: invoices.reference, customerName: contacts.name }).from(billingObligations)
    .innerJoin(invoices, eq(invoices.id, billingObligations.invoiceId))
    .leftJoin(contacts, and(eq(contacts.id, billingObligations.contactId), eq(contacts.organisationId, billingObligations.organisationId)))
    .where(and(eq(billingObligations.organisationId, organisationId), inArray(billingObligations.invoiceId, ids)));
  // The lab's rules (invoice-rules.js). A pending rule puts its note on the
  // draft. A skip rule holds a draft that already exists: void it, or change
  // the rule. Matching stays in invoice-rules.js.
  const rules = (await listRules(db, organisationId)).filter((r) => r.enabled && ['pending', 'skip', 'non_chargeable'].includes(r.action.kind));
  // A job a person said is No Charge is on the Non-chargeable tab with no rule.
  if (jobs.length && (rules.length || jobs.some((j) => j.obligation.noChargeReason))) {
    const settings = await readInvoicingSettings(db, organisationId);
    const customers = await customerBillingByContact(db, organisationId, jobs.map((j) => j.obligation.contactId));
    const exceptions = await ruleExceptionsFor(db, organisationId, jobs.map((j) => j.obligation.id));
    // A rule's item counts only on a charged line: an item edited to $0
    // does not satisfy the rule; Skip, with a reason, is the way to say so.
    const itemRows = await db.select({ invoiceId: invoiceLines.invoiceId, code: priceItems.code }).from(invoiceLines)
      .innerJoin(priceItems, eq(priceItems.id, invoiceLines.priceItemId))
      .where(and(inArray(invoiceLines.invoiceId, jobs.map((j) => j.obligation.invoiceId)), sql`${invoiceLines.unitAmountCents} * ${invoiceLines.quantity} > 0`));
    const itemsOf = Map.groupBy(itemRows, (r) => r.invoiceId);
    const items = await accountingItemsFor(accounting, organisationId, rules, jobs.map((j) => j.obligation));
    const prices = await rulePricesFor(db, organisationId, rules);
    for (const { obligation, reference, customerName } of jobs) {
      const customer = { ...effectiveSettings(settings, customers.get(obligation.contactId)), name: customerName ?? null };
      const job = {
        ...obligation, reference,
        ruleExceptions: exceptions.get(obligation.id) ?? [],
        draftItems: (itemsOf.get(obligation.invoiceId) ?? []).map((r) => r.code),
      };
      const found = [...ruleNonChargeable(rules, job, { customer, items, prices }), ...rulePending(rules, job, { customer, items, prices }), ...ruleSkip(rules, job, { customer, items, prices })];
      if (found.length) problems.set(obligation.invoiceId, [...(problems.get(obligation.invoiceId) ?? []), ...found]);
    }
  }
  // A draft whose job the ledger sent to review (the job changed after the
  // draft was made, or the work system deleted it) waits for a person.
  for (const { obligation } of jobs) {
    for (const reason of sourceBillingProblems(obligation)) {
      const found = { ...problem('job_review', 'Check the source invoice: ' + reason + '.', 'Source tax', { kind: 'job_review' }), sourceBilling: true };
      problems.set(obligation.invoiceId, [...(problems.get(obligation.invoiceId) ?? []), found]);
    }
  }
  // A history job is never charged without a person (history.js): a draft
  // whose job is on the history hold, or that only a rule released and no
  // non-chargeable rule matches now, is not sent.
  const historyByRule = await ruleReleasedHistory(db, organisationId, jobs.map((j) => j.obligation.id));
  for (const { obligation } of jobs) {
    if (!isHistoryHeld(obligation) && !historyByRule.has(obligation.id)) continue;
    const found = problems.get(obligation.invoiceId) ?? [];
    if (found.some((p) => p.code === 'non_chargeable')) continue;
    problems.set(obligation.invoiceId, [...found, problem('history_job',
      'This job is from the history import. Only a non-chargeable rule released it, and no such rule matches it now. Release the job in the Seazona history, or void this draft.',
      'History job', { kind: 'job_hold', reason: HISTORY_HOLD_REASON })]);
  }
  const reviewed = jobs.map((j) => j.obligation).filter((o) => o.holdState === 'review');
  for (const obligation of reviewed) {
    const { invoiceId, holdReason: reason } = obligation;
    const resolution = reason === CHANGED_REASON ? { kind: 'job_review' }
      : { kind: 'job_hold', reason: reason ?? 'the job is review' };
    const found = problem('job_review', `The job needs a look before this invoice goes: ${reason ?? 'it was sent to review'}.`, reviewShort(obligation), resolution);
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

// A draft a non-chargeable rule matches has nothing to fix: it is never sent.
const nonChargeableOf = (found) => found.filter((p) => p.code === 'non_chargeable');

// The views of the Invoices page. `accounting` is the accounting adapter, or
// null. Every draft is in one view: Non-chargeable (a non-chargeable rule
// matches its job), Problem (a check failed; the Pending tab) or Ready (its
// checks pass). An issued invoice is Sending while queued, and a Problem when
// the accounting system refused it. Answers { toCheck: [ids], ready: [ids],
// problems: Map(id -> problems), nonChargeable: Map(id -> rules), sending: Set(ids) }.
export async function invoiceViews(db, organisationId, { accounting = null } = {}) {
  const drafts = await db.select({ id: invoices.id, totalCents: invoices.totalCents, readyAt: invoices.readyAt }).from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'draft'), OWN))
    .orderBy(asc(invoices.createdAt), asc(invoices.id))
    .limit(CHECK_LIMIT);
  const problems = await checkDrafts(db, organisationId, drafts, accounting);
  const nonChargeable = new Map();
  for (const [id, found] of problems) {
    const rules = nonChargeableOf(found);
    if (!rules.length) continue;
    nonChargeable.set(id, rules);
    problems.delete(id);
  }
  const sending = new Set();
  const issued = await db.select({ id: invoices.id, sendState: invoices.sendState, sendError: invoices.sendError }).from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'issued'), OWN, inArray(invoices.sendState, ['queued', 'failed'])))
    .orderBy(desc(invoices.sendUpdatedAt));
  for (const row of issued) {
    if (row.sendState === 'queued') sending.add(row.id);
    else problems.set(row.id, [refusal(row.sendError)]);
  }
  // A draft whose checks pass is ready (Samuel, 2026-10-20): no person
  // needs to mark it. toCheck stays for callers that still read it.
  const clean = drafts.filter((d) => !problems.has(d.id) && !nonChargeable.has(d.id));
  return {
    toCheck: [],
    ready: clean.map((d) => d.id),
    problems,
    nonChargeable,
    sending,
  };
}

// The view of one invoice, with its problems, for the invoice page.
export async function invoiceView(db, organisationId, invoice, { accounting = null } = {}) {
  if (invoice.status === 'void') return { view: null, problems: [] };
  if (invoice.status === 'issued') {
    if (invoice.sendState === 'queued') return { view: 'sending', problems: [] };
    if (invoice.sendState === 'failed') return { view: 'problem', problems: [refusal(invoice.sendError)] };
    return { view: null, problems: [] };
  }
  const found = (await checkDrafts(db, organisationId, [invoice], accounting)).get(invoice.id) ?? [];
  const rules = nonChargeableOf(found);
  if (rules.length) return { view: 'non_chargeable', problems: [], nonChargeable: rules };
  return { view: found.length ? 'problem' : 'ready', problems: found };
}

// Mark ready: a person checked these drafts. A draft with a problem stays
// where it is. Answers { marked, refused: [{ invoiceId, problems }] }.
export async function markReady(db, organisationId, invoiceIds, { personId, accounting = null }) {
  const drafts = await db.select({ id: invoices.id, totalCents: invoices.totalCents }).from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'draft'), OWN, inArray(invoices.id, invoiceIds)));
  if (drafts.length !== new Set(invoiceIds).size) throw new FlowError('not_draft', 'only a draft Flow made can be marked ready');
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
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'draft'), OWN, inArray(invoices.id, invoiceIds)))
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
// `stops` names each held draft: `unread` (read failed or past the cap) or
// `review` (the job changed).
async function readJobsFirst(db, organisationId, invoiceIds, { work, now, personId }) {
  if (!invoiceIds.length || typeof work?.capabilities?.readWorkItem !== 'function') {
    return { go: invoiceIds, waiting: [], stops: [] };
  }
  const jobs = await db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), inArray(billingObligations.invoiceId, invoiceIds)));
  const old = jobs.filter((job) => needsRead(job, { work, now }));
  const outcomes = await readBeforeAct(db, organisationId, old.slice(0, READS_PER_PASS), { work, now, actor: `person:${personId}` });
  const held = new Set();
  const stops = [];
  for (const job of old.slice(READS_PER_PASS)) {
    held.add(job.invoiceId);
    stops.push({ invoiceId: job.invoiceId, kind: 'deferred' });
  }
  for (const { outcome, obligation } of outcomes.values()) {
    if (outcome === 'waiting') {
      held.add(obligation.invoiceId);
      stops.push({ invoiceId: obligation.invoiceId, kind: 'unread' });
    } else if (outcome === 'review') {
      held.add(obligation.invoiceId);
      stops.push({ invoiceId: obligation.invoiceId, kind: 'review' });
    }
  }
  return { go: invoiceIds.filter((id) => !held.has(id)), waiting: invoiceIds.filter((id) => held.has(id)), stops };
}

// The error when a ticked press sends nothing: name the cause (and the count
// for jobs), never one shared sentence.
function stoppedSendMessage({ accountingWaiting, accountingReason, stops, waiting }) {
  if (accountingWaiting) {
    if (accountingReason && /more changes than one read takes/i.test(accountingReason)) {
      return 'The accounting copy has more changes than one read takes. Nothing was sent.';
    }
    if (accountingReason) return `${accountingReason.replace(/\.?$/, '')}. Nothing was sent.`;
    return 'The accounting copy could not be read. Nothing was sent.';
  }
  const unread = stops.filter((stop) => stop.kind === 'unread').length;
  const reviews = stops.filter((stop) => stop.kind === 'review').length;
  if (unread) {
    return `${unread} ${unread === 1 ? 'job' : 'jobs'} could not be read from the work system. Nothing was sent.`;
  }
  if (reviews) {
    return `${reviews} ${reviews === 1 ? 'job' : 'jobs'} changed and ${reviews === 1 ? 'needs' : 'need'} a look. Nothing was sent.`;
  }
  const n = waiting.length || 1;
  return `${n} ${n === 1 ? 'job' : 'jobs'} could not be confirmed with the work system. Nothing was sent.`;
}

// Send all ready: issues each ready draft, then queues it for the accounting
// system. With `invoiceIds`, only those drafts. One id (the invoice page) is
// all or nothing. More than one id (the bulk bar) sends the ones Flow could
// confirm and leaves the rest. `work` is the work integration, for the read
// before act. `sendMode` is how the person chose to send this batch (an owner
// or admin can send it approved and emailed while the setting stays Draft);
// null keeps each customer's mode. With approve_and_email, `recipients` maps
// each invoice id to the client email the person saw in the dialog. An
// invoice with no email there goes as a draft, so Flow asks Xero to email
// only invoices whose address was shown. Answers { issued, queued, remaining, waiting, held }.
export async function sendAllReady(db, organisationId, { accounting = null, work = null, personId, issueDate, invoiceIds = null, sendMode = null, recipients = null, now = new Date() }) {
  if (sendMode !== null && !SEND_MODES.includes(sendMode)) throw new FlowError('invalid', `sendMode must be one of ${SEND_MODES.join(', ')}`);
  const seen = seenRecipients(recipients);
  await assertCanSend(accounting, organisationId);
  // Issue #45: the accounting copy reads its latest changes first, so the
  // draft checks below see an invoice someone made there meanwhile.
  let views = await invoiceViews(db, organisationId, { accounting });
  const accountingRead = views.ready.length ? await readAccountingFirst(db, organisationId, { accounting, work, now }) : { outcome: 'fresh' };
  if (accountingRead.changed) views = await invoiceViews(db, organisationId, { accounting });
  // Every check runs again at the press, as a gate: a ticked draft that
  // fails one now (someone edited it, its job changed, a rule matches) is not
  // sent and stays on Pending with its problem. The rest go.
  let { ready } = views;
  let held = 0;
  if (invoiceIds) {
    const wanted = new Set(invoiceIds);
    ready = ready.filter((id) => wanted.has(id));
    held = wanted.size - ready.length;
    if (!ready.length) {
      const kept = invoiceIds.map((id) => views.nonChargeable.get(id)?.[0]?.message).find(Boolean);
      if (kept) throw new FlowError('not_ready', `Not sent: ${kept}`);
      const reason = invoiceIds.map((id) => views.problems.get(id)?.[0]?.message).find(Boolean);
      throw new FlowError('not_ready', reason
        ? `Not sent: ${reason.replace(/\.?$/, '.')} The invoice is on Pending.`
        : 'Only a ready invoice can be sent. Mark it ready first.');
    }
  }
  const accountingWaiting = accountingRead.outcome === 'waiting';
  const { go, waiting, stops } = accountingWaiting
    ? { go: [], waiting: ready.slice(0, SEND_BATCH), stops: [] }
    : await readJobsFirst(db, organisationId, ready.slice(0, SEND_BATCH), { work, now, personId });
  // One invoice (the invoice page) is all or nothing: a job Flow could not
  // confirm stops the send. A bulk press sends the ones it confirmed. The
  // rest stay for the next press (`waiting`), or on Pending when the read
  // sent the job to review. An accounting read that cannot run still stops
  // every ticked invoice: that one read covers the whole press. When nothing
  // can go, the error names the cause and the count.
  if (invoiceIds && waiting.length && go.length === 0) {
    throw new FlowError('not_ready', stoppedSendMessage({
      accountingWaiting,
      accountingReason: accountingRead.reason,
      stops,
      waiting,
    }));
  }
  const batch = go;
  let issued = 0;
  for (const invoiceId of batch) {
    // Queued first: the worker sends only issued invoices, so a stop between
    // the two steps leaves a queued draft, never an issued invoice nobody sends.
    if (accounting) {
      const email = sendMode === 'approve_and_email' ? seen.get(invoiceId) ?? null : null;
      const mode = sendMode === 'approve_and_email' && !email ? 'accounting_draft' : sendMode;
      await queue(db, organisationId, [invoiceId], personId, mode, email);
    }
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
  return { issued, queued: accounting ? issued : 0, remaining: Math.max(0, ready.length - SEND_BATCH), waiting: waiting.length, held };
}

// Override (docs/INVOICE_SENDING.md, "Override"): an owner or admin sends one
// Pending draft although it has a warning. It is the only door: Send ready
// and the bulk bar never read an override. Every problem of the draft must be
// on the allow list (send-override.js), and the person must have ticked each
// warning as it is now (`acknowledged`, the problem keys). The record, the
// invoice number and the queue commit together. The send worker then passes
// the recorded keys to the accounting adapter, which still stops on any other
// problem. Answers { invoice, override }.
export async function sendAnyway(db, organisationId, invoiceId, {
  accounting = null, work = null, personId, issueDate, acknowledged, reasonCode, note = null, now = new Date(),
}) {
  if (!accounting) throw new FlowError('accounting_not_connected', 'No accounting system is on. Nothing to send.');
  if (!personId) throw new FlowError('invalid', 'personId is required');
  const reason = readReason(reasonCode, note);
  if (!Array.isArray(acknowledged) || acknowledged.some((key) => typeof key !== 'string')) throw new FlowError('invalid', 'acknowledged must list the warnings the person ticked');
  await assertCanSend(accounting, organisationId);
  let invoice = requireOwn(await getInvoice(db, organisationId, invoiceId));
  if (invoice.status !== 'draft') throw new FlowError('not_draft', 'Only a draft can be sent with a warning.');
  const accountingRead = await readAccountingFirst(db, organisationId, { accounting, work, now });
  if (accountingRead.outcome === 'waiting') {
    throw new FlowError('not_ready', stoppedSendMessage({ accountingWaiting: true, accountingReason: accountingRead.reason, stops: [], waiting: [invoiceId] }));
  }
  const { go, waiting, stops } = await readJobsFirst(db, organisationId, [invoiceId], { work, now, personId });
  if (!go.length) throw new FlowError('not_ready', stoppedSendMessage({ accountingWaiting: false, stops, waiting }));
  invoice = await getInvoice(db, organisationId, invoiceId);
  const found = (await checkDrafts(db, organisationId, [invoice], accounting)).get(invoiceId) ?? [];
  if (!found.length) throw new FlowError('not_overridable', 'This invoice has no warning. Send it in the usual way.');
  if (!overridable(found)) {
    const blocking = found.find((p) => !overridable([p]));
    throw new FlowError('not_overridable', `Not sent: ${blocking.message.replace(/\.?$/, '.')} An override cannot pass this problem.`);
  }
  const keys = found.map(problemKey).sort();
  const ticked = [...new Set(acknowledged)].sort();
  if (keys.length !== ticked.length || keys.some((key, i) => key !== ticked[i])) {
    throw new FlowError('override_stale', 'The warnings changed. Read them again.');
  }
  return db.transaction(async (tx) => {
    await queue(tx, organisationId, [invoiceId], personId);
    const issued = await issueInvoice(tx, organisationId, invoiceId, { issuedBy: `person:${personId}`, issueDate });
    const override = await recordOverride(tx, organisationId, issued, { problems: found, ...reason, personId });
    return { invoice: issued, override };
  });
}

// Send again: issued invoices that failed go back on the queue. With no ids,
// every failed one.
export async function sendAgain(db, organisationId, { accounting = null, personId, invoiceIds = null }) {
  await assertCanSend(accounting, organisationId);
  if (!accounting) throw new FlowError('accounting_not_connected', 'No accounting system is on. Nothing to send.');
  const where = [eq(invoices.organisationId, organisationId), eq(invoices.status, 'issued'), OWN, eq(invoices.sendState, 'failed')];
  if (invoiceIds) where.push(inArray(invoices.id, invoiceIds));
  const rows = await db.select({ id: invoices.id }).from(invoices).where(and(...where));
  await queue(db, organisationId, rows.map((r) => r.id), personId);
  return { queued: rows.length };
}

// The recipients the Send dialog showed: { invoiceId: email }, as a Map of
// lower-case emails. Anything else is refused.
function seenRecipients(recipients) {
  if (recipients == null) return new Map();
  if (typeof recipients !== 'object' || Array.isArray(recipients)) throw new FlowError('invalid', 'recipients must map invoice ids to emails');
  const seen = new Map();
  for (const [id, email] of Object.entries(recipients)) {
    if (email == null) continue;
    if (typeof email !== 'string' || email.length > 320 || !email.includes('@')) throw new FlowError('invalid', 'each recipient must be an email address');
    seen.set(id, email.trim().toLowerCase());
  }
  return seen;
}

async function queue(db, organisationId, invoiceIds, personId, sendMode = null, sendEmail = null) {
  if (!invoiceIds.length) return;
  await db.update(invoices)
    .set({ sendState: 'queued', sendError: null, sendRequestedBy: personId ?? null, sendMode, sendEmail, sendUpdatedAt: sql`now()` })
    .where(and(eq(invoices.organisationId, organisationId), inArray(invoices.id, invoiceIds)));
}

function unqueue(db, organisationId, invoiceId) {
  return db.update(invoices).set({ sendState: null, sendRequestedBy: null, sendMode: null, sendEmail: null, sendUpdatedAt: sql`now()` })
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId), eq(invoices.status, 'draft')));
}

// The short refusal message for an error report. An email address is dropped,
// and so is a double-quoted name: Flow's own messages put a customer name in
// quotes. Single quotes stay, because the accounting system quotes an account
// code that way. The invoice's own problem, shown to a person, keeps the
// full message.
function refusalMessage(message) {
  let text = String(message ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '')
    .replace(/"[^"\n]{0,240}"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
  // Dropping the address and the quoted name can leave an empty "See for."
  text = text.replace(/(?:^|\.\s*)See for\.$/i, (match) => (match.startsWith('.') ? '.' : '')).trim();
  return text.slice(0, REFUSAL_MESSAGE_LIMIT);
}

// One refused invoice, as the error report may name it. Anything that is not
// an id, a number or a code is left out.
function refusalFact(row, error) {
  const invoiceId = INVOICE_ID.test(row?.id ?? '') ? row.id : null;
  if (!invoiceId) return null;
  const number = INVOICE_NUMBER.test(row?.number ?? '') ? row.number : null;
  const code = REFUSAL_CODE.test(error?.code ?? '') ? error.code : 'send_failed';
  const message = refusalMessage(error?.message);
  return { invoiceId, ...(number ? { number } : {}), code, ...(message ? { message } : {}) };
}

function formatRefusal(item) {
  const fact = refusalFact(
    { id: item?.invoiceId, number: item?.number },
    { code: item?.code, message: item?.message },
  );
  if (!fact) return null;
  const who = fact.number ? `${fact.number} (${fact.invoiceId})` : fact.invoiceId;
  return fact.message ? `${who} ${fact.code}: ${fact.message}` : `${who} ${fact.code}`;
}

// The line the error service gets when the accounting system refuses invoices.
// `result` is the send pass summary (`failed`, `refusals`).
export function refusalReport(result) {
  const refusals = Array.isArray(result?.refusals) ? result.refusals : [];
  const count = Number.isInteger(result?.failed) && result.failed > 0 ? result.failed : refusals.length;
  const shown = refusals.slice(0, REFUSAL_REPORT_CAP).map(formatRefusal).filter(Boolean);
  const hidden = Math.max(0, refusals.length - REFUSAL_REPORT_CAP);
  const detail = [...shown, ...(hidden ? [`and ${hidden} more`] : [])].join('; ');
  const word = count === 1 ? 'invoice' : 'invoices';
  return `[sending] the accounting system refused ${count} ${word}${detail ? `: ${detail}` : ''}`;
}

// Why the person who queued a send may not send it now, or null. Only an
// active owner or admin sends to the accounting system; the worker checks
// again at the send, so a person turned off or made staff meanwhile stops
// what they queued.
async function requesterRefusal(db, personId) {
  const [row] = await db.select({ status: people.status, role: people.role }).from(people).where(eq(people.id, personId));
  if (row?.status !== 'active') return { code: 'requester_disabled', message: 'The person who asked to send this is turned off. Send it again.' };
  if (!['owner', 'admin'].includes(row.role)) return { code: 'requester_not_allowed', message: 'The person who asked to send this is no longer an owner or admin. An owner or admin can send it again.' };
  return null;
}

// One pass of the send worker: up to `limit` queued invoices, oldest first.
export async function sendQueued(db, organisationId, { accounting, limit = WORKER_BATCH }) {
  const rows = await db.select({ id: invoices.id, number: invoices.number, by: invoices.sendRequestedBy }).from(invoices)
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.status, 'issued'), OWN, eq(invoices.sendState, 'queued')))
    .orderBy(asc(invoices.sendUpdatedAt), asc(invoices.id))
    .limit(limit);
  const summary = { sent: 0, failed: 0, waiting: 0 };
  for (const [by, group] of Map.groupBy(rows, (r) => r.by ?? null)) {
    const known = new Map(group.map((row) => [row.id, row]));
    // A send waits in the queue. The person who asked for it must still be
    // an active owner or admin when it goes, so turning a person (or an
    // assistant's key) off, or making them staff, also stops what they queued.
    const refusal = by ? await requesterRefusal(db, by) : null;
    if (refusal) {
      for (const row of group) {
        await settle(db, organisationId, row.id, { sendState: 'failed', sendError: refusal });
        summary.failed += 1;
      }
      summary.refused = [...new Set([...(summary.refused ?? []), refusal.code])];
      continue;
    }
    // An invoice sent with an override (sendAnyway): the adapter passes the
    // recorded warnings and still stops on any other problem.
    const accepted = await acceptedKeysFor(db, organisationId, group.map((r) => r.id));
    // The adapter asks again right before each write (making the invoice,
    // emailing it), so a change of role meanwhile still stops it.
    const { invoices: results } = await accounting.capabilities.pushInvoices({
      organisationId, invoiceIds: group.map((r) => r.id), pushedBy: by, ...(accepted.size ? { accepted } : {}),
      ...(by ? { mayWrite: () => requesterRefusal(db, by) } : {}),
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
        const xero = xeroMatch(error);
        await settle(db, organisationId, result.invoiceId, { sendState: 'failed', sendError: { code: error.code, message: error.message, ...(error.short ? { short: error.short } : {}), ...(xero ? { xero } : {}) } });
        summary.failed += 1;
        summary.refused = [...new Set([...(summary.refused ?? []), error.code])];
        const fact = refusalFact(known.get(result.invoiceId), error);
        if (fact) summary.refusals = [...(summary.refusals ?? []), fact];
      }
    }
  }
  return summary;
}

// The Xero invoice a refusal matched, kept so the page can link to it.
// Only an id, a number and a status. Anything else in the error stays out.
function xeroMatch(error) {
  const xero = error?.details?.xero;
  if (!xero || typeof xero !== 'object') return null;
  if (!INVOICE_ID.test(xero.invoiceId ?? '')) return null;
  const number = INVOICE_NUMBER.test(xero.number ?? '') ? xero.number : null;
  const status = /^[A-Z0-9_]{1,32}$/.test(xero.status ?? '') ? xero.status : null;
  return { invoiceId: xero.invoiceId, ...(number ? { number } : {}), ...(status ? { status } : {}) };
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
        // person. The error report names which invoices and why, once, when
        // they are refused. The host log keeps the same pass on warn.
        if (ran.outcome === 'dead') log.error?.('[sending] the send run gave up after its last attempt');
        if (ran.job.result?.failed) log.error?.(refusalReport(ran.job.result));
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
    tick,
  };
}
