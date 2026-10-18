import { eq } from 'drizzle-orm';
import express from 'express';
import { FlowError } from '../../core/errors.js';
import { organisations } from '../../db/schema.js';
import { lastSync, listContacts, listItems, syncCatalogue } from './catalogue.js';
import { createXeroClient } from './client.js';
import { decryptToken, deleteConnection, describeConnection, readConnection, saveConnection } from './connections.js';
import { authorizeUrl, exchangeCode, fetchConnections, revokeToken, selectConnection } from './oauth.js';
import { writesAllowed } from './settings.js';

// The Xero adapter's routes, mounted at /api/xero (server/integrations/port.js).
//
//   GET  /status?organisationId=   any signed-in person: mode and connection
//   POST /connect                  owner: returns Xero's approval address
//   GET  /oauth/callback           Xero sends the owner back here
//   POST /disconnect               owner: revokes and forgets the connection
//   POST /sync                     owner or admin: copies Xero contacts and items
//   GET  /contacts?organisationId=&q=   any signed-in person: the copy
//   GET  /items?organisationId=    any signed-in person: the copy
//
// Only an owner, with a verified owner sign-in, can connect or disconnect.
// The callback carries no Flow session: the one-use state from /connect,
// issued to that owner for that organisation, is what admits it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function page(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>`
    + `<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;
}

export function sendError(res, error, log) {
  const status = error instanceof FlowError ? (error.status ?? 400) : 500;
  if (status >= 500) log.error?.(`[xero] ${error.code ?? 'error'}: ${error.message}`);
  const body = { ok: false, code: error.code ?? 'xero_failed', error: status === 500 && !(error instanceof FlowError) ? 'Something went wrong talking to Xero.' : error.message };
  if (error.details !== undefined) body.details = error.details;
  if (error.retryAfterMs) res.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
  return res.status(status).json(body);
}

export async function requireOrganisation(db, raw) {
  const organisationId = typeof raw === 'string' ? raw.trim() : '';
  if (!UUID.test(organisationId)) throw new FlowError('invalid', 'organisationId must be a Flow organisation id');
  const [row] = await db.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, organisationId));
  if (!row) throw Object.assign(new FlowError('not_found', 'organisation not found'), { status: 404 });
  return organisationId;
}

// Wraps an async handler so a thrown error becomes a JSON answer.
export const handle = (log, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    sendError(res, error, log);
  }
};

export function createXeroRouter({ db, personAuth, runtime, log = console }) {
  const { settings } = runtime;
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // Sign-in off: nothing but the callback answers, and it fails for want of
  // a state.
  const signedIn = personAuth
    ? [personAuth.requireSession]
    : [(_req, res) => res.status(503).json({ ok: false, code: 'sign_in_not_configured', error: 'Sign-in is not configured on this installation (FLOW_AUTH is unset).' })];
  const owner = personAuth ? [...signedIn, personAuth.requireOwner] : signedIn;
  const manager = personAuth ? [...signedIn, personAuth.requireRole('owner', 'admin')] : signedIn;

  router.get('/status', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.query.organisationId);
    const connection = await readConnection(db, organisationId);
    res.json({
      ok: true,
      mode: settings.mode,
      writesAllowed: writesAllowed(settings),
      redirectUri: settings.redirectUri,
      connected: Boolean(connection && connection.mode === settings.mode),
      connection: describeConnection(connection),
      rateLimit: connection ? runtime.governor.status(connection.tenantId) : null,
      lastSync: await lastSync(db, organisationId),
    });
  }));

  router.post('/connect', ...owner, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    if (!settings.redirectUri) {
      throw Object.assign(new FlowError('xero_redirect_uri_missing', 'Set FLOW_PUBLIC_ORIGIN (or XERO_REDIRECT_URI) to this installation\'s address, and register its /api/xero/oauth/callback on the Xero app.'), { status: 503 });
    }
    const state = runtime.states.issue({ organisationId, personId: req.person.id });
    res.json({ ok: true, authorizeUrl: authorizeUrl(settings, state), redirectUri: settings.redirectUri, mode: settings.mode });
  }));

  router.get('/oauth/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const entry = runtime.states.consume(req.query.state);
    if (!entry) {
      return res.status(400).type('html').send(page('Xero was not connected', 'This approval link has expired or was already used. Start again from Flow.'));
    }
    if (req.query.error) {
      return res.status(400).type('html').send(page('Xero was not connected', 'The approval was cancelled in Xero. Start again from Flow if you meant to connect.'));
    }
    try {
      const tokens = await exchangeCode(settings, runtime.transport, typeof req.query.code === 'string' ? req.query.code : '');
      const connections = await fetchConnections(settings, runtime.transport, tokens.access_token);
      let chosen;
      try {
        chosen = selectConnection(connections, settings);
        const probe = createXeroClient({
          tenantId: chosen.tenantId,
          accessToken: async () => tokens.access_token,
          fetch: runtime.transport,
          governor: runtime.governor,
          apiBase: settings.endpoints.api,
          log,
        });
        await runtime.assertEnvironment(probe);
      } catch (error) {
        // Refused: Xero keeps no grant for an organisation Flow will not use.
        await revokeToken(settings, runtime.transport, tokens.refresh_token).catch(() => false);
        throw error;
      }
      const connection = await saveConnection(db, {
        organisationId: entry.organisationId,
        mode: settings.mode,
        tenantId: chosen.tenantId,
        tenantName: chosen.tenantName ?? null,
        scope: tokens.scope ?? settings.scope,
        refreshToken: tokens.refresh_token,
        connectedBy: entry.personId,
        key: settings.tokenKey,
      });
      runtime.remember(entry.organisationId, tokens);
      log.info?.(`[xero] organisation ${entry.organisationId} connected to Xero tenant ${connection.tenantId} (${settings.mode}) by person ${entry.personId}`);
      return res.type('html').send(page('Xero is connected', `Flow is connected to ${connection.tenantName || 'your Xero organisation'} (${settings.mode}). You can close this tab.`));
    } catch (error) {
      log.error?.(`[xero] connect failed: ${error.code ?? 'error'}: ${error.message}`);
      const message = error instanceof FlowError ? error.message : 'Something went wrong talking to Xero. Try again.';
      return res.status(error.status && error.status < 500 ? error.status : 502).type('html').send(page('Xero was not connected', message));
    }
  });

  router.post('/disconnect', ...owner, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const connection = await readConnection(db, organisationId);
    if (!connection) return res.json({ ok: true, disconnected: false });
    let revoked = false;
    try {
      revoked = await revokeToken(settings, runtime.transport, decryptToken(connection.refreshTokenEnc, settings.tokenKey, organisationId));
    } catch (error) {
      log.warn?.(`[xero] could not revoke the Xero token for organisation ${organisationId}: ${error.code ?? 'error'}`);
    }
    await deleteConnection(db, organisationId);
    runtime.forget(organisationId);
    log.info?.(`[xero] organisation ${organisationId} disconnected from Xero by person ${req.person.id}`);
    return res.json({ ok: true, disconnected: true, revoked });
  }));

  router.post('/sync', ...manager, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const run = await syncCatalogue(db, runtime, organisationId, { startedBy: req.person.id });
    res.json({ ok: true, sync: run });
  }));

  router.get('/contacts', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.query.organisationId);
    res.json({ ok: true, contacts: await listContacts(db, organisationId, { q: typeof req.query.q === 'string' ? req.query.q : '' }) });
  }));

  router.get('/items', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.query.organisationId);
    res.json({ ok: true, items: await listItems(db, organisationId) });
  }));

  return router;
}
