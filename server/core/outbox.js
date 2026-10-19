import { and, eq, sql } from 'drizzle-orm';
import { outbox } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { linkRecord } from './links.js';
import { openReview } from './review.js';

// The outbox. Every write Flow makes to another system is a row here first,
// written in the same transaction as the Flow change it reports, with its
// idempotency key. An adapter sends it through its governor and records what
// came back. So a write is never lost, never made twice, and never made
// without a record of why.
//
//   pending -> sending -> sent
//                      -> ambiguous (outcome unknown: settle by a lookup first)
//                      -> pending again (a retry) or failed (opens a review item)
//   pending or ambiguous -> cancelled (a person)

// How long a send may take before Flow treats its outcome as unknown.
export const SEND_LEASE_MS = 10 * 60 * 1000;

// Queues a write. Pass the transaction that makes the Flow change. A repeat with
// the same key returns the first row; the same key for another record refuses.
export async function queueWrite(tx, organisationId, {
  system, action, entity, flowId, idempotencyKey, request, actor,
}) {
  if (!system || !action || !entity || !flowId) throw new FlowError('invalid', 'system, action, entity and flowId are required');
  if (!idempotencyKey) throw new FlowError('invalid', 'idempotencyKey is required');
  if (!actor) throw new FlowError('invalid', 'actor is required');
  const [row] = await tx.insert(outbox)
    .values({ organisationId, system, action, entity, flowId, idempotencyKey, request, createdBy: actor })
    .onConflictDoNothing({ target: outbox.idempotencyKey })
    .returning();
  if (row) return { write: row, queued: true };
  const [first] = await tx.select().from(outbox).where(eq(outbox.idempotencyKey, idempotencyKey));
  if (first.organisationId !== organisationId || first.flowId !== flowId || first.action !== action) {
    throw new FlowError('conflict', 'idempotency key already used for another write');
  }
  return { write: first, queued: false };
}

// Claims pending writes for one system. A write left `sending` past the lease
// (the process died mid-call) becomes `ambiguous`: the call may have left.
export async function claimWrites(db, { system, limit = 10, leaseMs = SEND_LEASE_MS }) {
  return db.transaction(async (tx) => {
    await tx.update(outbox)
      .set({ state: 'ambiguous', lastError: 'send did not finish', updatedAt: sql`now()` })
      .where(and(
        eq(outbox.system, system),
        eq(outbox.state, 'sending'),
        sql`${outbox.updatedAt} < now() - make_interval(secs => ${leaseMs / 1000})`,
      ));
    const { rows } = await tx.execute(sql`
      select id from outbox where system = ${system} and state = 'pending'
      order by created_at for update skip locked limit ${limit}`);
    const claimed = [];
    for (const { id } of rows) {
      const [write] = await tx.update(outbox)
        .set({ state: 'sending', attempts: sql`${outbox.attempts} + 1`, updatedAt: sql`now()` })
        .where(eq(outbox.id, id))
        .returning();
      claimed.push(write);
    }
    return claimed;
  });
}

// Moves one write from the states in `from` to new fields. Refuses a move from
// any other state, so two workers can never both settle one write.
async function move(tx, organisationId, writeId, from, fields) {
  const [row] = await tx.update(outbox)
    .set({ ...fields, updatedAt: sql`now()` })
    .where(and(
      eq(outbox.organisationId, organisationId),
      eq(outbox.id, writeId),
      sql`${outbox.state} in (${sql.join(from.map((s) => sql`${s}`), sql`, `)})`,
    ))
    .returning();
  if (row) return row;
  const [existing] = await tx.select().from(outbox)
    .where(and(eq(outbox.organisationId, organisationId), eq(outbox.id, writeId)));
  if (!existing) throw notFound('write');
  throw new FlowError('conflict', `write is ${existing.state}`, { state: existing.state });
}

// The system made the record. Flow links its own record to it in the same
// transaction, so the identity map always knows what Flow created.
export async function markSent(db, organisationId, writeId, { externalId }) {
  if (!externalId) throw new FlowError('invalid', 'externalId is required');
  return db.transaction(async (tx) => {
    const row = await move(tx, organisationId, writeId, ['sending', 'ambiguous'], {
      state: 'sent', externalId, sentAt: sql`now()`, lastError: null,
    });
    const link = await linkRecord(tx, organisationId, {
      entity: row.entity, flowId: row.flowId, system: row.system, externalId, matchedBy: 'created_by_flow',
    });
    return { write: row, link };
  });
}

// The outcome is unknown (a timeout, a 5xx after the request left). The adapter
// must look in the system before it sends again.
export async function markAmbiguous(db, organisationId, writeId, { error }) {
  return move(db, organisationId, writeId, ['sending'], { state: 'ambiguous', lastError: String(error).slice(0, 2000) });
}

// The system refused the write, or a lookup found it was never made. With
// `retry` it goes back to pending; without, it fails and opens a review item.
export async function markFailed(db, organisationId, writeId, { error, retry = false }) {
  const message = String(error).slice(0, 2000);
  if (retry) return move(db, organisationId, writeId, ['sending', 'ambiguous'], { state: 'pending', lastError: message });
  return db.transaction(async (tx) => {
    const row = await move(tx, organisationId, writeId, ['sending', 'ambiguous'], { state: 'failed', lastError: message });
    await openReview(tx, organisationId, {
      kind: 'write.failed',
      entity: row.entity,
      flowId: row.flowId,
      systems: [row.system],
      evidence: { writeId: row.id, action: row.action, attempts: row.attempts, error: message },
    });
    return row;
  });
}

export async function cancelWrite(db, organisationId, writeId, { actor }) {
  if (!actor) throw new FlowError('invalid', 'actor is required');
  return move(db, organisationId, writeId, ['pending', 'ambiguous', 'failed'], {
    state: 'cancelled', lastError: `cancelled by ${actor}`,
  });
}
