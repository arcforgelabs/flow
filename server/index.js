#!/usr/bin/env node
import { createApp } from './app.js';
import { createClerkProxy, ensureClerkAccount, loadClerkAdapter, resolveClerkProxyPath } from './auth/clerk.js';
import { seedFirstOwner } from './auth/people.js';
import { createPersonAuth } from './auth/session.js';
import { resolveSignInSettings } from './auth/settings.js';
import { expectedSchema } from './db/doctor.js';
import { migrateDatabase, openDatabase } from './db/index.js';
import {
  importEarlierAtStart, importEarlierLinksAtStart, importEarlierMappingsAtStart, resolveImportAtStart,
} from './import/at-start.js';
import { createCaptureRetentionWorker } from './core/captures.js';
import { createMonitoredLog } from './core/monitoring.js';
import { resolveObjectStorage } from './core/storage.js';
import { createTracing, traceQueries } from './core/tracing.js';
import { createPipelineWorker } from './core/pipeline.js';
import { createReconcileWorker } from './core/reconcile.js';
import { backgroundJobsOn } from './core/host.js';
import { createSendWorker } from './core/sending.js';
import { resolveSecretsKey } from './core/secrets.js';
import { adapters as shippedAdapters } from './integrations/adapters.js';
import { createIntegrations, resolveEnabledIntegrations } from './integrations/index.js';
import { readStoredSettings, settingsEnvironment, storedEnabled } from './integrations/setup.js';
import { resolveDefaultFamily } from './theme/themes.js';
import { createUpdateChecker, UPDATE_CHECK_INTERVAL_MS } from './update-check.js';

const port = Number(process.env.FLOW_PORT || process.env.PORT || 19300);

// Settings first: a malformed setting stops boot before anything runs.
let settings;
try {
  settings = resolveSignInSettings();
} catch (error) {
  console.error(`[auth] ${error.message}`);
  process.exit(1);
}
let defaultFamily;
try {
  defaultFamily = resolveDefaultFamily();
} catch (error) {
  console.error(`[ui] ${error.message}`);
  process.exit(1);
}
let secrets;
try {
  resolveEnabledIntegrations();
  secrets = resolveSecretsKey();
} catch (error) {
  console.error(`[integrations] ${error.message}`);
  process.exit(1);
}

let importAtStart;
try {
  importAtStart = resolveImportAtStart();
} catch (error) {
  console.error(`[import] ${error.message}`);
  process.exit(1);
}

// Flow's records live in PostgreSQL. Migrations run before the server accepts
// requests, so a release never serves an older schema. Then each enabled
// integration's own tables, and no others (docs/INTEGRATIONS.md).
const database = openDatabase();
await migrateDatabase(database.db);
// A failed import stops the start, so Flow never opens with half its records.
try {
  await importEarlierAtStart({ db: database.db, pool: database.pool, settings: importAtStart });
} catch (error) {
  console.error(`[import] ${error.message}`);
  process.exit(1);
}
// The earlier links are evidence to add, not records Flow needs to open, so a
// failure is logged and the start goes on.
await importEarlierLinksAtStart({ db: database.db, pool: database.pool, settings: importAtStart })
  .catch((error) => console.error(`[import] ${error.message}`));
await importEarlierMappingsAtStart({ db: database.db, pool: database.pool, settings: importAtStart })
  .catch((error) => console.error(`[import] ${error.message}`));
// What an owner set in Settings, Integrations, with the host's own
// environment over it (server/integrations/setup.js).
// Every part of Flow logs here: each error also goes to the installation's
// own error service while one is on (docs/SENTRY.md).
let integrations;
const log = createMonitoredLog({ log: console, reporters: () => integrations?.with('captureError') ?? [] });
// Performance traces, while a tracing service is on (docs/SENTRY.md, "Traces"):
// each request, and each database query inside one.
const tracing = createTracing({ tracers: () => integrations?.with('traceRequest') ?? [] });
traceQueries(database.pool, tracing);
try {
  const stored = await readStoredSettings(database.db);
  const { env: settingsEnv, unreadable } = settingsEnvironment({ env: process.env, stored, adapters: shippedAdapters, secrets });
  if (unreadable.length) console.warn(`[integrations] stored credentials Flow cannot read with this secrets key: ${unreadable.join(', ')}. An owner enters them again in Settings.`);
  integrations = createIntegrations({ turnedOnInFlow: storedEnabled(stored, process.env), settingsEnv, log });
  await integrations.start(database.db);
} catch (error) {
  console.error(`[integrations] ${error.message}`);
  process.exit(1);
}
const integrationsOn = integrations.list().filter((a) => a.enabled).map((a) => `${a.id}${a.state === 'ready' ? '' : ` (${a.state})`}`);
console.log(`[integrations] on: ${integrationsOn.join(', ') || 'none'}; secrets key ${secrets ? `from ${secrets.source}` : 'not set (FLOW_SECRETS_KEY)'}`);

