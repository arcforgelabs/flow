import { count, isNotNull } from 'drizzle-orm';
import {
  clientListSignature,
  invoiceListSignature,
  mapClient,
  mapInvoice,
  mapOrder,
  mapReference,
  orderListSignature,
  text,
} from './map.js';
import { runHistoryBackfill } from './history/backfill.js';
import { seazonaOrders } from './schema.js';
import {
  claimLane,
  clearOrderFailure,
  clearRecordFailures,
  finishLane,
  markOrderDeleted,
  readKnown,
  readLaneStates,
  readQuarantinedOrders,
  readQuarantinedRecordCounts,
  readQuarantinedRecords,
  recordOrderFailure,
  recordRecordFailure,
  selectActiveOrders,
  touchSynced,
  upsertRecords,
  upsertReference,
} from './store.js';

// The Seazona sync lanes. Each lane keeps one kind of record fresh, on its
// own cadence, and one failing lane never stops another:
//
//   invoices       changed invoices since a lastModified cursor, every 2 min
//   orders_recent  orders placed in the last 30 days, a few days per run
//   orders_active  open orders already known, re-read oldest first
//   clients        changed clients since a cursor, every 30 min
//   products       the product list, daily
//   users          the lab user list, daily
//   history        past orders, a few calls per run, only while a person
//                  has started a backfill (history/backfill.js)
//
// Issue #12 holds for every order read: a 404 marks the order deleted in
// Seazona, an empty answer is a failure, each failure is recorded per order
// and quarantines it after a few in a row, and a lane fails only when most of
// its reads fail. Errors and /health name each failing order and its status.
//
// Issue #101 holds for every lane: invoices and clients quarantine a record
// after a few failed reads too, so one bad record never holds a cursor. A
// list call that Seazona refuses (400, 401, 403, 404) means the path or the
// API client is wrong, and no wait fixes it: the lane stops and runs again
// only after a person saves the settings or Flow restarts on a new release.
// Calls the governor stopped (SeazonaCallsStopped) wait out its pause.

export const LANES = Object.freeze(['invoices', 'orders_recent', 'orders_active', 'clients', 'products', 'users', 'history']);

const DAY_MS = 24 * 60 * 60_000;
const MAX_REPORTED = 25;
const FINAL_STATUS_PATTERN = 'shipped|delivered|cancelled|canceled|void|closed|archived|deleted';

class LaneError extends Error {
  constructor(message, { code, details = null, held = false, retryAfterMs = null } = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.held = held;
    this.retryAfterMs = retryAfterMs;
  }
}

function listOrFail(list, what, sync) {
  if (!Array.isArray(list)) throw new LaneError(`Seazona ${what} answer was not a list`, { code: 'seazona_list_invalid' });
  // Seazona documents no paging. A list exactly at the cap may be cut off,
  // so hold the cursor rather than trust it.
  if (list.length === sync.listCap) {
    throw new LaneError(`Seazona ${what} answer has exactly ${sync.listCap} rows and may be cut off; the cursor is held`, {
      code: 'seazona_list_at_cap',
      held: true,
      details: { observedCount: list.length, listCap: sync.listCap },
    });
  }
  return list;
}

// A failure that is about Seazona or the rate limit, not one record: the
// whole lane stops and waits.
function isLaneLevel(error) {
  return error?.statusCode === 429 || error?.statusCode === 401 || error?.statusCode === 403
    || error?.kind === 'governor_timeout' || error?.kind === 'calls_stopped';
}

// Answers how a lane that threw should wait: { status, heldReason, delayMs }.
// A null delay means the lane is stopped until a person or a release.
const REJECTED = new Set([400, 401, 403, 404]);
function laneOutcome(error, state, sync) {
  if (error?.kind === 'calls_stopped') {
    if (error.reason === 'halted') return { status: 'stopped', heldReason: error.code, delayMs: null };
    return { status: 'failed', heldReason: null, delayMs: Math.max(sync.retryBaseMs, error.retryAfterMs ?? 0) };
  }
  if (error?.name === 'SeazonaApiError' && REJECTED.has(error.statusCode)) {
    const auth = error.statusCode === 401 || error.statusCode === 403;
    return { status: 'stopped', heldReason: auth ? 'seazona_api_halted' : 'seazona_request_rejected', delayMs: null };
  }
  return { status: error?.held ? 'held' : 'failed', heldReason: error?.held ? error.code : null, delayMs: failureDelayMs(error, state, sync) };
}

