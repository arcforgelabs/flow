import { and, eq, sql } from 'drizzle-orm';
import { automations, billingObligations, invoices } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { autoDraftJobs, readInvoicingSettings } from './invoicing-rules.js';
import { MAPPING_DEFAULTS, readMappingConfig, remapJobs } from './line-mapping.js';
import { setReady } from './ledger.js';
import { refreshReferences } from './references.js';

// Automations (docs/AUTOMATIONS.md): Flow's routines. Each one watches Flow's
// own records and moves them on, and each is on or off with its own settings,
// so no other system's status is baked into Flow's stages. `place` is the
// screen that shows it: the integration whose data triggers it, or invoicing. The routines are
// defined here; the `automations` table holds an organisation's choices. The
// pipeline (pipeline.js) runs them after it reads the integrations' copies.
//
//   mark_ready_from_work_status: a job whose work system status is one of the
//     chosen statuses becomes ready to invoice (Flow's stage). The statuses
//     are picked from those the work system reported (workStatuses).
//   draft_when_ready: a job that is ready to invoice and passes the invoicing
//     rules (invoicing-rules.js) gets a draft invoice in Flow.
//   ready_when_drafted: a draft the draft routine made goes straight to Ready
//     on the Invoices page, until a person changes it or moves it back.
//   reference_from_rule: a draft made from a job keeps the Reference the
//     lab's Reference rule gives (references.js), as the job's fields arrive.

const BATCH = 500;

const norm = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// A status matches when it is one of the chosen statuses, in any case.
export function statusMatches(status, statuses) {
  const have = norm(status);
  return Boolean(have) && statuses.some((wanted) => norm(wanted) === have);
}

// The statuses the work system has reported for this organisation's jobs, with
// the number of jobs at each, most jobs first. People pick the ready statuses
// from this list, so it follows each lab's own work system.
export async function workStatuses(db, organisationId) {
  const rows = await db.select({ status: billingObligations.sourceStatus, jobs: sql`count(*)::int` })
    .from(billingObligations)
    .where(and(eq(billingObligations.organisationId, organisationId), sql`${billingObligations.sourceStatus} is not null`))
    .groupBy(billingObligations.sourceStatus);
  const byName = new Map();
  for (const { status, jobs } of rows) {
    const key = norm(status);
    if (!key) continue;
    const seen = byName.get(key);
    if (seen) seen.jobs += jobs;
    else byName.set(key, { value: key, label: status.trim(), jobs });
  }
  return [...byName.values()].sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));
}

function readStatuses(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new FlowError('invalid', 'statuses must list 1 to 20 statuses');
  const statuses = [...new Set(value.map((s) => (typeof s === 'string' ? norm(s) : '')).filter(Boolean))];
  if (!statuses.length || statuses.some((s) => s.length > 100)) throw new FlowError('invalid', 'statuses must be short text');
  return statuses;
}

export const AUTOMATIONS = Object.freeze([
  {
    // Runs inside the pipeline's read of the work system (pipeline.js,
    // ingestWork), so every job reaches the ledger already mapped.
    key: 'map_lines',
    place: 'seazona',
    name: 'Map lines to price items',
    hint: 'Each Seazona line finds its price item.',
    defaults: { enabled: true, config: { ...MAPPING_DEFAULTS } },
    readConfig: (config) => readMappingConfig(config),
    remap: true,
  },
  {
    key: 'mark_ready_from_work_status',
    place: 'seazona',
    name: 'Mark ready to invoice',
    hint: 'When the job has one of the ready statuses.',
    defaults: { enabled: true, config: { statuses: ['shipped', 'delivered'] } },
    readConfig: (config) => ({ statuses: readStatuses(config.statuses) }),
  },
  {
    key: 'draft_when_ready',
    place: 'invoicing',
    name: 'Draft when ready',
    hint: 'Drafts each ready job that passes the checks.',
    defaults: { enabled: true, config: {} },
    readConfig: () => ({}),
  },
  {
    key: 'ready_when_drafted',
    place: 'invoicing',
    name: 'Ready when drafted',
    hint: 'A draft with no problem goes straight to Ready.',
    defaults: { enabled: true, config: {} },
    readConfig: () => ({}),
  },
  {
    key: 'reference_from_rule',
    place: 'invoicing',
    name: 'Reference from the rule',
    hint: 'A draft made from a job gets its Reference from the Reference rule. A Reference a person typed stays.',
    defaults: { enabled: true, config: {} },
    readConfig: () => ({}),
  },
]);

const byKey = new Map(AUTOMATIONS.map((a) => [a.key, a]));

