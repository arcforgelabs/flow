import { and, eq, sql } from 'drizzle-orm';
import { automations, billingObligations } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { autoDraftJobs } from './invoicing-rules.js';
import { setReady } from './ledger.js';

// Automations (docs/AUTOMATIONS.md): Flow's routines. Each one watches Flow's
// own records and moves them on, and each is on or off with its own settings,
// so no other system's status is baked into Flow's stages. `place` is the
// screen that shows it: the integration whose data triggers it, or invoicing. The routines are
// defined here; the `automations` table holds an organisation's choices. The
// pipeline (pipeline.js) runs them after it reads the integrations' copies.
//
//   mark_ready_from_work_status: a job whose work system status is one of the
//     chosen statuses becomes ready to invoice (Flow's stage).
//   draft_when_ready: a job that is ready to invoice and passes the invoicing
//     rules (invoicing-rules.js) gets a draft invoice in Flow.

const BATCH = 500;

const words = (value) => String(value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// A status matches when it holds one of the chosen statuses as whole words,
// in any case: "Shipped" and "Order shipped" match "shipped".
export function statusMatches(status, statuses) {
  const have = ` ${words(status).join(' ')} `;
  return statuses.some((wanted) => {
    const want = words(wanted).join(' ');
    return want && have.includes(` ${want} `);
  });
}

function readStatuses(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new FlowError('invalid', 'statuses must list 1 to 20 statuses');
  const statuses = [...new Set(value.map((s) => (typeof s === 'string' ? s.trim().toLowerCase() : '')).filter(Boolean))];
  if (!statuses.length || statuses.some((s) => s.length > 100)) throw new FlowError('invalid', 'statuses must be short text');
  return statuses;
}

export const AUTOMATIONS = Object.freeze([
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

// Runs every routine that is on. `accounting` is the integration whose copy
// the draft routine checks; without one, the draft routine waits.
export async function runAutomations(db, organisationId, { accounting = null, now = new Date() } = {}) {
  const summary = {};
  for (const automation of await listAutomations(db, organisationId)) {
    if (!automation.enabled) continue;
    if (automation.key === 'mark_ready_from_work_status') {
      summary[automation.key] = await markReadyFromWorkStatus(db, organisationId, automation.config);
    } else if (automation.key === 'draft_when_ready' && accounting) {
      summary[automation.key] = await autoDraftJobs(db, organisationId, { accounting, now, actor: actorOf(automation.key) });
    }
  }
  return summary;
}