function describeReadFailure(error) {
  const message = text(error?.message) || 'read failed';
  if (error?.code === 'seazona_empty_response') return { httpStatus: null, kind: 'empty_response', error: message };
  if (Number.isInteger(error?.statusCode)) return { httpStatus: error.statusCode, kind: 'http', error: message };
  return { httpStatus: null, kind: error?.kind || 'error', error: message };
}

function emptyResponse(what) {
  const error = new Error(`Seazona ${what} answered with an empty body`);
  error.code = 'seazona_empty_response';
  return error;
}

const failureLabel = (failure) => `${failure.id} (${failure.httpStatus ? `HTTP ${failure.httpStatus}` : failure.kind})`;

// Issue #12: a lane fails only when most of its reads fail, which points at
// Seazona or the credentials rather than single records. Otherwise it
// succeeds and reports the failures.
function judgeReads(what, attempted, failures, extra = {}) {
  const reported = failures.slice(0, MAX_REPORTED).map(({ error, ...failure }) => failure);
  const details = failures.length || extra.quarantinedIds?.length
    ? { attempted, failed: failures.length, failures: reported, ...extra }
    : null;
  if (failures.length && failures.length * 2 > attempted) {
    const labels = failures.slice(0, 10).map(failureLabel).join(', ');
    const more = failures.length > 10 ? `, and ${failures.length - 10} more` : '';
    throw new LaneError(`Seazona ${what} failed for ${failures.length} of ${attempted}: ${labels}${more}`, {
      code: 'seazona_reads_failed',
      details,
    });
  }
  return details;
}

// Reads one order's detail and applies issue #12. Returns
// { outcome: 'read' | 'deleted' | 'failed', failure? }.
async function readOrder(ctx, id, { listItem = null, known = null } = {}) {
  const { db, client, sync, at } = ctx;
  const mapOptions = { keepPatientReference: sync.keepPatientReference };
  try {
    const detail = await client.get(`orders/${encodeURIComponent(id)}`);
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw emptyResponse(`order ${id}`);
    const record = { ...mapOrder(listItem || {}, detail, mapOptions), id };
    const listSignatures = listItem ? new Map([[id, orderListSignature(listItem)]]) : new Map();
    const summary = await upsertRecords(db, 'orders', [record], { at, listSignatures });
    await clearOrderFailure(db, id);
    return { outcome: 'read', summary };
  } catch (error) {
    if (isLaneLevel(error)) throw error;
    if (error?.statusCode === 404) {
      const fallback = listItem ? { ...mapOrder(listItem, null, mapOptions), id } : null;
      await markOrderDeleted(db, id, { at, fallback });
      await clearOrderFailure(db, id);
      return { outcome: 'deleted' };
    }
    // An order seen in a list but never stored is kept from its list row, so
    // the active-order lane picks it up again.
    if (listItem && !known) {
      await upsertRecords(db, 'orders', [{ ...mapOrder(listItem, null, mapOptions), id }], { at });
    }
    const failure = describeReadFailure(error);
    const recorded = await recordOrderFailure(db, id, failure, {
      at,
      quarantineFailures: sync.orderQuarantineFailures,
      quarantineMs: sync.orderQuarantineMs,
    });
    return { outcome: 'failed', failure: { id, ...failure, ...recorded } };
  }
}

function addSummary(total, summary) {
  if (!summary) return;
  total.created += summary.created;
  total.changed += summary.changed;
  total.unchanged += summary.unchanged;
}

