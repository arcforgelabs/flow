import { eq, sql } from 'drizzle-orm';
import { portalSessions, practiceMembers } from '../db/schema.js';

// A practice session ends after 12 hours with no request. Staff can sign a
// member out at once: tokens issued before that moment are refused, and any
// session row for them is marked revoked.

export const PORTAL_IDLE_MS = 12 * 60 * 60 * 1000;

export async function touchPortalSession(db, {
  sessionId,
  organisationId,
  memberId,
  issuedAtMs = 0,
  revokedAt = null,
  now = Date.now(),
  idleMs = PORTAL_IDLE_MS,
}) {
  if (revokedAt && issuedAtMs <= new Date(revokedAt).getTime()) return { revoked: true };
  const [row] = await db.select().from(portalSessions).where(eq(portalSessions.sessionId, sessionId));
  if (row?.revokedAt) return { revoked: true };
  if (row && now - new Date(row.lastSeenAt).getTime() > idleMs) {
    await db.update(portalSessions).set({ revokedAt: new Date(now) }).where(eq(portalSessions.sessionId, sessionId));
    return { idle: true };
  }
  const seen = new Date(now);
  if (row) {
    await db.update(portalSessions).set({ lastSeenAt: seen, memberId }).where(eq(portalSessions.sessionId, sessionId));
  } else {
    await db.insert(portalSessions).values({ sessionId, organisationId, memberId, lastSeenAt: seen });
  }
  return { ok: true };
}

// Signs every current session of this member out. A later sign-in, with a
// token issued after this moment, is a new session.
export async function revokeMemberSessions(db, { memberId }) {
  const at = new Date();
  await db.update(practiceMembers).set({ sessionsRevokedAt: at, updatedAt: sql`now()` }).where(eq(practiceMembers.id, memberId));
  await db.update(portalSessions).set({ revokedAt: at }).where(eq(portalSessions.memberId, memberId));
  return at;
}