// Every routine with this organisation's choice, or its default.
export async function listAutomations(db, organisationId) {
  const rows = await db.select().from(automations).where(eq(automations.organisationId, organisationId));
  const saved = new Map(rows.map((r) => [r.key, r]));
  return AUTOMATIONS.map(({ key, place, name, hint, defaults }) => {
    const row = saved.get(key);
    return { key, place, name, hint, enabled: row?.enabled ?? defaults.enabled, config: { ...defaults.config, ...(row?.config ?? {}) } };
  });
}

export async function saveAutomation(db, organisationId, key, changes, { personId = null } = {}) {
  const automation = byKey.get(key);
  if (!automation) throw notFound('automation');
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new FlowError('invalid', 'the change must be an object');
  const unknown = Object.keys(changes).filter((k) => !['enabled', 'config'].includes(k));
  if (unknown.length) throw new FlowError('invalid', `unknown field: ${unknown[0]}`);
  const current = (await listAutomations(db, organisationId)).find((a) => a.key === key);
  const enabled = changes.enabled ?? current.enabled;
  if (typeof enabled !== 'boolean') throw new FlowError('invalid', 'enabled must be true or false');
  const config = 'config' in changes ? automation.readConfig({ ...current.config, ...changes.config }) : current.config;
  await db.insert(automations)
    .values({ organisationId, key, enabled, config, updatedBy: personId })
    .onConflictDoUpdate({ target: [automations.organisationId, automations.key], set: { enabled, config, updatedBy: personId, updatedAt: sql`now()` } });
  // A routine that shapes jobs as they come in applies to the jobs already read.
  if (automation.remap) await remapJobs(db, organisationId);
  return (await listAutomations(db, organisationId)).find((a) => a.key === key);
}

const actorOf = (key) => `automation:${key}`;

// Marks ready each job in work whose work system status is one of the chosen
// ones. A person who put a job back in work has decided: the routine leaves
// that job to people from then on.
async function markReadyFromWorkStatus(db, organisationId, { statuses }) {
  const actor = actorOf('mark_ready_from_work_status');
  const jobs = await db.select().from(billingObligations).where(and(
    eq(billingObligations.organisationId, organisationId),
    sql`${billingObligations.readyAt} is null`,
    sql`${billingObligations.invoiceId} is null`,
    sql`${billingObligations.sourceStatus} is not null`,
    sql`not exists (select 1 from obligation_events e where e.obligation_id = ${billingObligations.id}
      and e.kind = 'in_work' and e.actor not like 'automation:%')`,
  )).limit(BATCH);
  let marked = 0;
  for (const job of jobs) {
    if (!statusMatches(job.sourceStatus, statuses)) continue;
    await setReady(db, organisationId, job.id, { ready: true, actor });
    marked += 1;
  }
  return { marked };
}

// Marks ready each draft the draft routine made that no person has touched.
// A person's edit or "back to drafts" moves the draft's updatedAt on from its
// createdAt, so the routine leaves it to people from then on. A draft with a
// problem shows in Problem whatever its ready mark (sending.js, invoiceViews).
async function readyWhenDrafted(db, organisationId) {
  const rows = await db.update(invoices).set({ readyAt: sql`now()`, readyBy: null })
    .where(and(
      eq(invoices.organisationId, organisationId),
      eq(invoices.status, 'draft'),
      sql`${invoices.readyAt} is null`,
      sql`${invoices.updatedAt} = ${invoices.createdAt}`,
      sql`exists (select 1 from billing_obligations o join obligation_events e on e.obligation_id = o.id
        where o.organisation_id = ${invoices.organisationId} and o.invoice_id = ${invoices.id}
          and e.kind = 'drafted' and e.actor = ${actorOf('draft_when_ready')})`,
    ))
    .returning({ id: invoices.id });
  return { marked: rows.length };
}

// Runs every routine that is on. `accounting` is the integration whose copy
// the draft routine checks; without one, Flow's own records are the check.
export async function runAutomations(db, organisationId, { accounting = null, work = null, now = new Date() } = {}) {
  const summary = {};
  for (const automation of await listAutomations(db, organisationId)) {
    if (!automation.enabled) continue;
    if (automation.key === 'mark_ready_from_work_status') {
      summary[automation.key] = await markReadyFromWorkStatus(db, organisationId, automation.config);
    } else if (automation.key === 'draft_when_ready') {
      summary[automation.key] = await autoDraftJobs(db, organisationId, { accounting, work, now, actor: actorOf(automation.key) });
    } else if (automation.key === 'ready_when_drafted') {
      summary[automation.key] = await readyWhenDrafted(db, organisationId);
    } else if (automation.key === 'reference_from_rule') {
      const { referenceTemplate: template } = await readInvoicingSettings(db, organisationId);
      summary[automation.key] = await refreshReferences(db, organisationId, { template, work });
    }
  }
  return summary;
}
