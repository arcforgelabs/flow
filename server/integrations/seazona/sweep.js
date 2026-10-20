import { and, asc, eq, gt, gte, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import {
  clientListSignature,
  invoiceListSignature,
  isFinalStatus,
  mapClient,
  mapInvoice,
  orderListSignature,
  parseSeazonaDate,
  text,
} from './map.js';
import { seazonaClients, seazonaInvoices, seazonaOrders, seazonaSweepFindings } from './schema.js';
import {
  clearRecordFailures,
  readKnown,
  readLaneStates,
  readOrderFailures,
  readQuarantinedRecords,
  recordRecordFailure,
  touchSynced,
  upsertRecords,
} from './store.js';

// Issue #126: the slow re-check sweep (anti-entropy). The cursor lanes see
// only what their queries return, so three kinds of change can pass them by:
// an edit to an order older than the recent-order window that has left the
// active rotation, a record deleted in Seazona (a changed list never names
// it), and a change behind a cursor that moved too far. The sweep reads
// whole lists again on a slow cycle and compares them with Flow's copy:
//
//   orders    each day older than the recent-order window, newest day first:
//             GET orders/?ordered=<day> and its pages. A listed order whose
//             list fields changed is read again. An order Flow holds for
//             that day that the list leaves out is read again: a 404 marks
//             it deleted in Seazona (issue #12), and the billing feed
//             withdraws it, so its invoice goes to review.
//   clients   the whole list (GET clients/?lastModified=), read on from the
//             last row when it is full.
//   invoices  every change since the oldest invoice Flow holds, read on the
//             same way.
//
// A client or invoice that Flow holds and the whole list leaves out is read
// by its id. A 404 marks it `missing` in seazona_sweep_findings; the row is
// never deleted, and the mark clears when Seazona lists it again. The orders
// of a missing invoice are read again at once.
//
// Each kind starts again at most once a cycle (SEAZONA_SWEEP_CYCLE_DAYS). The
// sweep makes at most SEAZONA_SWEEP_CALLS_PER_RUN calls a run and
// SEAZONA_SWEEP_CALLS_PER_DAY a UTC day, through the same rate governor and
// call guard as every lane, and keeps its place in the lane's cursor. A
// change the lane that owns it will still read (after the lane's cursor) is
// left to that lane and costs no call.
//
// What the sweep finds that the lanes missed is counted in
// seazona_sweep_findings and reported once a run. A count above zero is a
// signal to fix a lane.

export const SWEEP_LANE = 'sweep';
export const SWEEP_KINDS = Object.freeze(['orders', 'clients', 'invoices']);

const DAY_MS = 24 * 60 * 60_000;
const REPORT_WINDOW_MS = 7 * DAY_MS;
const MAX_REPORTED = 25;
const ORDER_PAGE_MAX = 500;
const CONFIRM_BATCH = 25;

class SweepBudgetSpent extends Error {}

// readOrder (lanes.js) records any error it does not know as a failed read,
// so the share is checked before each order read, not inside it.
function readOrder(ctx, helpers, id, options) {
  if (!ctx.client.hasCall()) throw new SweepBudgetSpent();
  return helpers.readOrder(ctx, id, options);
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const floorUtcDay = (ms) => Date.parse(dayOf(ms));
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Seazona writes lastModified in UTC with no zone suffix.
function parseUtc(value) {
  const stamp = text(value);
  if (!stamp) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp}Z`);
}

// A client that refuses a call once the run's share is spent. A refused call
// is never sent, so it costs nothing.
function countedClient(client, budget) {
  return {
    governor: client.governor,
    hasCall: () => budget.left > 0,
    async get(path, query) {
      if (budget.left <= 0) throw new SweepBudgetSpent();
      budget.left -= 1;
      budget.spent += 1;
      return client.get(path, query);
    },
  };
}

async function recordFinding(db, resource, key, kind, { at, detail = null }) {
  await db.insert(seazonaSweepFindings)
    .values({ resource, recordKey: key, kind, firstFoundAt: at, lastFoundAt: at, detail })
    .onConflictDoUpdate({
      target: [seazonaSweepFindings.resource, seazonaSweepFindings.recordKey, seazonaSweepFindings.kind],
      set: { lastFoundAt: at, detail },
    });
}

async function clearMissing(db, resource, keys) {
  if (!keys.length) return;
  await db.delete(seazonaSweepFindings).where(and(
    eq(seazonaSweepFindings.resource, resource),
    eq(seazonaSweepFindings.kind, 'missing'),
    inArray(seazonaSweepFindings.recordKey, keys),
  ));
}

// The first time the owning lane's next read starts: a change at or after it
// is still that lane's to read. Null while the lane has never finished.
function laneReadsFrom(state, sync) {
  if (!state?.lastSuccessAt) return null;
  if (typeof state.cursor?.since === 'string') {
    const since = parseUtc(state.cursor.since);
    if (Number.isFinite(since)) return since;
  }
  const cursorMs = state.cursorTime?.getTime();
  return Number.isFinite(cursorMs) ? cursorMs - sync.cursorOverlapMs : null;
}

function isDue(progress, at, sync) {
  if (progress?.cycleStartedAt) return true;
  const finished = Date.parse(progress?.lastFinishedAt ?? '');
  return !Number.isFinite(finished) || at.getTime() - finished >= sync.sweepCycleMs;
}

// Orders: one ordered day at a time.

// The orders Flow holds for one ordered day (yyyy-mm-dd). Seazona writes the
// day as ISO text or as day/month/year.
async function heldOrdersFor(db, day) {
  const [year, month, date] = day.split('-');
  const dmy = `^0?${Number(date)}/0?${Number(month)}/(${year}|${year.slice(2)})(\\D|$)`;
  const rows = await db.select({
    id: seazonaOrders.id,
    orderedText: seazonaOrders.orderedText,
    lastSyncedAt: seazonaOrders.lastSyncedAt,
  })
    .from(seazonaOrders)
    .where(and(
      isNull(seazonaOrders.deletedInSourceAt),
      or(like(seazonaOrders.orderedText, `${day}%`), sql`${seazonaOrders.orderedText} ~ ${dmy}`),
    ));
  return rows.filter((row) => parseSeazonaDate(row.orderedText) === day);
}

// The days, before the recent-order window, that Flow holds orders for,
// newest first: billing still cares most about those.
async function orderDays(db, { at, sync }) {
  const windowStart = floorUtcDay(at.getTime() - sync.orderLookbackDays * DAY_MS);
  const rows = await db.selectDistinct({ orderedText: seazonaOrders.orderedText }).from(seazonaOrders);
  const days = new Set();
  for (const { orderedText } of rows) {
    const day = parseSeazonaDate(orderedText);
    if (day && Date.parse(day) < windowStart) days.add(day);
  }
  return [...days].sort().reverse();
}

async function sweepOrderDay(ctx, day, progress, helpers, found) {
  const { db, client, sync, at } = ctx;
  const cycleStart = Date.parse(progress.cycleStartedAt);
  const pageSize = Math.min(ORDER_PAGE_MAX, sync.listCap);
  const listed = new Map();
  let previous = null;
  for (let page = 1; ; page += 1) {
    const list = await client.get('orders/', { ordered: `${day}T00:00:00`, page, pageSize });
    if (!Array.isArray(list)) throw new helpers.LaneError(`Seazona order list for ${day} was not a list`, { code: 'seazona_list_invalid' });
    const ids = list.map((item) => text(item?.id)).filter(Boolean);
    // A Seazona that does not page answers the same rows again: what the
    // list left out is read one by one below.
    if (previous && ids.length && ids.every((id) => previous.has(id))) break;
    for (const item of list) {
      if (text(item?.id) && parseSeazonaDate(item?.ordered) === day) listed.set(text(item.id), item);
    }
    const lastDay = parseSeazonaDate(list.at(-1)?.ordered);
    if (list.length < pageSize || (lastDay && lastDay > day)) break;
    previous = new Set(ids);
  }

  const held = await heldOrdersFor(db, day);
  const known = await readKnownOrders(db, [...listed.keys()]);
  const failures = await readOrderFailures(db, [...new Set([...listed.keys(), ...held.map((row) => row.id)])]);
  // An order whose read failed this cycle waits for the next cycle.
  const failedThisCycle = (id) => (failures.get(id)?.lastAttemptAt?.getTime() ?? -Infinity) >= cycleStart;

  const unchanged = [];
  for (const [id, item] of listed) {
    const stored = known.get(id);
    if (stored && !stored.deletedInSourceAt && stored.listSignature === orderListSignature(item)) {
      unchanged.push(id);
      continue;
    }
    if (failedThisCycle(id)) continue;
    const result = await readOrder(ctx, helpers, id, { listItem: item, known: stored ?? null });
    // A change to an open order is the active-order lane's; it would find it.
    const missed = !stored || stored.deletedInSourceAt || isFinalStatus(stored.status);
    if (result.outcome === 'read' && missed && (result.summary.created || result.summary.changed)) {
      const kind = result.summary.created ? 'created' : 'changed';
      found[kind] += 1;
      await recordFinding(db, 'orders', id, kind, { at, detail: { status: text(item.status) || null } });
    } else if (result.outcome === 'deleted') {
      found.deleted += 1;
      await recordFinding(db, 'orders', id, 'deleted', { at, detail: { httpStatus: 404 } });
    }
  }
  await touchSynced(db, 'orders', unchanged, { at });

  // Held for this day, left out of the list, and not seen this cycle.
  for (const row of held) {
    if (listed.has(row.id) || row.lastSyncedAt.getTime() >= cycleStart || failedThisCycle(row.id)) continue;
    const result = await readOrder(ctx, helpers, row.id, { known: true });
    if (result.outcome === 'deleted') {
      found.deleted += 1;
      await recordFinding(db, 'orders', row.id, 'deleted', { at, detail: { httpStatus: 404 } });
    }
  }
}

async function readKnownOrders(db, ids) {
  if (!ids.length) return new Map();
  const rows = await db.select({
    id: seazonaOrders.id,
    status: seazonaOrders.status,
    listSignature: seazonaOrders.listSignature,
    deletedInSourceAt: seazonaOrders.deletedInSourceAt,
  }).from(seazonaOrders).where(inArray(seazonaOrders.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function sweepOrders(ctx, cursor, helpers, found) {
  const { db, at } = ctx;
  if (!cursor.orders?.cycleStartedAt) {
    cursor.orders = { cycleStartedAt: at.toISOString(), days: await orderDays(db, ctx), checkedDays: 0 };
  }
  const progress = cursor.orders;
  while (progress.days.length) {
    await sweepOrderDay(ctx, progress.days[0], progress, helpers, found);
    progress.days.shift();
    progress.checkedDays += 1;
  }
  cursor.orders = { lastFinishedAt: at.toISOString(), checkedDays: progress.checkedDays };
}

// Clients and invoices: the whole list, then the held records it left out.

const WHOLE_LISTS = {
  clients: {
    table: seazonaClients,
    key: 'id',
    keyOf: (item) => text(item?.id),
    idOf: (item) => text(item?.id),
    signatureOf: clientListSignature,
    detailPath: (id) => `clients/${encodeURIComponent(id)}`,
    map: (item, detail) => mapClient(item, detail),
    // Seazona answers the whole list only to an empty `?lastModified=`.
    list: (client, since) => (since ? client.get('clients/', { lastModified: since }) : client.get('clients/?lastModified=')),
    // "Modified after": step back a second so a row in the last row's second
    // is not lost.
    stepBackMs: 1000,
    firstSince: async () => '',
  },
  invoices: {
    table: seazonaInvoices,
    key: 'invoiceNumber',
    keyOf: (item) => text(item?.invoiceNumber),
    idOf: (item) => text(item?.id),
    signatureOf: invoiceListSignature,
    detailPath: (id) => `invoices/${encodeURIComponent(id)}`,
    map: (item, detail, sync) => mapInvoice(item, detail, { keepPatientReference: sync.keepPatientReference }),
    list: (client, since) => client.get('invoices/', { lastModified: since }),
    // The guide: on or after lastModified (inclusive).
    stepBackMs: 0,
    // A day before the oldest change Flow holds: an invoice older than that
    // was never in Flow's copy, so it cannot be missing from it.
    async firstSince(db) {
      const [{ oldest }] = await db.select({ oldest: sql`min(${seazonaInvoices.lastModifiedText})` }).from(seazonaInvoices);
      const oldestMs = parseUtc(oldest);
      return Number.isFinite(oldestMs) ? new Date(floorUtcDay(oldestMs) - DAY_MS).toISOString() : null;
    },
  },
};

// Compares one list answer with Flow's copy. A changed or new row that the
// owning lane has already passed is read and stored; a row the lane will
// still read is left to it.
async function compareListed(ctx, resource, items, { readsFrom, helpers, found }) {
  const { db, client, sync, at } = ctx;
  const spec = WHOLE_LISTS[resource];
  const keyed = items.map((item) => ({ item, key: spec.keyOf(item) })).filter((entry) => entry.key);
  const keys = keyed.map((entry) => entry.key);
  const known = await readKnown(db, resource, keys);
  const quarantined = await readQuarantinedRecords(db, resource, keys, { at });
  const seen = [];
  const read = [];
  for (const { item, key } of keyed) {
    const stored = known.get(key);
    const signature = spec.signatureOf(item);
    if (stored) seen.push(key);
    if (stored?.listSignature === signature || quarantined.has(key)) continue;
    const changedAt = parseUtc(item?.lastModified);
    if (Number.isFinite(changedAt) && changedAt >= readsFrom) continue;
    const id = spec.idOf(item);
    let detail = null;
    if (id) {
      try {
        detail = await client.get(spec.detailPath(id));
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw helpers.emptyResponse(`${resource} ${key}`);
      } catch (error) {
        if (error instanceof SweepBudgetSpent || helpers.isLaneLevel(error)) throw error;
        await recordRecordFailure(db, resource, key, helpers.describeReadFailure(error), {
          at,
          quarantineFailures: sync.orderQuarantineFailures,
          quarantineMs: sync.orderQuarantineMs,
        });
        continue;
      }
    }
    const summary = await upsertRecords(db, resource, [spec.map(item, detail, sync)], { at, listSignatures: new Map([[key, signature]]) });
    read.push(key);
    if (summary.created || summary.changed) {
      const kind = summary.created ? 'created' : 'changed';
      found[kind] += 1;
      await recordFinding(db, resource, key, kind, { at, detail: { lastModified: text(item?.lastModified) || null } });
    }
  }
  await touchSynced(db, resource, seen, { at });
  await clearRecordFailures(db, resource, read);
  await clearMissing(db, resource, keys);
}

// Reads by id each held record the whole list left out (not seen since the
// cycle started), in key order.
async function confirmLeftOut(ctx, resource, progress, { helpers, found }) {
  const { db, client, sync, at } = ctx;
  const spec = WHOLE_LISTS[resource];
  const { table } = spec;
  const keyColumn = table[spec.key];
  for (;;) {
    const rows = await db.select({ key: keyColumn, ...(resource === 'invoices' ? { seazonaId: table.seazonaId } : {}) })
      .from(table)
      .where(and(
        lt(table.lastSyncedAt, new Date(progress.cycleStartedAt)),
        progress.afterKey ? gt(keyColumn, progress.afterKey) : undefined,
      ))
      .orderBy(asc(keyColumn))
      .limit(CONFIRM_BATCH);
    if (!rows.length) return;
    const quarantined = await readQuarantinedRecords(db, resource, rows.map((row) => row.key), { at });
    for (const row of rows) {
      if (!quarantined.has(row.key)) await confirmOne(row);
      progress.afterKey = row.key;
    }
  }

  async function confirmOne(row) {
    const id = resource === 'invoices' ? row.seazonaId : row.key;
    if (!id) {
      await markMissing(row.key, { confirmed: false });
      return;
    }
    try {
      const detail = await client.get(spec.detailPath(id));
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw helpers.emptyResponse(`${resource} ${row.key}`);
      const listItem = resource === 'invoices' ? { invoiceNumber: row.key, id } : { id };
      await upsertRecords(db, resource, [spec.map(listItem, detail, sync)], { at });
      await clearRecordFailures(db, resource, [row.key]);
      await clearMissing(db, resource, [row.key]);
    } catch (error) {
      if (error instanceof SweepBudgetSpent || helpers.isLaneLevel(error)) throw error;
      if (error?.statusCode === 404) {
        await markMissing(row.key, { confirmed: true, httpStatus: 404 });
        return;
      }
      await recordRecordFailure(db, resource, row.key, helpers.describeReadFailure(error), {
        at,
        quarantineFailures: sync.orderQuarantineFailures,
        quarantineMs: sync.orderQuarantineMs,
      });
    }
  }

  async function markMissing(key, detail) {
    found.missing += 1;
    await recordFinding(db, resource, key, 'missing', { at, detail });
    if (resource !== 'invoices') return;
    // The invoice is gone: read its orders again, so a deleted order leaves
    // billing and its draft goes to review.
    const orders = await db.select({ id: seazonaOrders.id }).from(seazonaOrders)
      .where(and(eq(seazonaOrders.invoiceNumber, key), isNull(seazonaOrders.deletedInSourceAt)));
    for (const { id } of orders) {
      const result = await readOrder(ctx, helpers, id, { known: true });
      if (result.outcome === 'deleted') {
        found.deleted += 1;
        await recordFinding(db, 'orders', id, 'deleted', { at, detail: { httpStatus: 404 } });
      }
    }
  }
}

async function sweepWholeList(ctx, resource, cursor, laneStates, helpers, found) {
  const { db, client, sync, at } = ctx;
  const spec = WHOLE_LISTS[resource];
  // Nothing to compare with until the owning lane has read once.
  const readsFrom = laneReadsFrom(laneStates.get(resource), sync);
  if (readsFrom === null) return;
  if (!cursor[resource]?.cycleStartedAt) {
    const since = await spec.firstSince(db);
    if (since === null) {
      cursor[resource] = { lastFinishedAt: at.toISOString(), listed: 0 };
      return;
    }
    cursor[resource] = { cycleStartedAt: at.toISOString(), step: 'walk', since, listed: 0 };
  }
  const progress = cursor[resource];
  while (progress.step === 'walk') {
    const items = await spec.list(client, progress.since);
    if (!Array.isArray(items)) throw new helpers.LaneError(`Seazona ${resource} list was not a list`, { code: 'seazona_list_invalid' });
    await compareListed(ctx, resource, items, { readsFrom, helpers, found });
    progress.listed += items.length;
    if (items.length < sync.listCap) {
      progress.step = 'confirm';
      break;
    }
    // A full list goes on from its last row. Rows out of order, or a full
    // list inside one second, cannot go on: the cycle ends with no
    // left-out check, as the list was not read whole.
    let lastMs = -Infinity;
    const ordered = items.every((item) => {
      const ms = parseUtc(item?.lastModified);
      const ok = Number.isFinite(ms) && ms >= lastMs;
      lastMs = ok ? ms : lastMs;
      return ok;
    });
    const next = lastMs - spec.stepBackMs;
    const sinceMs = progress.since ? parseUtc(progress.since) : -Infinity;
    if (!ordered || !(next > sinceMs)) {
      cursor[resource] = { lastFinishedAt: at.toISOString(), listed: progress.listed, incomplete: ordered ? 'one_second_full' : 'not_oldest_first' };
      return;
    }
    progress.since = new Date(next).toISOString();
  }
  await confirmLeftOut(ctx, resource, progress, { helpers, found });
  cursor[resource] = { lastFinishedAt: at.toISOString(), listed: progress.listed };
}

// The source high-water mark: the latest lastModified Flow holds from
// Seazona, against where the owning lane reads next. Seazona's time ahead of
// Flow's by more than the overlap can make a lane skip changes.
async function readHighWater(db, laneStates, sync, nowMs) {
  const out = {};
  for (const resource of ['invoices', 'clients']) {
    const { table } = WHOLE_LISTS[resource];
    const [{ latest }] = await db.select({ latest: sql`max(${table.lastModifiedText})` }).from(table);
    const sourceMs = parseUtc(latest);
    const readsFrom = laneReadsFrom(laneStates.get(resource), sync);
    const aheadMs = Number.isFinite(sourceMs) ? sourceMs - nowMs : null;
    out[resource] = {
      sourceLastModified: Number.isFinite(sourceMs) ? iso(sourceMs) : null,
      laneReadsFrom: iso(readsFrom),
      gapMs: Number.isFinite(sourceMs) && readsFrom !== null ? sourceMs - readsFrom : null,
      seazonaAheadMs: aheadMs !== null && aheadMs > 0 ? aheadMs : 0,
      seazonaAhead: aheadMs !== null && aheadMs > sync.cursorOverlapMs,
    };
  }
  return out;
}

// The sweep lane's run. `helpers` come from lanes.js: readOrder (issue #12
// for each order read), isLaneLevel, describeReadFailure, emptyResponse and
// LaneError.
export async function runSweep(ctx, helpers) {
  const { db, sync, at, state } = ctx;
  const previous = state?.cursor ?? {};
  const today = dayOf(at.getTime());
  const spentToday = previous.budget?.day === today ? previous.budget.calls : 0;
  const budget = { left: Math.max(0, Math.min(sync.sweepCallsPerRun, sync.sweepCallsPerDay - spentToday)), spent: 0 };
  const cursor = structuredClone(previous);
  const found = { changed: 0, created: 0, deleted: 0, missing: 0 };
  const sweepCtx = { ...ctx, client: countedClient(ctx.client, budget) };
  const laneStates = await readLaneStates(db);
  const save = () => ({ ...cursor, budget: { day: today, calls: spentToday + budget.spent } });

  try {
    for (const kind of SWEEP_KINDS) {
      if (budget.left <= 0) break;
      if (!isDue(cursor[kind], at, sync)) continue;
      if (kind === 'orders') await sweepOrders(sweepCtx, cursor, helpers, found);
      else await sweepWholeList(sweepCtx, kind, cursor, laneStates, helpers, found);
    }
  } catch (error) {
    if (!(error instanceof SweepBudgetSpent)) {
      // A lane-level failure keeps what this run checked.
      if (error && typeof error === 'object') error.progress = { cursor: save() };
      throw error;
    }
  }

  const reports = [];
  const total = found.changed + found.created + found.deleted + found.missing;
  if (total) reports.push('the sweep found records the sync lanes missed');
  const highWater = await readHighWater(db, laneStates, sync, at.getTime());
  const warned = cursor.seazonaAheadWarned ?? {};
  for (const [resource, mark] of Object.entries(highWater)) {
    if (mark.seazonaAhead && !warned[resource]) reports.push(`Seazona's ${resource} times are ahead of Flow's clock by more than the cursor overlap`);
    warned[resource] = mark.seazonaAhead;
  }
  cursor.seazonaAheadWarned = warned;

  return {
    calls: budget.spent,
    callsToday: spentToday + budget.spent,
    found,
    reports,
    cursorTime: at,
    cursor: save(),
  };
}

// What /health shows for the sweep. Reads Flow's database only.
export async function readSweepHealth(db, settings, { now = Date.now } = {}) {
  const nowMs = Number(now());
  const sync = settings.sync;
  const laneStates = await readLaneStates(db);
  const cursor = laneStates.get(SWEEP_LANE)?.cursor ?? {};
  const counts = await db.select({
    resource: seazonaSweepFindings.resource,
    kind: seazonaSweepFindings.kind,
    records: sql`count(*)::int`,
  })
    .from(seazonaSweepFindings)
    .where(gte(seazonaSweepFindings.lastFoundAt, new Date(nowMs - REPORT_WINDOW_MS)))
    .groupBy(seazonaSweepFindings.resource, seazonaSweepFindings.kind);
  const foundLastWeek = {};
  for (const row of counts) {
    if (row.kind === 'missing') continue;
    foundLastWeek[row.resource] = { ...foundLastWeek[row.resource], [row.kind]: row.records };
  }
  const missingRows = await db.select({ resource: seazonaSweepFindings.resource, key: seazonaSweepFindings.recordKey })
    .from(seazonaSweepFindings)
    .where(eq(seazonaSweepFindings.kind, 'missing'))
    .orderBy(seazonaSweepFindings.resource, seazonaSweepFindings.recordKey);
  const missing = {};
  for (const row of missingRows) {
    const entry = missing[row.resource] ?? (missing[row.resource] = { count: 0, keys: [] });
    entry.count += 1;
    if (entry.keys.length < MAX_REPORTED) entry.keys.push(row.key);
  }
  const today = dayOf(nowMs);
  const kinds = Object.fromEntries(SWEEP_KINDS.map((kind) => [kind, {
    running: Boolean(cursor[kind]?.cycleStartedAt),
    lastFinishedAt: cursor[kind]?.lastFinishedAt ?? null,
    ...(cursor[kind]?.incomplete ? { incomplete: cursor[kind].incomplete } : {}),
  }]));
  return {
    callsToday: cursor.budget?.day === today ? cursor.budget.calls : 0,
    callsPerDay: sync.sweepCallsPerDay,
    kinds,
    foundLastWeek,
    missing,
    highWater: await readHighWater(db, laneStates, sync, nowMs),
  };
}
