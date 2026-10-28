import { and, eq, inArray, sql } from 'drizzle-orm';
import { FlowError } from '../../core/errors.js';
import { orderStatusLabel } from './map.js';
import { orderLink } from './settings.js';
import { seazonaOrders, seazonaPersonSettings, seazonaStageMoves } from './schema.js';

// Stage moves on the Jobs board (docs/SEAZONA.md, "Stage moves"). Seazona's
// API cannot change an order's status, so Flow never tries: a move becomes a
// hand-off. Flow records the move, the person makes it in Seazona, and the
// next sync that reads the new status settles it. Until then the card shows
// "Waiting for Seazona" in the new lane. After a day with no change the move
// expires and the card goes back to Seazona's stage. No alert follows: the
// person saw what to do in Seazona when they moved the card.
// Every function here reads and writes Flow's database only.

export const HAND_OFF_MS = 24 * 60 * 60_000;
const MAX_STATUS = 80;

// Record a person's move of one order to `toStatus`, and answer the hand-off
// the board shows. A second move of the same order replaces the first.
export async function requestStageMove(db, { orderId, toStatus, personId = null, settings = null, now = Date.now() }) {
  const to = typeof toStatus === 'string' ? toStatus.trim() : '';
  if (!to || to.length > MAX_STATUS) throw new FlowError('invalid', 'toStatus must be a Seazona status');
  const [order] = await db.select().from(seazonaOrders).where(eq(seazonaOrders.id, String(orderId ?? '')));
  if (!order || order.deletedInSourceAt) throw new FlowError('not_found', 'Flow has no Seazona order with that number');
  const known = await db.selectDistinct({ status: seazonaOrders.status }).from(seazonaOrders)
    .where(eq(sql`lower(trim(${seazonaOrders.status}))`, to.toLowerCase()));
  if (!known.length) throw new FlowError('invalid', `Seazona has no status named ${to}`);
  const from = orderStatusLabel(order) || null;
  if (from && from.toLowerCase() === to.toLowerCase()) throw new FlowError('conflict', `The order is already ${from} in Seazona`);
  const at = new Date(Number(now));
  const row = {
    orderId: order.id, fromStatus: from, toStatus: known[0].status.trim(), requestedBy: personId,
    requestedAt: at, expiresAt: new Date(at.getTime() + HAND_OFF_MS), state: 'waiting', settledAt: null,
  };
  await db.insert(seazonaStageMoves).values(row).onConflictDoUpdate({ target: seazonaStageMoves.orderId, set: row });
  return handOff(row, { settings });
}

// Take a waiting move back: the card returns to Seazona's stage.
export async function cancelStageMove(db, { orderId, now = Date.now() }) {
  const rows = await db.update(seazonaStageMoves).set({ state: 'cancelled', settledAt: new Date(Number(now)) })
    .where(and(eq(seazonaStageMoves.orderId, String(orderId ?? '')), eq(seazonaStageMoves.state, 'waiting'))).returning();
  return { cancelled: rows.length > 0 };
}

// Settle the waiting moves against Flow's copy of the orders: done when the
// order has the new status, expired when a day has passed. An order that
// moved to some other status settles as done too: Seazona has the last word.
export async function settleStageMoves(db, { now = Date.now() } = {}) {
  const at = new Date(Number(now));
  const waiting = await db.select({ move: seazonaStageMoves, order: seazonaOrders }).from(seazonaStageMoves)
    .leftJoin(seazonaOrders, eq(seazonaOrders.id, seazonaStageMoves.orderId))
    .where(eq(seazonaStageMoves.state, 'waiting'));
  const done = [];
  const expired = [];
  for (const { move, order } of waiting) {
    const status = orderStatusLabel(order) || null;
    if (status && status !== move.fromStatus) done.push(move.orderId);
    else if (move.expiresAt <= at) expired.push(move.orderId);
  }
  if (done.length) {
    await db.update(seazonaStageMoves).set({ state: 'done', settledAt: at })
      .where(and(inArray(seazonaStageMoves.orderId, done), eq(seazonaStageMoves.state, 'waiting')));
  }
  if (expired.length) {
    await db.update(seazonaStageMoves).set({ state: 'expired', settledAt: at })
      .where(and(inArray(seazonaStageMoves.orderId, expired), eq(seazonaStageMoves.state, 'waiting')));
  }
  return { done: done.length, expired: expired.length };
}

// The waiting moves, by order id, for the board's cards.
export async function waitingStageMoves(db) {
  const rows = await db.select().from(seazonaStageMoves).where(eq(seazonaStageMoves.state, 'waiting'));
  return new Map(rows.map((r) => [r.orderId, r]));
}

// What the board shows for a waiting move. `link` opens the order in
// Seazona's web app (settings.js, orderLink); `exact` is false when it opens
// only the lab's Seazona home page.
export function handOff(row, { settings = null } = {}) {
  const link = orderLink(settings, { sourceJobRef: row.orderId });
  return {
    kind: 'hand_off',
    system: 'seazona',
    sourceJobRef: row.orderId,
    caseRef: row.orderId,
    from: row.fromStatus,
    to: row.toStatus,
    state: row.state,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    openUrl: link?.url ?? null,
    openExact: Boolean(link?.exact),
  };
}

// Each person's own Seazona choices, with their defaults.
export const PERSON_SETTINGS = Object.freeze([
  {
    key: 'askBeforeStageMoves',
    label: 'Ask before stage moves',
    hint: 'On the Jobs board, show what to do in Seazona before a card moves to a Seazona stage.',
    kind: 'onoff',
    default: true,
  },
]);

export async function readPersonSettings(db, personId) {
  const [row] = await db.select().from(seazonaPersonSettings).where(eq(seazonaPersonSettings.personId, String(personId)));
  return PERSON_SETTINGS.map((s) => ({ ...s, value: row ? Boolean(row[s.key]) : s.default }));
}

export async function writePersonSetting(db, personId, { key, value }, { now = Date.now() } = {}) {
  const setting = PERSON_SETTINGS.find((s) => s.key === key);
  if (!setting) throw new FlowError('invalid', 'no such setting');
  if (typeof value !== 'boolean') throw new FlowError('invalid', `${setting.label} must be on or off`);
  const at = new Date(Number(now));
  await db.insert(seazonaPersonSettings).values({ personId: String(personId), [key]: value, updatedAt: at })
    .onConflictDoUpdate({ target: seazonaPersonSettings.personId, set: { [key]: value, updatedAt: at } });
  return readPersonSettings(db, personId);
}