// Background jobs run only where FLOW_BACKGROUND_JOBS allows: never in a
// Replit workspace, which shares the published app's secrets
// (server/core/host.js).
const jobsOn = backgroundJobsOn(process.env);
if (!jobsOn) console.log('[flow] background jobs off (FLOW_BACKGROUND_JOBS): no sync, pipeline, reconcile or sending in this copy');
// The pipeline (server/core/pipeline.js) joins what the integrations copy into
// Flow: jobs into the ledger, and each job to its accounting invoice. It runs
// only while an integration that feeds it is on, and writes to no other
// system. FLOW_PIPELINE=off stops it.
if (jobsOn && process.env.FLOW_PIPELINE !== 'off') {
  createPipelineWorker({ db: database.db, integrations, log }).start();
}
// The daily reconcile (server/core/reconcile.js) compares Flow's own copies
// and opens a review item for a day that does not agree. It never calls or
// writes to another system.
if (jobsOn) createReconcileWorker({ db: database.db, integrations, log }).start();
// The send worker (server/core/sending.js) sends only what a person queued
// with Send all ready, to the accounting integration that is on.
if (jobsOn) createSendWorker({ db: database.db, integrations, log }).start();

// Capture photos (server/core/storage.js). A bad storage setting stops boot.
// On Replit the default is off, never the local folder. The retention pass
// only deletes Flow's own files, so it still runs where background jobs are
// off: a second copy deleting the same key does nothing.
let storage = null;
try {
  const resolved = await resolveObjectStorage({ env: process.env, secrets });
  storage = resolved.storage;
  if (storage) console.log(`[storage] ${resolved.mode}`);
  else console.log(`[storage] captures off (${resolved.reason})`);
} catch (error) {
  console.error(`[storage] ${error.message}`);
  process.exit(1);
}
if (storage) createCaptureRetentionWorker({ db: database.db, storage, log }).start();

let auth = null;
if (settings.mode === 'clerk') {
  const { keys } = settings;
  const clerk = await loadClerkAdapter({ ...keys, authorizedParties: settings.authorizedParties });
  const personAuth = createPersonAuth({ db: database.db, clerk, ...settings, log });
  let clerkProxy = null;
  const proxyPath = resolveClerkProxyPath(keys.proxyUrl);
  if (proxyPath) {
    const { clerkFrontendApiProxy } = await import('@clerk/backend/proxy');
    clerkProxy = { path: proxyPath, handler: createClerkProxy({ proxyPath, ...keys, proxy: clerkFrontendApiProxy }) };
  }
  auth = { settings, clerk, personAuth, clerkProxy };

  if (settings.firstOwnerEmail) {
    const seeded = await seedFirstOwner(database.db, settings.firstOwnerEmail);
    if (seeded) {
      console.log(`[auth] no owner yet: invited FLOW_FIRST_OWNER_EMAIL as owner (person ${seeded.id})`);
      await ensureClerkAccount(clerk, seeded.email).catch((error) => {
        console.error(`[auth] could not prepare the first owner's Clerk account: ${error.message}`);
      });
    }
  }
  const ownerPaths = [
    ...(settings.ownerGoogleDomains.length ? [`Google Workspace sign-in on ${settings.ownerGoogleDomains.join(', ')} with no password`] : []),
    `a Clerk second factor within ${settings.ownerMfaMaxAgeMinutes} min`,
  ];
  console.log(`[auth] Clerk sign-in on (CLERK_SECRET_KEY, ${keys.publishableSource}); public sign-up ${settings.publicSignUp ? 'on' : settings.signUpDomains.length ? `only ${settings.signUpDomains.join(', ')}` : 'off'}; owner actions: ${ownerPaths.join(', or ')}${proxyPath ? `; Clerk proxied at ${proxyPath}` : ''}`);
  // Replit's managed Clerk has no MFA, so there the Google Workspace path is
  // the only way an owner can manage people.
  if (!settings.ownerGoogleDomains.length && (process.env.REPL_ID || process.env.REPLIT_DEPLOYMENT)) {
    console.warn('[auth] FLOW_OWNER_GOOGLE_DOMAINS is unset: on Replit\'s managed Clerk no owner can manage people (docs/SELF_HOSTING.md, "Sign-in (Clerk)")');
  }
} else {
  console.log('[auth] sign-in off (FLOW_AUTH unset): person routes answer 503');
}

// Replit puts one proxy in front of the app.
const trustProxy = process.env.REPL_ID || process.env.REPLIT_DEPLOYMENT ? 1 : false;

const updates = createUpdateChecker();

createApp({
  database, schemaJournals: expectedSchema({ adapters: shippedAdapters }).journals, auth, trustProxy, updates, integrations, secrets, defaultFamily, log, tracing, storage,
  publicOrigin: process.env.FLOW_PUBLIC_ORIGIN,
}).listen(port, () => {
  console.log(`[flow] listening on ${port}; design system ${defaultFamily} (FLOW_THEME)`);
});

// The update notice: a release build logs when a newer release is out on its
// channel, at start and every six hours. A build that is not a release asks
// nobody.
async function noticeUpdate() {
  try {
    const status = await updates.status();
    if (status.updateAvailable) {
      console.log(`[flow] update available: ${status.latest} (running ${status.current}, channel ${status.channel}). Notes: ${status.releaseUrl}. How to update: ${status.upgradeUrl}`);
    }
  } catch (error) {
    console.error(`[flow] update check failed: ${error?.message || error}`);
  }
}
noticeUpdate();
setInterval(noticeUpdate, UPDATE_CHECK_INTERVAL_MS).unref();
