import { Readable } from 'node:stream';
import { normaliseEmail } from './people.js';

// Everything Flow asks of Clerk goes through one small adapter, so tests pass
// a fake with the same members and never need keys or the network:
//
//   authenticate(req)        the verified session on this request, or null
//   getUser(clerkUserId)     the Clerk user (emails, external accounts)
//   findUserIdByEmail(email) the Clerk user with this email, or null
//   createUser({ email })    a Clerk account with no password, for an invitee
//   deleteUser(clerkUserId)  removes a Clerk account (an unused invitee's only)
//   inviteByEmail({ email, redirectUrl })
//                            Clerk emails an invitation link to `email`
//
// The real one is loaded only when FLOW_AUTH=clerk.
export async function loadClerkAdapter({ secretKey, publishableKey, proxyUrl, authorizedParties = [] }) {
  const { createClerkClient } = await import('@clerk/backend');
  // No SDK telemetry: Flow sends Clerk only what sign-in needs.
  const client = createClerkClient({ secretKey, publishableKey, ...(proxyUrl ? { proxyUrl } : {}), telemetry: { disabled: true } });
  return {
    async authenticate(req) {
      // Only the Authorization header is read. Flow never accepts the session
      // cookie, so another site cannot make a browser act with it.
      const headers = new Headers();
      if (typeof req.headers.authorization === 'string') headers.set('authorization', req.headers.authorization);
      const request = new Request(`${req.protocol}://${req.get('host')}${req.originalUrl}`, { method: req.method, headers });
      const state = await client.authenticateRequest(request, {
        acceptsToken: 'session_token',
        ...(authorizedParties.length ? { authorizedParties } : {}),
      });
      return state.isAuthenticated ? state.toAuth() : null;
    },
    getUser: (clerkUserId) => client.users.getUser(clerkUserId),
    async findUserIdByEmail(email) {
      const { data } = await client.users.getUserList({ emailAddress: [email], limit: 1 });
      return data[0]?.id ?? null;
    },
    async createUser({ email }) {
      const user = await client.users.createUser({ emailAddress: [email], skipPasswordRequirement: true });
      return user.id;
    },
    async deleteUser(clerkUserId) {
      await client.users.deleteUser(clerkUserId);
    },
    // Clerk sends the email. Its link opens `redirectUrl` with a sign-up
    // ticket; a pending invitation for the same address is replaced.
    async inviteByEmail({ email, redirectUrl }) {
      await client.invitations.createInvitation({ emailAddress: email, redirectUrl, notify: true, ignoreExisting: true });
    },
  };
}

// A Clerk account nobody has used: never signed in, no password and no
// connected account. Flow made it for an invitee (ensureClerkAccount).
export function unusedClerkAccount(clerkUser) {
  return Boolean(clerkUser)
    && !clerkUser.lastSignInAt
    && clerkUser.passwordEnabled === false
    && !(Array.isArray(clerkUser.externalAccounts) && clerkUser.externalAccounts.length);
}

// Has Clerk email an invitation to `email`. Clerk does not invite an address
// that already has an account, so an unused account Flow made earlier is
// removed first; the invitee's account is made when they take up the
// invitation. An address with a used account gets no email: that person can
// already sign in. Returns { emailed }.
export async function sendClerkInvitation(clerk, email, redirectUrl) {
  const existing = await clerk.findUserIdByEmail(email);
  if (existing) {
    if (!unusedClerkAccount(await clerk.getUser(existing))) return { emailed: false };
    await clerk.deleteUser(existing);
  }
  await clerk.inviteByEmail({ email, redirectUrl });
  return { emailed: true };
}

// An invitee needs a Clerk account before their first sign-in, because with
// public sign-up off Flow's sign-in page never creates one. The account has
// the invitee's email (verified, since the backend made it) and no password;
// their first Google sign-in on that address joins it.
export async function ensureClerkAccount(clerk, email) {
  const existing = await clerk.findUserIdByEmail(email);
  if (existing) return { clerkUserId: existing, created: false };
  return { clerkUserId: await clerk.createUser({ email }), created: true };
}

