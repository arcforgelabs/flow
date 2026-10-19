import { randomBytes } from 'node:crypto';
import { DEFAULT_TIMEOUT_MS, xeroError } from './client.js';

// Xero OAuth 2.0 (authorisation code with offline_access). Bodies that carry
// tokens never reach a log or an error message.

export const STATE_TTL_MS = 10 * 60 * 1000;

export function authorizeUrl(settings, state) {
  const url = new URL(settings.endpoints.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('redirect_uri', settings.redirectUri);
  url.searchParams.set('scope', settings.scope);
  url.searchParams.set('state', state);
  return url.toString();
}

async function call(fetchImpl, url, init, what) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error?.code === 'xero_replay_no_match') throw error;
      throw xeroError('xero_unreachable', `Flow could not reach Xero for ${what}.`, { status: 503 });
    }
    const text = await response.text().catch(() => '');
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function tokenRequest(settings, fetchImpl, form, what) {
  const basic = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64');
  const { response, body } = await call(fetchImpl, settings.endpoints.token, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  }, what);
  if (!response.ok) {
    // invalid_grant: the refresh token was revoked, expired (60 days unused)
    // or already used. Only a new connection fixes that.
    if (body?.error === 'invalid_grant') {
      throw xeroError('xero_reconnect_needed', 'Xero no longer accepts this connection. An owner must connect Xero again.', { status: 409 });
    }
    throw xeroError('xero_token_failed', `Xero refused ${what} (${response.status}${body?.error ? `, ${body.error}` : ''}).`, {
      status: 502,
      oauthError: typeof body?.error === 'string' ? body.error.slice(0, 40) : null,
    });
  }
  if (!body?.access_token || !body?.refresh_token) {
    throw xeroError('xero_token_failed', `Xero's answer to ${what} had no tokens.`, { status: 502 });
  }
  return body;
}

export function exchangeCode(settings, fetchImpl, code) {
  if (!code) throw xeroError('xero_oauth_failed', 'Xero sent no authorisation code.', { status: 400 });
  return tokenRequest(settings, fetchImpl, { grant_type: 'authorization_code', code, redirect_uri: settings.redirectUri }, 'the authorisation code');
}

export function refreshTokens(settings, fetchImpl, refreshToken) {
  return tokenRequest(settings, fetchImpl, { grant_type: 'refresh_token', refresh_token: refreshToken }, 'the token refresh');
}

// Best effort: a disconnect deletes Flow's copy even when Xero is down.
export async function revokeToken(settings, fetchImpl, refreshToken) {
  const basic = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64');
  const { response } = await call(fetchImpl, settings.endpoints.revoke, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }).toString(),
  }, 'revoking the token');
  return response.ok;
}

export async function fetchConnections(settings, fetchImpl, accessToken) {
  const { response, body } = await call(fetchImpl, settings.endpoints.connections, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  }, 'the organisation list');
  if (!response.ok || !Array.isArray(body)) {
    throw xeroError('xero_oauth_failed', `Xero did not list the authorised organisations (${response.status}).`, { status: 502 });
  }
  return body;
}

const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

// The one Xero organisation this connection is for. XERO_TENANT_ID and
// XERO_TENANT_NAME narrow the choice; more than one left is refused.
export function selectConnection(connections, settings) {
  let matches = connections.filter((c) => (c.tenantType ?? 'ORGANISATION') === 'ORGANISATION');
  if (settings.tenantId) matches = matches.filter((c) => c.tenantId === settings.tenantId);
  if (settings.tenantName) matches = matches.filter((c) => sameName(c.tenantName, settings.tenantName));
  const names = connections.map((c) => c.tenantName).filter(Boolean);
  if (!matches.length) {
    const wanted = settings.tenantId || settings.tenantName;
    throw xeroError('xero_wrong_organisation',
      wanted
        ? `The Xero organisation this installation is set to (XERO_TENANT_ID or XERO_TENANT_NAME) was not among the ones approved: ${names.join(', ') || 'none'}.`
        : 'No Xero organisation was approved.',
      { status: 409 });
  }
  if (matches.length > 1) {
    throw xeroError('xero_ambiguous_organisation',
      `More than one Xero organisation was approved (${names.join(', ')}). Set XERO_TENANT_ID or XERO_TENANT_NAME, or approve only one.`,
      { status: 409 });
  }
  return matches[0];
}

// One-use OAuth states, kept in memory for ten minutes. One Flow process
// serves one lab, and an owner finishes the Xero approval in the same
// browser within minutes.
export function createStateStore({ now = Date.now, ttlMs = STATE_TTL_MS } = {}) {
  const states = new Map();
  const purge = () => {
    for (const [state, entry] of states) if (now() - entry.createdAt > ttlMs) states.delete(state);
  };
  return {
    issue(entry) {
      purge();
      const state = randomBytes(24).toString('base64url');
      states.set(state, { ...entry, createdAt: now() });
      return state;
    },
    consume(state) {
      purge();
      if (typeof state !== 'string' || !states.has(state)) return null;
      const entry = states.get(state);
      states.delete(state);
      return entry;
    },
  };
}
