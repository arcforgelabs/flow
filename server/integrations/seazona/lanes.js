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
import { runSweep } from './sweep.js';
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
  readRecordRereadCounts,
  readRecordsDueForReread,
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
//   sweep          whole lists again, slowly, for what the others missed
//                  (issue #126, sweep.js)
//
// Issue #12 holds for every order read: a 404 marks the order deleted in
// Seazona, an empty answer is a failure, each failure is recorded per order
// and quarantines it after a few in a row, and a lane fails only when most of
// its reads fail. Errors and /health name each failing order and its status.
//
// Issue #125: a list at the row cap is read on, not held: invoices and
// clients from the last row they answered, orders page by page. A lane holds
// only where Seazona gives no way on.
//
// Issue #101 holds for every lane: invoices and clients quarantine a record
// after a few failed reads too, so one bad record never holds a cursor. A
// list call that Seazona refuses (400, 401, 403, 404) means the path or the
// API client is wrong, and no wait fixes it: the lane stops and runs again
// only after a person saves the settings or Flow restarts on a new release.
// Calls the governor stopped (SeazonaCallsStopped) wait out its pause.

export const LANES = Object.freeze(['invoices', 'orders_recent', 'orders_active', 'clients', 'products', 'users', 'history', 'sweep']);

const DAY_MS = 24 * 60 * 60_000;
const MAX_REPORTED = 25;
const FINAL_STATUS_PATTERN = 'shipped|delivered|cancelled|canceled|void|closed|archived|deleted';

class LaneError extends Error {
  constructor(message, { code, details = null, held = false, retryAfterMs = null, progress = null } = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.held = held;
    this.retryAfterMs = retryAfterMs;
    // What the lane read before it stopped: { cursor }, kept with the failure.
    this.progress = progress;
  }
}

function listOrFail(list, what) {
  if (!Array.isArray(list)) throw new LaneError(`Seazona ${what} answer was not a list`, { code: 'seazona_list_invalid' });
  return list;
}

// Issue #125: a list at the cap is read on, page by page or from its last
// row. The lane holds only where it cannot go on.
function cannotGoOn(what, sync, reason, progress) {
  return new LaneError(`Seazona ${what} answer is full (${sync.listCap} rows) and cannot be read further (${reason}); the cursor is held`, {
    code: 'seazona_list_at_cap',
    held: true,
    details: { listCap: sync.listCap, reason },
    progress,
  });
}

