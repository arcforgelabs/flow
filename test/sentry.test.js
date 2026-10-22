import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import * as SentryNode from '@sentry/node';
import express from 'express';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createMonitoredLog } from '../server/core/monitoring.js';
import { adapters } from '../server/integrations/adapters.js';
import { createRegistry } from '../server/integrations/port.js';
import { createTracing, requestName, sqlName, traceQueries } from '../server/core/tracing.js';
import { createSentryAdapter, readSentrySettings, SENTRY_BROWSER, SENTRY_BROWSER_REPLAY, SENTRY_BROWSER_TRACING, sentryRelease } from '../server/integrations/sentry/index.js';
import { routePattern, scrubRecordingEvent, scrubSpan, tagNotify } from '../server/ui/monitoring.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// The Sentry adapter (docs/SENTRY.md), with the Sentry SDK faked: nothing
// leaves the test. Synthetic data only (CONTRIBUTING.md).
const DSN = 'https://0123456789abcdef0123456789abcdef@o1.ingest.example.test/42';
const quiet = { info() {}, warn() {}, error() {} };

function fakeSdk() {
  const calls = [];
  return {
    calls,
    init: (options) => calls.push(['init', options]),
    captureEvent: (event) => calls.push(['event', event]),
    captureException: (error, scope) => calls.push(['exception', error, scope]),
    close: async () => calls.push(['close']),
    startSpan: (options, work) => { calls.push(['span', options]); return work(); },
    getActiveSpan: () => ({ id: 'request' }),
    getRootSpan: (span) => ({ root: span.id }),
    updateSpanName: (span, name) => calls.push(['name', span, name]),
  };
}

test('with the real SDK, a logged line reaches Sentry as the title, with no stack to name it', async () => {
  // Sentry names an event that has a stack after its top frame. A logged
  // line must keep its own words, or every issue reads "Object.captureError".
  const sent = [];
  const sdk = { ...SentryNode, init: (options) => SentryNode.init({ ...options, beforeSend: (event) => { sent.push(event); return null; } }) };
  const adapter = createSentryAdapter({ sdk, env: {} });
  await adapter.start({ log: quiet, env: { SENTRY_DSN: DSN } });
  try {
    adapter.capabilities.captureError({ message: '[seazona] read failed', source: 'seazona' });
    await SentryNode.flush(1000);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message, '[seazona] read failed');
    assert.equal(sent[0].exception, undefined);
    assert.equal(sent[0].level, 'error');
    assert.equal(sent[0].tags.source, 'seazona');
  } finally {
    await adapter.stop();
  }
});

test('Flow ships the Sentry adapter, with no DSN of its own', () => {
  const sentry = adapters.find((a) => a.id === 'sentry');
  assert.ok(sentry);
  assert.deepEqual(sentry.setup.fields.map((f) => f.name), ['SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_CLIENT', 'SENTRY_FEEDBACK', 'SENTRY_REPLAY', 'SENTRY_TRACES_SAMPLE_RATE']);
  assert.equal(sentry.schema, undefined);
});

test('the settings need a Sentry DSN; environment and the report button have defaults', () => {
  assert.throws(() => readSentrySettings({}), /SENTRY_DSN is not set/);
  assert.throws(() => readSentrySettings({ SENTRY_DSN: 'https://example.test/1' }), /not a Sentry DSN/);
  assert.deepEqual(readSentrySettings({ SENTRY_DSN: DSN }), { dsn: DSN, environment: 'production', feedback: true, replay: true, tracesSampleRate: 0.2, tags: { product: 'flow' } });
  assert.deepEqual(readSentrySettings({ SENTRY_DSN: ` ${DSN} `, SENTRY_ENVIRONMENT: 'staging', SENTRY_FEEDBACK: 'off', SENTRY_REPLAY: 'off', SENTRY_TRACES_SAMPLE_RATE: '0' }), { dsn: DSN, environment: 'staging', feedback: false, replay: false, tracesSampleRate: 0, tags: { product: 'flow' } });
  assert.deepEqual(readSentrySettings({ SENTRY_DSN: DSN, SENTRY_CLIENT: ' Example Lab ' }).tags, { product: 'flow', client: 'Example Lab' });
  assert.throws(() => readSentrySettings({ SENTRY_DSN: DSN, SENTRY_CLIENT: 'a\nb' }), /SENTRY_CLIENT must be one short line/);
});

