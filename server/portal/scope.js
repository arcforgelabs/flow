import { and, desc, eq } from 'drizzle-orm';
import { FlowError, notFound } from '../core/errors.js';
import { isHistoryHeld } from '../core/history.js';
import { billingObligations } from '../db/schema.js';
import { portalStage, portalTrack, readPortalSettings } from './settings.js';

// The only portal read of jobs. Every route that shows a job calls this,
// with the contact id the guard put on the request. A job with no obligation
// for that contact is not returned, even if a work system lists it.

const keyOf = (system, ref) => `${system}\u0000${ref}`;

function present(row, work, statusNames, order, today) {
  const status = portalStage(row.sourceStatus, statusNames, order);
  const dueOn = work?.dueOn ?? row.jobDate ?? null;
  const items = (row.lines ?? []).map((line) => line.description).filter(Boolean);
  return {
    id: row.id,
    caseRef: row.caseRef ?? null,
    item: items[0] ?? null,
    items,
    dentist: row.practitioner ?? work?.practitioner ?? null,
    status,
    dueOn,
    late: Boolean(dueOn && dueOn < today),
    track: portalTrack(status),
  };
}

async function workReports(scope, work, log) {
  const reports = [];
  for (const adapter of work) {
    try {
      reports.push(await adapter.capabilities.listWork({ organisationId: scope.organisationId }));
    } catch (error) {
      log.error?.(`[portal] ${adapter.id} listWork: ${error.message}`);
    }
  }
  return reports;
}

// Jobs for one practice. `work` is the lab's listWork adapters, used only
// to attach a due date and the status order. Rows are still the obligation's.
export async function portalJobs(db, scope, { work = [], log = console, today = new Date().toISOString().slice(0, 10) } = {}) {
  const rows = (await db.select().from(billingObligations).where(and(
    eq(billingObligations.organisationId, scope.organisationId),
    eq(billingObligations.contactId, scope.contactId),
  )).orderBy(desc(billingObligations.sourceSeenAt))).filter((row) => !isHistoryHeld(row));
  const settings = await readPortalSettings(db, scope.organisationId);
  const reports = await workReports(scope, work, log);
  const byJob = new Map();
  const order = [];
  for (const report of reports) {
    for (const status of report.statuses ?? []) {
      const label = typeof status === 'string' ? status : status?.label;
      if (label && !order.includes(label)) order.push(label);
    }
    for (const item of report.items ?? []) byJob.set(keyOf(item.sourceSystem, item.sourceJobRef), item);
  }
  if (!order.length) {
    for (const row of rows) {
      if (row.sourceStatus && !order.includes(row.sourceStatus)) order.push(row.sourceStatus);
    }
  }
  return rows.map((row) => present(row, byJob.get(keyOf(row.sourceSystem, row.sourceJobRef)) ?? null, settings.statusNames, order, today));
}

export async function portalJob(db, scope, id, options) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ''))) throw notFound('job');
  const [row] = await db.select({ id: billingObligations.id }).from(billingObligations).where(and(
    eq(billingObligations.organisationId, scope.organisationId),
    eq(billingObligations.contactId, scope.contactId),
    eq(billingObligations.id, id),
  )).limit(1);
  if (!row) throw notFound('job');
  const jobs = await portalJobs(db, scope, options);
  const job = jobs.find((item) => item.id === id);
  if (!job) throw notFound('job');
  return job;
}

export function assertPortalScope(scope) {
  if (!scope?.organisationId || !scope?.contactId) throw new FlowError('forbidden', 'That practice is not yours.');
}
