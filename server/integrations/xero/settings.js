// Xero adapter settings, read from the environment once at boot. Errors name
// the variable, never its value: XERO_CLIENT_SECRET and XERO_TOKEN_KEY must
// never reach a log.
//
// XERO_MODE turns the adapter on and says which Xero it acts on (issue #10).
// It has no default: unset, the adapter is off.
//   live     the lab's own Xero organisation. Draft invoices are written only
//            when XERO_ALLOW_LIVE_WRITES=on as well.
//   sandbox  a Xero Demo Company. Flow refuses any organisation whose class
//            is not DEMO, so a sandbox can never write to a real ledger.
//   replay   no network: recorded, synthetic Xero responses
//            (server/integrations/xero/fixtures). Development and CI.

export const XERO_MODES = Object.freeze(['live', 'sandbox', 'replay']);

// Xero's own public endpoints. They are the same for every installation.
export const XERO_ENDPOINTS = Object.freeze({
  api: 'https://api.xero.com/api.xro/2.0',
  authorize: 'https://login.xero.com/identity/connect/authorize',
  token: 'https://identity.xero.com/connect/token',
  revoke: 'https://identity.xero.com/connect/revocation',
  connections: 'https://api.xero.com/connections',
  // Deep links into the Xero web app, for a person to open a record.
  web: 'https://go.xero.com',
});

export const XERO_CALLBACK_PATH = '/api/xero/oauth/callback';
export const DEFAULT_XERO_SCOPE = 'offline_access accounting.contacts accounting.invoices accounting.settings.read';
export const DEFAULT_XERO_DAY_LIMIT = 1000;
export const DEFAULT_DUE_DAYS = 30;
export const DEFAULT_MIRROR_PAGE_SIZE = 200;
export const MAX_MIRROR_PAGE_SIZE = 1000;

function readEnv(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function readOnOff(env, name) {
  const raw = readEnv(env, name).toLowerCase();
  if (raw === '' || raw === 'off') return false;
  if (raw === 'on') return true;
  throw new Error(`${name} must be "on", "off" or unset`);
}

function readPositiveInteger(env, name, fallback) {
  const raw = readEnv(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number`);
  return value;
}

function readFraction(env, name, fallback) {
  const raw = readEnv(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${name} must be a number above 0 and at most 1`);
  return value;
}

// A 32-byte key as 64 hex characters or base64. Returns null, never the input.
export function decodeTokenKey(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    const key = Buffer.from(value, 'base64');
    if (key.length === 32) return key;
  }
  return null;
}

