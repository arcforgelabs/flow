import { and, desc, eq, isNull } from 'drizzle-orm';
import { portalAccessRequests, practiceMembers } from '../db/schema.js';
import { primaryEmailOf } from './clerk.js';
import { normaliseEmail } from './people.js';
import { deny } from './session.js';
import { isPlainEmail } from './settings.js';
import { portalScope, readPortalSettings } from '../portal/scope.js';

// The practice portal's guard (docs/PORTAL.md). Clerk proves who someone is.
// An active practice_members row says which practices they may see. A staff
// session has no such row and is refused. `?practice=` may only pick among
// this member's own rows.

function bearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

async function linkInvited(db, clerk, clerkUserId, log) {
  const linked = await db.select().from(practiceMembers).where(and(
    eq(practiceMembers.clerkUserId, clerkUserId),
    eq(practiceMembers.status, 'active'),
  ));
  if (linked.length) return linked;
  let email = null;
  try {
    const primary = primaryEmailOf(await clerk.getUser(clerkUserId));
    if (primary.verified && isPlainEmail(primary.email)) email = normaliseEmail(primary.email);
  } catch (error) {
    log.warn?.(`[portal] could not read the sign-in email: ${error.message}`);
    return [];
  }
  if (!email) return [];
  await db.update(practiceMembers).set({ clerkUserId, status: 'active', updatedAt: new Date() }).where(and(
    eq(practiceMembers.email, email),
    eq(practiceMembers.status, 'invited'),
    isNull(practiceMembers.clerkUserId),
  ));
  return db.select().from(practiceMembers).where(and(
    eq(practiceMembers.clerkUserId, clerkUserId),
    eq(practiceMembers.status, 'active'),
  ));
}

async function ownRequest(db, email) {
  if (!email) return null;
  const [row] = await db.select({
    status: portalAccessRequests.status,
    practiceName: portalAccessRequests.practiceName,
  }).from(portalAccessRequests)
    .where(eq(portalAccessRequests.email, email))
    .orderBy(desc(portalAccessRequests.createdAt))
    .limit(1);
  return row ? { status: row.status, practiceName: row.practiceName } : null;
}

export function createPracticeAuth({ db, clerk, work = () => [], log = console, now = Date.now }) {
  if (!db) throw new Error('createPracticeAuth: db is required');
  if (!clerk?.authenticate || !clerk?.getUser) throw new Error('createPracticeAuth: a Clerk adapter is required');

  async function requirePracticeMember(req, res, next) {
    if (!bearer(req)) return deny(res, 'signed_out');
    let auth;
    try {
      auth = await clerk.authenticate(req);
    } catch (error) {
      log.error?.(`[portal] Clerk session check failed: ${error.message}`);
      return deny(res, 'sign_in_unavailable');
    }
    if (!auth?.userId) return deny(res, 'signed_out');
    const exp = auth.sessionClaims?.exp;
    if (typeof exp === 'number' && exp * 1000 <= now()) return deny(res, 'session_expired');

    let members;
    try {
      members = await linkInvited(db, clerk, auth.userId, log);
    } catch (error) {
      log.error?.(`[portal] practice member lookup failed: ${error.message}`);
      return deny(res, 'sign_in_unavailable');
    }
    if (!members.length) {
      let request = null;
      try {
        const primary = primaryEmailOf(await clerk.getUser(auth.userId));
        request = await ownRequest(db, primary.verified ? primary.email : null);
      } catch (error) {
        log.warn?.(`[portal] could not read a join request: ${error.message}`);
      }
      return res.status(403).json({
        ok: false,
        code: 'not_a_member',
        error: 'This sign-in is not on a practice team. Ask the lab, or join.',
        request,
      });
    }

    const open = [];
    for (const member of members) {
      const settings = await readPortalSettings(db, member.organisationId);
      if (settings.enabled) open.push(member);
    }
    if (!open.length) return deny(res, 'portal_off');
    const asked = typeof req.query.practice === 'string' ? req.query.practice : '';
    const member = open.find((row) => row.contactId === asked) ?? open[0];
    req.practiceMember = member;
    req.practiceMembers = open;
    req.clerkAuth = auth;
    req.portal = portalScope(db, {
      organisationId: member.organisationId,
      contactId: member.contactId,
      actor: member,
      work,
      log,
    });
    return next();
  }

  return { requirePracticeMember };
}
