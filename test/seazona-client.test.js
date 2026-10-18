import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createSeazonaClient, deriveClientKey, parseRetryAfterMs, SeazonaApiError } from '../server/integrations/seazona/client.js';
import { normaliseRequestPath } from '../server/integrations/seazona/governor.js';
import { createReplayFetch } from '../server/integrations/seazona/replay.js';
import { describeSeazonaSettings, normaliseBaseUrl, resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';

// Synthetic data only (CONTRIBUTING.md). No test reaches a network: every
// client here answers from a replay, and global fetch throws if anything
// tries it.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function forbidNetwork() {
  globalThis.fetch = () => {
    throw new Error('a test tried to reach the network');
  };
}

// A governor that keeps its ledger in memory, so these tests need no database.
function memoryGovernor() {
  const admitted = [];
  const responses = [];
  return {
    admitted,
    responses,
    async reserve({ workflow, isRetry }) {
      admitted.push({ workflow, isRetry });
      return { requestId: admitted.length };
    },
    async recordResponse(entry) {
      responses.push(entry);
    },
  };
}

const replaySettings = (overrides = {}) => ({
  ...resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: '/dev/null' }),
  ...overrides,
});

function replayClient(responses, extra = {}) {
  const fetchImpl = createReplayFetch({ responses });
  const governor = memoryGovernor();
  const client = createSeazonaClient({
    settings: replaySettings(),
    fetchImpl,
    governor,
    sleepFn: async () => {},
    random: () => 0,
    ...extra,
  });
  return { client, fetchImpl, governor };
}

describe('Seazona settings', () => {
  test('there is no default mode: unset means not configured', () => {
    const settings = resolveSeazonaSettings({});
    assert.equal(settings.mode, null);
    assert.equal(settings.scheduled, false);
    assert.deepEqual(describeSeazonaSettings(settings), {
      mode: null, configured: false, scheduled: false, requestsPerMinute: 30, publishedLimitPerMinute: 60,
    });
  });

  test('an unknown mode stops the adapter', () => {
    assert.throws(() => resolveSeazonaSettings({ SEAZONA_MODE: 'production' }), /SEAZONA_MODE must be one of live, sandbox, replay/);
  });

  test('live and sandbox need an https address and both credentials', () => {
    for (const mode of ['live', 'sandbox']) {
      assert.throws(() => resolveSeazonaSettings({ SEAZONA_MODE: mode }), /SEAZONA_API_BASE_URL is required/);
      assert.throws(
        () => resolveSeazonaSettings({ SEAZONA_MODE: mode, SEAZONA_API_BASE_URL: 'https://api.example.test' }),
        /SEAZONA_API_CLIENT_ID and SEAZONA_API_CLIENT_SECRET are required/,
      );
    }
    assert.throws(() => normaliseBaseUrl('http://api.example.test'), /must use https/);
    assert.throws(() => normaliseBaseUrl('https://user:pw@api.example.test'), /plain address/);
    assert.equal(normaliseBaseUrl('https://api.example.test'), 'https://api.example.test/v1');
    assert.equal(normaliseBaseUrl('https://api.example.test/v1/'), 'https://api.example.test/v1');
  });

  test('only live mode runs on a timer', () => {
    const env = { SEAZONA_API_BASE_URL: 'https://api.example.test', SEAZONA_API_CLIENT_ID: 'id-example', SEAZONA_API_CLIENT_SECRET: 'secret-example' };
    assert.equal(resolveSeazonaSettings({ ...env, SEAZONA_MODE: 'live' }).scheduled, true);
    assert.equal(resolveSeazonaSettings({ ...env, SEAZONA_MODE: 'sandbox' }).scheduled, false);
    assert.equal(resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: 'x.json' }).scheduled, false);
    assert.throws(() => resolveSeazonaSettings({ SEAZONA_MODE: 'replay' }), /SEAZONA_REPLAY_FILE is required/);
  });

  test('a setting can lower the rate but never raise it above 30 a minute', () => {
    assert.equal(resolveSeazonaSettings({ SEAZONA_API_REQUESTS_PER_MINUTE: '60' }).rate.requestsPerMinute, 30);
    assert.equal(resolveSeazonaSettings({ SEAZONA_API_REQUESTS_PER_MINUTE: '12' }).rate.requestsPerMinute, 12);
  });
});

