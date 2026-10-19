import express from 'express';
import { createConnectorApi } from './api/connector.js';
import { createSignInRouter } from './auth/routes.js';
import { deployedBuildStatus } from './deployed-build.js';
import { integrationsHealth } from './integrations/health.js';
import { rateLimit } from './rate-limit.js';
import { DEFAULT_FAMILY } from './theme/themes.js';
import { messagePage } from './ui/page.js';
import { createUiAssetsRouter } from './ui/routes.js';

// The Flow HTTP app. Routes are added per module (invoices, bills, payments,
// dashboard).
//
// `auth` is { settings, clerk, personAuth, clerkProxy } from server/index.js
// (or a test). Without it sign-in is off and every person route answers 503.
// `trustProxy` is Express's `trust proxy`: 1 hop on Replit, so rate limits
// count per client rather than per proxy. The limits are requests per minute
// per client, sized for a lab of a few people: `rateLimitPerMinute` for /api,
// `signInRateLimitPerMinute` for the sign-in page and its config, and
// `clerkProxyRateLimitPerMinute` for Clerk's Frontend API, which a signed-in
// browser calls often. `build` is what GET /health reports
// (server/deployed-build.js); `updates` is a server/update-check.js checker.
// `integrations` is the started registry (server/integrations/index.js); each
// adapter's own routes are mounted under /api/<id>, and GET /health reports
// each one (server/integrations/health.js). `defaultFamily` is the design
// system every page starts on (FLOW_THEME, server/theme/themes.js).
export function createApp({
  build = deployedBuildStatus(),
  database = null,
  auth = null,
  updates = null,
  integrations = null,
  trustProxy = false,
  rateLimitPerMinute = 120,
  signInRateLimitPerMinute = 30,
  clerkProxyRateLimitPerMinute = 300,
  defaultFamily = DEFAULT_FAMILY,
  log = console,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.get('/health', async (_req, res) => {
    let databaseOk = null;
    if (database) {
      databaseOk = await database.pool.query('SELECT 1').then(() => true, () => false);
    }
    const ok = databaseOk !== false;
    // The running build (commit, deploy ref, source, CI result, release), so
    // an operator can confirm what a publish deployed. The repository is
    // public, so none of it is a secret.
    // Each integration's state and its own health (mode, freshness, failing
    // records). An integration problem does not fail the health check: Flow's
    // core works with no integration connected (VISION.md).
    const body = { ok, service: 'flow', database: databaseOk, build };
    if (integrations) body.integrations = await integrationsHealth(integrations);
    res.status(ok ? 200 : 503).json(body);
  });

  // Clerk's Frontend API through Flow's origin (CLERK_PROXY_URL). Before any
  // body parser, so request bodies reach Clerk intact.
  if (auth?.clerkProxy) {
    app.use(auth.clerkProxy.path, rateLimit({ limit: clerkProxyRateLimitPerMinute, windowMs: 60_000 }), auth.clerkProxy.handler);
  }

  // The design systems, Flow's components and the faces every page loads.
  app.use(createUiAssetsRouter());

  app.use('/api', rateLimit({ limit: rateLimitPerMinute, windowMs: 60_000 }));

  // Machine access first, with its own authentication (issue #9). A Clerk
  // session never opens it.
  app.use('/api/flow/v1', createConnectorApi());

  // Is a newer Flow release out on this installation's channel? Owners only,
  // as in Field. It only reads, so an owner session is enough; it needs no
  // second factor. With sign-in off it answers 503 like the person routes,
  // and the server log still carries the notice (server/index.js).
  if (updates) {
    const updateStatus = async (_req, res) => res.json({ ok: true, ...(await updates.status()) });
    if (auth?.personAuth) {
      app.get('/api/updates', auth.personAuth.requireSession, auth.personAuth.requireRole('owner'), updateStatus);
    } else {
      app.get('/api/updates', (_req, res) => res.status(503).json({
        ok: false,
        code: 'sign_in_not_configured',
        error: 'Sign-in is not configured on this installation (FLOW_AUTH is unset).',
      }));
    }
  }

  // An adapter's own pages (such as the end of connecting Xero) use
  // `messagePage` so they look like the rest of Flow.
  const page = (options) => messagePage({ ...options, defaultFamily });
  for (const { path, handler } of integrations?.routes({ db: database?.db ?? null, personAuth: auth?.personAuth ?? null, log, messagePage: page }) ?? []) {
    app.use(path, handler);
  }

  app.use(createSignInRouter({
    settings: auth?.settings ?? { mode: 'off' },
    db: database?.db ?? null,
    clerk: auth?.clerk ?? null,
    personAuth: auth?.personAuth ?? null,
    defaultFamily,
    rateLimitPerMinute: signInRateLimitPerMinute,
    log,
  }));

  return app;
}
