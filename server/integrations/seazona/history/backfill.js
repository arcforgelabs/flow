import { eq, inArray } from 'drizzle-orm';
import { FlowError } from '../../../core/errors.js';
import { mapOrder, parseSeazonaDate, text } from '../map.js';
import { seazonaHistoryBatchJobs, seazonaLaneState, seazonaOrders } from '../schema.js';
import { recordRecordFailure } from '../store.js';
import { createApiBatch, finishApiBatch, stageApiJobs } from './index.js';

// The history backfill (docs/SEAZONA.md, "History import"). A person starts
// it with a first day; the `history` lane then walks the orders from that day
// on with GET orders/?ordered=<day> and its pages, and reads each order's
// detail. It makes at most
// `historyCallsPerRun` calls a run, through the same rate governor and call
// guards as the live lanes, and keeps its place in the lane's cursor, so it
// resumes after a restart. Orders the live copy already holds, and orders
// any earlier backfill read, are not read again, so a read started again over
// the same days costs only the list calls. Each order becomes one job in an API batch: reconciled as it is
// read, written to Flow's history when it is new, and kept for a person when
// it is not. The batch rows are the record of what the API confirmed.

export const LANE = 'history';
const PAGE_SIZE = 500;
const DAY_MS = 24 * 60 * 60_000;
const RESOURCE = 'history_orders';
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const orderedParam = (day) => `${day}T00:00:00`;

// An order's detail as a history job.
export function orderToHistoryJob(record) {
  return {
    invoiceNumber: record.invoiceNumber,
    caseRef: record.id,
    company: record.company,
    accountNumber: null,
    doctorName: record.doctorName,
    status: record.status,
    jobDate: null,
    orderedDate: parseSeazonaDate(record.orderedText),
    dueDate: parseSeazonaDate(record.dueText),
    shippedDate: null,
    lines: (record.lines ?? []).map((l) => ({
      description: l.description,
      code: l.code ?? null,
      amountCents: l.amountCents ?? null,
      ...(typeof l.taxable === 'boolean' ? { taxable: l.taxable } : {}),
      ...(l.tooth ? { tooth: l.tooth } : {}),
    })),
    subtotalCents: record.subtotalCents,
    totalCents: null,
    patientReference: record.patientReference,
  };
}

// Starts a backfill from `from` (yyyy-mm-dd) through `through`, by default the
// day before the live recent-order lane's window. One runs at a time.
export async function startBackfill(db, { from, through = null, createdBy, settings, now = Date.now }) {
  const at = new Date(Number(now()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from ?? '')) || Number.isNaN(Date.parse(from))) {
    throw Object.assign(new FlowError('invalid', 'from must be a day, yyyy-mm-dd'), { status: 400 });
  }
  const last = through ?? dayOf(at.getTime() - (settings.sync.orderLookbackDays + 1) * DAY_MS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last) || last < from) {
    throw Object.assign(new FlowError('invalid', 'through must be a day on or after from'), { status: 400 });
  }
  const [state] = await db.select().from(seazonaLaneState).where(eq(seazonaLaneState.lane, LANE));
  if (state?.cursor?.batchId && !state.cursor.done) {
    throw Object.assign(new FlowError('conflict', 'A history backfill is already running'), { status: 409 });
  }
  const batch = await createApiBatch(db, { createdBy, from, through: last, at });
  const cursor = { batchId: batch.id, from, through: last, nextDay: from, page: 1, pending: [], done: false, days: 0, read: 0 };
  await db.insert(seazonaLaneState).values({ lane: LANE, status: 'idle', cursor, nextRunAt: at })
    .onConflictDoUpdate({ target: seazonaLaneState.lane, set: { status: 'idle', cursor, nextRunAt: at, failureCount: 0, lastError: null, heldReason: null, updatedAt: at } });
  return describeBackfill(cursor);
}

// Stops a running backfill. Its batch keeps what it read and waits for a person.
export async function stopBackfill(db, { now = Date.now } = {}) {
  const at = new Date(Number(now()));
  const [state] = await db.select().from(seazonaLaneState).where(eq(seazonaLaneState.lane, LANE));
  const cursor = state?.cursor;
  if (!cursor?.batchId || cursor.done) throw Object.assign(new FlowError('conflict', 'No history backfill is running'), { status: 409 });
  const stopped = { ...cursor, done: true, stopped: true };
  await db.update(seazonaLaneState).set({ cursor: stopped, updatedAt: at }).where(eq(seazonaLaneState.lane, LANE));
  await finishApiBatch(db, cursor.batchId, { at });
  return describeBackfill(stopped);
}

export function describeBackfill(cursor) {
  if (!cursor?.batchId) return null;
  return {
    batchId: cursor.batchId,
    from: cursor.from,
    through: cursor.through,
    nextDay: cursor.done ? null : cursor.nextDay,
    // The day whose orders it reads now: the last day listed while orders
    // from it wait, else the next day to list.
    readingDay: cursor.done ? null : (cursor.pending?.length && cursor.listDay) || cursor.nextDay,
    daysDone: cursor.days ?? 0,
    reachedDay: cursor.reached ?? null,
    ordersRead: cursor.read ?? 0,
    waitingToRead: cursor.pending?.length ?? 0,
    running: !cursor.done,
    stopped: Boolean(cursor.stopped),
    // Where a stopped read goes on: the day it listed last while orders from
    // that list were still to read, else the next day.
    resumeFrom: !cursor.stopped ? null
      : cursor.pending?.length && cursor.listDay ? cursor.listDay
        : cursor.nextDay <= cursor.through ? cursor.nextDay : null,
  };
}

