import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createIntegrations } from '../server/integrations/index.js';
import { defineAdapter } from '../server/integrations/port.js';
import { createXeroAdapter, XERO_TABLES } from '../server/integrations/xero/index.js';
import { decryptToken } from '../server/integrations/xero/connections.js';
import { selectConnection } from '../server/integrations/xero/oauth.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import {
  bootFlow, connectionsAnswer, ORIGIN, organisationAnswer, quietLog, revokeAnswer, seedLab, TENANT, tokenAnswer,
  TOKEN_KEY, xeroAnswer, xeroRuntime, xeroTables,
} from './support/xero.js';

// Connecting Xero: owner only, the redirect URI from settings, the refresh
// token sealed at rest and rotated under a row lock. Xero is replayed with
// synthetic answers; Clerk is faked.

const KEY = Buffer.from(TOKEN_KEY, 'hex');

test('an adapter declares routes as a function', () => {
  const health = async () => ({ ok: true });
  assert.throws(() => defineAdapter({ id: 'sample', name: 'S', routes: {}, capabilities: { health } }), /routes must be a function/);
});

test('a live connection takes only the Xero organisation the settings name', () => {
  const list = [
    { tenantId: 't1', tenantName: 'Example Lab', tenantType: 'ORGANISATION' },
    { tenantId: 't2', tenantName: 'Other Lab', tenantType: 'ORGANISATION' },
  ];
  assert.equal(selectConnection(list, { tenantName: 'example lab' }).tenantId, 't1');
  assert.equal(selectConnection(list, { tenantId: 't2' }).tenantId, 't2');
  assert.throws(() => selectConnection(list, {}), (error) => error.code === 'xero_ambiguous_organisation');
  assert.throws(() => selectConnection(list, { tenantName: 'Third Lab' }), (error) => error.code === 'xero_wrong_organisation');
});

