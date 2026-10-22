import { can } from './permissions.js';
import { displayNameOf, googleWorkspaceOwner, primaryEmailOf, secondFactorVerified } from './clerk.js';
import { fillPersonName, findPersonByClerkId, findPersonByEmail, linkPerson, recordPendingPerson } from './people.js';
import { DEFAULT_OWNER_MFA_MAX_AGE_MINUTES, isPlainEmail } from './settings.js';

// Checks the Clerk session on every person request, then maps the Clerk user
// to a Flow person by verified email. Clerk proves who someone is; the
// `people` table decides whether they get in and what they may do. A Clerk
// account with no Flow person gets no access.

const DENIALS = {
  signed_out: [401, 'Sign in to Flow.'],
  session_expired: [401, 'Your sign-in has expired. Sign in again.'],
  email_unverified: [403, 'Flow links your sign-in by your verified email address. Verify your primary email, then sign in again.'],
  email_not_plain: [403, 'Flow only accepts plain (ASCII) email addresses.'],
  email_linked_elsewhere: [403, 'That email address is already linked to a different sign-in. Ask a Flow owner.'],
  not_invited: [403, 'This installation is invitation only. Ask a Flow owner to invite you.'],
  access_pending: [403, "You're signed in, but a Flow owner still needs to approve your access."],
  access_disabled: [403, 'Your Flow access has been turned off. Ask a Flow owner if this is a mistake.'],
  role_required: [403, 'Your Flow role does not allow this.'],
  permission_required: [403, 'You do not have permission to do this.'],
  owner_required: [403, 'Only a Flow owner can do this.'],
  owner_verification_required: [403, null],
  sign_in_unavailable: [503, 'Sign-in is unavailable right now. Try again shortly.'],
};

