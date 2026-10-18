import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createXeroClient } from '../server/integrations/xero/client.js';
import { createGovernor } from '../server/integrations/xero/governor.js';
import { createReplayFetch, loadReplayFixtures } from '../server/integrations/xero/replay.js';
import { resolveXeroSettings, writesAllowed } from '../server/integrations/xero/settings.js';

// The Xero adapter's settings, rate-limit governor and API client, against
// replayed synthetic responses. Nothing here reaches the real Xero.

const API = 'https://api.xero.com/api.xro/2.0';
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const TOKEN = 'synthetic-access-token-never-logged';
const KEY = 'a'.repeat(64);
const quiet = { info() {}, warn() {}, error() {} };

function harness(interactions, { now = () => Date.parse('2026-10-18T00:00:00Z'), config } = {}) {
  const sleeps = [];
  const governor = createGovernor({ now, random: () => 0, sleep: async (ms) => { sleeps.push(ms); }, log: quiet, config });
  const fetch = createReplayFetch(interactions);
  let invalidated = 0;
  const client = createXeroClient({
    tenantId: TENANT,
    accessToken: async () => TOKEN,
    invalidateAccessToken: () => { invalidated += 1; },
    fetch,
    governor,
    log: quiet,
  });
  return { client, fetch, governor, sleeps, invalidated: () => invalidated };
}

const answer = (path, body, { method = 'GET', status = 200, headers = {}, query, repeat } = {}) => ({
  ...(repeat ? { repeat } : {}),
  request: { method, url: `${API}/${path}`, ...(query ? { query } : {}) },
  response: { status, headers, body },
});

describe('Xero settings', () => {
  test('the adapter is off until XERO_MODE says which Xero it acts on', () => {
    assert.equal(resolveXeroSettings({}), null);
    assert.throws(() => resolveXeroSettings({ XERO_MODE: 'production' }), /XERO_MODE must be/);
  });

  test('live and sandbox need the Xero app keys and a token key; errors never echo values', () => {
    assert.throws(() => resolveXeroSettings({ XERO_MODE: 'sandbox' }), /needs XERO_CLIENT_ID and XERO_CLIENT_SECRET/);
    assert.throws(
      () => resolveXeroSettings({ XERO_MODE: 'sandbox', XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 'shh' }),
      /needs XERO_TOKEN_KEY/,
    );
    let message = '';
    try {
      resolveXeroSettings({ XERO_MODE: 'sandbox', XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 'shh', XERO_TOKEN_KEY: 'not-a-key-value' });
    } catch (error) {
      message = error.message;
    }
    assert.match(message, /XERO_TOKEN_KEY must be a 32-byte key/);
    assert.doesNotMatch(message, /not-a-key-value/);
  });

  test('live must name its Xero organisation, and writes only with XERO_ALLOW_LIVE_WRITES=on', () => {
    const base = { XERO_MODE: 'live', XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 'shh', XERO_TOKEN_KEY: KEY };
    assert.throws(() => resolveXeroSettings(base), /needs XERO_TENANT_ID or XERO_TENANT_NAME/);
    const live = resolveXeroSettings({ ...base, XERO_TENANT_NAME: 'Example Lab' });
    assert.equal(live.mode, 'live');
    assert.equal(writesAllowed(live), false);
    assert.equal(writesAllowed(resolveXeroSettings({ ...base, XERO_TENANT_NAME: 'Example Lab', XERO_ALLOW_LIVE_WRITES: 'on' })), true);
    assert.equal(writesAllowed(resolveXeroSettings({ XERO_MODE: 'replay' })), true);
  });

  test('the redirect URI comes from the installation address, never from code', () => {
    const replay = (env) => resolveXeroSettings({ XERO_MODE: 'replay', ...env });
    assert.equal(replay({}).redirectUri, null);
    assert.equal(replay({ FLOW_PUBLIC_ORIGIN: 'https://flow.example.test/' }).redirectUri, 'https://flow.example.test/api/xero/oauth/callback');
    assert.equal(
      replay({ FLOW_PUBLIC_ORIGIN: 'https://flow.example.test', XERO_REDIRECT_URI: 'https://other.example.test/api/xero/oauth/callback' }).redirectUri,
      'https://other.example.test/api/xero/oauth/callback',
    );
    assert.throws(() => replay({ XERO_REDIRECT_URI: 'https://flow.example.test/callback' }), /must end in \/api\/xero\/oauth\/callback/);
    assert.throws(() => replay({ FLOW_PUBLIC_ORIGIN: 'http://flow.example.test' }), /must be https/);
    assert.equal(replay({ FLOW_PUBLIC_ORIGIN: 'http://localhost:19300' }).redirectUri, 'http://localhost:19300/api/xero/oauth/callback');
  });

  test('tracking is configured as a pair; tax types and numbering have Xero defaults', () => {
    assert.throws(() => resolveXeroSettings({ XERO_MODE: 'replay', XERO_TRACKING_CATEGORY: 'Department' }), /set together/);
    const settings = resolveXeroSettings({ XERO_MODE: 'replay' });
    assert.deepEqual(settings.taxTypes, { GST: 'OUTPUT', GST_FREE: 'EXEMPTOUTPUT' });
    assert.equal(settings.invoiceNumber, 'xero');
    assert.equal(settings.dayLimit, 1000);
  });
});

