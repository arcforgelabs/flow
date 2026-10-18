import express from 'express';
import { createConnectorApi } from './api/connector.js';
import { createSignInRouter } from './auth/routes.js';
import { rateLimit } from './rate-limit.js';

// The Flow HTTP app. Routes are added per module (invoices, bills, payments,
// dashboard).
//
// `auth` is { settings, clerk, personAuth, clerkProxy } from server/index.js
// (or a test). Without it sign-in is off and every person route answers 503.
// `trustProxy` is Express's `trust proxy`: 1 hop on Replit, so rate limits
// count per client rather than per proxy.
export function createApp({
  revision = process.env.FLOW_REVISION || null,
  database = null,
  auth = null,
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
    res.status(ok ? 200 : 503).json({ ok, service: 'flow', revision, database: databaseOk });
  });

  // Clerk's Frontend API through Flow's origin (CLERK_PROXY_URL). Before any
  // body parser, so request bodies reach Clerk intact.
  if (auth?.clerkProxy) app.use(auth.clerkProxy.path, auth.clerkProxy.handler);

  app.use('/api', rateLimit({ limit: rateLimitPerMinute, windowMs: 60_000 }));

  // Machine access first, with its own authentication (issue #9). A Clerk
  // session never opens it.
  app.use('/api/flow/v1', createConnectorApi());

  app.use(createSignInRouter({
    settings: auth?.settings ?? { mode: 'off' },
    db: database?.db ?? null,
    clerk: auth?.clerk ?? null,
    personAuth: auth?.personAuth ?? null,
    log,
  }));

  return app;
}
