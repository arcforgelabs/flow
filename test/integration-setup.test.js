import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { createPersonAuth } from '../server/auth/session.js';
import { decodeKey, openSecret, resolveSecretsKey, sealSecret } from '../server/core/secrets.js';
import { adapters as shippedAdapters } from '../server/integrations/adapters.js';
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
  test('a key accepts hex or base64 for exactly 32 bytes', () => {
    const bytes = Buffer.from(KEY, 'hex');
    for (const raw of [KEY.toUpperCase(), ` \n${KEY}\t`, bytes.toString('base64'), bytes.toString('base64').replace(/=$/, '')]) {
      assert.ok(decodeKey(raw)?.equals(bytes), 'the decoded key must keep the original bytes');
    }
    for (const raw of [undefined, null, '', '  ', 'g'.repeat(64), 'ab'.repeat(31), 'ab'.repeat(33), Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')]) {
      assert.equal(decodeKey(raw), null, 'an invalid key must be refused');
    }
  });

  test('FLOW_SECRETS_KEY wins; a long SESSION_SECRET is the fallback; a bad key stops boot', () => {
    const explicit = resolveSecretsKey({ FLOW_SECRETS_KEY: ` ${KEY} `, SESSION_SECRET: 'x'.repeat(40) });
    assert.equal(explicit.source, 'FLOW_SECRETS_KEY');
    assert.ok(explicit.key.equals(Buffer.from(KEY, 'hex')), 'the explicit key must win over the session secret');
    const fallback = resolveSecretsKey({ FLOW_SECRETS_KEY: ' ', SESSION_SECRET: ` ${'x'.repeat(32)} ` });
    assert.equal(fallback.source, 'SESSION_SECRET');
    assert.equal(resolveSecretsKey({ SESSION_SECRET: 'x'.repeat(31) }), null);
    assert.equal(resolveSecretsKey({}), null);
    assert.throws(() => resolveSecretsKey({ FLOW_SECRETS_KEY: 'nope', SESSION_SECRET: 'x'.repeat(40) }), /FLOW_SECRETS_KEY must be/);
    const sealed = sealSecret(fallback, SECRET, 'integration:xero:XERO_CLIENT_SECRET');
    const restarted = resolveSecretsKey({ SESSION_SECRET: 'x'.repeat(32) });
    assert.equal(openSecret(restarted, sealed, 'integration:xero:XERO_CLIENT_SECRET'), SECRET);
  });

  test('a sealed value opens only with the same key and the same setting', () => {
    const secrets = resolveSecretsKey({ FLOW_SECRETS_KEY: KEY });
    const sealed = sealSecret(secrets, SECRET, 'integration:seazona:SEAZONA_API_CLIENT_SECRET');
    assert.doesNotMatch(JSON.stringify(sealed), /synthetic-client-secret/);
    assert.equal(openSecret(secrets, sealed, 'integration:seazona:SEAZONA_API_CLIENT_SECRET'), SECRET);
    assert.throws(() => openSecret(secrets, sealed, 'integration:seazona:SEAZONA_API_CLIENT_ID'), (e) => e.code === 'secret_unreadable');
    assert.throws(() => openSecret(secrets, sealed, 'integration:xero:XERO_CLIENT_SECRET'), (e) => e.code === 'secret_unreadable');
    const other = resolveSecretsKey({ FLOW_SECRETS_KEY: 'ef'.repeat(32) });
    assert.throws(() => openSecret(other, sealed, 'integration:seazona:SEAZONA_API_CLIENT_SECRET'), (e) => e.code === 'secret_unreadable');
  });

  test('a changed sealed value is refused, and repeated seals use fresh nonces', () => {
    const secrets = resolveSecretsKey({ FLOW_SECRETS_KEY: KEY });
    const context = 'integration:xero:XERO_CLIENT_SECRET';
    const sealed = sealSecret(secrets, SECRET, context);
    const repeated = sealSecret(secrets, SECRET, context);
    assert.notEqual(repeated.iv, sealed.iv);
    assert.equal(openSecret(secrets, repeated, context), SECRET);
    for (const field of ['data', 'tag', 'iv']) {
      const bytes = Buffer.from(sealed[field], 'base64');
      bytes[0] ^= 1;
      assert.throws(
        () => openSecret(secrets, { ...sealed, [field]: bytes.toString('base64') }, context),
        (error) => error.code === 'secret_unreadable',
      );
    }
    assert.throws(() => openSecret(secrets, { ...sealed, v: 2 }, context), (error) => error.code === 'secret_unreadable');
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

  test('the shipped adapters merge with a secrets key and nothing stored, as at a first start', () => {
    // Seazona's setup names no derived keys. With a secrets key this once
    // stopped boot: "adapter.setup.derivedKeys is not iterable".
    const secrets = resolveSecretsKey({ SESSION_SECRET: 'x'.repeat(40) });
    const { env, unreadable } = settingsEnvironment({ env: {}, stored: new Map(), adapters: shippedAdapters, secrets });
    assert.match(env.XERO_TOKEN_KEY, /^[0-9a-f]{64}$/);
    assert.deepEqual(unreadable, []);
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