// The callback address Xero sends the owner back to. XERO_REDIRECT_URI wins;
// otherwise it is this installation's FLOW_PUBLIC_ORIGIN plus the callback
// path. It must match a redirect URI registered on the Xero app exactly.
export function resolveRedirectUri(env = process.env) {
  const explicit = readEnv(env, 'XERO_REDIRECT_URI');
  const origin = readEnv(env, 'FLOW_PUBLIC_ORIGIN');
  const raw = explicit || (origin ? `${origin.replace(/\/+$/, '')}${XERO_CALLBACK_PATH}` : '');
  if (!raw) return null;
  const name = explicit ? 'XERO_REDIRECT_URI' : 'FLOW_PUBLIC_ORIGIN';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${name} must be https (Xero accepts http only for localhost)`);
  }
  if (url.pathname !== XERO_CALLBACK_PATH || url.search || url.hash) {
    throw new Error(`XERO_REDIRECT_URI must end in ${XERO_CALLBACK_PATH}, with no query`);
  }
  return url.toString();
}

function resolveTaxTypes(env) {
  return {
    GST: readEnv(env, 'XERO_TAX_TYPE_GST') || 'OUTPUT',
    GST_FREE: readEnv(env, 'XERO_TAX_TYPE_GST_FREE') || 'EXEMPTOUTPUT',
  };
}

function resolveTracking(env) {
  const category = readEnv(env, 'XERO_TRACKING_CATEGORY');
  const option = readEnv(env, 'XERO_TRACKING_OPTION');
  if (!category && !option) return null;
  if (!category || !option) throw new Error('XERO_TRACKING_CATEGORY and XERO_TRACKING_OPTION are set together');
  return { category, option };
}

// null when the adapter is off. Otherwise the settings the adapter needs.
export function resolveXeroSettings(env = process.env) {
  const mode = readEnv(env, 'XERO_MODE').toLowerCase();
  if (!mode) return null;
  if (!XERO_MODES.includes(mode)) throw new Error('XERO_MODE must be "live", "sandbox", "replay" or unset');

  const clientId = readEnv(env, 'XERO_CLIENT_ID');
  const clientSecret = readEnv(env, 'XERO_CLIENT_SECRET');
  const tokenKey = decodeTokenKey(readEnv(env, 'XERO_TOKEN_KEY'));
  if (mode !== 'replay') {
    const missing = [];
    if (!clientId) missing.push('XERO_CLIENT_ID');
    if (!clientSecret) missing.push('XERO_CLIENT_SECRET');
    if (missing.length) throw new Error(`XERO_MODE=${mode} needs ${missing.join(' and ')} (from the Xero app)`);
  }
  if (readEnv(env, 'XERO_TOKEN_KEY') && !tokenKey) {
    throw new Error('XERO_TOKEN_KEY must be a 32-byte key, as 64 hex characters or base64');
  }
  if (mode !== 'replay' && !tokenKey) {
    throw new Error(`XERO_MODE=${mode} needs XERO_TOKEN_KEY (a 32-byte key that encrypts the Xero refresh token)`);
  }

  const tenantId = readEnv(env, 'XERO_TENANT_ID') || null;
  const tenantName = readEnv(env, 'XERO_TENANT_NAME') || null;
  // A live connection must name the organisation it is for, so an owner who
  // can see several Xero organisations cannot connect the wrong one.
  if (mode === 'live' && !tenantId && !tenantName) {
    throw new Error('XERO_MODE=live needs XERO_TENANT_ID or XERO_TENANT_NAME (the lab\'s Xero organisation)');
  }

  const invoiceNumber = (readEnv(env, 'XERO_INVOICE_NUMBER') || 'xero').toLowerCase();
  if (!['xero', 'flow'].includes(invoiceNumber)) throw new Error('XERO_INVOICE_NUMBER must be "xero", "flow" or unset');

  return {
    mode,
    clientId: clientId || (mode === 'replay' ? 'replay-client-id' : ''),
    clientSecret: clientSecret || (mode === 'replay' ? 'replay-client-secret' : ''),
    tokenKey,
    redirectUri: resolveRedirectUri(env),
    scope: readEnv(env, 'XERO_SCOPE') || DEFAULT_XERO_SCOPE,
    tenantId,
    tenantName,
    liveWrites: readOnOff(env, 'XERO_ALLOW_LIVE_WRITES'),
    dayLimit: readPositiveInteger(env, 'XERO_DAY_LIMIT', DEFAULT_XERO_DAY_LIMIT),
    usageWarningFraction: readFraction(env, 'XERO_USAGE_WARNING_FRACTION', 0.7),
    taxTypes: resolveTaxTypes(env),
    tracking: resolveTracking(env),
    defaultDueDays: readPositiveInteger(env, 'XERO_DEFAULT_DUE_DAYS', DEFAULT_DUE_DAYS),
    invoiceNumber,
    replayFixtures: readEnv(env, 'XERO_REPLAY_FIXTURES') || null,
    // Free text on Xero records (references, line descriptions) can name a
    // patient. Flow keeps it only when the lab turns this on (VISION.md).
    keepReference: readOnOff(env, 'XERO_KEEP_REFERENCE'),
    mirrorPageSize: Math.min(readPositiveInteger(env, 'XERO_MIRROR_PAGE_SIZE', DEFAULT_MIRROR_PAGE_SIZE), MAX_MIRROR_PAGE_SIZE),
    // The share of the day's calls the mirror leaves for drafts and people.
    mirrorReserveFraction: readFraction(env, 'XERO_MIRROR_RESERVE_FRACTION', 0.3),
    // The key Xero signs each webhook with (issue #45), from the Xero app's
    // Webhooks page. Unset, Flow answers no webhook and reads by polling only.
    webhookKey: readEnv(env, 'XERO_WEBHOOK_KEY') || null,
    endpoints: XERO_ENDPOINTS,
  };
}

// Whether this installation may write to Xero now. Reads always may.
export function writesAllowed(settings) {
  if (!settings) return false;
  return settings.mode !== 'live' || settings.liveWrites === true;
}
