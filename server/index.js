#!/usr/bin/env node
import { createApp } from './app.js';
import { createClerkProxy, ensureClerkAccount, loadClerkAdapter, resolveClerkProxyPath } from './auth/clerk.js';
import { seedFirstOwner } from './auth/people.js';
import { createPersonAuth } from './auth/session.js';
import { resolveSignInSettings } from './auth/settings.js';
import { migrateDatabase, openDatabase } from './db/index.js';

const port = Number(process.env.FLOW_PORT || process.env.PORT || 19300);

// Sign-in settings first: a malformed setting stops boot before anything runs.
let settings;
try {
  settings = resolveSignInSettings();
} catch (error) {
  console.error(`[auth] ${error.message}`);
  process.exit(1);
}

// Flow's records live in PostgreSQL. Migrations run before the server accepts
// requests, so a release never serves an older schema.
const database = openDatabase();
await migrateDatabase(database.db);

let auth = null;
if (settings.mode === 'clerk') {
  const { keys } = settings;
  const clerk = await loadClerkAdapter({ ...keys, authorizedParties: settings.authorizedParties });
  const personAuth = createPersonAuth({ db: database.db, clerk, ...settings });
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
  console.log(`[auth] Clerk sign-in on (CLERK_SECRET_KEY, ${keys.publishableSource}); public sign-up ${settings.publicSignUp ? 'on' : 'off'}; owner actions: ${ownerPaths.join(', or ')}${proxyPath ? `; Clerk proxied at ${proxyPath}` : ''}`);
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

createApp({ database, auth, trustProxy }).listen(port, () => {
  console.log(`[flow] listening on ${port}`);
});