// Starts the owner's approval and follows Xero's redirect back to Flow.
async function connect(app, ownerToken, organisationId, { code = 'synthetic-code' } = {}) {
  const started = await request(app, '/api/xero/connect', { token: ownerToken, method: 'POST', body: { organisationId } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const state = new URL(started.body.authorizeUrl).searchParams.get('state');
  const back = await request(app, `/api/xero/oauth/callback?code=${code}&state=${state}`);
  return { started, state, back };
}

describe('connecting Xero', { skip: skipWithoutDatabase }, () => {
  let handle;

  before(async () => {
    handle = await freshDatabase();
  });
  after(async () => handle?.close());

  test('with Xero off, a start creates no Xero tables and its routes answer turned off', async () => {
    const { runtime } = xeroRuntime([]);
    const { app } = await bootFlow(handle, { on: false, runtime });
    assert.deepEqual(await xeroTables(handle.db), []);
    const res = await request(app, '/api/xero/status');
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'integration_off');
    assert.equal(res.body.reason, 'disabled');
  });

  test('with Xero on and no XERO_MODE, Flow does not start', async () => {
    const integrations = createIntegrations({ env: { FLOW_INTEGRATIONS: 'xero' }, adapters: [createXeroAdapter()], log: quietLog() });
    await assert.rejects(integrations.start(handle.db), /XERO_MODE must be "live", "sandbox" or "replay"/);
  });

  describe('with Xero on (replay)', () => {
    let integrations;
    let app;
    let lab;
    let replay;

    before(async () => {
      replay = xeroRuntime([
        tokenAnswer(1),
        connectionsAnswer(),
        organisationAnswer(),
        tokenAnswer(2),
        revokeAnswer(),
      ]);
      const booted = await bootFlow(handle, { on: true, runtime: replay.runtime, log: replay.log });
      app = booted.app;
      integrations = booted.integrations;
      lab = await seedLab(handle, booted.clerk);
    });

    test('a start creates every Xero table', async () => {
      assert.deepEqual(await xeroTables(handle.db), [...XERO_TABLES].sort());
    });

    test('status needs a sign-in, and shows the mode and no connection yet', async () => {
      assert.equal((await request(app, `/api/xero/status?organisationId=${lab.organisation.id}`)).status, 401);
      const res = await request(app, `/api/xero/status?organisationId=${lab.organisation.id}`, { token: lab.staffToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.mode, 'replay');
      assert.equal(res.body.connected, false);
      assert.equal(res.body.redirectUri, `${ORIGIN}/api/xero/oauth/callback`);
    });

    test('only an owner can start a connection', async () => {
      const res = await request(app, '/api/xero/connect', { token: lab.staffToken, method: 'POST', body: { organisationId: lab.organisation.id } });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'owner_required');
    });

    test('an owner connects; the redirect URI comes from settings and the refresh token is stored sealed', async () => {
      const { started, state, back } = await connect(app, lab.ownerToken, lab.organisation.id);
      const authorize = new URL(started.body.authorizeUrl);
      assert.equal(authorize.origin, 'https://login.xero.com');
      assert.equal(authorize.searchParams.get('redirect_uri'), `${ORIGIN}/api/xero/oauth/callback`);
      assert.match(authorize.searchParams.get('scope'), /offline_access/);
      assert.equal(back.status, 200, back.text);
      assert.match(back.text, /Xero is connected/);

      const { rows } = await handle.db.execute(sql`select * from xero_connections`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tenant_id, TENANT);
      assert.equal(rows[0].mode, 'replay');
      assert.doesNotMatch(JSON.stringify(rows[0]), /synthetic-refresh/);
      assert.equal(decryptToken(rows[0].refresh_token_enc, KEY, lab.organisation.id), 'synthetic-refresh-1');

      const { rows: jobs } = await handle.db.execute(sql`select kind, state, organisation_id from background_jobs`);
      assert.deepEqual(jobs, [{ kind: 'xero.import', state: 'queued', organisation_id: lab.organisation.id }], 'connecting queues the history import');
      assert.throws(() => decryptToken(rows[0].refresh_token_enc, KEY, '00000000-0000-4000-8000-000000000000'), /cannot be read/);

      const exchange = replay.fetch.calls.find((call) => call.path === '/connect/token');
      assert.match(exchange.body, /grant_type=authorization_code/);
      assert.match(exchange.body, new RegExp(`redirect_uri=${encodeURIComponent(`${ORIGIN}/api/xero/oauth/callback`)}`));

      const again = await request(app, `/api/xero/oauth/callback?code=synthetic-code&state=${state}`);
      assert.equal(again.status, 400, 'a state is used once');
    });

    test('status shows the connection and never a token', async () => {
      const res = await request(app, `/api/xero/status?organisationId=${lab.organisation.id}`, { token: lab.staffToken });
      assert.equal(res.body.connected, true);
      assert.equal(res.body.connection.tenantId, TENANT);
      assert.doesNotMatch(res.text, /synthetic-(refresh|access)/);
    });

    test('an expired access token is refreshed and the rotated refresh token is stored', async () => {
      replay.runtime.forget(lab.organisation.id);
      const { client } = await replay.runtime.clientFor(handle.db, lab.organisation.id);
      assert.equal((await client.getOrganisation()).Class, 'DEMO');
      const refresh = replay.fetch.calls.filter((call) => call.path === '/connect/token').at(-1);
      assert.match(refresh.body, /grant_type=refresh_token&refresh_token=synthetic-refresh-1/);
      const { rows } = await handle.db.execute(sql`select refresh_token_enc, refreshed_at from xero_connections`);
      assert.equal(decryptToken(rows[0].refresh_token_enc, KEY, lab.organisation.id), 'synthetic-refresh-2');
      assert.ok(rows[0].refreshed_at);
    });

    test('health reports the mode and the connections', async () => {
      const health = await integrations.whenEnabled('xero', (adapter) => adapter.capabilities.health());
      const { calls, ...rest } = health;
      assert.deepEqual(rest, { ok: true, mode: 'replay', writesAllowed: true, connected: 1 });
      // The call guard's state for the one connected organisation.
      assert.equal(calls.length, 1);
      assert.equal(calls[0].circuit, 'closed');
      assert.deepEqual(calls[0].stoppedResources, []);
      assert.equal(calls[0].dailyFailureBudget, 50);
    });

    test('only an owner can disconnect; it revokes the token and forgets the connection', async () => {
      const refused = await request(app, '/api/xero/disconnect', { token: lab.staffToken, method: 'POST', body: { organisationId: lab.organisation.id } });
      assert.equal(refused.status, 403);
      const res = await request(app, '/api/xero/disconnect', { token: lab.ownerToken, method: 'POST', body: { organisationId: lab.organisation.id } });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, disconnected: true, revoked: true });
      const revoke = replay.fetch.calls.find((call) => call.path === '/connect/revocation');
      assert.match(revoke.body, /token=synthetic-refresh-2/);
      assert.equal((await handle.db.execute(sql`select count(*)::int as n from xero_connections`)).rows[0].n, 0);
      await assert.rejects(replay.runtime.clientFor(handle.db, lab.organisation.id), (error) => error.code === 'xero_not_connected');
    });

    test('no token ever reaches the log', () => {
      assert.ok(replay.log.lines.some((line) => /connected to Xero tenant/.test(line)));
      for (const line of replay.log.lines) assert.doesNotMatch(line, /synthetic-(refresh|access)/);
    });
  });

  test('a sandbox refuses a Xero organisation that is not a Demo Company, and revokes the grant', async () => {
    await handle.pool.query('delete from xero_connections');
    const replay = xeroRuntime([tokenAnswer(1), connectionsAnswer(), organisationAnswer('PREMIUM'), revokeAnswer()], {
      XERO_MODE: 'sandbox', XERO_CLIENT_ID: 'synthetic-id', XERO_CLIENT_SECRET: 'synthetic-secret',
    });
    const { app, clerk } = await bootFlow(handle, { runtime: replay.runtime, log: replay.log });
    const ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    const [organisation] = (await handle.db.execute(sql`select id from organisations limit 1`)).rows;
    const { back } = await connect(app, ownerToken, organisation.id);
    assert.equal(back.status, 409);
    assert.match(back.text, /not one/);
    assert.ok(replay.fetch.calls.some((call) => call.path === '/connect/revocation'));
    assert.equal((await handle.db.execute(sql`select count(*)::int as n from xero_connections`)).rows[0].n, 0);
  });

  test('live refuses an organisation other than the one XERO_TENANT_NAME names', async () => {
    const replay = xeroRuntime([tokenAnswer(1), connectionsAnswer([{ tenantId: TENANT, tenantName: 'Other Lab', tenantType: 'ORGANISATION' }]), revokeAnswer()], {
      XERO_MODE: 'live', XERO_CLIENT_ID: 'synthetic-id', XERO_CLIENT_SECRET: 'synthetic-secret', XERO_TENANT_NAME: 'Example Lab',
    });
    const { app, clerk } = await bootFlow(handle, { runtime: replay.runtime, log: quietLog() });
    const ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    const [organisation] = (await handle.db.execute(sql`select id from organisations limit 1`)).rows;
    const { back } = await connect(app, ownerToken, organisation.id);
    assert.equal(back.status, 409);
    assert.match(back.text, /was not among the ones approved/);
    assert.equal((await handle.db.execute(sql`select count(*)::int as n from xero_connections`)).rows[0].n, 0);
  });

  test('a connection made in another mode is not used', async () => {
    const { runtime } = xeroRuntime([]);
    const [organisation] = (await handle.db.execute(sql`select id from organisations limit 1`)).rows;
    await handle.db.execute(sql`insert into xero_connections (organisation_id, mode, tenant_id, refresh_token_enc) values (${organisation.id}, 'sandbox', ${TENANT}, 'v1:x:y:z')`);
    await assert.rejects(runtime.clientFor(handle.db, organisation.id), (error) => error.code === 'xero_mode_changed');
  });

  test('an invalid grant asks an owner to connect again', async () => {
    const { runtime } = xeroRuntime([xeroAnswer('https://identity.xero.com/connect/token', { error: 'invalid_grant' }, { method: 'POST', status: 400 })]);
    const [organisation] = (await handle.db.execute(sql`select id from organisations limit 1`)).rows;
    await handle.pool.query('delete from xero_connections');
    const { saveConnection } = await import('../server/integrations/xero/connections.js');
    await saveConnection(handle.db, { organisationId: organisation.id, mode: 'replay', tenantId: TENANT, tenantName: null, scope: null, refreshToken: 'synthetic-refresh-old', connectedBy: null, key: KEY });
    const { client } = await runtime.clientFor(handle.db, organisation.id);
    await assert.rejects(client.getOrganisation(), (error) => error.code === 'xero_reconnect_needed');
  });
});
