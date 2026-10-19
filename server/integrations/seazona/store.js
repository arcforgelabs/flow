import { and, eq, getTableColumns, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { hashOf } from './map.js';
import {
  seazonaClients,
  seazonaInvoices,
  seazonaLaneState,
  seazonaOrderReadFailures,
  seazonaOrders,
  seazonaRecordReadFailures,
  seazonaReference,
} from './schema.js';

// Reads and writes of the Seazona mirror. Every write takes `at`, the lane's
// clock, so one run uses one time throughout.

export const MIRRORS = Object.freeze({
  orders: { table: seazonaOrders, key: 'id' },
  invoices: { table: seazonaInvoices, key: 'invoiceNumber' },
  clients: { table: seazonaClients, key: 'id' },
});

function excludedSet(table, fields) {
  const columns = getTableColumns(table);
  return Object.fromEntries(fields.map((field) => [field, sql.raw(`excluded."${columns[field].name}"`)]));
}

// Stored list signatures and deleted marks for a set of keys.
export async function readKnown(db, mirror, keys) {
  const { table, key } = MIRRORS[mirror];
  if (!keys.length) return new Map();
  const columns = { key: table[key], listSignature: table.listSignature, recordHash: table.recordHash };
  if (mirror === 'orders') columns.deletedInSourceAt = table.deletedInSourceAt;
  const rows = await db.select(columns).from(table).where(inArray(table[key], keys));
  return new Map(rows.map((row) => [row.key, row]));
}

// Upserts mapped records. `last_changed_at` moves only when the record
// differs from what was stored. Returns { created, changed, unchanged }.
export async function upsertRecords(db, mirror, records, { at, listSignatures = new Map() } = {}) {
  const { table, key } = MIRRORS[mirror];
  const summary = { created: 0, changed: 0, unchanged: 0 };
  if (!records.length) return summary;
  const known = await readKnown(db, mirror, records.map((record) => record[key]));
  const values = records.map((record) => {
    const row = { ...record };
    if (mirror === 'orders') row.deletedInSourceAt = null; // a successful read clears the 404 mark
    const recordHash = hashOf(row);
    const before = known.get(record[key]);
    if (!before) summary.created += 1;
    else if (before.recordHash !== recordHash || before.deletedInSourceAt) summary.changed += 1;
    else summary.unchanged += 1;
    return {
      ...row,
      listSignature: listSignatures.get(record[key]) ?? null,
      recordHash,
      firstSeenAt: at,
      lastSyncedAt: at,
      lastChangedAt: at,
    };
  });
  // A detail-only read (no list row) keeps the stored list signature.
  const keep = new Set([key, 'firstSeenAt', 'lastChangedAt', ...(listSignatures.size ? [] : ['listSignature'])]);
  const updatable = Object.keys(values[0]).filter((field) => !keep.has(field));
  await db.insert(table).values(values).onConflictDoUpdate({
    target: table[key],
    set: {
      ...excludedSet(table, updatable),
      // An order that comes back after a 404 counts as changed.
      lastChangedAt: mirror === 'orders'
        ? sql`case when ${table.recordHash} = excluded.record_hash and ${seazonaOrders.deletedInSourceAt} is null then ${table.lastChangedAt} else excluded.last_changed_at end`
        : sql`case when ${table.recordHash} = excluded.record_hash then ${table.lastChangedAt} else excluded.last_changed_at end`,
    },
  });
  return summary;
}

// A list row that did not change since the last read: only its sync time moves.
export async function touchSynced(db, mirror, keys, { at }) {
  const { table, key } = MIRRORS[mirror];
  if (!keys.length) return;
  await db.update(table).set({ lastSyncedAt: at }).where(inArray(table[key], keys));
}

// Issue #12: Seazona answered 404. Keep the row and its history, mark it, and
// refresh its sync time so it never comes first in the rotation again. An
// order seen in a list but never stored is kept from that list row.
export async function markOrderDeleted(db, id, { at, fallback = null }) {
  const [row] = await db.update(seazonaOrders)
    .set({
      deletedInSourceAt: sql`coalesce(${seazonaOrders.deletedInSourceAt}, ${at})`,
      lastChangedAt: sql`case when ${seazonaOrders.deletedInSourceAt} is null then ${at} else ${seazonaOrders.lastChangedAt} end`,
      lastSyncedAt: at,
    })
    .where(eq(seazonaOrders.id, id))
    .returning({ id: seazonaOrders.id });
  if (row || !fallback) return;
  await db.insert(seazonaOrders).values({
    ...fallback,
    recordHash: hashOf(fallback),
    deletedInSourceAt: at,
    firstSeenAt: at,
    lastSyncedAt: at,
    lastChangedAt: at,
  }).onConflictDoNothing();
}

export async function upsertReference(db, resource, records, { at }) {
  if (!records.length) return { stored: 0 };
  const values = records.map((record) => ({ ...record, resource, recordHash: hashOf(record), lastSyncedAt: at }));
  await db.insert(seazonaReference).values(values).onConflictDoUpdate({
    target: [seazonaReference.resource, seazonaReference.id],
    set: excludedSet(seazonaReference, ['name', 'code', 'kind', 'priceCents', 'taxable', 'recordHash', 'lastSyncedAt']),
  });
  return { stored: values.length };
}

// Open orders for the active-order lane: not final, not deleted in Seazona,
// not quarantined, oldest observation first. A failed read never refreshes
// last_synced_at, so the rotation uses whichever is later, the last success
// or the last failed attempt: a failed order goes to the back. Complete
// orders win only an equal-age tie.
export async function selectActiveOrders(db, { at, limit, finalStatusPattern }) {
  const rotationAt = sql`greatest(${seazonaOrders.lastSyncedAt}, coalesce(${seazonaOrderReadFailures.lastAttemptAt}, ${seazonaOrders.lastSyncedAt}))`;
  const open = and(
    isNull(seazonaOrders.deletedInSourceAt),
    or(isNull(seazonaOrders.status), sql`${seazonaOrders.status} !~* ${finalStatusPattern}`),
  );
  const notQuarantined = or(isNull(seazonaOrderReadFailures.quarantinedUntil), lt(seazonaOrderReadFailures.quarantinedUntil, at));
  const targets = await db.select({
    id: seazonaOrders.id,
    failureCount: seazonaOrderReadFailures.failureCount,
  })
    .from(seazonaOrders)
    .leftJoin(seazonaOrderReadFailures, eq(seazonaOrderReadFailures.orderId, seazonaOrders.id))
    .where(and(open, notQuarantined))
    .orderBy(rotationAt, sql`(${seazonaOrders.status} ~* '\\mcomplete') desc nulls last`, seazonaOrders.id)
    .limit(limit);
  const [{ candidates }] = await db.select({ candidates: sql`count(*)::int` })
    .from(seazonaOrders)
    .where(open);
  return { targets, candidates };
}

export async function readOrderFailures(db, ids) {
  if (!ids.length) return new Map();
  const rows = await db.select().from(seazonaOrderReadFailures).where(inArray(seazonaOrderReadFailures.orderId, ids));
  return new Map(rows.map((row) => [row.orderId, row]));
}

export async function clearOrderFailure(db, id) {
  await db.delete(seazonaOrderReadFailures).where(eq(seazonaOrderReadFailures.orderId, id));
}

// Records one failed read. After `quarantineFailures` failures in a row the
// order waits `quarantineMs`; when that ends it gets one more read, and a
// failure then quarantines it again.
export async function recordOrderFailure(db, id, failure, { at, quarantineFailures, quarantineMs }) {
  const [row] = await db.insert(seazonaOrderReadFailures).values({
    orderId: id,
    failureCount: 1,
    lastAttemptAt: at,
    lastHttpStatus: failure.httpStatus,
    lastFailureKind: failure.kind,
    lastError: failure.error.slice(0, 300),
    quarantinedUntil: quarantineFailures <= 1 ? new Date(at.getTime() + quarantineMs) : null,
  }).onConflictDoUpdate({
    target: seazonaOrderReadFailures.orderId,
    set: {
      failureCount: sql`${seazonaOrderReadFailures.failureCount} + 1`,
      lastAttemptAt: at,
      lastHttpStatus: failure.httpStatus,
      lastFailureKind: failure.kind,
      lastError: failure.error.slice(0, 300),
      quarantinedUntil: sql`case when ${seazonaOrderReadFailures.failureCount} + 1 >= ${quarantineFailures}
        then ${new Date(at.getTime() + quarantineMs)}::timestamptz else null end`,
    },
  }).returning();
  return { failureCount: row.failureCount, quarantinedUntil: row.quarantinedUntil?.toISOString() ?? null };
}

export async function readQuarantinedOrders(db, { at, limit = 25 }) {
  const rows = await db.select().from(seazonaOrderReadFailures)
    .where(and(isNotNull(seazonaOrderReadFailures.quarantinedUntil), gt(seazonaOrderReadFailures.quarantinedUntil, at)))
    .orderBy(seazonaOrderReadFailures.orderId)
    .limit(limit);
  return rows.map((row) => ({
    id: row.orderId,
    httpStatus: row.lastHttpStatus,
    kind: row.lastFailureKind,
    failureCount: row.failureCount,
    lastAttemptAt: row.lastAttemptAt.toISOString(),
    quarantinedUntil: row.quarantinedUntil.toISOString(),
  }));
}

// Issue #101: failed detail reads of invoices and clients, per record.
// Answers Map(key -> row) for the keys that are quarantined at `at`.
export async function readQuarantinedRecords(db, resource, keys, { at }) {
  if (!keys.length) return new Map();
  const rows = await db.select().from(seazonaRecordReadFailures).where(and(
    eq(seazonaRecordReadFailures.resource, resource),
    inArray(seazonaRecordReadFailures.recordKey, keys),
    gt(seazonaRecordReadFailures.quarantinedUntil, at),
  ));
  return new Map(rows.map((row) => [row.recordKey, row]));
}

export async function clearRecordFailures(db, resource, keys) {
  if (!keys.length) return;
  await db.delete(seazonaRecordReadFailures).where(and(
    eq(seazonaRecordReadFailures.resource, resource),
    inArray(seazonaRecordReadFailures.recordKey, keys),
  ));
}

// Records one failed read, as recordOrderFailure does for orders. Answers
// { failureCount, quarantinedUntil }.
export async function recordRecordFailure(db, resource, key, failure, { at, quarantineFailures, quarantineMs }) {
  const until = new Date(at.getTime() + quarantineMs);
  const [row] = await db.insert(seazonaRecordReadFailures).values({
    resource,
    recordKey: key,
    failureCount: 1,
    lastAttemptAt: at,
    lastHttpStatus: failure.httpStatus,
    lastFailureKind: failure.kind,
    quarantinedUntil: quarantineFailures <= 1 ? until : null,
  }).onConflictDoUpdate({
    target: [seazonaRecordReadFailures.resource, seazonaRecordReadFailures.recordKey],
    set: {
      failureCount: sql`${seazonaRecordReadFailures.failureCount} + 1`,
      lastAttemptAt: at,
      lastHttpStatus: failure.httpStatus,
      lastFailureKind: failure.kind,
      quarantinedUntil: sql`case when ${seazonaRecordReadFailures.failureCount} + 1 >= ${quarantineFailures}
        then ${until}::timestamptz else null end`,
    },
  }).returning();
  return { failureCount: row.failureCount, quarantinedUntil: row.quarantinedUntil?.toISOString() ?? null };
}

export async function readQuarantinedRecordCounts(db, { at }) {
  const rows = await db.select({ resource: seazonaRecordReadFailures.resource, records: sql`count(*)::int` })
    .from(seazonaRecordReadFailures)
    .where(gt(seazonaRecordReadFailures.quarantinedUntil, at))
    .groupBy(seazonaRecordReadFailures.resource);
  return Object.fromEntries(rows.map((row) => [row.resource, row.records]));
}

// Lane state.

export async function readLaneStates(db) {
  const rows = await db.select().from(seazonaLaneState);
  return new Map(rows.map((row) => [row.lane, row]));
}

// Claims a lane for this run. Returns false when another run holds it and has
// not been running longer than `stuckMs`, so two processes never run one lane
// at once.
export async function claimLane(db, lane, { at, stuckMs }) {
  await db.insert(seazonaLaneState).values({ lane }).onConflictDoNothing();
  const claimed = await db.update(seazonaLaneState)
    .set({ status: 'processing', lastAttemptAt: at, updatedAt: at })
    .where(and(
      eq(seazonaLaneState.lane, lane),
      or(ne(seazonaLaneState.status, 'processing'), lt(seazonaLaneState.lastAttemptAt, new Date(at.getTime() - stuckMs))),
    ))
    .returning({ lane: seazonaLaneState.lane });
  return claimed.length > 0;
}

// Issue #101: a lane stopped for a person or a release runs again. Answers
// the lanes it reset.
export async function resetStoppedLanes(db, { at }) {
  const rows = await db.update(seazonaLaneState)
    .set({ status: 'idle', nextRunAt: at, failureCount: 0, heldReason: null, updatedAt: at })
    .where(eq(seazonaLaneState.status, 'stopped'))
    .returning({ lane: seazonaLaneState.lane });
  return rows.map((row) => row.lane);
}

// A person acted: every lane that failed or stopped runs at the next tick.
export async function resetFailedLanes(db, { at }) {
  const rows = await db.update(seazonaLaneState)
    .set({ status: 'idle', nextRunAt: at, failureCount: 0, heldReason: null, updatedAt: at })
    .where(inArray(seazonaLaneState.status, ['stopped', 'failed', 'held']))
    .returning({ lane: seazonaLaneState.lane });
  return rows.map((row) => row.lane);
}

export async function finishLane(db, lane, patch) {
  await db.update(seazonaLaneState).set({ ...patch, updatedAt: patch.lastAttemptAt ?? new Date() }).where(eq(seazonaLaneState.lane, lane));
}
