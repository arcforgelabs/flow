import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { reviewItems } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';

// The review queue (issue 59). Everything a person must decide is one row
// here: a link Flow could not prove, a write that failed for good, a job that
// gave up, a difference between two systems. Flow never settles a conflict by
// overwriting one side; it opens an item and waits for a person.

function requireActor(actor) {
  if (!actor) throw new FlowError('invalid', 'actor is required');
}

// Opens an item, or updates the one open item for the same kind and record:
// a repeat finding refreshes the evidence and never makes a second item.
export async function openReview(db, organisationId, {
  kind, entity, flowId, systems = [], evidence = {}, moneyAtRiskCents = 0,
}) {
  if (!kind || !entity || !flowId) throw new FlowError('invalid', 'kind, entity and flowId are required');
  if (!Number.isSafeInteger(moneyAtRiskCents) || moneyAtRiskCents < 0) {
    throw new FlowError('invalid', 'moneyAtRiskCents must be whole, non-negative cents');
  }
  const [row] = await db.insert(reviewItems)
    .values({ organisationId, kind, entity, flowId, systems, evidence, moneyAtRiskCents })
    .onConflictDoUpdate({
      target: [reviewItems.organisationId, reviewItems.kind, reviewItems.entity, reviewItems.flowId],
      targetWhere: sql`state = 'open'`,
      set: {
        systems,
        evidence,
        moneyAtRiskCents,
        seenCount: sql`${reviewItems.seenCount} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

// Closes an open item with the choice a person made. `dismiss` records that
// nothing needed doing.
export async function resolveReview(db, organisationId, reviewId, { resolution, note = null, actor, dismiss = false }) {
  requireActor(actor);
  if (!resolution) throw new FlowError('invalid', 'resolution is required');
  const [row] = await db.update(reviewItems)
    .set({
      state: dismiss ? 'dismissed' : 'resolved',
      resolution,
      note,
      resolvedBy: actor,
      resolvedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(reviewItems.organisationId, organisationId),
      eq(reviewItems.id, reviewId),
      eq(reviewItems.state, 'open'),
    ))
    .returning();
  if (row) return row;
  const [existing] = await db.select().from(reviewItems)
    .where(and(eq(reviewItems.organisationId, organisationId), eq(reviewItems.id, reviewId)));
  if (!existing) throw notFound('review item');
  throw new FlowError('conflict', 'review item is already closed', { state: existing.state });
}

// Closes the open item for one record and kind, when the cause went away on its
// own (for example a person confirmed a link from another screen).
export async function resolveReviewFor(db, organisationId, { kind, entity, flowId, resolution, actor }) {
  requireActor(actor);
  const rows = await db.update(reviewItems)
    .set({ state: 'resolved', resolution, resolvedBy: actor, resolvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(
      eq(reviewItems.organisationId, organisationId),
      eq(reviewItems.kind, kind),
      eq(reviewItems.entity, entity),
      eq(reviewItems.flowId, flowId),
      eq(reviewItems.state, 'open'),
    ))
    .returning();
  return rows[0] ?? null;
}

// The queue a person works through: most money at risk first, then oldest.
export async function listReview(db, organisationId, { state = 'open', kind, limit = 100 } = {}) {
  const filters = [eq(reviewItems.organisationId, organisationId), eq(reviewItems.state, state)];
  if (kind) filters.push(eq(reviewItems.kind, kind));
  return db.select().from(reviewItems)
    .where(and(...filters))
    .orderBy(desc(reviewItems.moneyAtRiskCents), asc(reviewItems.createdAt))
    .limit(limit);
}
