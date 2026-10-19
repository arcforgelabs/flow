import { and, eq } from 'drizzle-orm';
import express from 'express';
import { FlowError } from '../../core/errors.js';
import { billingObligations, organisations } from '../../db/schema.js';
import { lastSync, listContacts, listItems, syncCatalogue } from './catalogue.js';
import { createXeroClient } from './client.js';
import { describePush, listPushes, MAX_BATCH, previewDrafts, pushDrafts } from './drafts.js';
import { recordXeroEvidence, recordXeroPayments } from './ledger.js';
import { MIRROR_RESOURCES, mirrorStatus, mirrorXero } from './mirror.js';
import { decryptToken, deleteConnection, describeConnection, readConnection, saveConnection } from './connections.js';
import { authorizeUrl, exchangeCode, fetchConnections, revokeToken, selectConnection } from './oauth.js';
import { writesAllowed } from './settings.js';
import { DEFAULT_FAMILY } from '../../theme/themes.js';
import { messagePage as themedMessagePage } from '../../ui/page.js';

// The Xero adapter's routes, mounted at /api/xero (server/integrations/port.js).
//
//   GET  /status?organisationId=   any signed-in person: mode and connection
//   POST /connect                  owner: returns Xero's approval address
//   GET  /oauth/callback           Xero sends the owner back here
//   POST /disconnect               owner: revokes and forgets the connection
//   POST /sync                     owner or admin: copies Xero contacts and items
//   GET  /contacts?organisationId=&q=   any signed-in person: the copy
//   GET  /items?organisationId=    any signed-in person: the copy
//   POST /invoices/preview         any signed-in person: the Xero drafts Flow
//                                  would make, and what stops them (no Xero calls)
//   POST /invoices/push            owner or admin: issued invoices to Xero drafts
//   GET  /invoices/:invoiceId/pushes?organisationId=   any signed-in person
//   POST /obligations/:obligationId/check   owner or admin: Xero's invoice for
//                                  a billable job, recorded on the ledger
//   POST /payments/sync            owner or admin: Xero payments to the ledger
//   POST /mirror                   owner or admin: copies Xero invoices, credit
//                                  notes and payments changed since the last copy
//   GET  /mirror?organisationId=   any signed-in person: what the copy holds
//
// Only an owner, with a verified owner sign-in, can connect or disconnect.
// The callback carries no Flow session: the one-use state from /connect,
// issued to that owner for that organisation, is what admits it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export function sendError(res, error, log) {
  const status = error instanceof FlowError ? (error.status ?? 400) : 500;
  if (status >= 500) log.error?.(`[xero] ${error.code ?? 'error'}: ${error.message}`);
  const body = { ok: false, code: error.code ?? 'xero_failed', error: status === 500 && !(error instanceof FlowError) ? 'Something went wrong talking to Xero.' : error.message };
  if (error.details !== undefined) body.details = error.details;
  if (error.retryAfterMs) res.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
  return res.status(status).json(body);
}

function requireInvoiceIds(raw, name = 'invoiceIds') {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_BATCH || !raw.every((id) => typeof id === 'string' && UUID.test(id))) {
    throw new FlowError('invalid', `${name} must list 1 to ${MAX_BATCH} Flow invoice ids`);
  }
  return [...new Set(raw)];
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

// `messagePage` draws the callback's answer in the installation's design
// system (server/ui/page.js); the server's app passes it.
export function createXeroRouter({ db, personAuth, runtime, log = console, messagePage = (options) => themedMessagePage({ ...options, defaultFamily: DEFAULT_FAMILY }) }) {
  const page = (title, text, tone) => messagePage({ title, text, tone });
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
      return res.status(400).type('html').send(page('Xero was not connected', 'This approval link has expired or was already used. Start again from Flow.', 'danger'));
    }
    if (req.query.error) {
      return res.status(400).type('html').send(page('Xero was not connected', 'The approval was cancelled in Xero. Start again from Flow if you meant to connect.', 'danger'));
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
      return res.type('html').send(page('Xero is connected', `Flow is connected to ${connection.tenantName || 'your Xero organisation'} (${settings.mode}). You can close this tab.`, 'success'));
    } catch (error) {
      log.error?.(`[xero] connect failed: ${error.code ?? 'error'}: ${error.message}`);
      const message = error instanceof FlowError ? error.message : 'Something went wrong talking to Xero. Try again.';
      return res.status(error.status && error.status < 500 ? error.status : 502).type('html').send(page('Xero was not connected', message, 'danger'));
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

  router.post('/invoices/preview', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const preview = await previewDrafts(db, runtime, organisationId, requireInvoiceIds(req.body?.invoiceIds));
    res.json({ ok: true, mode: settings.mode, writesAllowed: writesAllowed(settings), ...preview });
  }));

  router.post('/invoices/push', ...manager, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const invoiceIds = requireInvoiceIds(req.body?.invoiceIds);
    const allowExistingReference = req.body?.allowExistingReference === undefined ? [] : requireInvoiceIds(req.body.allowExistingReference, 'allowExistingReference');
    const result = await pushDrafts(db, runtime, organisationId, invoiceIds, { pushedBy: req.person.id, allowExistingReference });
    log.info?.(`[xero] organisation ${organisationId}: person ${req.person.id} sent ${invoiceIds.length} invoice(s) to Xero: ${JSON.stringify(result.summary)}`);
    res.json({ ok: true, ...result });
  }));

  router.get('/invoices/:invoiceId/pushes', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.query.organisationId);
    const [invoiceId] = requireInvoiceIds([req.params.invoiceId], 'invoiceId');
    res.json({ ok: true, pushes: (await listPushes(db, organisationId, invoiceId)).map(describePush) });
  }));

  router.post('/obligations/:obligationId/check', ...manager, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const [obligationId] = requireInvoiceIds([req.params.obligationId], 'obligationId');
    const [obligation] = await db.select().from(billingObligations)
      .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId)));
    if (!obligation) throw Object.assign(new FlowError('not_found', 'obligation not found'), { status: 404 });
    const row = await recordXeroEvidence(db, runtime, organisationId, obligation, { actor: `person:${req.person.id}` });
    res.json({ ok: true, obligation: row });
  }));

  router.post('/payments/sync', ...manager, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const result = await recordXeroPayments(db, runtime, organisationId, { actor: `person:${req.person.id}` });
    res.json({ ok: true, ...result });
  }));

  router.post('/mirror', ...manager, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const resources = req.body?.resources ?? MIRROR_RESOURCES;
    if (!Array.isArray(resources) || !resources.length || !resources.every((r) => MIRROR_RESOURCES.includes(r))) {
      throw new FlowError('invalid', `resources must list some of: ${MIRROR_RESOURCES.join(', ')}`);
    }
    const results = await mirrorXero(db, runtime, organisationId, { resources: [...new Set(resources)] });
    log.info?.(`[xero] organisation ${organisationId}: person ${req.person.id} copied Xero records: ${JSON.stringify(results)}`);
    res.json({ ok: true, results, ...(await mirrorStatus(db, organisationId)) });
  }));

  router.get('/mirror', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.query.organisationId);
    res.json({ ok: true, ...(await mirrorStatus(db, organisationId)) });
  }));

  return router;
}