describe('Xero rate-limit governor', () => {
  test('holds calls above the per-minute budget until the window moves', async () => {
    let at = Date.parse('2026-10-18T00:00:00Z');
    const sleeps = [];
    const governor = createGovernor({
      config: { maxPerMinute: 2 },
      now: () => at,
      sleep: async (ms) => { sleeps.push(ms); at += ms; },
      log: quiet,
    });
    await governor.acquire(TENANT);
    governor.release(TENANT);
    await governor.acquire(TENANT);
    governor.release(TENANT);
    await governor.acquire(TENANT);
    governor.release(TENANT);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 59_000, `waited ${sleeps[0]} ms`);
    assert.equal(governor.status(TENANT).dayCount, 3);
  });

  test('Xero\'s day count replaces the setting, and a spent day opens the circuit', async () => {
    const governor = createGovernor({ now: () => Date.parse('2026-10-18T03:00:00Z'), log: quiet });
    governor.observe(TENANT, { dayRemaining: 4000 });
    assert.equal(governor.status(TENANT).dayLimitSource, 'xero');
    assert.equal(governor.status(TENANT).dayLimit, 4000);
    governor.observe(TENANT, { dayRemaining: 0 });
    await assert.rejects(governor.acquire(TENANT), (error) => error.code === 'xero_rate_limited' && error.status === 429);
  });

  test('the circuit closes when the day rolls over', async () => {
    let at = Date.parse('2026-10-18T23:00:00Z');
    const governor = createGovernor({ now: () => at, config: { dayLimit: 1 }, log: quiet });
    await governor.acquire(TENANT);
    governor.release(TENANT);
    await assert.rejects(governor.acquire(TENANT), /circuit open/);
    at = Date.parse('2026-10-19T00:00:01Z');
    await governor.acquire(TENANT);
    governor.release(TENANT);
  });

  test('retry waits follow Xero\'s rate-limit problem and never exceed a minute', () => {
    const governor = createGovernor({ now: () => 30_000, random: () => 0, log: quiet });
    assert.equal(governor.retryDelayMs('ConcurrentLimit', null), 200);
    assert.equal(governor.retryDelayMs('MinuteLimit', 5000), 5000);
    assert.equal(governor.retryDelayMs('MinuteLimit', null), 30_000);
    assert.equal(governor.retryDelayMs('AppMinuteLimit', 600_000), 60_000);
    assert.equal(governor.retryDelayMs('DayLimit', 3_600_000), 0);
  });

  test('a warning is logged once a day at the usage threshold', async () => {
    const warnings = [];
    const governor = createGovernor({
      now: () => Date.parse('2026-10-18T01:00:00Z'),
      config: { dayLimit: 10, usageWarningFraction: 0.5 },
      log: { warn: (line) => warnings.push(line) },
    });
    for (let i = 0; i < 7; i += 1) {
      await governor.acquire(TENANT);
      governor.release(TENANT);
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /5 of 10 Xero calls used today/);
  });
});

