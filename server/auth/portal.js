import { findPersonByClerkId, findPersonByEmail } from './people.js';
import { primaryEmailOf } from './clerk.js';
import { organisations } from '../db/schema.js';
import { deny } from './session.js';
import { linkInvitedMembers, membersForClerk } from '../portal/members.js';
import { openRequestForEmail } from '../portal/requests.js';
import { readPortalSettings } from '../portal/settings.js';
import { PORTAL_IDLE_MS, touchPortalSession } from '../portal/sessions.js';

// Practice routes. Clerk proves who someone is. An active practice_members
// row decides which practices they may see. A lab person (a `people` row)
// is refused here; a practice member is refused on staff routes because
// they have no `people` row.

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

export async function labOrganisation(db) {
  const [org] = await db.select().from(organisations).orderBy(organisations.createdAt).limit(1);
  return org ?? null;
}

export function createPortalAuth({
  db,
  clerk,
  log = console,
  now = Date.now,
  idleMs = PORTAL_IDLE_MS,
}) {
  if (!db) throw new Error('createPortalAuth: db is required');
  if (!clerk?.authenticate || !clerk?.getUser) throw new Error('createPortalAuth: a Clerk adapter is required');

  async function requirePracticeMember(req, res, next) {
    if (!bearerToken(req)) return deny(res, 'signed_out');
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

    let person;
    try {
      person = await findPersonByClerkId(db, auth.userId);
    } catch (error) {
      log.error?.(`[portal] person lookup failed: ${error.message}`);
      return deny(res, 'sign_in_unavailable');
    }
    if (person) return deny(res, 'staff_session');

    let clerkUser;
    try {
      clerkUser = await clerk.getUser(auth.userId);
    } catch (error) {
      log.error?.(`[portal] Clerk user read failed: ${error.message}`);
      return deny(res, 'sign_in_unavailable');
    }
    const { email, verified } = primaryEmailOf(clerkUser);
    if (!email || !verified) return deny(res, 'email_unverified');
    const staffByEmail = await findPersonByEmail(db, email);
    if (staffByEmail) return deny(res, 'staff_session');

    let members = await membersForClerk(db, auth.userId);
    if (!members.length) members = await linkInvitedMembers(db, { email, clerkUserId: auth.userId });
    if (!members.length) {
      const waiting = await openRequestForEmail(db, email);
      if (waiting) return deny(res, 'access_pending', 'Waiting for the lab.');
      return deny(res, 'not_invited', 'This practice portal is invitation only. Ask the lab, or join.');
    }

    const organisationId = members[0].organisationId;
    const settings = await readPortalSettings(db, organisationId);
    if (!settings.enabled) return deny(res, 'portal_off');

    const asked = typeof req.query.practice === 'string' ? req.query.practice : null;
    const contactIds = [...new Set(members.map((member) => member.contactId))];
    if (asked && !contactIds.includes(asked)) return deny(res, 'practice_required');
    const contactId = asked && contactIds.includes(asked) ? asked : contactIds[0];
    const member = members.find((row) => row.contactId === contactId) ?? members[0];

    const sessionId = auth.sessionId || auth.sessionClaims?.sid || `${auth.userId}:${auth.sessionClaims?.iat ?? 'session'}`;
    const issuedAtMs = typeof auth.sessionClaims?.iat === 'number' ? auth.sessionClaims.iat * 1000 : 0;
    let gate;
    try {
      gate = await touchPortalSession(db, {
        sessionId,
        organisationId,
        memberId: member.id,
        issuedAtMs,
        revokedAt: member.sessionsRevokedAt,
        now: now(),
        idleMs,
      });
    } catch (error) {
      log.error?.(`[portal] session check failed: ${error.message}`);
      return deny(res, 'sign_in_unavailable');
    }
    if (gate.revoked) return deny(res, 'session_revoked');
    if (gate.idle) return deny(res, 'session_expired', 'Your session ended after 12 hours idle. Sign in again.');

    req.portal = {
      organisationId,
      contactId,
      contactIds,
      member,
      members,
      sessionId,
    };
    req.clerkAuth = auth;
    return next();
  }

  function requireTeamManager(req, res, next) {
    const role = req.portal?.member?.role;
    if (role === 'owner' || role === 'admin') return next();
    return deny(res, 'role_required');
  }

  return { requirePracticeMember, requireTeamManager, labOrganisation: () => labOrganisation(db) };
}