export async function readBackfill(db) {
  const [state] = await db.select().from(seazonaLaneState).where(eq(seazonaLaneState.lane, LANE));
  const backfill = describeBackfill(state?.cursor);
  return backfill && { ...backfill, nextRunAt: backfill.running ? state.nextRunAt : null };
}

// One run of the `history` lane. `helpers` are the lane module's failure
// rules, so the backfill fails, holds and stops exactly as the live lanes do.
export async function runHistoryBackfill(ctx, { isLaneLevel, describeReadFailure, emptyResponse, LaneError }) {
  const { db, client, sync, at, state } = ctx;
  const start = state?.cursor ?? {};
  if (!start.batchId || start.done) return { idle: true, cursor: start, cursorTime: state?.cursorTime ?? null };
  const cursor = { ...start, pending: [...(start.pending ?? [])] };
  const budget = sync.historyCallsPerRun;
  const pageSize = sync.historyPageSize ?? PAGE_SIZE;
  const jobs = [];
  const failures = [];
  let calls = 0;
  let deleted = 0;
  let quarantined = 0;

  const alreadyRead = async (ids) => {
    if (!ids.length) return new Set();
    const rows = await db.select({ key: seazonaHistoryBatchJobs.jobKey }).from(seazonaHistoryBatchJobs)
      .where(inArray(seazonaHistoryBatchJobs.jobKey, ids.map((id) => `case:${id}`)));
    return new Set(rows.map((r) => r.key.slice(5)));
  };

  try {
    while (calls < budget) {
      if (!cursor.pending.length) {
        if (cursor.nextDay > cursor.through) {
          cursor.done = true;
          break;
        }
        calls += 1;
        cursor.listDay = cursor.nextDay;
        const list = await client.get('orders/', { ordered: orderedParam(cursor.nextDay), page: cursor.page, pageSize });
        if (!Array.isArray(list)) throw new LaneError(`Seazona order list for ${cursor.nextDay} answer was not a list`, { code: 'seazona_list_invalid' });
        // The guide says the list answers orders placed on or after `ordered`,
        // oldest first, in stable pages; the live lane was built when it
        // answered one day. Both work here: orders after `through` end the walk,
        // a full page goes on to the next page, and a short page to the next day.
        const placed = (item) => (typeof item?.ordered === 'string' ? item.ordered.slice(0, 10) : null);
        const inRange = list.filter((item) => !(placed(item) > cursor.through));
        const beyond = inRange.length < list.length;
        for (const item of inRange) if (placed(item) > (cursor.reached ?? '')) cursor.reached = placed(item);
        const ids = [...new Set(inRange.map((item) => text(item?.id)).filter(Boolean))];
        // The live copy holds these already; a read again costs a call for nothing.
        const live = ids.length
          ? new Set((await db.select({ id: seazonaOrders.id }).from(seazonaOrders).where(inArray(seazonaOrders.id, ids))).map((r) => r.id))
          : new Set();
        const seen = await alreadyRead(ids);
        cursor.pending = ids.filter((id) => !live.has(id) && !seen.has(id));
        if (beyond) {
          cursor.nextDay = dayOf(Date.parse(cursor.through) + DAY_MS);
        } else if (list.length >= pageSize) {
          cursor.page += 1;
        } else {
          cursor.page = 1;
          cursor.nextDay = dayOf(Date.parse(cursor.nextDay) + DAY_MS);
          cursor.days = (cursor.days ?? 0) + 1;
        }
        continue;
      }
      const id = cursor.pending.shift();
      if ((await alreadyRead([id])).size) continue;
      calls += 1;
      try {
        const detail = await client.get(`orders/${encodeURIComponent(id)}`);
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw emptyResponse(`order ${id}`);
        const record = { ...mapOrder({}, detail, { keepPatientReference: sync.keepPatientReference }), id };
        jobs.push({ jobKey: `case:${id}`, job: orderToHistoryJob(record) });
        cursor.read = (cursor.read ?? 0) + 1;
      } catch (error) {
        if (isLaneLevel(error)) throw error;
        // Seazona has no such order now: nothing to keep.
        if (error?.statusCode === 404) {
          deleted += 1;
          continue;
        }
        const failure = describeReadFailure(error);
        const recorded = await recordRecordFailure(db, RESOURCE, id, failure, {
          at, quarantineFailures: sync.orderQuarantineFailures, quarantineMs: sync.orderQuarantineMs,
        });
        failures.push({ id, ...failure, ...recorded });
        // Read again later in the walk, until it is quarantined.
        if (recorded.quarantinedUntil) quarantined += 1;
        else cursor.pending.push(id);
      }
    }
  } finally {
    // What was read is kept even when the lane stops on a lane-level failure.
    await stageApiJobs(db, cursor.batchId, jobs, { at });
  }
  if (cursor.done) await finishApiBatch(db, cursor.batchId, { at });
  const failureDetails = failures.length
    ? { attempted: calls, failed: failures.length, failures: failures.slice(0, 25).map(({ error, ...f }) => f), quarantined }
    : null;
  return {
    calls,
    read: jobs.length,
    deleted,
    backfill: describeBackfill(cursor),
    failureDetails,
    cursor,
    cursorTime: at,
  };
}
