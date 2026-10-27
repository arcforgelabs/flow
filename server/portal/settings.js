import { eq, sql } from 'drizzle-orm';
import { FlowError } from '../core/errors.js';
import { invoicingSettings } from '../db/schema.js';

// Portal names live on the lab's invoicing settings row: one place already
// holds the organisation's choices, so the portal does not add a table.
// A work-system status with no portal name is hidden. The job shows the
// last status before it that does have a name.

export const PORTAL_STAGES = Object.freeze(['Ordered', 'Received', 'In work', 'Quality check', 'Sent']);

const DEFAULTS = Object.freeze({ enabled: true, statusNames: {} });

function cleanNames(value, { strict = false } = {}) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new FlowError('invalid', 'status names must be an object');
    return {};
  }
  const out = {};
  for (const [status, name] of Object.entries(value)) {
    const key = String(status).trim();
    if (!key || key.length > 80) {
      if (strict) throw new FlowError('invalid', 'a status name is too long');
      continue;
    }
    if (name == null || name === '') continue;
    if (!PORTAL_STAGES.includes(name)) {
      if (strict) throw new FlowError('invalid', `portal name must be one of ${PORTAL_STAGES.join(', ')}`);
      continue;
    }
    out[key] = name;
  }
  return out;
}

export async function readPortalSettings(db, organisationId) {
  const [row] = await db.select({
    enabled: invoicingSettings.portalEnabled,
    statusNames: invoicingSettings.portalStatusNames,
  }).from(invoicingSettings).where(eq(invoicingSettings.organisationId, organisationId));
  if (!row) return { ...DEFAULTS, statusNames: {} };
  return { enabled: row.enabled, statusNames: cleanNames(row.statusNames) };
}

export async function savePortalSettings(db, organisationId, changes, { personId = null } = {}) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new FlowError('invalid', 'the settings must be an object');
  }
  const fields = {};
  if ('enabled' in changes) fields.portalEnabled = changes.enabled === true;
  if ('statusNames' in changes) fields.portalStatusNames = cleanNames(changes.statusNames, { strict: true });
  if (!Object.keys(fields).length) throw new FlowError('invalid', 'name a setting to change');
  await db.insert(invoicingSettings)
    .values({ organisationId, ...fields, updatedBy: personId })
    .onConflictDoUpdate({
      target: invoicingSettings.organisationId,
      set: { ...fields, updatedBy: personId, updatedAt: sql`now()` },
    });
  return readPortalSettings(db, organisationId);
}

// The portal name for a job's current work-system status. A status with no
// name is skipped; the job keeps the previous named stage.
export function portalStage(sourceStatus, statusNames, order = []) {
  const list = order.filter(Boolean);
  if (sourceStatus && !list.includes(sourceStatus)) list.push(sourceStatus);
  let index = sourceStatus ? list.indexOf(sourceStatus) : -1;
  if (index < 0) index = list.length - 1;
  for (let i = index; i >= 0; i -= 1) {
    const name = statusNames[list[i]];
    if (PORTAL_STAGES.includes(name)) return name;
  }
  return null;
}

export function portalTrack(status) {
  const at = PORTAL_STAGES.indexOf(status);
  return PORTAL_STAGES.map((name, i) => ({
    name,
    state: at < 0 ? 'upcoming' : i < at ? 'done' : i === at ? 'current' : 'upcoming',
  }));
}
