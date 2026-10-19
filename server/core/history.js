import { and, asc, eq, sql } from 'drizzle-orm';
import { billingObligations } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { setHold } from './ledger.js';

// Past jobs from a work system's history import (docs/SEAZONA.md, "History
// import"). The pipeline holds each new one (pipeline.js, ingestHistory), so
// it never drafts. The matcher still sets its accounting state. Only a
// person's release moves one into drafting.

export const HISTORY_HOLD_REASON = 'history_import';
export const HISTORY_ACTOR = 'import:seazona_history';

export const isHistoryHeld = (obligation) => obligation?.holdState === 'held' && obligation?.holdReason === HISTORY_HOLD_REASON;

// Accounting states that need a person: no invoice found, or more than one fits.
export const HISTORY_NEEDS_PERSON = ['not_found', 'ambiguous', 'conflict'];

const historyHeld = (organisationId) => and(
  eq(billingObligations.organisationId, organisationId),
  eq(billingObligations.holdState, 'held'),
  eq(billingObligations.holdReason, HISTORY_HOLD_REASON),
);

// Held history jobs by accounting state: counts, and one page of jobs
// (`state` one accounting state, or `needs_person`).
export async function listHistoryJobs(db, organisationId, { state = null, limit = 100, offset = 0 } = {}) {
  const counts = Object.fromEntries((await db.select({ state: billingObligations.accountingState, n: sql`count(*)::int` })
    .from(billingObligations).where(historyHeld(organisationId)).groupBy(billingObligations.accountingState))
    .map((r) => [r.state, r.n]));
  const filters = [historyHeld(organisationId)];
  if (state === 'needs_person') filters.push(sql`${billingObligations.accountingState} in ('not_found', 'ambiguous', 'conflict')`);
  else if (state) filters.push(eq(billingObligations.accountingState, state));
  const jobs = await db.select().from(billingObligations).where(and(...filters))
    .orderBy(asc(billingObligations.jobDate), asc(billingObligations.sourceJobRef))
    .limit(Math.max(1, Math.min(500, Number(limit) || 100))).offset(Math.max(0, Number(offset) || 0));
  const needsPerson = HISTORY_NEEDS_PERSON.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  return {
    counts: { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0), needsPerson },
    jobs: jobs.map((o) => ({
      id: o.id,
      sourceJobRef: o.sourceJobRef,
      sourceInvoiceRef: o.sourceInvoiceRef,
      jobDate: o.jobDate,
      contactId: o.contactId,
      practitioner: o.practitioner,
      totalCents: o.totalCents,
      accountingState: o.accountingState,
      accountingRef: o.accountingRef,
      accountingMatchedBy: o.accountingMatchedBy,
    })),
  };
}

// A person moves one held history job into drafting.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function releaseHistoryJob(db, organisationId, obligationId, { actor }) {
  if (!UUID.test(String(obligationId))) throw Object.assign(new FlowError('invalid', 'the job id must be a Flow id'), { status: 400 });
  const [row] = await db.select().from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId)));
  if (!row) throw Object.assign(notFound('job'), { status: 404 });
  if (!isHistoryHeld(row)) throw Object.assign(new FlowError('conflict', 'the job is not a held history job'), { status: 409 });
  return setHold(db, organisationId, obligationId, { holdState: 'none', actor });
}
