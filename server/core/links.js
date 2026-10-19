import { and, eq, sql } from 'drizzle-orm';
import { externalLinks, LINK_ENTITIES, LINK_MATCHES, priorLinks } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { openReview, resolveReviewFor } from './review.js';

// The identity map (issue 57). It records that a Flow record and a record in
// another system are the same thing, how Flow knows, and who confirmed it.
// Pushes, imports and the ledger read the link first; matching by name only
// ever proposes one.
//
// A link is exact when Flow made the external record, or both sides carry the
// same id. A name match is a guess: it stays `proposed` and opens a review item
// until a person confirms it. A link is never deleted; a replaced one is
// `superseded`.

const EXACT = new Set(['created_by_flow', 'exact_id', 'imported', 'person']);

function check({ entity, flowId, system, externalId, matchedBy }) {
  if (!LINK_ENTITIES.includes(entity)) throw new FlowError('invalid', `unknown link entity: ${entity}`);
  if (!LINK_MATCHES.includes(matchedBy)) throw new FlowError('invalid', `unknown match: ${matchedBy}`);
  if (!flowId || !system || !externalId) throw new FlowError('invalid', 'flowId, system and externalId are required');
}

// Two callers that link the same external record, or the same Flow record, at
// the same time take turns: the decision below reads, then writes.
async function lockPair(tx, organisationId, { system, entity, externalId, flowId }) {
  const keys = [
    `link:${organisationId}:${system}:${entity}:ext:${externalId}`,
    `link:${organisationId}:${system}:${entity}:flow:${flowId}`,
  ].sort();
  for (const key of keys) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function activeBy(tx, organisationId, { system, entity }, column, value) {
  const [row] = await tx.select().from(externalLinks).where(and(
    eq(externalLinks.organisationId, organisationId),
    eq(externalLinks.system, system),
    eq(externalLinks.entity, entity),
    eq(column, value),
    eq(externalLinks.state, 'active'),
  ));
  return row ?? null;
}

// Records a link. Answers `{ outcome, link }`:
// - `linked`: a new active link;
// - `existing`: the same active link was already there;
// - `proposed`: a guess, waiting for a person (a review item is open);
// - `conflict`: one side already links elsewhere. Nothing changes; a review
//   item holds both sides.
export async function linkRecord(db, organisationId, link) {
  check(link);
  const { entity, flowId, system, externalId, matchedBy } = link;
  return db.transaction(async (tx) => {
    await lockPair(tx, organisationId, link);
    const byExternal = await activeBy(tx, organisationId, link, externalLinks.externalId, externalId);
    if (byExternal?.flowId === flowId) return { outcome: 'existing', link: byExternal };
    const byFlow = await activeBy(tx, organisationId, link, externalLinks.flowId, flowId);
    if (byExternal || byFlow) {
      await openReview(tx, organisationId, {
        kind: 'link.conflict',
        entity,
        flowId,
        systems: [system],
        evidence: {
          proposed: { system, externalId, matchedBy },
          linkedExternal: byExternal && { flowId: byExternal.flowId, externalId: byExternal.externalId },
          linkedFlow: byFlow && { flowId: byFlow.flowId, externalId: byFlow.externalId },
        },
      });
      return { outcome: 'conflict', link: byExternal ?? byFlow };
    }
    const state = EXACT.has(matchedBy) ? 'active' : 'proposed';
    const [waiting] = await tx.select().from(externalLinks).where(and(
      eq(externalLinks.organisationId, organisationId),
      eq(externalLinks.system, system),
      eq(externalLinks.entity, entity),
      eq(externalLinks.externalId, externalId),
      eq(externalLinks.flowId, flowId),
      eq(externalLinks.state, 'proposed'),
    ));
    if (waiting && state === 'proposed') return { outcome: 'proposed', link: waiting };
    if (waiting) {
      // Exact evidence for a pair a person was asked about settles the question.
      await tx.update(externalLinks).set({ state: 'superseded', updatedAt: sql`now()` })
        .where(eq(externalLinks.id, waiting.id));
      await resolveReviewFor(tx, organisationId, {
        kind: 'link.proposed', entity, flowId, resolution: `exact:${matchedBy}`, actor: 'system:links',
      });
    }
    const [row] = await tx.insert(externalLinks)
      .values({ organisationId, entity, flowId, system, externalId, matchedBy, state })
      .returning();
    if (state === 'proposed') {
      await openReview(tx, organisationId, {
        kind: 'link.proposed',
        entity,
        flowId,
        systems: [system],
        evidence: { linkId: row.id, system, externalId, matchedBy },
      });
    }
    return { outcome: state === 'active' ? 'linked' : 'proposed', link: row };
  });
}

// A person confirms a proposed link. It becomes active, unless either side
// gained an active link meanwhile.
export async function confirmLink(db, organisationId, linkId, { personId = null, actor }) {
  if (!actor) throw new FlowError('invalid', 'actor is required');
  return db.transaction(async (tx) => {
    const [proposed] = await tx.select().from(externalLinks)
      .where(and(eq(externalLinks.organisationId, organisationId), eq(externalLinks.id, linkId)));
    if (!proposed) throw notFound('link');
    await lockPair(tx, organisationId, proposed);
    const [current] = await tx.select().from(externalLinks)
      .where(eq(externalLinks.id, linkId)).for('update');
    if (current.state !== 'proposed') throw new FlowError('conflict', 'link is not waiting for a person', { state: current.state });
    const taken = await activeBy(tx, organisationId, current, externalLinks.externalId, current.externalId)
      ?? await activeBy(tx, organisationId, current, externalLinks.flowId, current.flowId);
    if (taken) throw new FlowError('conflict', 'one side already has an active link', { linkId: taken.id });
    const [row] = await tx.update(externalLinks)
      .set({ state: 'active', confirmedBy: personId, confirmedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(externalLinks.id, linkId))
      .returning();
    await resolveReviewFor(tx, organisationId, {
      kind: 'link.proposed', entity: row.entity, flowId: row.flowId, resolution: 'confirmed', actor,
    });
    return row;
  });
}

// Ends a link (for example when the external record was merged or deleted).
export async function supersedeLink(db, organisationId, linkId) {
  const [row] = await db.update(externalLinks)
    .set({ state: 'superseded', updatedAt: sql`now()` })
    .where(and(eq(externalLinks.organisationId, organisationId), eq(externalLinks.id, linkId)))
    .returning();
  if (!row) throw notFound('link');
  return row;
}

// The Flow record an external record is, through an active link, or null.
export async function flowIdFor(db, organisationId, { system, entity, externalId }) {
  const row = await activeBy(db, organisationId, { system, entity }, externalLinks.externalId, externalId);
  return row?.flowId ?? null;
}

// The external id of a Flow record in one system, through an active link, or null.
export async function externalIdFor(db, organisationId, { system, entity, flowId }) {
  const row = await activeBy(db, organisationId, { system, entity }, externalLinks.flowId, flowId);
  return row?.externalId ?? null;
}

// The link an earlier installation held for a work system's job, if any
// (`prior_links`). The pipeline reads it when the job first becomes an
// obligation (#58).
export async function priorLinkFor(db, organisationId, { sourceSystem, sourceJobRef, system }) {
  const [row] = await db.select().from(priorLinks).where(and(
    eq(priorLinks.organisationId, organisationId),
    eq(priorLinks.sourceSystem, sourceSystem),
    eq(priorLinks.sourceJobRef, sourceJobRef),
    eq(priorLinks.system, system),
  ));
  return row ?? null;
}
