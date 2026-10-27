import { and, eq, inArray, isNull } from 'drizzle-orm';
import { contacts, invoices, priceItems, reviewItems } from '../db/schema.js';
import { listRules } from './invoice-rules.js';
import { customerBillingByContact, effectiveSettings, readInvoicingSettings, ruleBlockers } from './invoicing-rules.js';
import { REVIEW_CHANGED, listObligations } from './ledger.js';
import { isHistoryHeld } from './history.js';
import { invoiceViews } from './sending.js';

// The Jobs board (/jobs, server/ui/jobs.js). Its columns are the work
// system's own job statuses, one to one. Its jobs come from the work
// system's copy in Flow (the port's listWork: Seazona's open orders and the
// ones finished lately), so jobs still in the lab show. A job that has a
// billing obligation (ledger.js) carries it, with the state of its invoice,
// for the job's detail panel. With no work system that offers listWork, the
// board shows the ledger's jobs by the status the work system last reported.

// The ledger's jobs with what the Jobs page shows: the customer's name, the
// invoice's number, status, Invoices page view (sending.js) and problems,
// and the invoicing rules a job with no invoice waits on. `listed` is
// listObligations output. `accounting` is the accounting adapter, or null.
export async function describeObligations(db, organisationId, listed, { accounting = null } = {}) {
  const contactIds = [...new Set(listed.map((e) => e.obligation.contactId).filter(Boolean))];
  const invoiceIds = [...new Set(listed.map((e) => e.obligation.invoiceId).filter(Boolean))];
  const changedIds = listed.filter((e) => e.obligation.holdState === 'review' && e.obligation.invoiceId).map((e) => e.obligation.id);
  const [names, numbers, views, changed] = await Promise.all([
    contactIds.length
      ? db.select({ id: contacts.id, name: contacts.name }).from(contacts)
        .where(and(eq(contacts.organisationId, organisationId), inArray(contacts.id, contactIds)))
      : [],
    invoiceIds.length
      ? db.select({ id: invoices.id, number: invoices.number, status: invoices.status }).from(invoices)
        .where(and(eq(invoices.organisationId, organisationId), inArray(invoices.id, invoiceIds)))
      : [],
    invoiceIds.length ? invoiceViews(db, organisationId, { accounting }) : null,
    // The open "job changed" alerts (ledger.js): only the work system changed
    // and the draft is not sent, so a person can use the new lines.
    changedIds.length
      ? db.select({ flowId: reviewItems.flowId, evidence: reviewItems.evidence }).from(reviewItems).where(and(
        eq(reviewItems.organisationId, organisationId), eq(reviewItems.kind, REVIEW_CHANGED),
        eq(reviewItems.state, 'open'), inArray(reviewItems.flowId, changedIds),
      ))
      : [],
  ]);
  const offers = new Set(changed.filter((r) => r.evidence?.canUseNewLines).map((r) => r.flowId));
  const nameOf = new Map(names.map((c) => [c.id, c.name]));
  const invoiceOf = new Map(numbers.map((i) => [i.id, i]));
  const settings = await readInvoicingSettings(db, organisationId);
  const customers = await customerBillingByContact(db, organisationId, contactIds);
  const rules = await listRules(db, organisationId);
  const ready = new Set(views?.ready ?? []);
  const toCheck = new Set(views?.toCheck ?? []);
  const invoiceView = (id) => (!id || !views ? null
    : views.problems.has(id) ? 'problem' : views.nonChargeable.has(id) ? 'non_chargeable' : ready.has(id) ? 'ready' : toCheck.has(id) ? 'to_check'
      : views.sending.has(id) ? 'sending' : null);
  // The invoicing rules a job with no invoice waits on, for every view a
  // draft can still come from.
  const waitingFor = (o, v) => (o.invoiceId || !['in_work', 'ready', 'pending', 'held'].includes(v)
    ? [] : ruleBlockers(o, { ...effectiveSettings(settings, customers.get(o.contactId)), name: nameOf.get(o.contactId) ?? null }, { rules }));
  return listed.map(({ obligation: { lineFingerprint: _fingerprint, organisationId: _org, draftBasis: _basis, ...o }, view, reasons }) => ({
    ...o,
    canUseNewLines: offers.has(o.id),
    contactName: nameOf.get(o.contactId) ?? null,
    invoiceNumber: invoiceOf.get(o.invoiceId)?.number ?? null,
    invoiceStatus: invoiceOf.get(o.invoiceId)?.status ?? null,
    invoiceView: invoiceView(o.invoiceId),
    invoiceProblems: (o.invoiceId && views?.problems.get(o.invoiceId)) || [],
    view,
    reasons,
    waitingFor: waitingFor(o, view),
  }));
}

const keyOf = (system, ref) => `${system}\u0000${ref}`;