// Invoices and clients: a list since a cursor, then a detail read for each
// row whose list fields changed.
async function syncListWithDetail(ctx, { mirror, what, items, keyOf, idOf, signatureOf, detailPath, map }) {
  const { db, client, sync, at } = ctx;
  const keyed = items.map((item) => ({ item, key: keyOf(item) })).filter((entry) => entry.key);
  const known = await readKnown(db, mirror, keyed.map((entry) => entry.key));
  const quarantined = await readQuarantinedRecords(db, mirror, keyed.map((entry) => entry.key), { at });
  const summary = { created: 0, changed: 0, unchanged: 0 };
  const unchanged = [];
  const read = [];
  const failures = [];
  const skipped = [];
  let newlyQuarantined = 0;
  let detailReads = 0;
  for (const { item, key } of keyed) {
    const signature = signatureOf(item);
    if (known.get(key)?.listSignature === signature) {
      unchanged.push(key);
      continue;
    }
    // Issue #101: a quarantined record costs no call until its wait ends.
    if (quarantined.has(key)) {
      skipped.push(key);
      continue;
    }
    const id = idOf(item);
    let detail = null;
    if (id) {
      try {
        detailReads += 1;
        detail = await client.get(detailPath(id));
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw emptyResponse(`${what} ${key}`);
      } catch (error) {
        if (isLaneLevel(error)) throw error;
        const failure = describeReadFailure(error);
        const recorded = await recordRecordFailure(db, mirror, key, failure, {
          at,
          quarantineFailures: sync.orderQuarantineFailures,
          quarantineMs: sync.orderQuarantineMs,
        });
        if (recorded.quarantinedUntil) newlyQuarantined += 1;
        failures.push({ id: key, ...failure, ...recorded });
        continue;
      }
    }
    read.push(key);
    addSummary(summary, await upsertRecords(db, mirror, [map(item, detail)], { at, listSignatures: new Map([[key, signature]]) }));
  }
  await touchSynced(db, mirror, unchanged, { at });
  await clearRecordFailures(db, mirror, read);
  summary.unchanged += unchanged.length;
  const extra = skipped.length ? { quarantinedIds: skipped.slice(0, MAX_REPORTED) } : {};
  const failureDetails = judgeReads(`${what} reads`, detailReads, failures, extra);
  // A quarantined record no longer holds the cursor; a record that may still
  // be read again does.
  const anyFailed = failures.some((failure) => !failure.quarantinedUntil);
  return { summary, detailReads, listCount: items.length, failureDetails, anyFailed, newlyQuarantined, quarantined: skipped.length };
}

function cursorSince(ctx, fallbackMs) {
  const cursorMs = ctx.state?.cursorTime?.getTime();
  return new Date(Number.isFinite(cursorMs) ? cursorMs - ctx.sync.cursorOverlapMs : fallbackMs).toISOString();
}