test('the traces setting is a share from 0 to 1', () => {
  for (const [rate, expected] of [['1', 1], ['0.05', 0.05], ['.5', 0.5], [' ', 0.2]]) {
    assert.equal(readSentrySettings({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: rate }).tracesSampleRate, expected);
  }
  for (const rate of ['2', '-0.1', 'all', '0x1', '1e-1']) {
    assert.throws(() => readSentrySettings({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: rate }), /SENTRY_TRACES_SAMPLE_RATE must be a number from 0 to 1/);
  }
});

test('the release is the Flow release tag, else the commit', () => {
  assert.equal(sentryRelease({ FLOW_DEPLOYED_RELEASE: 'v2026.10.26' }), 'flow@2026.10.26');
  assert.equal(sentryRelease({ FLOW_RELEASE: '2026.10.26' }), 'flow@2026.10.26');
  assert.equal(sentryRelease({ FLOW_REVISION: '0123456789abcdef' }), 'flow@0123456789ab');
  assert.equal(sentryRelease({}), null);
});

test('the browser SDK is pinned with an integrity hash', () => {
  assert.match(SENTRY_BROWSER.src, /^https:\/\/browser\.sentry-cdn\.com\/\d+\.\d+\.\d+\/bundle\.feedback\.min\.js$/);
  assert.match(SENTRY_BROWSER.integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.match(SENTRY_BROWSER_TRACING.src, /^https:\/\/browser\.sentry-cdn\.com\/\d+\.\d+\.\d+\/bundle\.tracing\.replay\.feedback\.min\.js$/);
  assert.match(SENTRY_BROWSER_TRACING.integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.match(SENTRY_BROWSER_REPLAY.src, /^https:\/\/browser\.sentry-cdn\.com\/\d+\.\d+\.\d+\/bundle\.replay\.feedback\.min\.js$/);
  assert.match(SENTRY_BROWSER_REPLAY.integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
  // One SDK version for every bundle.
  assert.equal(SENTRY_BROWSER.src.split('/')[3], SENTRY_BROWSER_TRACING.src.split('/')[3]);
  assert.equal(SENTRY_BROWSER.src.split('/')[3], SENTRY_BROWSER_REPLAY.src.split('/')[3]);
});

test('the adapter starts the SDK without personal data, and sends errors only while started', async () => {
  const sdk = fakeSdk();
  const adapter = createSentryAdapter({ sdk, env: { FLOW_RELEASE: '2026.10.26' } });
  adapter.capabilities.captureError({ message: 'before start' });
  assert.equal(adapter.capabilities.browserMonitoring(), null);
  assert.equal(sdk.calls.length, 0);

  await adapter.start({ log: quiet, env: { SENTRY_DSN: DSN } });
  const [, options] = sdk.calls[0];
  assert.equal(options.dsn, DSN);
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.release, 'flow@2026.10.26');
  assert.equal(options.environment, 'production');
  assert.deepEqual(options.initialScope, { tags: { product: 'flow' } });
  assert.equal(options.beforeSendSpan, scrubSpan);
  // The host's health check is never traced; a browser's choice is kept.
  const sampled = (path) => options.tracesSampler({ attributes: { 'url.path': path }, inheritOrSampleWith: (rate) => rate });
  assert.equal(sampled('/health'), 0);
  assert.equal(sampled('/api/invoicing/invoices'), 0.2);

  adapter.capabilities.captureError({ message: '[seazona] read failed', source: 'seazona' });
  const boom = new Error('boom');
  adapter.capabilities.captureError({ message: '[http] boom', source: 'http', error: boom });
  assert.deepEqual(sdk.calls[1], ['event', { message: '[seazona] read failed', level: 'error', tags: { source: 'seazona' } }]);
  assert.equal(sdk.calls[2][0], 'exception');
  assert.equal(sdk.calls[2][1], boom);
  assert.deepEqual(sdk.calls[2][2].tags, { source: 'http' });

  assert.deepEqual(adapter.capabilities.browserMonitoring(), {
    dsn: DSN, environment: 'production', release: 'flow@2026.10.26', feedback: true, replay: true, tags: { product: 'flow' }, tracesSampleRate: 0.2, script: SENTRY_BROWSER_TRACING,
  });
  assert.deepEqual(await adapter.capabilities.health(), { ok: true, environment: 'production', feedback: true });

  await adapter.stop();
  assert.deepEqual(sdk.calls.at(-1), ['close']);
  assert.equal(adapter.capabilities.browserMonitoring(), null);
});

test('with traces at 0 the adapter traces nothing and the browser loads the SDK without tracing', async () => {
  const sdk = fakeSdk();
  const adapter = createSentryAdapter({ sdk, env: {} });
  await adapter.start({ log: quiet, env: { SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '0' } });
  assert.equal(adapter.capabilities.browserMonitoring().script, SENTRY_BROWSER_REPLAY);
  assert.equal(adapter.capabilities.traceRequest(), null);
  assert.equal(adapter.capabilities.traceSpan({ name: 'q', op: 'db' }, () => 7), 7);
  assert.equal(sdk.calls.filter(([kind]) => kind === 'span').length, 0);
});

test('with replay and traces off the browser loads the smallest SDK', async () => {
  const adapter = createSentryAdapter({ sdk: fakeSdk(), env: {} });
  await adapter.start({ log: quiet, env: { SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '0', SENTRY_REPLAY: 'off' } });
  assert.equal(adapter.capabilities.browserMonitoring().replay, false);
  assert.equal(adapter.capabilities.browserMonitoring().script, SENTRY_BROWSER);
});

test('a replay keeps no attribute values, element text or query strings', () => {
  const click = scrubRecordingEvent({ type: 5, data: { tag: 'breadcrumb', payload: {
    category: 'ui.click',
    message: 'main > li.row[title="Jane Citizen"] > button[aria-label="Delete Jane Citizen"]',
    data: { nodeId: 7, node: { id: 7, tagName: 'button', textContent: 'Jane', attributes: { id: 'del', class: 'icon', role: 'button', 'aria-label': 'Delete Jane Citizen', title: 'Jane' } } },
  } } });
  assert.equal(click.data.payload.message, 'main > li.row > button');
  assert.deepEqual(click.data.payload.data.node, { id: 7, tagName: 'button', textContent: '', attributes: { id: 'del', class: 'icon', role: 'button' } });
  assert.equal(click.data.tag, 'breadcrumb');

  const move = scrubRecordingEvent({ type: 5, data: { tag: 'breadcrumb', payload: { category: 'navigation', data: { from: '/invoices?q=Jane', to: '/clients/7#notes' } } } });
  assert.deepEqual(move.data.payload.data, { from: '/invoices', to: '/clients/7' });

  const span = scrubRecordingEvent({ type: 5, data: { tag: 'performanceSpan', payload: { op: 'navigation.navigate', description: 'https://flow.test/search?q=Jane' } } });
  assert.equal(span.data.payload.description, 'https://flow.test/search');

  const snapshot = { type: 2, data: { node: {} } };
  assert.equal(scrubRecordingEvent(snapshot), snapshot);
});

test('with traces on, spans join the request\'s trace and the request is named by its route', async () => {
  const sdk = fakeSdk();
  const adapter = createSentryAdapter({ sdk, env: {} });
  assert.equal(adapter.capabilities.traceRequest(), null);
  await adapter.start({ log: quiet, env: { SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '1' } });
  assert.equal(adapter.capabilities.traceSpan({ name: 'SELECT ?', op: 'db', attributes: {} }, () => 'rows'), 'rows');
  assert.deepEqual(sdk.calls.at(-1), ['span', { name: 'SELECT ?', op: 'db', attributes: {}, onlyIfParent: true }]);
  adapter.capabilities.traceRequest()('GET /api/invoicing/invoices/:id');
  assert.deepEqual(sdk.calls.at(-1), ['name', { root: 'request' }, 'GET /api/invoicing/invoices/:id']);
});

test('a trace span keeps timings and the route, never a query string, header, address or email', () => {
  const span = scrubSpan({
    name: 'GET /api/invoicing/search?q=Jane%20Citizen',
    attributes: {
      'sentry.op': 'http.client',
      'url.full': 'https://flow.example.test/api/invoicing/search?q=Jane',
      'url.path': '/api/invoicing/search',
      'url.query': 'q=Jane',
      'http.request.header.cookie': ['session=[Filtered]'],
      'http.response.header.set-cookie': ['x'],
      'client.address': '203.0.113.9',
      'network.peer.address': '203.0.113.9',
      'user.id': 'p1',
      'user.email': 'person@example.test',
      'user.ip_address': '203.0.113.9',
      'http.response.status_code': 200,
    },
  });
  assert.equal(span.name, 'GET /api/invoicing/search');
  assert.deepEqual(span.attributes, {
    'sentry.op': 'http.client',
    'url.full': 'https://flow.example.test/api/invoicing/search',
    'url.path': '/api/invoicing/search',
    'user.id': 'p1',
    'http.response.status_code': 200,
  });
  // A database span's SQL keeps its placeholders.
  assert.equal(scrubSpan({ name: 'SELECT ? FROM invoices WHERE id = $1', attributes: {} }).name, 'SELECT ? FROM invoices WHERE id = $1');
});

test('paths and SQL are named without the values in them', () => {
  assert.equal(routePattern('/invoices/123?q=Jane'), '/invoices/:id');
  assert.equal(routePattern('/api/x/0b9c6a3e-1f2d-4c5b-8a7e-9d0c1b2a3f4e/lines'), '/api/x/:id/lines');
  assert.equal(routePattern('/jobs/board'), '/jobs/board');
  assert.equal(sqlName("select $1::int, 'Jane Citizen' as n, 42 from xero_v2  where a = 3.5"), 'select $1::int, ? as n, ? from xero_v2 where a = ?');
  assert.equal(sqlName({ text: 'SELECT 1' }), 'SELECT ?');
  assert.equal(requestName({ method: 'GET', baseUrl: '/api/invoicing', route: { path: '/invoices/:id' }, originalUrl: '/api/invoicing/invoices/9' }), 'GET /api/invoicing/invoices/:id');
  assert.equal(requestName({ method: 'GET', originalUrl: '/invoices/9?x=1' }), 'GET /invoices/:id');
});

test('with no tracer on, tracing runs the work as it is', async () => {
  const tracing = createTracing();
  assert.equal(tracing.span('q', 'db', () => 3), 3);
  const queries = [];
  const pool = { query: async (...args) => { queries.push(args); return { rows: [] }; }, on() {} };
  traceQueries(pool, tracing);
  await pool.query('SELECT $1', [1]);
  assert.deepEqual(queries, [['SELECT $1', [1]]]);
});

test('each request is named by the route it matched, and each query gets a span', async () => {
  const names = [];
  const spans = [];
  const tracer = { capabilities: {
    traceRequest: () => (name) => names.push(name),
    traceSpan: ({ name, op }, work) => { spans.push([op, name]); return work(); },
  } };
  const tracing = createTracing({ tracers: () => [tracer] });
  let connected;
  const pool = { query: async () => ({ rows: [] }), on: (event, fn) => { connected = fn; } };
  traceQueries(pool, tracing);
  const client = { query: async () => ({ rows: [] }) };
  connected(client);
  const app = express();
  app.use(tracing.requests());
  const router = express.Router();
  router.get('/invoices/:id', async (_req, res) => {
    await pool.query('SELECT * FROM invoices WHERE id = $1', ['9']);
    await client.query({ text: "UPDATE invoices SET state = 'sent'" });
    // pg's own callback call inside the pool: no second span.
    pool.query('SELECT 1', () => {});
    res.json({ ok: true });
  });
  app.use('/api/invoicing', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await (await fetch(`http://127.0.0.1:${port}/api/invoicing/invoices/9?q=Jane`)).json();
    await (await fetch(`http://127.0.0.1:${port}/invoices/12`)).text();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    server.close();
  }
  assert.deepEqual(names, ['GET /api/invoicing/invoices/:id', 'GET /invoices/:id']);
  assert.deepEqual(spans, [['db', 'SELECT * FROM invoices WHERE id = $1'], ['db', 'UPDATE invoices SET state = ?']]);
});

test('a problem report is tagged notify=yes only when the person asks for a response and gives an email', () => {
  const report = (email) => ({ type: 'feedback', tags: { source: 'browser' }, contexts: { feedback: { message: 'It broke.', contact_email: email } } });
  const asked = report('person@example.test');
  tagNotify(asked, true);
  assert.deepEqual(asked.tags, { source: 'browser', notify: 'yes' });
  // The email is prefilled, so an address alone does not ask for a reply.
  for (const wantsResponse of [false, undefined]) {
    const prefilled = report('person@example.test');
    tagNotify(prefilled, wantsResponse);
    assert.equal(prefilled.tags.notify, 'no');
  }
  for (const email of [undefined, '', '  ']) {
    const noAddress = report(email);
    tagNotify(noAddress, true);
    assert.equal(noAddress.tags.notify, 'no');
  }
  const error = { type: undefined, tags: {} };
  tagNotify(error, true);
  assert.deepEqual(error.tags, {});
});

test('without a DSN the adapter does not start', async () => {
  const adapter = createSentryAdapter({ sdk: fakeSdk(), env: {} });
  await assert.rejects(adapter.start({ log: quiet, env: {} }), /SENTRY_DSN is not set/);
});

test('the monitored log passes every line on and sends each error with its source', () => {
  const lines = [];
  const sent = [];
  const reporter = { id: 'r', capabilities: { captureError: (event) => sent.push(event) } };
  let reporters = [];
  const log = createMonitoredLog({ log: { error: (...args) => lines.push(args), info() {}, warn() {} }, reporters: () => reporters });
  log.error('[xero] token refresh failed');
  assert.equal(sent.length, 0);
  reporters = [reporter];
  const cause = new Error('socket hang up');
  log.error('[seazona] read failed:', cause);
  log.error('no tag');
  assert.equal(lines.length, 3);
  assert.deepEqual(sent[0], { message: '[seazona] read failed: socket hang up', source: 'seazona', error: cause });
  assert.equal(sent[1].source, 'server');
});

test('a reporter that throws is warned about once a minute and never breaks logging', () => {
  const warnings = [];
  let clock = 0;
  const reporter = { id: 'r', capabilities: { captureError: () => { throw new Error('offline'); } } };
  const log = createMonitoredLog({ log: { error() {}, info() {}, warn: (line) => warnings.push(line) }, reporters: () => [reporter], now: () => clock });
  log.error('one');
  log.error('two');
  clock = 61_000;
  log.error('three');
  assert.equal(warnings.length, 2);
});

describe('monitoring API', { skip: skipWithoutDatabase }, () => {
  let handle;
  let clerk;
  let staffToken;
  const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };

  before(async () => {
    handle = await freshDatabase();
    clerk = fakeClerk();
    const owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await invitePerson(handle.db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    staffToken = clerk.signIn(clerk.addUser({ email: 'staff@example.test' }));
  });

  after(async () => handle?.close());

  async function appWith({ sentryOn, sdk = fakeSdk() }) {
    const integrations = createRegistry({ log: quiet, env: sentryOn ? { SENTRY_DSN: DSN } : {} });
    integrations.register(createSentryAdapter({ sdk, env: {} }));
    // An integration whose one route fails, to reach the app's last error handler.
    integrations.register({
      id: 'broken',
      name: 'Broken',
      capabilities: { health: async () => ({ ok: true }) },
      routes: () => express.Router().get('/boom', () => { throw new Error('boom 42'); }),
    });
    if (sentryOn) integrations.enable('sentry');
    integrations.enable('broken');
    await integrations.start(handle.db);
    const log = createMonitoredLog({ log: quiet, reporters: () => integrations.with('captureError') });
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    return { app: createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log }), sdk, integrations };
  }

  test('a browser learns the Sentry settings only when signed in and only while Sentry is on', async () => {
    const off = await appWith({ sentryOn: false });
    assert.equal((await request(off.app, '/api/monitoring')).status, 401);
    assert.deepEqual((await request(off.app, '/api/monitoring', { token: staffToken })).body, { ok: true, on: false });

    const on = await appWith({ sentryOn: true });
    const { body } = await request(on.app, '/api/monitoring', { token: staffToken });
    assert.equal(body.on, true);
    assert.equal(body.service, 'sentry');
    assert.equal(body.dsn, DSN);
    assert.equal(body.feedback, true);
    assert.equal(body.replay, true);
    assert.equal(body.tracesSampleRate, 0.2);
    assert.equal(body.script.src, SENTRY_BROWSER_TRACING.src);
    await on.integrations.stop();
  });

  test('a server fault no route answered goes to Sentry and is answered with no detail', async () => {
    const { app, sdk, integrations } = await appWith({ sentryOn: true });
    const res = await request(app, '/api/broken/boom', { token: staffToken });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { ok: false, code: 'internal', error: 'Something went wrong.' });
    const sent = sdk.calls.find(([kind]) => kind === 'exception');
    assert.equal(sent[1].message, 'boom 42');
    assert.deepEqual(sent[2].tags, { source: 'http' });
    await integrations.stop();
  });
});
