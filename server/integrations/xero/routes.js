import { and, eq } from 'drizzle-orm';
import express from 'express';
import { FlowError } from '../../core/errors.js';
import { createActionGuard } from '../call-guard.js';
import { billingObligations, organisations } from '../../db/schema.js';
import { lastSync, listContacts, listItems, syncCatalogue } from './catalogue.js';
import { createXeroClient } from './client.js';
import { describePush, listPushes, MAX_BATCH, previewDrafts, pushDrafts } from './drafts.js';
import { recordXeroEvidence, recordXeroPayments } from './ledger.js';
import { IMPORT_STATES, importOverview, linkXeroInvoice, makeFlowInvoice, matchXero, saveImportSettings } from './links.js';
import { queueHistoryImport, resetImport } from './import.js';
import { MIRROR_RESOURCES, mirrorStatus, mirrorXero } from './mirror.js';
import { accountingStatus, checkSentInvoices } from './reconcile.js';
import { decryptToken, deleteConnection, describeConnection, readConnection, saveConnection } from './connections.js';
import { authorizeUrl, exchangeCode, fetchConnections, revokeToken, selectConnection } from './oauth.js';
import { writesAllowed } from './settings.js';
import { readXeroUsage } from './usage.js';
import { saveEvents, signatureValid } from './webhooks.js';
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
//   POST /invoices/status          any signed-in person: each invoice's Xero
//                                  status and any difference, from the copy
//   POST /invoices/:invoiceId/recheck   owner or admin: reads Xero's changes,
//                                  then checks that one invoice again (Mark resolved)
//   POST /obligations/:obligationId/check   owner or admin: Xero's invoice for
//                                  a billable job, recorded on the ledger
//   POST /payments/sync            owner or admin: Xero payments to the ledger
//   POST /mirror                   owner or admin: copies Xero invoices, credit
//                                  notes and payments changed since the last copy
//   GET  /mirror?organisationId=   any signed-in person: what the copy holds
//   POST /webhooks                 Xero: change events, signed with the
//                                  webhook key (XERO_WEBHOOK_KEY); no session
//
// Each POST that calls Xero waits between presses (XERO_ACTIONS, the action
// guard): a press too soon answers 429 with the wait.
//
// Only an owner, with a verified owner sign-in, can connect or disconnect.
// The callback carries no Flow session: the one-use state from /connect,
// issued to that owner for that organisation, is what admits it.

// The buttons that call Xero, and how long each waits before it runs again
// (the action guard, call-guard.js). A send is one invoice at a time, so it
// only runs once at a time and backs off after a failure.
export const XERO_ACTIONS = Object.freeze({
  sync: { cooldownMs: 5 * 60_000 },
  recheck: { cooldownMs: 30_000 },
  push: { cooldownMs: 0, budget: false },
  obligationCheck: { cooldownMs: 30_000 },
  paymentsSync: { cooldownMs: 5 * 60_000 },
  mirror: { cooldownMs: 2 * 60_000 },
});

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
// What the Xero page says about calls for one connection: stopped until a
// person connects again (a refused connection or resource), and since when.
export function callsState(status) {
  const resources = status.stoppedResources.map((r) => r.resource);
  const since = status.haltedAt ?? status.stoppedResources.map((r) => r.at).filter(Boolean).sort()[0] ?? null;
  return { stopped: Boolean(status.haltedReason) || resources.length > 0, all: Boolean(status.haltedReason), resources, since };
}

const XERO_INTEGRATION = Object.freeze({ name: 'Xero', logo: 'xero.svg' });