// The ledger's lines as the board shows them: whether each maps to a price item.
const ledgerLines = (lines) => (lines ?? []).map((l) => ({
  code: l.itemCode ?? null, description: l.description, amountCents: l.lineAmountCents ?? null, mapped: Boolean(l.priceItemId),
}));

// Answers { jobs, statuses }. `work` is the adapters that offer listWork;
// `live` says an accounting system checks the ledger (ledgerView).
export async function boardJobs(db, organisationId, { work = [], accounting = null, live = false, log = console } = {}) {
  // Held history jobs are past work, so the board leaves them out
  // (core/history.js); the history import lists them by accounting state.
  const listed = (await listObligations(db, organisationId, { accounting: live })).filter((entry) => !isHistoryHeld(entry.obligation));
  const obligations = await describeObligations(db, organisationId, listed, { accounting });
  const byJob = new Map(obligations.map((o) => [keyOf(o.sourceSystem, o.sourceJobRef), o]));

  const reports = [];
  for (const adapter of work) {
    try {
      reports.push(await adapter.capabilities.listWork({ organisationId }));
    } catch (error) {
      // The board still shows the ledger's jobs when the copy cannot be read.
      log.error?.(`[jobs] ${adapter.id} listWork: ${error.message}`);
    }
  }
  if (!reports.length) {
    const statuses = new Map();
    const jobs = obligations.map((o) => {
      const status = o.sourceStatus?.trim() || null;
      if (status && !statuses.has(status)) statuses.set(status, { label: status, final: false, firstSeenAt: null });
      return {
        sourceSystem: o.sourceSystem, sourceJobRef: o.sourceJobRef, caseRef: o.caseRef, status,
        clientName: o.contactName, workClientName: null, practitioner: o.practitioner, patient: null, department: null,
        orderedOn: null, dueOn: null, jobDate: o.jobDate, shippedOn: o.shippedOn,
        totalCents: o.totalCents, lines: ledgerLines(o.lines), obligation: o,
      };
    });
    return { jobs: await withIssues(jobs, work, log), statuses: [...statuses.values()] };
  }

  const codes = new Set((await db.select({ code: priceItems.code }).from(priceItems)
    .where(and(eq(priceItems.organisationId, organisationId), isNull(priceItems.archivedAt)))).map((p) => p.code));
  const jobs = [];
  const statuses = [];
  for (const report of reports) {
    statuses.push(...(report.statuses ?? []));
    for (const item of report.items ?? []) {
      const o = byJob.get(keyOf(item.sourceSystem, item.sourceJobRef)) ?? null;
      jobs.push({
        sourceSystem: item.sourceSystem,
        sourceJobRef: item.sourceJobRef,
        caseRef: item.caseRef ?? o?.caseRef ?? null,
        status: item.status ?? null,
        // The Flow customer once the work system's client is linked to one;
        // until then the work system's own name for the client.
        clientName: o?.contactName ?? item.clientName ?? null,
        workClientName: item.clientName ?? null,
        practitioner: item.practitioner ?? o?.practitioner ?? null,
        department: item.department ?? null,
        patient: item.patient ?? null,
        orderedOn: item.orderedOn ?? null,
        dueOn: item.dueOn ?? null,
        jobDate: o?.jobDate ?? null,
        shippedOn: o?.shippedOn ?? null,
        totalCents: o?.totalCents ?? item.totalCents ?? null,
        lines: o ? ledgerLines(o.lines)
          : (item.lines ?? []).map((l) => ({ code: l.code ?? null, description: l.description, amountCents: l.amountCents ?? null, mapped: Boolean(l.code && codes.has(l.code)) })),
        // A stage move the work system has not made yet (moveWork).
        pendingMove: item.pendingMove ?? null,
        // The link to the job in the work system's own web app ({ url, exact }).
        link: item.link ?? null,
        obligation: o,
      });
    }
  }
  return { jobs: await withIssues(jobs, work, log), statuses };
}

// Each job's open issues from its integration (the port's jobIssues): a
// short phrase and the page where a person fixes it. A failed read leaves
// the board as it is.
async function withIssues(jobs, adapters, log) {
  const issues = new Map();
  for (const adapter of adapters) {
    if (typeof adapter.capabilities.jobIssues !== 'function') continue;
    const refs = jobs.filter((j) => j.sourceSystem === adapter.id).map((j) => j.sourceJobRef);
    if (!refs.length) continue;
    try {
      const found = await adapter.capabilities.jobIssues({ refs });
      for (const [ref, list] of Object.entries(found ?? {})) issues.set(keyOf(adapter.id, ref), list);
    } catch (error) {
      log.error?.(`[jobs] ${adapter.id} jobIssues: ${error.message}`);
    }
  }
  return jobs.map((j) => ({ ...j, issues: issues.get(keyOf(j.sourceSystem, j.sourceJobRef)) ?? [] }));
}
