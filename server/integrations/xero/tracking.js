import { sql } from 'drizzle-orm';
import { normaliseName } from './catalogue.js';
import { xeroError } from './client.js';
import { withXeroLane } from './governor.js';

const TRACKING_SETTING = '/integrations/xero#tracking';

// This is the only owner of workspace tracking. Null is an explicit Off.
export async function readTracking(db, organisationId) {
  const { rows: [row] } = await db.execute(sql`select category, option from xero_tracking_settings where organisation_id = ${organisationId}`);
  return row?.category ? { category: row.category, option: row.option } : null;
}

// Upgrade bridge only, never a runtime fallback. An existing choice,
// including Off, wins. Receipt and import commit together; later workspaces
// start Off even if obsolete host variables were not removed.
export async function migrateLegacyTracking(db, env, log = console) {
  await db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`insert into xero_tracking_cutover (singleton) values (true) on conflict do nothing returning singleton`);
    if (!rows.length) return;
    const category = String(env?.XERO_TRACKING_CATEGORY ?? '').trim();
    const option = String(env?.XERO_TRACKING_OPTION ?? '').trim();
    if (Boolean(category) !== Boolean(option)) log.warn?.('[xero] Incomplete legacy tracking configuration was not imported. Choose Tracking in Integrations > Xero.');
    await tx.execute(sql`insert into xero_tracking_settings (organisation_id, category, option)
      select id, ${category && option ? category : null}, ${category && option ? option : null} from organisations
      on conflict (organisation_id) do nothing`);
  });
}

export function activeTracking(categories) {
  return categories.filter((c) => c.Status === 'ACTIVE').map((c) => ({
    category: c.Name,
    options: (c.Options ?? []).filter((o) => o.Status === 'ACTIVE').map((o) => o.Name),
  }));
}

export function assertTracking(categories, tracking) {
  if (!tracking) return;
  const category = activeTracking(categories).find((c) => normaliseName(c.category) === normaliseName(tracking.category));
  if (!category || !category.options.some((o) => normaliseName(o) === normaliseName(tracking.option))) {
    throw xeroError('xero_tracking_missing', 'Tracking “' + tracking.category + ' / ' + tracking.option + '” is not active in Xero. Choose an active category and option, or Off, in Integrations › Xero › Tracking.',
      { status: 409, details: { settingUrl: TRACKING_SETTING } });
  }
}

export async function trackingCategories(db, runtime, organisationId) {
  return runtime.serial(organisationId, () => withXeroLane('reads', async () => {
    const { client } = await runtime.clientFor(db, organisationId);
    return client.getTrackingCategories();
  }));
}

export async function saveTracking(db, organisationId, tracking, actor) {
  await db.execute(sql`insert into xero_tracking_settings (organisation_id, category, option, updated_by)
    values (${organisationId}, ${tracking?.category ?? null}, ${tracking?.option ?? null}, ${actor ?? null})
    on conflict (organisation_id) do update set category = excluded.category, option = excluded.option, updated_by = excluded.updated_by, updated_at = now()`);
  return readTracking(db, organisationId);
}