describe('Xero API client (replay)', () => {
  test('sends the tenant header and reads the organisation', async () => {
    const { client, fetch, governor } = harness(loadReplayFixtures());
    const organisation = await client.getOrganisation();
    assert.equal(organisation.Class, 'DEMO');
    assert.equal(fetch.calls[0].headers['xero-tenant-id'], TENANT);
    assert.equal(fetch.calls[0].headers.Authorization, undefined, 'the replay log never keeps the token');
    assert.equal(governor.status(TENANT).dayLimitSource, 'xero');
  });

  test('a minute-limit 429 waits as Xero asks, then retries once', async () => {
    const { client, fetch, sleeps } = harness([
      answer('Items', { Message: 'rate limited' }, { status: 429, headers: { 'retry-after': '2', 'x-rate-limit-problem': 'MinuteLimit' } }),
      answer('Items', { Items: [{ ItemID: 'i1', Code: 'CROWN' }] }),
    ]);
    const items = await client.listItems();
    assert.equal(items.length, 1);
    assert.deepEqual(sleeps, [2000]);
    assert.equal(fetch.calls.length, 2);
  });

  test('a daily-limit 429 fails fast and blocks later calls without asking Xero', async () => {
    const { client, fetch } = harness([
      answer('Items', { Message: 'day limit' }, { status: 429, headers: { 'retry-after': '3600', 'x-rate-limit-problem': 'DayLimit' } }),
    ]);
    await assert.rejects(client.listItems(), (error) => error.code === 'xero_rate_limited');
    await assert.rejects(client.listItems(), (error) => error.code === 'xero_rate_limited' && error.retryAfterMs > 0);
    assert.equal(fetch.calls.length, 1);
  });

  test('a 401 drops the cached access token and tries once more', async () => {
    const { client, invalidated } = harness([
      answer('Organisation', { Title: 'Unauthorized' }, { status: 401 }),
      answer('Organisation', { Organisations: [{ Name: 'Example Lab (Demo)' }] }),
    ]);
    assert.equal((await client.getOrganisation()).Name, 'Example Lab (Demo)');
    assert.equal(invalidated(), 1);
  });

  test('a create retried after a 429 sends the same body under the same Idempotency-Key', async () => {
    const created = { InvoiceID: 'inv-1', Status: 'DRAFT' };
    const { client, fetch } = harness([
      answer('Invoices', {}, { method: 'POST', status: 429, headers: { 'x-rate-limit-problem': 'ConcurrentLimit' } }),
      answer('Invoices', { Invoices: [created] }, { method: 'POST', query: { summarizeErrors: 'false' } }),
    ]);
    const result = await client.createInvoice({ Type: 'ACCREC', Status: 'DRAFT' }, { idempotencyKey: 'flow-key-1' });
    assert.equal(result.InvoiceID, 'inv-1');
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(fetch.calls[0].body, fetch.calls[1].body);
    assert.equal(fetch.calls[0].headers['Idempotency-Key'], 'flow-key-1');
    assert.equal(fetch.calls[1].headers['Idempotency-Key'], 'flow-key-1');
  });

  test('a refused invoice reports Xero\'s validation messages', async () => {
    const { client } = harness([
      answer('Invoices', { Invoices: [{ HasErrors: true, StatusAttributeString: 'ERROR', ValidationErrors: [{ Message: 'Account code is not valid.' }] }] }, { method: 'POST' }),
    ]);
    await assert.rejects(
      client.createInvoice({ Type: 'ACCREC' }, { idempotencyKey: 'k' }),
      (error) => error.code === 'xero_validation_failed' && /Account code is not valid/.test(error.message),
    );
  });

  test('errors never carry the access token', async () => {
    const { client } = harness([answer('Items', `token ${TOKEN} rejected`, { status: 500 })]);
    const error = await client.listItems().catch((caught) => caught);
    assert.equal(error.code, 'xero_api_error');
    assert.equal(error.status, 500);
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), new RegExp(TOKEN));
  });

  test('contacts are read page by page until a short page', async () => {
    const page = (n, count) => answer('Contacts', { Contacts: Array.from({ length: count }, (_, i) => ({ ContactID: `c${n}-${i}` })) }, { query: { page: n } });
    const { client, fetch } = harness([page(1, 100), page(2, 3)]);
    assert.equal((await client.listContacts()).length, 103);
    assert.equal(fetch.calls.length, 2);
  });

  test('a request replay does not know fails instead of reaching Xero', async () => {
    const { client } = harness([]);
    await assert.rejects(client.listItems(), (error) => error.code === 'xero_replay_no_match');
  });

  test('a reference lookup quotes the reference safely', async () => {
    const { client, fetch } = harness([answer('Invoices', { Invoices: [] })]);
    await client.findInvoicesByReference('Case "7" \\ A');
    assert.equal(fetch.calls[0].query.where, 'Type=="ACCREC" AND Reference=="Case \\"7\\" \\\\ A"');
  });
});
