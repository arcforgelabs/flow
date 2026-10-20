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
import { createSentryAdapter, readSentrySettings, SENTRY_BROWSER, sentryRelease } from '../server/integrations/sentry/index.js';
import { tagNotify } from '../server/ui/monitoring.js';
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
  assert.deepEqual(sentry.setup.fields.map((f) => f.name), ['SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_FEEDBACK']);
  assert.equal(sentry.schema, undefined);
});

test('the settings need a Sentry DSN; environment and the report button have defaults', () => {
  assert.throws(() => readSentrySettings({}), /SENTRY_DSN is not set/);
  assert.throws(() => readSentrySettings({ SENTRY_DSN: 'https://example.test/1' }), /not a Sentry DSN/);
  assert.deepEqual(readSentrySettings({ SENTRY_DSN: DSN }), { dsn: DSN, environment: 'production', feedback: true });
  assert.deepEqual(readSentrySettings({ SENTRY_DSN: ` ${DSN} `, SENTRY_ENVIRONMENT: 'staging', SENTRY_FEEDBACK: 'off' }), { dsn: DSN, environment: 'staging', feedback: false });
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

  adapter.capabilities.captureError({ message: '[seazona] read failed', source: 'seazona' });
  const boom = new Error('boom');
  adapter.capabilities.captureError({ message: '[http] boom', source: 'http', error: boom });
  assert.deepEqual(sdk.calls[1], ['event', { message: '[seazona] read failed', level: 'error', tags: { source: 'seazona' } }]);
  assert.equal(sdk.calls[2][0], 'exception');
  assert.equal(sdk.calls[2][1], boom);
  assert.deepEqual(sdk.calls[2][2].tags, { source: 'http' });

  assert.deepEqual(adapter.capabilities.browserMonitoring(), {
    dsn: DSN, environment: 'production', release: 'flow@2026.10.26', feedback: true, script: SENTRY_BROWSER,
  });
  assert.deepEqual(await adapter.capabilities.health(), { ok: true, environment: 'production', feedback: true });

  await adapter.stop();
  assert.deepEqual(sdk.calls.at(-1), ['close']);
  assert.equal(adapter.capabilities.browserMonitoring(), null);
});

test('a problem report is tagged notify=yes only when the person typed an email', () => {
  const report = (email) => ({ type: 'feedback', tags: { source: 'browser' }, contexts: { feedback: { message: 'It broke.', contact_email: email } } });
  const asked = report('person@example.test');
  tagNotify(asked);
  assert.deepEqual(asked.tags, { source: 'browser', notify: 'yes' });
  for (const email of [undefined, '', '  ']) {
    const quietReport = report(email);
    tagNotify(quietReport);
    assert.equal(quietReport.tags.notify, 'no');
  }
  const error = { type: undefined, tags: {} };
  tagNotify(error);
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
    assert.equal(body.script.src, SENTRY_BROWSER.src);
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
