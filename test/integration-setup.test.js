import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { createPersonAuth } from '../server/auth/session.js';
import { openSecret, resolveSecretsKey, sealSecret } from '../server/core/secrets.js';
import { createIntegrations } from '../server/integrations/index.js';
import { createSeazonaAdapter } from '../server/integrations/seazona/index.js';
import { readStoredSettings, settingsEnvironment } from '../server/integrations/setup.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { quietLog, seedLab } from './support/xero.js';

// An owner turns an integration on and enters its settings in Flow. Synthetic
// values only; Seazona is never called (sandbox mode starts no sync).

const KEY = 'cd'.repeat(32);
const SECRET = 'synthetic-client-secret-0001';

describe('the secrets key', () => {
  test('FLOW_SECRETS_KEY wins; a long SESSION_SECRET is the fallback; a bad key stops boot', () => {
    assert.equal(resolveSecretsKey({ FLOW_SECRETS_KEY: KEY }).source, 'FLOW_SECRETS_KEY');
    assert.equal(resolveSecretsKey({ SESSION_SECRET: 'x'.repeat(40) }).source, 'SESSION_SECRET');
    assert.equal(resolveSecretsKey({ SESSION_SECRET: 'short' }), null);
    assert.equal(resolveSecretsKey({}), null);
    assert.throws(() => resolveSecretsKey({ FLOW_SECRETS_KEY: 'nope' }), /FLOW_SECRETS_KEY must be/);
  });

  test('a sealed value opens only with the same key and the same setting', () => {
    const secrets = resolveSecretsKey({ FLOW_SECRETS_KEY: KEY });
    const sealed = sealSecret(secrets, SECRET, 'integration:seazona:SEAZONA_API_CLIENT_SECRET');
    assert.doesNotMatch(JSON.stringify(sealed), /synthetic-client-secret/);
    assert.equal(openSecret(secrets, sealed, 'integration:seazona:SEAZONA_API_CLIENT_SECRET'), SECRET);
    assert.throws(() => openSecret(secrets, sealed, 'integration:xero:XERO_CLIENT_SECRET'), (e) => e.code === 'secret_unreadable');
    const other = resolveSecretsKey({ FLOW_SECRETS_KEY: 'ef'.repeat(32) });
    assert.throws(() => openSecret(other, sealed, 'integration:seazona:SEAZONA_API_CLIENT_SECRET'), (e) => e.code === 'secret_unreadable');
  });

  test('the host environment wins over stored settings, and a derived key appears only with a secrets key', () => {
    const secrets = resolveSecretsKey({ FLOW_SECRETS_KEY: KEY });
    const adapter = { id: 'xero', setup: { fields: [{ name: 'XERO_MODE' }, { name: 'XERO_CLIENT_SECRET', secret: true }], derivedKeys: ['XERO_TOKEN_KEY'] } };
    const stored = new Map([['xero', { config: { XERO_MODE: 'sandbox' }, secrets: { XERO_CLIENT_SECRET: sealSecret(secrets, 's', 'integration:xero:XERO_CLIENT_SECRET') } }]]);
    const { env } = settingsEnvironment({ env: { XERO_MODE: 'live' }, stored, adapters: [adapter], secrets });
    assert.equal(env.XERO_MODE, 'live');
    assert.equal(env.XERO_CLIENT_SECRET, 's');
    assert.match(env.XERO_TOKEN_KEY, /^[0-9a-f]{64}$/);
    const without = settingsEnvironment({ env: {}, stored, adapters: [adapter], secrets: null });
    assert.equal(without.env.XERO_TOKEN_KEY, undefined);
    assert.deepEqual(without.unreadable, ['xero:XERO_CLIENT_SECRET']);
  });
});

