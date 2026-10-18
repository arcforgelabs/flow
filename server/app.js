import express from 'express';
import { createConnectorApi } from './api/connector.js';
import { createSignInRouter } from './auth/routes.js';
import { deployedBuildStatus } from './deployed-build.js';
import { rateLimit } from './rate-limit.js';

// The Flow HTTP app. Routes are added per module (invoices, bills, payments,
// dashboard).
//
// `auth` is { settings, clerk, personAuth, clerkProxy } from server/index.js
// (or a test). Without it sign-in is off and every person route answers 503.
// `trustProxy` is Express's `trust proxy`: 1 hop on Replit, so rate limits
// count per client rather than per proxy. `build` is what GET /health reports
// (server/deployed-build.js); `updates` is a server/update-check.js checker.
export function createApp({
  build = deployedBuildStatus(),
  database = null,
  auth = null,
  updates = null,
  trustProxy = false,
  rateLimitPerMinute = 120,
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
    res.status(ok ? 200 : 503).json({ ok, service: 'flow', database: databaseOk, build });
  });

  // Clerk's Frontend API through Flow's origin (CLERK_PROXY_URL). Before any
  // body parser, so request bodies reach Clerk intact.
  if (auth?.clerkProxy) app.use(auth.clerkProxy.path, auth.clerkProxy.handler);

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

  app.use(createSignInRouter({
    settings: auth?.settings ?? { mode: 'off' },
    db: database?.db ?? null,
    clerk: auth?.clerk ?? null,
    personAuth: auth?.personAuth ?? null,
    log,
  }));

  return app;
}
