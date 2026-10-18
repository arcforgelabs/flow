import { sql } from 'drizzle-orm';
import { createApp } from '../../server/app.js';
import { invitePerson, seedFirstOwner } from '../../server/auth/people.js';
import { createPersonAuth } from '../../server/auth/session.js';
import { createOrganisation } from '../../server/core/directory.js';
import { createIntegrations } from '../../server/integrations/index.js';
import { createXeroAdapter } from '../../server/integrations/xero/index.js';
import { createReplayFetch } from '../../server/integrations/xero/replay.js';
import { createXeroRuntime } from '../../server/integrations/xero/runtime.js';
import { resolveXeroSettings } from '../../server/integrations/xero/settings.js';
import { fakeClerk, TEST_PUBLISHABLE_KEY } from './clerk.js';

// Xero test support: synthetic ids, replayed Xero answers, and a Flow app
// with sign-in faked. Nothing here reaches the real Xero or Clerk.

export const TENANT = '00000000-0000-4000-8000-0000000000a1';
export const TOKEN_KEY = 'ab'.repeat(32);
export const API = 'https://api.xero.com/api.xro/2.0';
export const IDENTITY = 'https://identity.xero.com';
export const ORIGIN = 'https://flow.example.test';
export const OWNER = 'owner@example.test';
export const STAFF = 'staff@example.test';

export function quietLog() {
  const lines = [];
  const push = (line) => lines.push(String(line));
  return { lines, info: push, warn: push, error: push };
}

export const xeroAnswer = (path, body, { method = 'GET', status = 200, headers = {}, query, repeat } = {}) => ({
  ...(repeat ? { repeat } : {}),
  request: { method, url: path.startsWith('https://') ? path : `${API}/${path}`, ...(query ? { query } : {}) },
  response: { status, headers, body },
});

export const tokenAnswer = (n, { status = 200, body } = {}) => xeroAnswer(`${IDENTITY}/connect/token`, body ?? {
  access_token: `synthetic-access-${n}`,
  refresh_token: `synthetic-refresh-${n}`,
  expires_in: 1800,
  token_type: 'Bearer',
  scope: 'offline_access accounting.contacts accounting.invoices accounting.settings.read',
}, { method: 'POST', status });

export const connectionsAnswer = (list = [{ tenantId: TENANT, tenantName: 'Example Lab (Demo)', tenantType: 'ORGANISATION' }]) => xeroAnswer('https://api.xero.com/connections', list);
export const organisationAnswer = (klass = 'DEMO') => xeroAnswer('Organisation', { Organisations: [{ Name: 'Example Lab (Demo)', Class: klass }] }, { repeat: true });
export const revokeAnswer = () => xeroAnswer(`${IDENTITY}/connect/revocation`, '', { method: 'POST', repeat: true });

export function xeroRuntime(interactions, env = {}, log = quietLog()) {
  const settings = resolveXeroSettings({ XERO_MODE: 'replay', XERO_TOKEN_KEY: TOKEN_KEY, FLOW_PUBLIC_ORIGIN: ORIGIN, ...env });
  const fetch = createReplayFetch(interactions);
  return { runtime: createXeroRuntime({ settings, fetch, log }), fetch, log };
}

export async function xeroTables(db) {
  const { rows } = await db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'xero\\_%' order by table_name`);
  return rows.map((r) => r.table_name);
}

// One Flow start with the Xero adapter on or off, an organisation, an owner
// and a staff member signed in.
export async function bootFlow(handle, { on = true, runtime, log = quietLog() } = {}) {
  const integrations = createIntegrations({
    env: { FLOW_INTEGRATIONS: on ? 'xero' : '' },
    adapters: [createXeroAdapter({ runtime })],
    log,
  });
  await integrations.start(handle.db);
  const clerk = fakeClerk();
  const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log });
  const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
  const app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log });
  return { app, clerk, integrations };
}

export async function seedLab(handle, clerk) {
  const organisation = await createOrganisation(handle.db, { name: 'Example Lab' });
  const owner = await seedFirstOwner(handle.db, OWNER);
  await invitePerson(handle.db, { email: STAFF, role: 'staff', invitedBy: owner.id });
  const ownerToken = clerk.signIn(clerk.addUser({ email: OWNER, google: true, password: false }));
  const staffToken = clerk.signIn(clerk.addUser({ email: STAFF }));
  return { organisation, owner, ownerToken, staffToken };
}
