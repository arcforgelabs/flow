import { and, eq } from 'drizzle-orm';
import { contacts, billingObligations, invoicingSettings, PORTAL_STAGES } from '../db/schema.js';
import { FlowError } from '../core/errors.js';
import { isHistoryHeld } from '../core/history.js';
import { addMember, changeMember, listMembers, publicMember, removeMember } from './members.js';

// The only way a practice portal route reads Flow. Every query names the
// member's practice. A job, member or contact from another practice is
// dropped before it is returned (docs/PORTAL.md).

export function normaliseStatusNames(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [status, name] of Object.entries(value)) {
    const key = String(status ?? '').trim();
    if (!key || key.length > 80) continue;
    if (!PORTAL_STAGES.includes(name)) continue;
    out[key] = name;
  }
  return out;
}

// The portal name for a work-system status. A status with no portal name is
// skipped; the job keeps the nearest earlier status that has one.
export function portalStageOf(workStatus, statusOrder, names) {
  const order = (statusOrder ?? []).filter(Boolean);
  const start = order.indexOf(workStatus);
  const sequence = start === -1 ? [workStatus, ...[...order].reverse()] : order.slice(0, start + 1).reverse();
  for (const label of sequence) {
    if (label && PORTAL_STAGES.includes(names?.[label])) return names[label];
  }
  return null;
}

export function jobTrack(stage) {
  const at = PORTAL_STAGES.indexOf(stage);
  return PORTAL_STAGES.map((name, index) => ({
    name,
    state: at === -1 ? 'waiting' : index < at ? 'done' : index === at ? 'current' : 'waiting',
  }));
}

export async function readPortalSettings(db, organisationId) {
  const [row] = await db.select({
    portalEnabled: invoicingSettings.portalEnabled,
    portalStatusNames: invoicingSettings.portalStatusNames,
  }).from(invoicingSettings).where(eq(invoicingSettings.organisationId, organisationId));
  return { enabled: Boolean(row?.portalEnabled), names: normaliseStatusNames(row?.portalStatusNames) };
}

export async function practicesOf(db, members) {
  const choices = [];
  for (const member of members) {
    const [row] = await db.select({ name: contacts.name }).from(contacts).where(and(
      eq(contacts.organisationId, member.organisationId),
      eq(contacts.id, member.contactId),
    ));
    choices.push({ contactId: member.contactId, name: row?.name ?? 'Practice', role: member.role });
  }
  return choices;
}

const keyOf = (system, ref) => `${system}\u0000${ref}`;

function presentJob(row, work, names, statusOrder, today) {
  const stage = portalStageOf(work?.status ?? row.sourceStatus, statusOrder, names);
  const due = work?.dueOn ?? row.jobDate ?? null;
  const descriptions = (Array.isArray(row.lines) ? row.lines : [])
    .map((line) => String(line?.description ?? '').trim())
    .filter(Boolean);
  return {
    id: row.id,
    caseRef: work?.caseRef ?? row.caseRef ?? row.sourceJobRef,
    item: descriptions[0] ?? '',
    dentist: work?.practitioner ?? row.practitioner ?? '',
    status: stage,
    due,
    late: Boolean(due && due < today && stage !== 'Sent'),
    orderedOn: work?.orderedOn ?? null,
    lines: descriptions.map((description) => ({ description })),
    track: jobTrack(stage),
  };
}

async function workReport(work, organisationId, log) {
  const items = new Map();
  const statuses = [];
  for (const adapter of work) {
    if (typeof adapter?.capabilities?.listWork !== 'function') continue;
    try {
      const report = await adapter.capabilities.listWork({ organisationId });
      for (const status of report?.statuses ?? []) {
        const label = status?.label ?? status;
        if (label) statuses.push(String(label));
      }
      for (const item of report?.items ?? []) items.set(keyOf(item.sourceSystem, item.sourceJobRef), item);
    } catch (error) {
      log?.error?.(`[portal] ${adapter.id} listWork: ${error.message}`);
    }
  }
  return { items, statuses };
}

function matchesQuery(job, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [job.caseRef, job.item, job.dentist, job.status].some((value) => String(value ?? '').toLowerCase().includes(needle));
}

// `readOnly` is the lab's view of one practice: jobs only.
export function portalScope(db, {
  organisationId, contactId, actor = null, work = () => [], log = console, today = null, readOnly = false, requireEnabled = true,
}) {
  if (!organisationId || !contactId) throw new FlowError('invalid', 'a practice is required');
  const day = today ?? new Date().toISOString().slice(0, 10);

  function kept(rows) {
    return rows.filter((row) => row.organisationId === organisationId && row.contactId === contactId);
  }

  async function portal() {
    const settings = await readPortalSettings(db, organisationId);
    if (requireEnabled && !settings.enabled) throw new FlowError('portal_off', 'The practice portal is turned off.');
    return settings;
  }

  async function listed() {
    const settings = await portal();
    const rows = kept(await db.select().from(billingObligations).where(and(
      eq(billingObligations.organisationId, organisationId),
      eq(billingObligations.contactId, contactId),
    ))).filter((row) => !isHistoryHeld(row));
    const report = await workReport(work(), organisationId, log);
    const order = report.statuses.length ? report.statuses : [...new Set(rows.map((row) => row.sourceStatus).filter(Boolean))];
    return {
      settings,
      jobs: rows.map((row) => presentJob(row, report.items.get(keyOf(row.sourceSystem, row.sourceJobRef)) ?? null, settings.names, order, day)),
    };
  }

  return {
    organisationId,
    contactId,
    async jobs({ q = '', mine = false, practitionerName = null } = {}) {
      const { jobs } = await listed();
      const needle = String(q ?? '').trim();
      const found = jobs.filter((job) => matchesQuery(job, needle));
      const mineName = String(practitionerName ?? '').trim().toLowerCase();
      const shown = mine ? found.filter((job) => mineName && String(job.dentist ?? '').trim().toLowerCase() === mineName) : found;
      shown.sort((a, b) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999')) || String(a.caseRef).localeCompare(String(b.caseRef)));
      return shown;
    },
    async job(id) {
      const { jobs } = await listed();
      return jobs.find((job) => job.id === id) ?? null;
    },
    async team() {
      await portal();
      const [contact] = await db.select({ name: contacts.name }).from(contacts).where(and(
        eq(contacts.organisationId, organisationId),
        eq(contacts.id, contactId),
      ));
      const rows = await listMembers(db, { organisationId, contactId });
      return rows.map((row) => publicMember(row, contact?.name ?? null));
    },
    async invite(input) {
      if (readOnly) throw new FlowError('forbidden', 'This view is read only.');
      await portal();
      if (!actor || actor.status !== 'active' || !['owner', 'admin'].includes(actor.role)) {
        throw new FlowError('forbidden', 'Only an owner or an admin can change the team.');
      }
      if (actor.role !== 'owner' && input.role === 'owner') throw new FlowError('forbidden', 'An admin cannot change an owner');
      return addMember(db, { organisationId, contactId, ...input, invitedBy: actor?.id ?? null });
    },
    async changeMember(id, patch) {
      if (readOnly) throw new FlowError('forbidden', 'This view is read only.');
      await portal();
      return changeMember(db, { organisationId, contactId, id, actor, ...patch });
    },
    async removeMember(id) {
      if (readOnly) throw new FlowError('forbidden', 'This view is read only.');
      await portal();
      return removeMember(db, { organisationId, contactId, id, actor });
    },
  };
}