export function deny(res, code, error) {
  const [status, message] = DENIALS[code] ?? DENIALS.signed_out;
  return res.status(status).json({ ok: false, code, error: error ?? message });
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

export function ownerVerificationMessage({ ownerGoogleDomains, ownerMfaMaxAgeMinutes }) {
  const ways = [];
  if (ownerGoogleDomains.length) {
    ways.push(`sign in with Google using your work account (${ownerGoogleDomains.map((domain) => `@${domain}`).join(' or ')}), with no password set on your sign-in`);
  }
  ways.push(`sign in with a second factor (it counts for ${ownerMfaMaxAgeMinutes} minutes)`);
  return `Owner actions need a verified owner sign-in. Sign out, then ${ways.join(', or ')}.`;
}

export function createPersonAuth({
  db,
  clerk,
  publicSignUp = false,
  signUpDomains = [],
  ownerGoogleDomains = [],
  ownerMfaMaxAgeMinutes = DEFAULT_OWNER_MFA_MAX_AGE_MINUTES,
  log = console,
  now = Date.now,
  clerkUserCacheMs = 60 * 1000,
}) {
  if (!db) throw new Error('createPersonAuth: db is required');
  if (!clerk?.authenticate || !clerk?.getUser) throw new Error('createPersonAuth: a Clerk adapter is required');
  const ownerMessage = ownerVerificationMessage({ ownerGoogleDomains, ownerMfaMaxAgeMinutes });
  // Clerk users fetched for the owner check, cached briefly so a burst of
  // owner requests costs one Clerk call. Failures are never cached.
  const clerkUsers = new Map();

  // Clerk users already checked for a name in this run, so a person whose
  // sign-in has no name costs one Clerk call, not one per request.
  const nameChecked = new Set();

  // The person, with their Clerk name filled in when Flow has none. Never
  // stops a sign-in: a Clerk error keeps the person as they are.
  async function withName(person, clerkUser = null) {
    if (person.name?.trim() || nameChecked.has(person.clerkUserId)) return person;
    if (nameChecked.size > 1000) nameChecked.clear();
    nameChecked.add(person.clerkUserId);
    try {
      const name = displayNameOf(clerkUser ?? await cachedClerkUser(person.clerkUserId));
      return (name && await fillPersonName(db, { id: person.id, name })) || person;
    } catch (error) {
      log.warn?.(`[auth] could not read the name of Flow person ${person.id}: ${error.message}`);
      return person;
    }
  }

  // { person } or { denial }.
  async function personFor(clerkUserId) {
    const linked = await findPersonByClerkId(db, clerkUserId);
    if (linked) return { person: await withName(linked) };

    const clerkUser = await clerk.getUser(clerkUserId);
    const { email, verified } = primaryEmailOf(clerkUser);
    if (!email || !verified) return { denial: 'email_unverified' };
    if (!isPlainEmail(email)) return { denial: 'email_not_plain' };

    const invited = await findPersonByEmail(db, email);
    if (invited) {
      if (invited.clerkUserId) return { denial: 'email_linked_elsewhere' };
      const person = await linkPerson(db, { id: invited.id, clerkUserId });
      if (person) {
        log.info?.(`[auth] linked Clerk user ${clerkUserId} to Flow person ${person.id} (${person.role})`);
        return { person: await withName(person, clerkUser) };
      }
      const again = await findPersonByClerkId(db, clerkUserId);
      return again ? { person: again } : { denial: 'email_linked_elsewhere' };
    }

    // Someone Flow does not know. Unless public sign-up is on or their
    // email's domain may sign up, Flow records nothing about them: they
    // simply have no access.
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!publicSignUp && !signUpDomains.includes(domain)) {
      log.warn?.(`[auth] Clerk user ${clerkUserId} refused: not invited`);
      return { denial: 'not_invited' };
    }
    const person = await recordPendingPerson(db, { email, name: displayNameOf(clerkUser), clerkUserId });
    if (!person) return { denial: 'access_pending' };
    log.info?.(`[auth] Clerk user ${clerkUserId} asked for access; pending Flow person ${person.id}`);
    return { person };
  }

  // Every person route starts here. The session token must be in the
  // Authorization header; Clerk verifies it, and Flow checks its expiry too.
  async function requireSession(req, res, next) {
    if (!bearerToken(req)) return deny(res, 'signed_out');
    let auth;
    try {
      auth = await clerk.authenticate(req);
    } catch (error) {
      log.error?.(`[auth] Clerk session check failed: ${error.message}`);
      return deny(res, 'sign_in_unavailable');
    }
    if (!auth?.userId) return deny(res, 'signed_out');
    const exp = auth.sessionClaims?.exp;
    if (typeof exp === 'number' && exp * 1000 <= now()) return deny(res, 'session_expired');

    let resolved;
    try {
      resolved = await personFor(auth.userId);
    } catch (error) {
      log.error?.(`[auth] Flow person lookup failed: ${error.message}`);
      return deny(res, 'sign_in_unavailable');
    }
    if (resolved.denial) return deny(res, resolved.denial);
    if (resolved.person.status === 'pending') return deny(res, 'access_pending');
    if (resolved.person.status !== 'active') return deny(res, 'access_disabled');
    req.person = resolved.person;
    req.clerkAuth = auth;
    return next();
  }

  function requireRole(...roles) {
    return (req, res, next) => (roles.includes(req.person?.role) ? next() : deny(res, 'role_required'));
  }

  // The same list the Settings page edits (server/auth/permissions.js). A
  // database error fails closed.
  function requirePermission(key) {
    return async (req, res, next) => {
      try {
        if (await can(db, req.person, key)) return next();
        return deny(res, 'permission_required');
      } catch (error) {
        log.error?.(`[auth] permission check failed: ${error.message}`);
        return deny(res, 'sign_in_unavailable');
      }
    };
  }

  async function cachedClerkUser(clerkUserId) {
    const cached = clerkUsers.get(clerkUserId);
    if (cached && cached.expiresAt > now()) return cached.user;
    const user = await clerk.getUser(clerkUserId);
    if (clerkUsers.size > 100) clerkUsers.clear();
    clerkUsers.set(clerkUserId, { user, expiresAt: now() + clerkUserCacheMs });
    return user;
  }

  // Is this owner's sign-in strong enough for owner actions?
  //   (a) the session passed a second factor within ownerMfaMaxAgeMinutes
  //       (an installation with its own Clerk application and MFA on), or
  //   (b) Google Workspace sign-in on an allowed domain with no password
  //       (Replit's managed Clerk, which has no MFA).
  // A Clerk error fails closed. Returns { verified, by } or { unavailable }.
  async function ownerVerification(person, auth) {
    if (secondFactorVerified(auth, ownerMfaMaxAgeMinutes)) return { verified: true, by: 'second_factor' };
    if (!ownerGoogleDomains.length) return { verified: false, by: null };
    try {
      const clerkUser = await cachedClerkUser(auth.userId);
      return googleWorkspaceOwner(clerkUser, person.email, ownerGoogleDomains)
        ? { verified: true, by: 'google_workspace' }
        : { verified: false, by: null };
    } catch (error) {
      log.error?.(`[auth] owner sign-in check failed: ${error.message}`);
      return { unavailable: true };
    }
  }

  // The verified-sign-in half of an owner action: a second factor, or Google
  // Workspace on the owner domain with no password. Use after requireSession.
  async function requireVerified(req, res, next) {
    const check = await ownerVerification(req.person, req.clerkAuth);
    if (check.unavailable) return deny(res, 'sign_in_unavailable');
    if (!check.verified) return deny(res, 'owner_verification_required', ownerMessage);
    return next();
  }

  // Owner-only routes: managing people, and settings that stay with the owner.
  // Use after requireSession. The role check is here; the sign-in check is
  // requireVerified, so Connect can keep the sign-in check without the role.
  async function requireOwner(req, res, next) {
    if (req.person?.role !== 'owner') return deny(res, 'owner_required');
    return requireVerified(req, res, next);
  }

  return { requireSession, requireRole, requirePermission, requireOwner, requireVerified, ownerVerification };
}