const floorUtcDay = (ms) => {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

// GET orders/?ordered= matches one UTC calendar day, written
// yyyy-MM-ddTHH:mm:ss without milliseconds.
export function formatOrderedDay(ms) {
  return new Date(floorUtcDay(ms)).toISOString().replace(/\.\d{3}Z$/, '');
}

const laneRuns = {
  async invoices(ctx) {
    const { client, sync, at } = ctx;
    const since = cursorSince(ctx, floorUtcDay(at.getTime()) - sync.invoiceLookbackDays * DAY_MS);
    const items = listOrFail(await client.get('invoices/', { lastModified: since }), 'invoice list', sync);
    const mapOptions = { keepPatientReference: sync.keepPatientReference };
    const result = await syncListWithDetail(ctx, {
      mirror: 'invoices',
      what: 'invoice',
      items,
      keyOf: (item) => text(item?.invoiceNumber),
      idOf: (item) => text(item?.id),
      signatureOf: invoiceListSignature,
      detailPath: (id) => `invoices/${encodeURIComponent(id)}`,
      map: (item, detail) => mapInvoice(item, detail, mapOptions),
    });
    // A failed invoice read keeps the cursor, so the next run reads it again.
    return { ...result, cursorTime: result.anyFailed ? ctx.state?.cursorTime ?? null : at, since };
  },

  async orders_recent(ctx) {
    const { db, client, sync, at } = ctx;
    const nowMs = at.getTime();
    const lookbackStart = floorUtcDay(nowMs - sync.orderLookbackDays * DAY_MS);
    const doneThrough = Date.parse(ctx.state?.cursor?.completedThrough ?? '');
    // Re-read the last finished day as well, so late orders on it are seen.
    const resume = Number.isFinite(doneThrough) ? Math.max(lookbackStart, doneThrough) : lookbackStart;
    const days = [];
    for (let day = floorUtcDay(resume); day <= floorUtcDay(nowMs) && days.length < sync.orderDaysPerRun; day += DAY_MS) days.push(day);

    const byId = new Map();
    for (const day of days) {
      const list = listOrFail(await client.get('orders/', { ordered: formatOrderedDay(day) }), `order list for ${formatOrderedDay(day)}`, sync);
      for (const item of list) if (text(item?.id)) byId.set(text(item.id), item);
    }
    const known = await readKnown(db, 'orders', [...byId.keys()]);
    const summary = { created: 0, changed: 0, unchanged: 0 };
    const unchanged = [];
    const failures = [];
    const deleted = [];
    let detailReads = 0;
    for (const [id, item] of byId) {
      const stored = known.get(id);
      // An order marked deleted that shows up in a list is read again.
      if (stored && !stored.deletedInSourceAt && stored.listSignature === orderListSignature(item)) {
        unchanged.push(id);
        continue;
      }
      detailReads += 1;
      const result = await readOrder(ctx, id, { listItem: item, known: stored });
      if (result.outcome === 'read') addSummary(summary, result.summary);
      else if (result.outcome === 'deleted') deleted.push(id);
      else failures.push(result.failure);
    }
    await touchSynced(db, 'orders', unchanged, { at });
    summary.unchanged += unchanged.length;
    const failureDetails = judgeReads('recent order reads', detailReads, failures);
    const lastDay = days.length ? days[days.length - 1] : floorUtcDay(nowMs);
    return {
      summary,
      detailReads,
      listCount: byId.size,
      days: days.map(formatOrderedDay),
      deletedIds: deleted,
      failureDetails,
      cursorTime: new Date(lastDay),
      cursor: { completedThrough: new Date(lastDay).toISOString() },
    };
  },

  async orders_active(ctx) {
    const { db, sync, at } = ctx;
    const { targets, candidates } = await selectActiveOrders(db, {
      at,
      limit: sync.activeOrdersPerRun,
      finalStatusPattern: FINAL_STATUS_PATTERN,
    });
    const summary = { created: 0, changed: 0, unchanged: 0 };
    const failures = [];
    const deleted = [];
    for (const target of targets) {
      const result = await readOrder(ctx, target.id, { known: true });
      if (result.outcome === 'read') addSummary(summary, result.summary);
      else if (result.outcome === 'deleted') deleted.push(target.id);
      else failures.push(result.failure);
    }
    const quarantined = await readQuarantinedOrders(db, { at, limit: MAX_REPORTED });
    const failureDetails = judgeReads('active order reads', targets.length, failures, {
      quarantinedIds: quarantined.map((order) => order.id),
    });
    return {
      summary,
      detailReads: targets.length,
      openOrders: candidates,
      deletedIds: deleted,
      failureDetails,
      cursorTime: at,
    };
  },

  async clients(ctx) {
    const { client, sync, at } = ctx;
    // The first run reads the whole list; later runs read changes only.
    // Seazona answers the whole list only to an empty `?lastModified=`; a
    // bare path is a 404.
    const since = ctx.state?.cursorTime ? cursorSince(ctx, 0) : '';
    const reply = since ? await client.get('clients/', { lastModified: since }) : await client.get('clients/?lastModified=');
    const items = listOrFail(reply, 'client list', sync);
    const result = await syncListWithDetail(ctx, {
      mirror: 'clients',
      what: 'client',
      items,
      keyOf: (item) => text(item?.id),
      idOf: (item) => text(item?.id),
      signatureOf: clientListSignature,
      detailPath: (id) => `clients/${encodeURIComponent(id)}`,
      map: (item, detail) => mapClient(item, detail),
    });
    return { ...result, cursorTime: result.anyFailed ? ctx.state?.cursorTime ?? null : at, since: since || null };
  },

  history: (ctx) => runHistoryBackfill(ctx, { isLaneLevel, describeReadFailure, emptyResponse, LaneError }),
  products: (ctx) => syncReference(ctx, 'products'),
  users: (ctx) => syncReference(ctx, 'users'),
};

async function syncReference(ctx, resource) {
  const { db, client, sync, at } = ctx;
  const list = listOrFail(await client.get(`${resource}/`), `${resource} list`, sync);
  const records = list.map((item) => mapReference(resource, item)).filter((record) => record.id);
  const { stored } = await upsertReference(db, resource, records, { at });
  return { listCount: list.length, stored, cursorTime: at };
}

function failureDelayMs(error, state, sync) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) {
    return Math.min(sync.retryMaxMs, Math.max(sync.retryBaseMs, error.retryAfterMs));
  }
  if (error?.held) return sync.heldRetryMs;
  const attempt = (state?.failureCount ?? 0) + 1;
  return Math.min(sync.retryMaxMs, sync.retryBaseMs * (2 ** Math.min(attempt - 1, 10)));
}