describe('Seazona client', () => {
  test('replay mode never reaches the network', async () => {
    forbidNetwork();
    const { client, fetchImpl } = replayClient([{ path: 'products/', body: [{ id: 'P-1', name: 'Example crown' }] }]);
    assert.deepEqual(await client.get('products/'), [{ id: 'P-1', name: 'Example crown' }]);
    assert.deepEqual(fetchImpl.calls, [{ method: 'GET', path: 'products/', query: {} }]);
  });

  test('live and sandbox clients refuse to run without the rate governor', () => {
    const settings = resolveSeazonaSettings({
      SEAZONA_MODE: 'sandbox',
      SEAZONA_API_BASE_URL: 'https://api.example.test',
      SEAZONA_API_CLIENT_ID: 'id-example',
      SEAZONA_API_CLIENT_SECRET: 'secret-example',
    });
    assert.throws(() => createSeazonaClient({ settings, fetchImpl: async () => {} }), /needs the rate governor in sandbox mode/);
    assert.throws(() => createSeazonaClient({ settings: { mode: null } }), /needs a mode/);
  });

  test('every attempt goes through the governor, and a 5xx is retried', async () => {
    const { client, governor } = replayClient([
      { path: 'orders/ORD-1', sequence: [{ status: 503 }, { status: 200, body: { id: 'ORD-1' } }] },
    ]);
    assert.deepEqual(await client.get('orders/ORD-1'), { id: 'ORD-1' });
    assert.deepEqual(governor.admitted.map((a) => a.isRetry), [false, true]);
    assert.deepEqual(governor.responses.map((r) => r.statusCode), [503, 200]);
    assert.equal(client.stats.retries, 1);
  });

  test('a 429 passes its Retry-After to the governor as a cooldown', async () => {
    const { client, governor } = replayClient([
      { path: 'clients/', sequence: [{ status: 429, headers: { 'retry-after': '7' } }, { status: 200, body: [] }] },
    ]);
    assert.deepEqual(await client.get('clients/'), []);
    assert.equal(governor.responses[0].retryAfterMs, 7_000);
    assert.equal(client.stats.rateLimited, 1);
  });

  test('a 404 is an error with its status, after one request', async () => {
    const { client, governor } = replayClient([{ path: 'orders/ORD-404', status: 404 }]);
    await assert.rejects(client.get('orders/ORD-404'), (error) => {
      assert.ok(error instanceof SeazonaApiError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.kind, 'http');
      return true;
    });
    assert.equal(governor.admitted.length, 1);
  });

  test('retries stop at the setting and the last status is the error', async () => {
    const { client, governor } = replayClient([{ path: 'orders/ORD-500', status: 500 }]);
    await assert.rejects(client.get('orders/ORD-500'), { statusCode: 500 });
    assert.equal(governor.admitted.length, 3); // first try and two retries (SEAZONA_API_MAX_RETRIES default 2)
  });

  test('an empty body is null, and bad JSON, timeouts and replay misses are named failures', async () => {
    const { client, governor } = replayClient([
      { path: 'orders/ORD-EMPTY', status: 200, rawBody: '' },
      { path: 'orders/ORD-BAD', status: 200, rawBody: '{not json' },
      { path: 'orders/ORD-SLOW', error: 'timeout' },
    ]);
    assert.equal(await client.get('orders/ORD-EMPTY'), null);
    await assert.rejects(client.get('orders/ORD-BAD'), { kind: 'invalid_json' });
    await assert.rejects(client.get('orders/ORD-SLOW'), { kind: 'timeout' });
    await assert.rejects(client.get('orders/ORD-NONE'), { kind: 'replay_miss' });
    assert.deepEqual(governor.responses.slice(2).map((r) => r.failureKind), ['timeout', 'replay_miss']);
  });

  test('errors and telemetry carry the path only, never the host, query or credentials', async () => {
    const fetchImpl = createReplayFetch({ responses: [{ path: 'invoices/', query: { lastModified: '*' }, status: 403 }] });
    const governor = memoryGovernor();
    const settings = resolveSeazonaSettings({
      SEAZONA_MODE: 'sandbox',
      SEAZONA_API_BASE_URL: 'https://tenant.example.test',
      SEAZONA_API_CLIENT_ID: 'id-example',
      SEAZONA_API_CLIENT_SECRET: 'secret-example',
    });
    const client = createSeazonaClient({ settings, fetchImpl, governor, sleepFn: async () => {} });
    const error = await client.get('invoices/', { lastModified: '2026-01-01T00:00:00Z' }).catch((e) => e);
    assert.equal(error.message, 'Seazona GET /v1/invoices/ failed with HTTP 403');
    const told = JSON.stringify({ message: error.message, path: error.path, responses: governor.responses });
    for (const secret of ['tenant.example.test', 'lastModified', 'id-example', 'secret-example', '2026-01-01']) {
      assert.ok(!told.includes(secret), `leaked ${secret}`);
    }
    assert.equal(normaliseRequestPath('https://tenant.example.test/v1/orders/ORD-1?x=1'), '/v1/orders/ORD-1');
  });

  test('sandbox sends basic authentication to the configured address', async () => {
    const seen = [];
    const settings = resolveSeazonaSettings({
      SEAZONA_MODE: 'sandbox',
      SEAZONA_API_BASE_URL: 'https://api.example.test/',
      SEAZONA_API_CLIENT_ID: 'id-example',
      SEAZONA_API_CLIENT_SECRET: 'secret-example',
    });
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization, method: init.method });
      return new Response('[]', { status: 200 });
    };
    const client = createSeazonaClient({ settings, fetchImpl, governor: memoryGovernor() });
    await client.get('orders/', { ordered: '2026-10-01T00:00:00', empty: '' });
    assert.deepEqual(seen, [{
      url: 'https://api.example.test/v1/orders/?ordered=2026-10-01T00%3A00%3A00',
      auth: `Basic ${Buffer.from('id-example:secret-example').toString('base64')}`,
      method: 'GET',
    }]);
    assert.match(deriveClientKey(settings), /^[0-9a-f]{24}$/);
  });

  test('Retry-After takes seconds or a date', () => {
    assert.equal(parseRetryAfterMs('2'), 2_000);
    assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', Date.parse('2026-01-01T00:00:00Z')), 10_000);
    assert.equal(parseRetryAfterMs(''), null);
  });
});