export function createXeroRouter({ db, personAuth, runtime, log = console, buttonCooldowns = true, actions = createActionGuard({ integration: 'xero', actions: XERO_ACTIONS, off: !buttonCooldowns }), messagePage = (options) => themedMessagePage({ ...options, defaultFamily: DEFAULT_FAMILY }) }) {
  // Shared callback card (server/ui/page.js): integration marks, status line,
  // and a short auto-return on success only (issue #211).
  const page = (title, text, tone, extra = {}) => messagePage({ title, text, tone, integration: XERO_INTEGRATION, ...extra });
  const { settings } = runtime;
  const router = express.Router();
  const act = (name, key) => actions.route(name, { key });

  // Xero's webhooks (webhooks.js), before the JSON parser: the signature
  // covers the raw body. Xero wants 200 with no body within 5 seconds, and
  // 401 for a bad signature (its "intent to receive" test sends both).
  router.post('/webhooks', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    if (!settings.webhookKey) return res.status(404).end();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!signatureValid(settings.webhookKey, raw, req.get('x-xero-signature'))) return res.status(401).end();
    try {
      await saveEvents(db, runtime, JSON.parse(raw.toString('utf8') || '{}'));
    } catch (error) {
      log.error?.(`[xero] saving webhook events failed: ${error?.code ?? error?.name ?? 'error'}`);
      return res.status(500).end();
    }
    return res.status(200).end();
  });

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
    const connected = Boolean(connection && connection.mode === settings.mode);
    const picture = connected
      ? await readXeroUsage(db, {
        organisationId,
        tenantId: connection.tenantId,
        governor: runtime.governor.status(connection.tenantId),
        warningFraction: settings.usageWarningFraction,
        refreshedAt: connection.refreshedAt,
        now: runtime.now(),
      })
      : { usage: null, freshness: null };
    res.json({
      ok: true,
      mode: settings.mode,
      writesAllowed: writesAllowed(settings),
      redirectUri: settings.redirectUri,
      connected,
      connection: describeConnection(connection),
      rateLimit: connected ? runtime.governor.status(connection.tenantId) : null,
      calls: connected ? callsState(await runtime.guardFor(db).status(connection.tenantId)) : null,
      lastSync: await lastSync(db, organisationId),
      usage: picture.usage,
      freshness: picture.freshness,
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
      const previous = await readConnection(db, entry.organisationId);
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
      // A new connection is a person acting: calls stopped before resume.
      await runtime.guardFor(db).resume();
      // Another Xero organisation starts its history from the beginning.
      if (previous && previous.tenantId !== connection.tenantId) await resetImport(db, entry.organisationId);
      await queueHistoryImport(db, entry.organisationId, { reason: 'connected' });
      log.info?.(`[xero] organisation ${entry.organisationId} connected to Xero tenant ${connection.tenantId} (${settings.mode}) by person ${entry.personId}`);
      const organisation = connection.tenantName || 'your Xero organisation';
      return res.type('html').send(page(
        'Xero is connected',
        'Flow is now copying its invoice and payment history in the background.',
        'success',
        { organisation, mode: settings.mode, autoReturnSeconds: 5 },
      ));
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

  router.post('/sync', ...manager, act('sync'), handle(log, async (req, res) => {
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

  // Xero's status of each invoice, from Flow's copy: no Xero calls.
  router.post('/invoices/status', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const statuses = await accountingStatus(db, runtime, organisationId, requireInvoiceIds(req.body?.invoiceIds));
    res.json({ ok: true, invoices: [...statuses.values()] });
  }));

  // Mark resolved: read Xero's changes (a few calls, through the call guard),
  // then check this one invoice again. The item closes only when the
  // difference is gone; otherwise it stays open with the new evidence.
  router.post('/invoices/:invoiceId/recheck', ...manager, act('recheck', (req) => req.params.invoiceId), handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const [invoiceId] = requireInvoiceIds([req.params.invoiceId], 'invoiceId');
    await mirrorXero(db, runtime, organisationId, { resources: ['invoices'] });
    const result = await checkSentInvoices(db, runtime, organisationId, { invoiceIds: [invoiceId] });
    const status = (await accountingStatus(db, runtime, organisationId, [invoiceId])).get(invoiceId) ?? null;
    res.json({ ok: true, resolved: !status?.finding, closed: result.closed, status });
  }));

  router.post('/invoices/push', ...manager, act('push'), handle(log, async (req, res) => {
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

  router.post('/obligations/:obligationId/check', ...manager, act('obligationCheck', (req) => req.params.obligationId), handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const [obligationId] = requireInvoiceIds([req.params.obligationId], 'obligationId');
    const [obligation] = await db.select().from(billingObligations)
      .where(and(eq(billingObligations.organisationId, organisationId), eq(billingObligations.id, obligationId)));
    if (!obligation) throw Object.assign(new FlowError('not_found', 'obligation not found'), { status: 404 });
    const row = await recordXeroEvidence(db, runtime, organisationId, obligation, { actor: `person:${req.person.id}` });
    res.json({ ok: true, obligation: row });
  }));

  router.post('/payments/sync', ...manager, act('paymentsSync'), handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const result = await recordXeroPayments(db, runtime, organisationId, { actor: `person:${req.person.id}` });
    res.json({ ok: true, ...result });
  }));

  router.post('/mirror', ...manager, act('mirror'), handle(log, async (req, res) => {
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

  // The Import page (links.js): each Xero sales invoice in Flow's copy against
  // Flow's own invoices. Reads Flow's database only.
  router.get('/import', ...signedIn, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.query.organisationId);
    const show = typeof req.query.show === 'string' && [...IMPORT_STATES, 'check', 'all'].includes(req.query.show) ? req.query.show : 'all';
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    const offset = Math.max(0, Math.min(Number.parseInt(req.query.offset, 10) || 0, 1_000_000));
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 50, 100));
    res.json({ ok: true, ...(await importOverview(db, organisationId, { show, q, limit, offset })) });
  }));

  router.post('/import/match', ...manager, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const result = await matchXero(db, organisationId, { actor: `person:${req.person.id}` });
    log.info?.(`[xero] organisation ${organisationId}: person ${req.person.id} matched Xero invoices: ${JSON.stringify(result)}`);
    res.json({ ok: true, ...result });
  }));

  router.put('/import/settings', ...manager, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    res.json({ ok: true, settings: await saveImportSettings(db, organisationId, { autoLink: req.body?.autoLink, makeUnmatched: req.body?.makeUnmatched, actor: `person:${req.person.id}` }) });
  }));

  const xeroId = (raw) => {
    if (typeof raw !== 'string' || !UUID.test(raw)) throw Object.assign(new FlowError('not_found', 'Xero invoice not found'), { status: 404 });
    return raw;
  };

  router.post('/import/:xeroInvoiceId/link', ...manager, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const [invoiceId] = requireInvoiceIds([req.body?.invoiceId], 'invoiceId');
    res.json({ ok: true, ...(await linkXeroInvoice(db, organisationId, xeroId(req.params.xeroInvoiceId), { invoiceId, actor: `person:${req.person.id}` })) });
  }));

  router.post('/import/:xeroInvoiceId/make', ...manager, handle(log, async (req, res) => {
    const organisationId = await requireOrganisation(db, req.body?.organisationId);
    const jobId = req.body?.jobId == null ? null : requireInvoiceIds([req.body.jobId], 'jobId')[0];
    const { invoice } = await makeFlowInvoice(db, organisationId, xeroId(req.params.xeroInvoiceId), { jobId, actor: `person:${req.person.id}` });
    res.json({ ok: true, invoice: { id: invoice.id, number: invoice.number } });
  }));

  return router;
}