// Seazona writes lastModified in UTC with no zone suffix.
function parseUtc(value) {
  const stamp = text(value);
  if (!stamp) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp}Z`);
}

// A failure that is about Seazona or the rate limit, not one record: the
// whole lane stops and waits.
function isLaneLevel(error) {
  return error?.statusCode === 429 || error?.statusCode === 401 || error?.statusCode === 403
    || error?.kind === 'governor_timeout' || error?.kind === 'calls_stopped' || error?.code === 'seazona_person_read_limit';
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
export async function readOrder(ctx, id, { listItem = null, known = null, history = false, requestOptions = {} } = {}) {
  const { db, client, sync, at } = ctx;
  const mapOptions = { keepPatientReference: sync.keepPatientReference };
  try {
    const detail = await client.get(`orders/${encodeURIComponent(id)}`, {}, requestOptions);
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw emptyResponse(`order ${id}`);
    const record = { ...mapOrder(listItem || {}, detail, mapOptions), id };
    if (history) return { outcome: 'read', record };
    const listSignatures = listItem ? new Map([[id, orderListSignature(listItem)]]) : new Map();
    const summary = await upsertRecords(db, 'orders', [record], { at, listSignatures });
    await clearOrderFailure(db, id);
    return { outcome: 'read', summary };
  } catch (error) {
    if (isLaneLevel(error)) throw error;
    if (error?.statusCode === 404) {
      if (history) return { outcome: 'deleted' };
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
          detailId: id,
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

// Issue #142: a quarantined invoice or client is in a later list only if it
// changes again, so when its wait ends the lane reads its detail by id. A
// success stores it and clears the failure; a 404 clears the failure (the
// record is gone, issue #126); a failure quarantines it again, with no new
// report. Each read goes through the call guard like any other.
async function rereadReleased(ctx, { mirror, what, detailPath, map }) {
  const { db, client, sync, at } = ctx;
  const due = sync.recordRereadsPerRun ? await readRecordsDueForReread(db, mirror, { at, limit: sync.recordRereadsPerRun }) : [];
  const result = { summary: { created: 0, changed: 0, unchanged: 0 }, detailReads: 0, reread: 0, gone: 0, failed: 0 };
  for (const row of due) {
    result.detailReads += 1;
    try {
      const detail = await client.get(detailPath(row.detailId));
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw emptyResponse(`${what} ${row.recordKey}`);
      addSummary(result.summary, await upsertRecords(db, mirror, [map(detail)], { at }));
      await clearRecordFailures(db, mirror, [row.recordKey]);
      result.reread += 1;
    } catch (error) {
      if (isLaneLevel(error)) throw error;
      if (error?.statusCode === 404) {
        await clearRecordFailures(db, mirror, [row.recordKey]);
        result.gone += 1;
        continue;
      }
      await recordRecordFailure(db, mirror, row.recordKey, describeReadFailure(error), {
        at,
        quarantineFailures: sync.orderQuarantineFailures,
        quarantineMs: sync.orderQuarantineMs,
      });
      result.failed += 1;
    }
  }
  return result;
}

// Adds the re-reads to a lane's result.
function withRereads(result, reread) {
  if (!reread.detailReads) return result;
  addSummary(result.summary, reread.summary);
  return {
    ...result,
    detailReads: result.detailReads + reread.detailReads,
    rereads: { attempted: reread.detailReads, read: reread.reread, gone: reread.gone, failed: reread.failed },
  };
}

// Where the next changed-list read starts. A run that stopped inside a
// window keeps the exact start of the next part (`cursor.since`); otherwise
// the last finished run's start, less the overlap.
function cursorSince(ctx, fallback) {
  const exact = ctx.state?.cursor?.since;
  if (typeof exact === 'string') return exact;
  const cursorMs = ctx.state?.cursorTime?.getTime();
  return Number.isFinite(cursorMs) ? new Date(cursorMs - ctx.sync.cursorOverlapMs).toISOString() : fallback;
}

function mergeDetails(total, details) {
  if (!details) return total;
  if (!total) return details;
  return {
    ...total,
    attempted: (total.attempted ?? 0) + (details.attempted ?? 0),
    failed: (total.failed ?? 0) + (details.failed ?? 0),
    failures: [...(total.failures ?? []), ...(details.failures ?? [])].slice(0, MAX_REPORTED),
    ...(total.quarantinedIds || details.quarantinedIds
      ? { quarantinedIds: [...(total.quarantinedIds ?? []), ...(details.quarantinedIds ?? [])].slice(0, MAX_REPORTED) }
      : {}),
  };
}

// Invoices and clients: Seazona answers changes since a time in one list,
// with no paging, cut at the cap. The guide says the invoice list answers
// changes on or after the time, oldest first, so a full list is one part of
// the window: the next part starts at its last row (less `stepBackMs`, for a
// list that answers strictly after). Rows out of order, or a full list inside
// one second, cannot go on: the lane holds, and keeps where it got to. A run
// reads at most `listPagesPerRun` parts; the next run goes on from the exact
// start it stored.
async function walkChangedList(ctx, { what, firstSince, stepBackMs, list, read }) {
  const { sync, at, state } = ctx;
  const total = { summary: { created: 0, changed: 0, unchanged: 0 }, detailReads: 0, listCount: 0, failureDetails: null, newlyQuarantined: 0, quarantined: 0 };
  let since = firstSince;
  for (let pages = 1; ; pages += 1) {
    const items = listOrFail(await list(since), `${what} list`);
    const result = await read(items);
    addSummary(total.summary, result.summary);
    total.detailReads += result.detailReads;
    total.listCount += result.listCount;
    total.newlyQuarantined += result.newlyQuarantined;
    total.quarantined += result.quarantined;
    total.failureDetails = mergeDetails(total.failureDetails, result.failureDetails);
    const keep = { ...total, pages, since: firstSince || null };
    // A failed read keeps this part's start, so the next run reads it again.
    if (result.anyFailed) return { ...keep, anyFailed: true, cursorTime: state?.cursorTime ?? null, cursor: { since } };
    if (items.length < sync.listCap) return { ...keep, cursorTime: at, cursor: {} };
    const sinceMs = since ? parseUtc(since) : -Infinity;
    let lastMs = -Infinity;
    for (const item of items) {
      const ms = parseUtc(item?.lastModified);
      if (!Number.isFinite(ms) || ms < lastMs) throw cannotGoOn(`${what} list`, sync, 'rows are not oldest first', { cursor: { since } });
      lastMs = ms;
    }
    const next = lastMs - stepBackMs;
    if (!(next > sinceMs)) throw cannotGoOn(`${what} list`, sync, 'one second holds more than the cap', { cursor: { since } });
    since = new Date(next).toISOString();
    if (pages >= sync.listPagesPerRun) return { ...keep, cursorTime: state?.cursorTime ?? null, cursor: { since } };
  }
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

// The guide's largest order page.
const ORDER_PAGE_MAX = 500;

// True when an order row was placed on a later day than `dayMs` (the start
// of a UTC day). `ordered` is the lab's local time with no zone, written
// yyyy-MM-ddTHH:mm:ss or dd/MM/yyyy; this compares calendar days only, so a
// lab ahead of UTC never ends a day early. Unknown dates are not after.
function placedAfter(item, dayMs) {
  const raw = text(item?.ordered);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  const local = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(raw);
  const placed = iso ? Date.UTC(+iso[1], +iso[2] - 1, +iso[3]) : local ? Date.UTC(+local[3], +local[2] - 1, +local[1]) : NaN;
  return Number.isFinite(placed) && placed > dayMs;
}

const laneRuns = {
  async invoices(ctx) {
    const { client, sync, at } = ctx;
    const firstSince = cursorSince(ctx, new Date(floorUtcDay(at.getTime()) - sync.invoiceLookbackDays * DAY_MS).toISOString());
    const mapOptions = { keepPatientReference: sync.keepPatientReference };
    const reread = await rereadReleased(ctx, {
      mirror: 'invoices',
      what: 'invoice',
      detailPath: (id) => `invoices/${encodeURIComponent(id)}`,
      map: (detail) => mapInvoice({}, detail, mapOptions),
    });
    return withRereads(await walkChangedList(ctx, {
      what: 'invoice',
      firstSince,
      // The guide: on or after lastModified (inclusive).
      stepBackMs: 0,
      list: (since) => client.get('invoices/', { lastModified: since }),
      read: (items) => syncListWithDetail(ctx, {
        mirror: 'invoices',
        what: 'invoice',
        items,
        keyOf: (item) => text(item?.invoiceNumber),
        idOf: (item) => text(item?.id),
        signatureOf: invoiceListSignature,
        detailPath: (id) => `invoices/${encodeURIComponent(id)}`,
        map: (item, detail) => mapInvoice(item, detail, mapOptions),
      }),
    }), reread);
  },

  async orders_recent(ctx) {
    const { db, client, sync, at } = ctx;
    const nowMs = at.getTime();
    const lookbackStart = floorUtcDay(nowMs - sync.orderLookbackDays * DAY_MS);
    const doneThrough = Date.parse(ctx.state?.cursor?.completedThrough ?? '');
    const partial = ctx.state?.cursor?.partial;
    const partialDay = Date.parse(partial?.day ?? '');
    // Go on inside a day a run did not finish; otherwise re-read the last
    // finished day as well, so late orders on it are seen.
    const resumeInside = Number.isFinite(partialDay) && partialDay >= lookbackStart;
    const resume = resumeInside ? partialDay : Number.isFinite(doneThrough) ? Math.max(lookbackStart, doneThrough) : lookbackStart;

    // Issue #125: the list is paged (page, pageSize). A full page goes on to
    // the next page; a short page, or a page past the day, ends the day. The
    // guide says the list answers orders on or after `ordered`; a list that
    // answers one day works the same way.
    const pageSize = Math.min(ORDER_PAGE_MAX, sync.listCap);
    const byId = new Map();
    const days = [];
    let calls = 0;
    let lastDone = null;
    let stoppedAt = null;
    for (let day = floorUtcDay(resume); day <= floorUtcDay(nowMs) && days.length < sync.orderDaysPerRun && !stoppedAt; day += DAY_MS) {
      const label = `order list for ${formatOrderedDay(day)}`;
      let page = resumeInside && day === floorUtcDay(resume) ? Math.max(1, Number(partial.page) || 1) : 1;
      let previous = null;
      for (;;) {
        if (calls >= sync.listPagesPerRun) {
          stoppedAt = { day, page };
          break;
        }
        calls += 1;
        if (!days.includes(day)) days.push(day);
        const list = listOrFail(await client.get('orders/', { ordered: formatOrderedDay(day), page, pageSize }), label);
        const ids = list.map((item) => text(item?.id)).filter(Boolean);
        // A Seazona that does not page answers the same rows again.
        if (previous && ids.length && ids.every((id) => previous.has(id))) throw cannotGoOn(label, sync, 'the next page answers the same orders');
        for (const item of list) if (text(item?.id)) byId.set(text(item.id), item);
        if (list.length < pageSize || placedAfter(list[list.length - 1], day + DAY_MS)) break;
        previous = new Set(ids);
        page += 1;
      }
      if (!stoppedAt) lastDone = day;
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
    const through = lastDone ?? (Number.isFinite(doneThrough) ? doneThrough : null);
    return {
      summary,
      detailReads,
      listCount: byId.size,
      listCalls: calls,
      days: days.map(formatOrderedDay),
      deletedIds: deleted,
      failureDetails,
      cursorTime: through === null ? ctx.state?.cursorTime ?? null : new Date(through),
      cursor: {
        ...(through === null ? {} : { completedThrough: new Date(through).toISOString() }),
        ...(stoppedAt ? { partial: { day: new Date(stoppedAt.day).toISOString(), page: stoppedAt.page } } : {}),
      },
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
    const { client } = ctx;
    const reread = await rereadReleased(ctx, {
      mirror: 'clients',
      what: 'client',
      detailPath: (id) => `clients/${encodeURIComponent(id)}`,
      map: (detail) => mapClient({}, detail),
    });
    // The first run reads the whole list; later runs read changes only.
    // Seazona answers the whole list only to an empty `?lastModified=`; a
    // bare path is a 404.
    return withRereads(await walkChangedList(ctx, {
      what: 'client',
      firstSince: cursorSince(ctx, ''),
      // The guide says "modified after": step back a second so a row in the
      // last row's second is not lost.
      stepBackMs: 1000,
      list: (since) => (since ? client.get('clients/', { lastModified: since }) : client.get('clients/?lastModified=')),
      read: (items) => syncListWithDetail(ctx, {
        mirror: 'clients',
        what: 'client',
        items,
        keyOf: (item) => text(item?.id),
        idOf: (item) => text(item?.id),
        signatureOf: clientListSignature,
        detailPath: (id) => `clients/${encodeURIComponent(id)}`,
        map: (item, detail) => mapClient(item, detail),
      }),
    }), reread);
  },

  history: (ctx) => runHistoryBackfill(ctx, { isLaneLevel, describeReadFailure, emptyResponse, LaneError }),
  sweep: (ctx) => runSweep(ctx, { readOrder, isLaneLevel, describeReadFailure, emptyResponse, LaneError }),
  products: (ctx) => syncReference(ctx, 'products'),
  users: (ctx) => syncReference(ctx, 'users'),
};

async function syncReference(ctx, resource) {
  const { db, client, sync, at } = ctx;
  const list = listOrFail(await client.get(`${resource}/`), `${resource} list`);
  // The whole list in one answer, with no paging and no way to read on.
  if (list.length === sync.listCap) throw cannotGoOn(`${resource} list`, sync, 'the list has no paging');
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
        ...(error?.progress?.cursor ? { cursor: error.progress.cursor } : {}),
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
//
// Issue #143: a lane that ran before and has not succeeded within its
// freshness limit (or two of its own cadences, if those are longer) is
// stale, and a stale lane makes `ok` false like a failed one.
export async function readSeazonaSyncHealth(db, settings, { now = Date.now } = {}) {
  const nowMs = Number(now());
  const states = await readLaneStates(db);
  const quarantinedOrders = await readQuarantinedOrders(db, { at: new Date(nowMs), limit: MAX_REPORTED });
  const [{ deleted }] = await db.select({ deleted: count() }).from(seazonaOrders).where(isNotNull(seazonaOrders.deletedInSourceAt));
  const quarantinedRecords = await readQuarantinedRecordCounts(db, { at: new Date(nowMs) });
  const rereadDue = await readRecordRereadCounts(db, { at: new Date(nowMs) });
  const lanes = LANES.map((lane) => {
    const state = states.get(lane);
    const { freshnessMs, cadenceMs } = settings.sync.lanes[lane];
    const staleAfterMs = Math.max(freshnessMs, 2 * cadenceMs);
    const ageMs = state?.lastSuccessAt ? Math.max(0, nowMs - state.lastSuccessAt.getTime()) : null;
    return {
      lane,
      status: state?.status ?? 'never_run',
      fresh: ageMs !== null && ageMs <= staleAfterMs,
      stale: ageMs !== null && ageMs > staleAfterMs,
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
      ...(rereadDue[lane] ? { rereadDue: rereadDue[lane] } : {}),
    };
  });
  return {
    ok: lanes.every((lane) => !lane.stale && !['failed', 'held', 'stopped'].includes(lane.status)),
    lanes,
    deletedOrders: Number(deleted),
  };
}
