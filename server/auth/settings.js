// Sign-in settings, read from the environment once at boot. Errors name the
// variable, never its value: CLERK_SECRET_KEY must never reach a log.

export const DEFAULT_OWNER_MFA_MAX_AGE_MINUTES = 12 * 60;

function readEnv(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

// FLOW_AUTH: "clerk" signs people in with Clerk. Unset: sign-in is off and
// every person route answers 503, so Flow never runs open. Any other value
// stops boot, so a typo cannot quietly turn sign-in off.
export function resolveAuthMode(env = process.env) {
  const raw = readEnv(env, 'FLOW_AUTH').toLowerCase();
  if (raw === '') return 'off';
  if (raw === 'clerk') return 'clerk';
  throw new Error('FLOW_AUTH must be "clerk" or unset');
}

// Replit's Clerk integration sets CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY
// (some templates name the second VITE_CLERK_PUBLISHABLE_KEY; either works).
// CLERK_PROXY_URL is set on a published Replit app.
export function resolveClerkKeys(env = process.env) {
  const secretKey = readEnv(env, 'CLERK_SECRET_KEY');
  const publishableSource = readEnv(env, 'CLERK_PUBLISHABLE_KEY') ? 'CLERK_PUBLISHABLE_KEY'
    : readEnv(env, 'VITE_CLERK_PUBLISHABLE_KEY') ? 'VITE_CLERK_PUBLISHABLE_KEY' : null;
  const publishableKey = publishableSource ? readEnv(env, publishableSource) : '';
  const missing = [];
  if (!secretKey) missing.push('CLERK_SECRET_KEY');
  if (!publishableKey) missing.push('CLERK_PUBLISHABLE_KEY');
  if (missing.length) {
    throw new Error(`FLOW_AUTH=clerk needs ${missing.join(' and ')} (Replit: Tools > Users & Auth sets them)`);
  }
  if (!/^sk_(test|live)_\S+$/.test(secretKey)) {
    throw new Error('CLERK_SECRET_KEY is not a Clerk secret key (expected sk_test_... or sk_live_...)');
  }
  if (!/^pk_(test|live)_\S+$/.test(publishableKey)) {
    throw new Error(`${publishableSource} is not a Clerk publishable key (expected pk_test_... or pk_live_...)`);
  }
  return { secretKey, publishableKey, publishableSource, proxyUrl: readEnv(env, 'CLERK_PROXY_URL') || null };
}

// FLOW_PUBLIC_SIGN_UP: "on" lets anyone with a verified email ask for access
// (they wait as `pending` until an owner approves them). Unset or "off": only
// people an owner invited get in, and Flow's sign-in page creates no account.
export function resolvePublicSignUp(env = process.env) {
  const raw = readEnv(env, 'FLOW_PUBLIC_SIGN_UP').toLowerCase();
  if (raw === '' || raw === 'off') return false;
  if (raw === 'on') return true;
  throw new Error('FLOW_PUBLIC_SIGN_UP must be "on", "off" or unset');
}

// FLOW_OWNER_MFA_MAX_AGE: how long a Clerk second factor counts for owner
// actions. Minutes, or with an m/h suffix ("90m", "12h"). Default 12h.
export function parseOwnerMfaMaxAge(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return DEFAULT_OWNER_MFA_MAX_AGE_MINUTES;
  const match = /^(\d+)\s*(m|h)?$/.exec(value);
  const minutes = match ? Number(match[1]) * (match[2] === 'h' ? 60 : 1) : NaN;
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw new Error('FLOW_OWNER_MFA_MAX_AGE must be a positive number of minutes, or hours with "h" (e.g. 12h)');
  }
  return minutes;
}

// FLOW_OWNER_GOOGLE_DOMAINS: comma-separated email domains whose Google
// Workspace sign-in counts as an owner's verified sign-in (that Workspace
// enforces 2-Step Verification). No default: unset turns that path off.
export function parseOwnerGoogleDomains(raw) {
  const domains = String(raw ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  for (const domain of domains) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      throw new Error('FLOW_OWNER_GOOGLE_DOMAINS must be a comma-separated list of email domains (e.g. example.com)');
    }
  }
  return [...new Set(domains)];
}

// FLOW_PUBLIC_ORIGIN: the published app's origin. Clerk then accepts only
// session tokens minted for it. Unset: Clerk's default.
export function resolveAuthorizedParties(env = process.env) {
  const raw = readEnv(env, 'FLOW_PUBLIC_ORIGIN');
  if (!raw) return [];
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('FLOW_PUBLIC_ORIGIN must be an absolute URL (e.g. https://flow.example.com)');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('FLOW_PUBLIC_ORIGIN must be an http(s) URL');
  }
  return [url.origin];
}

// FLOW_FIRST_OWNER_EMAIL: while the installation has no owner, Flow invites
// this address as its owner at boot. Ignored once an owner exists.
export function resolveFirstOwnerEmail(env = process.env) {
  const email = readEnv(env, 'FLOW_FIRST_OWNER_EMAIL').toLowerCase();
  if (!email) return null;
  if (!isPlainEmail(email)) throw new Error('FLOW_FIRST_OWNER_EMAIL must be a plain (ASCII) email address');
  return email;
}

// Flow emails are plain ASCII, so a look-alike character cannot pose as
// someone else's address.
export function isPlainEmail(email) {
  return typeof email === 'string' && /^[\x21-\x3f\x41-\x7e]+@[a-z0-9.-]+\.[a-z0-9-]+$/i.test(email);
}

export function resolveSignInSettings(env = process.env) {
  const mode = resolveAuthMode(env);
  if (mode === 'off') return { mode };
  return {
    mode,
    keys: resolveClerkKeys(env),
    publicSignUp: resolvePublicSignUp(env),
    ownerMfaMaxAgeMinutes: parseOwnerMfaMaxAge(readEnv(env, 'FLOW_OWNER_MFA_MAX_AGE')),
    ownerGoogleDomains: parseOwnerGoogleDomains(readEnv(env, 'FLOW_OWNER_GOOGLE_DOMAINS')),
    authorizedParties: resolveAuthorizedParties(env),
    firstOwnerEmail: resolveFirstOwnerEmail(env),
  };
}