// Runs every lane that is due (or the ones in `only`, or all with `force`).
// Returns { ok, results } with one result per lane that ran.
export async function runSeazonaSync(db, client, { settings, now = Date.now, only = [], force = false } = {}) {
  const sync = settings.sync;
  const states = await readLaneStates(db);
  const wanted = only.length ? LANES.filter((lane) => only.includes(lane)) : LANES;
  const results = {};
  for (const lane of wanted) {
    const state = states.get(lane) ?? null;
    const startMs = Number(now());
    if (!force && !only.length && state?.status === 'stopped') continue;
    if (!force && !only.length && state?.nextRunAt && state.nextRunAt.getTime() > startMs) continue;
    const at = new Date(startMs);
    if (!(await claimLane(db, lane, { at, stuckMs: sync.stuckLaneMs }))) {
      results[lane] = { ok: true, skipped: 'running_elsewhere' };
      continue;
    }
    const cadenceMs = sync.lanes[lane].cadenceMs;
    try {
      const result = await laneRuns[lane]({ db, client, sync, at, state });
      await finishLane(db, lane, {
        status: 'ok',
        cursorTime: result.cursorTime ?? state?.cursorTime ?? null,
        cursor: result.cursor ?? state?.cursor ?? {},
        lastSuccessAt: at,
        lastAttemptAt: at,
        nextRunAt: new Date(Number(now()) + cadenceMs),
        failureCount: 0,
        lastError: null,
        failureDetails: result.failureDetails ?? null,
        heldReason: null,
      });
      const { cursor, cursorTime, anyFailed, ...reported } = result;
      results[lane] = { ok: true, ...reported };
    } catch (error) {
      const { status, heldReason, delayMs } = laneOutcome(error, state, sync);
      const message = text(error?.message) || 'Seazona lane failed';
      const code = heldReason ?? error?.code ?? 'seazona_lane_failed';
      await finishLane(db, lane, {
        status,
        lastAttemptAt: at,
        nextRunAt: delayMs === null ? null : new Date(Number(now()) + delayMs),
        failureCount: (state?.failureCount ?? 0) + 1,
        lastError: message,
        failureDetails: error?.details ?? (Number.isInteger(error?.statusCode) ? { httpStatus: error.statusCode, path: error.path ?? null } : null),
        heldReason,
      });
      results[lane] = { ok: false, status, error: message, code, details: error?.details ?? null, retryAfterMs: delayMs };
    }
  }
  return { ok: Object.values(results).every((result) => result.ok), results };
}

// What /health shows for the sync: each lane's state, the failing and
// quarantined orders by id and status, and how many orders are marked
// deleted in Seazona. No patient data.
export async function readSeazonaSyncHealth(db, settings, { now = Date.now } = {}) {
  const nowMs = Number(now());
  const states = await readLaneStates(db);
  const quarantinedOrders = await readQuarantinedOrders(db, { at: new Date(nowMs), limit: MAX_REPORTED });
  const [{ deleted }] = await db.select({ deleted: count() }).from(seazonaOrders).where(isNotNull(seazonaOrders.deletedInSourceAt));
  const quarantinedRecords = await readQuarantinedRecordCounts(db, { at: new Date(nowMs) });
  const lanes = LANES.map((lane) => {
    const state = states.get(lane);
    const { freshnessMs } = settings.sync.lanes[lane];
    const ageMs = state?.lastSuccessAt ? Math.max(0, nowMs - state.lastSuccessAt.getTime()) : null;
    return {
      lane,
      status: state?.status ?? 'never_run',
      fresh: ageMs !== null && ageMs <= freshnessMs,
      ageMs,
      lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
      lastAttemptAt: state?.lastAttemptAt?.toISOString() ?? null,
      nextRunAt: state?.nextRunAt?.toISOString() ?? null,
      failureCount: state?.failureCount ?? 0,
      lastError: state?.lastError ?? null,
      heldReason: state?.heldReason ?? null,
      failureDetails: state?.failureDetails ?? null,
      ...(lane === 'orders_active' ? { quarantinedOrders } : {}),
      ...(quarantinedRecords[lane] ? { quarantinedRecords: quarantinedRecords[lane] } : {}),
    };
  });
  return {
    ok: lanes.every((lane) => !['failed', 'held', 'stopped'].includes(lane.status)),
    lanes,
    deletedOrders: Number(deleted),
  };
}