// The Clerk user's primary email and whether Clerk has verified it. Flow
// links people only by a verified primary address.
export function primaryEmailOf(clerkUser) {
  const addresses = Array.isArray(clerkUser?.emailAddresses) ? clerkUser.emailAddresses : [];
  const primary = addresses.find((address) => address?.id === clerkUser?.primaryEmailAddressId) ?? null;
  if (!primary) return { email: null, verified: false };
  return { email: normaliseEmail(primary.emailAddress), verified: primary.verification?.status === 'verified' };
}

export function displayNameOf(clerkUser) {
  const name = [clerkUser?.firstName, clerkUser?.lastName].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
  return name || null;
}

// Clerk's `fva` claim is [minutes since first factor, minutes since second
// factor]; the second is -1 when the session never passed a second factor.
export function secondFactorVerified(auth, maxAgeMinutes) {
  const fva = Array.isArray(auth?.factorVerificationAge) ? auth.factorVerificationAge
    : Array.isArray(auth?.sessionClaims?.fva) ? auth.sessionClaims.fva : null;
  const age = fva?.[1];
  return typeof age === 'number' && Number.isFinite(age) && age >= 0 && age <= maxAgeMinutes;
}

// The Google Workspace owner path. The Clerk user has a verified Google
// account whose email is the owner's Flow email, on an allowed domain, and
// no password, so Google (and the 2-Step Verification its Workspace
// enforces) is the only way into that account.
export function googleWorkspaceOwner(clerkUser, flowEmail, allowedDomains) {
  if (!clerkUser || !allowedDomains?.length) return false;
  if (clerkUser.passwordEnabled !== false) return false;
  const email = normaliseEmail(flowEmail);
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (!email.includes('@') || !allowedDomains.includes(domain)) return false;
  const accounts = Array.isArray(clerkUser.externalAccounts) ? clerkUser.externalAccounts : [];
  return accounts.some((account) => ['oauth_google', 'google'].includes(String(account?.provider).toLowerCase())
    && account?.verification?.status === 'verified'
    && normaliseEmail(account?.emailAddress) === email);
}

// The path part of CLERK_PROXY_URL with no trailing slash, or null.
export function resolveClerkProxyPath(proxyUrl) {
  if (!proxyUrl) return null;
  let pathname;
  try {
    pathname = new URL(proxyUrl, 'http://flow.invalid').pathname;
  } catch {
    throw new Error('CLERK_PROXY_URL is not a valid URL or path');
  }
  return pathname.replace(/\/+$/, '') || null;
}

// Replit's managed Clerk publishes the app with CLERK_PROXY_URL, so the
// browser talks to Clerk's Frontend API through Flow's own origin. Clerk's
// SDK does the forwarding; this turns Express's request into a web Request
// and streams the answer back. Mount it before any body parser.
export function createClerkProxy({ proxyPath, publishableKey, secretKey, proxy }) {
  return async function clerkProxy(req, res, next) {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else headers.set(name, value);
      }
      // The client address as Express resolved it, so a client cannot hand
      // Clerk a forged X-Forwarded-For.
      headers.delete('x-forwarded-for');
      if (req.ip) headers.set('x-forwarded-for', req.ip);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`${req.protocol}://${req.get('host')}${req.originalUrl}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const response = await proxy(request, { proxyPath, publishableKey, secretKey });
      res.status(response.status);
      for (const [name, value] of response.headers) {
        if (name !== 'set-cookie') res.setHeader(name, value);
      }
      const cookies = response.headers.getSetCookie?.() ?? [];
      if (cookies.length) res.setHeader('set-cookie', cookies);
      if (!response.body || req.method === 'HEAD') return res.end();
      Readable.fromWeb(response.body).on('error', next).pipe(res);
    } catch (error) {
      next(error);
    }
  };
}