describe('Settings, Integrations', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let integrations;
  const secrets = resolveSecretsKey({ FLOW_SECRETS_KEY: KEY });

  before(async () => {
    handle = await freshDatabase();
    const log = quietLog();
    integrations = createIntegrations({ env: {}, settingsEnv: {}, adapters: [createSeazonaAdapter({ fetchImpl: async () => { throw new Error('no network in tests'); } })], log });
    await integrations.start(handle.db);
    const clerk = fakeClerk();
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log });
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, secrets, log });
    lab = await seedLab(handle, clerk);
  });
  after(async () => {
    await integrations?.stop();
    await handle?.close();
  });

  const put = (token, body) => request(app, '/api/integrations/seazona', { token, method: 'PUT', body });

  test('only an owner sees or changes integration settings', async () => {
    assert.equal((await request(app, '/api/integrations', { token: lab.staffToken })).status, 403);
    assert.equal((await put(lab.staffToken, { enabled: true })).status, 403);
  });

  test('turned on with a setting missing, it reports what is missing and Flow keeps running', async () => {
    const res = await put(lab.ownerToken, { enabled: true, values: { SEAZONA_MODE: 'sandbox' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.integration.state, 'failed');
    assert.match(res.body.integration.error, /SEAZONA_API_BASE_URL|SEAZONA_API_CLIENT/);
    assert.equal(integrations.list().find((a) => a.id === 'seazona').state, 'failed');
    assert.equal((await request(app, '/health')).status, 200, 'Flow keeps running');
  });

  test('with every setting, it starts at once; the secret is stored sealed and never shown', async () => {
    const res = await put(lab.ownerToken, {
      values: {
        SEAZONA_API_BASE_URL: 'https://seazona.example.test/v1',
        SEAZONA_API_CLIENT_ID: 'synthetic-client-id',
        SEAZONA_API_CLIENT_SECRET: SECRET,
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.integration.state, 'ready', res.body.integration.error);
    assert.doesNotMatch(JSON.stringify(res.body), /synthetic-client-secret/);
    const secretField = res.body.integration.fields.find((f) => f.name === 'SEAZONA_API_CLIENT_SECRET');
    assert.deepEqual({ set: secretField.set, source: secretField.source, value: secretField.value }, { set: true, source: 'flow', value: undefined });

    const { rows } = await handle.pool.query('select * from integration_settings');
    assert.doesNotMatch(JSON.stringify(rows), /synthetic-client-secret/);
    const { rows: events } = await handle.pool.query('select kind, settings from integration_setting_events order by created_at, kind');
    assert.ok(events.some((e) => e.kind === 'secret_set' && e.settings.includes('SEAZONA_API_CLIENT_SECRET')));
    assert.ok(events.some((e) => e.kind === 'turned_on'));

    const list = await request(app, '/api/integrations', { token: lab.ownerToken });
    assert.equal(list.body.secretsKey.source, 'FLOW_SECRETS_KEY');
    assert.doesNotMatch(list.text, /synthetic-client-secret/);
    const stored = await readStoredSettings(handle.db);
    assert.equal(stored.get('seazona').enabled, true);
  });

  test('bad values are refused before anything is stored', async () => {
    assert.equal((await put(lab.ownerToken, { values: { SEAZONA_MODE: 'replay' } })).status, 400);
    assert.equal((await put(lab.ownerToken, { values: { SEAZONA_API_BASE_URL: 'http://plain.example.test' } })).status, 400);
    assert.equal((await put(lab.ownerToken, { values: { NOT_A_SETTING: 'x' } })).status, 400);
    assert.equal((await put(lab.ownerToken, { values: { SEAZONA_API_CLIENT_SECRET: 'two words' } })).status, 400);
  });

  test('turned off, it stops at once and keeps its settings', async () => {
    const res = await put(lab.ownerToken, { enabled: false });
    assert.equal(res.body.integration.state, 'disabled');
    assert.equal(res.body.integration.fields.find((f) => f.name === 'SEAZONA_API_CLIENT_SECRET').set, true);
  });
});
