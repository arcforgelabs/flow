import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { createSeazonaGovernor, pathShape } from '../server/integrations/seazona/governor.js';
import { createReplayFetch } from '../server/integrations/seazona/replay.js';
import { resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import { skipWithoutDatabase } from './support/db.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';

// Synthetic data only (CONTRIBUTING.md). The clock is fake: "waiting" moves it.
describe('Seazona rate governor', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let clock;

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    await db.execute(sql`truncate seazona_api_requests, seazona_api_governor`);
    clock = fakeClock();
  });

  const governor = (options = {}) => createSeazonaGovernor({
    db, clientKey: 'client-a', now: clock.now, sleepFn: clock.sleep, ...options,
  });

  test('requests are spaced out to stay inside the limit', async () => {
    const gate = governor({ requestsPerMinute: 30 });
    assert.equal(gate.minIntervalMs, 2_000);
    const start = clock.now();
    for (let i = 0; i < 5; i += 1) await gate.reserve();
    assert.equal(clock.now() - start, 8_000);
  });

  test('no more than the limit is admitted in any minute, across two processes', async () => {
    // Two governors on one database are two processes with one API client.
    const one = governor({ requestsPerMinute: 3 });
    const two = governor({ requestsPerMinute: 3 });
    const times = [];
    for (let i = 0; i < 4; i += 1) {
      await (i % 2 ? two : one).reserve();
      times.push(clock.now());
    }
    const { rows } = await db.execute(sql`select count(*)::int as n from seazona_api_requests`);
    assert.equal(rows[0].n, 4);
    // The fourth waits until the first has left the 60 second window.
    assert.ok(times[3] - times[0] > 60_000, `fourth admitted after ${times[3] - times[0]} ms`);
  });

  test('a limit above 30 a minute is lowered to 30', () => {
    assert.equal(governor({ requestsPerMinute: 60 }).limitPerMinute, 30);
  });

  test('a 429 cooldown holds the next request', async () => {
    const gate = governor();
    const { requestId } = await gate.reserve();
    await gate.recordResponse({ requestId, path: '/v1/clients/', statusCode: 429, retryAfterMs: 30_000 });
    const before429 = clock.now();
    await gate.reserve();
    assert.ok(clock.now() - before429 >= 30_000);
    assert.ok((await gate.status()).lastDay.rateLimited === 1);
  });

  test('a request that cannot get a slot in time gives up with a named error', async () => {
    const gate = governor({ requestsPerMinute: 1, maxWaitMs: 5_000 });
    await gate.reserve();
    await assert.rejects(gate.reserve(), { code: 'seazona_api_governor_timeout', kind: 'governor_timeout' });
  });

  test('telemetry names each failing path and keeps no host or query', async () => {
    const fetchImpl = createReplayFetch({ responses: [
      { path: 'orders/ORD-404', status: 404 },
      { path: 'orders/ORD-1', status: 200, body: { id: 'ORD-1' } },
    ] });
    const settings = resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: 'unused.json' });
    const client = createSeazonaClient({ settings, db, fetchImpl, now: clock.now, sleepFn: clock.sleep });
    for (let i = 0; i < 3; i += 1) await client.get('orders/ORD-404', { probe: 'x' }).catch(() => {});
    await client.get('orders/ORD-1');
    const month = await client.governor.summarise({ from: new Date(clock.now() - 30 * 86_400_000), to: new Date(clock.now() + 1) });
    assert.equal(month.requests, 4);
    assert.equal(month.failed, 3);
    assert.deepEqual(month.failures, [{ path: '/v1/orders/ORD-404', statusCode: 404, failureKind: null, requests: 3 }]);
    const { rows } = await db.execute(sql`select request_path from seazona_api_requests`);
    assert.ok(rows.every((row) => !row.request_path.includes('?') && !row.request_path.includes('replay')));
  });

  test('/health splits faults from 404s and groups failed calls by path shape, with no record ids (issue #144)', async () => {
    const fetchImpl = createReplayFetch({ responses: [
      { path: 'orders/ORD-404', status: 404 },
      { path: 'orders/ORD-405', status: 404 },
      { path: 'users/', status: 400 },
      { path: 'orders/ORD-1', status: 200, body: { id: 'ORD-1' } },
    ] });
    const settings = resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: 'unused.json' });
    const client = createSeazonaClient({ settings, db, fetchImpl, now: clock.now, sleepFn: clock.sleep });
    for (const path of ['orders/ORD-404', 'orders/ORD-405', 'users/', 'orders/ORD-1']) await client.get(path).catch(() => {});
    clock.advance(1);
    const { lastDay } = await client.governor.status();
    assert.deepEqual([lastDay.requests, lastDay.failed, lastDay.faults, lastDay.notFound], [4, 3, 1, 2]);
    assert.deepEqual(lastDay.failures, [
      { path: '/v1/orders/:id', statusCode: 404, failureKind: null, requests: 2 },
      { path: '/v1/users', statusCode: 400, failureKind: null, requests: 1 },
    ]);
    assert.ok(!JSON.stringify(lastDay).includes('ORD-'));
    assert.equal(pathShape('/v1/clients/a1b2c3d4-1234-5678-abcd-ef0123456789'), '/v1/clients/:id');
    assert.equal(pathShape('/v1/clients/login-exists'), '/v1/clients/login-exists');
  });

  test('telemetry older than the retention is removed', async () => {
    const gate = governor({ telemetryRetentionMs: 86_400_000 });
    const old = await gate.reserve();
    await gate.recordResponse({ requestId: old.requestId, path: '/v1/products/', statusCode: 200 });
    clock.advance(2 * 86_400_000);
    const fresh = await gate.reserve();
    await gate.recordResponse({ requestId: fresh.requestId, path: '/v1/products/', statusCode: 200 });
    const { rows } = await db.execute(sql`select count(*)::int as n from seazona_api_requests`);
    assert.equal(rows[0].n, 1);
  });

  // Issue #101: calls stop before the vendor sees a run of failures.
  const stopClient = (responses, env = {}) => {
    const fetchImpl = createReplayFetch({ responses });
    const settings = resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: 'unused.json', SEAZONA_API_MAX_RETRIES: '0', ...env });
    const client = createSeazonaClient({ settings, db, fetchImpl, now: clock.now, sleepFn: clock.sleep, random: () => 0 });
    return { client, fetchImpl };
  };

  test('a 401 makes one call, then no call until a person resumes', async () => {
    const { client, fetchImpl } = stopClient([{ path: 'clients/', status: 401 }]);
    await assert.rejects(client.get('clients/'), { statusCode: 401 });
    for (let i = 0; i < 3; i += 1) {
      clock.advance(24 * 60 * 60_000);
      await assert.rejects(client.get('clients/'), { code: 'seazona_api_halted', kind: 'calls_stopped' });
    }
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal((await client.governor.status()).circuit, 'halted');
    await client.governor.resume();
    await assert.rejects(client.get('clients/'), { statusCode: 401 });
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('repeated failures open the circuit; a failed probe doubles the pause; a good probe closes it', async () => {
    const { client, fetchImpl } = stopClient([
      { path: 'products/', sequence: [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 200, body: [] }] },
    ]);
    for (let i = 0; i < 5; i += 1) await assert.rejects(client.get('products/'), { statusCode: 500 });
    await assert.rejects(client.get('products/'), { code: 'seazona_api_circuit_open' });
    assert.equal(fetchImpl.calls.length, 5);
    assert.equal((await client.governor.status()).circuit, 'open');

    clock.advance(5 * 60_000);
    await assert.rejects(client.get('products/'), { statusCode: 500 }); // the probe
    const reopened = await client.governor.status();
    assert.equal(reopened.circuit, 'open');
    assert.equal(Date.parse(reopened.circuitOpenUntil) - clock.now(), 10 * 60_000);
    await assert.rejects(client.get('products/'), { code: 'seazona_api_circuit_open' });
    assert.equal(fetchImpl.calls.length, 6);

    clock.advance(10 * 60_000);
    assert.deepEqual(await client.get('products/'), []);
    assert.equal((await client.governor.status()).circuit, 'closed');
  });

  test('the day\'s failed-call budget stops calls until the next UTC day', async () => {
    const { client, fetchImpl } = stopClient([{ path: 'users/', status: 503 }], {
      SEAZONA_CIRCUIT_FAILURES: '100', SEAZONA_DAILY_FAILURE_BUDGET: '3',
    });
    for (let i = 0; i < 3; i += 1) await assert.rejects(client.get('users/'), { statusCode: 503 });
    await assert.rejects(client.get('users/'), { code: 'seazona_api_failure_budget_spent' });
    assert.equal(fetchImpl.calls.length, 3);
    const status = await client.governor.status();
    assert.equal(status.failedToday, 3);
    assert.equal(status.dailyFailureBudget, 3);
    clock.set('2026-10-02T00:00:01.000Z');
    await assert.rejects(client.get('users/'), { statusCode: 503 });
    assert.equal(fetchImpl.calls.length, 4);
  });

  test('a 404 on one record is not a failure the circuit counts', async () => {
    const { client, fetchImpl } = stopClient([{ path: 'orders/ORD-404', status: 404 }]);
    for (let i = 0; i < 8; i += 1) await assert.rejects(client.get('orders/ORD-404'), { statusCode: 404 });
    assert.equal(fetchImpl.calls.length, 8);
    assert.equal((await client.governor.status()).circuit, 'closed');
  });
});
