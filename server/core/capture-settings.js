import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { captures, integrationSettings } from '../db/schema.js';

// One installation-wide reader switch; credentials and Australia routing stay
// with the host. Reuse integration settings/events rather than another store.
export const CAPTURE_SETTINGS = { id: 'capture', name: 'Capture', setup: { fields: [{ name: 'CAPTURE_READER', label: 'Reader', kind: 'onoff' }] } };

export async function captureReaderEnabled(db) {
  const [row] = await db.select({ config: integrationSettings.config }).from(integrationSettings)
    .where(eq(integrationSettings.adapterId, CAPTURE_SETTINGS.id));
  // Preserve an existing host-enabled reader until its owner chooses otherwise.
  return row?.config?.CAPTURE_READER !== 'off';
}

export async function captureMonthCost(db, organisationId, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [row] = await db.select({
    costMicros: sql`coalesce(sum((${captures.read}->>'costMicros')::bigint), 0)`.mapWith(Number),
    unpriced: sql`count(*) filter (where ${captures.read} is not null and ${captures.read}->>'costMicros' is null)`.mapWith(Number),
  }).from(captures).where(and(eq(captures.organisationId, organisationId), gte(captures.createdAt, start), lt(captures.createdAt, end)));
  return { ...row, currency: 'USD', month: start.toISOString().slice(0, 7) };
}
