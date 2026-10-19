import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { createIntegrations } from '../server/integrations/index.js';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { createSeazonaAdapter, requireSeazonaSettings } from '../server/integrations/seazona/index.js';
import { runSeazonaSync } from '../server/integrations/seazona/lanes.js';
import { createReplayFetch, loadReplay } from '../server/integrations/seazona/replay.js';
import { createSeazonaScheduler } from '../server/integrations/seazona/scheduler.js';
import { seazonaSchema } from '../server/integrations/seazona/tables.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { fakeClock } from './support/seazona.js';

// Synthetic data only (CONTRIBUTING.md). Nothing here reaches a network:
// replay mode, or a live-mode adapter whose fetch is a replay and whose timers
// never fire on their own.

const BILLING_REPLAY = fileURLToPath(new URL('./fixtures/seazona/billing.json', import.meta.url));
const REPLAY_ENV = { FLOW_INTEGRATIONS: 'seazona', SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: BILLING_REPLAY, SEAZONA_ORDER_LOOKBACK_DAYS: '1' };
const LIVE_ENV = {
  FLOW_INTEGRATIONS: 'seazona',
  SEAZONA_MODE: 'live',
  SEAZONA_API_BASE_URL: 'https://api.example.test',
  SEAZONA_API_CLIENT_ID: 'id-example',
  SEAZONA_API_CLIENT_SECRET: 'secret-example',
};

// Timers that only run when the test says so.
function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    },
    async fire() {
      const timer = pending.shift();
      if (timer && !timer.cleared) await timer.fn();
    },
  };
}

const silent = { info() {}, warn() {}, error() {} };

test('Seazona on with no mode, or a bad setting, stops boot', () => {
  assert.throws(() => requireSeazonaSettings({}), /SEAZONA_MODE must be "live", "sandbox" or "replay"/);
  assert.throws(() => requireSeazonaSettings({ SEAZONA_MODE: 'live' }), /SEAZONA_API_BASE_URL is required/);
});

test('the scheduler runs, then sleeps until the next lane is due, one run at a time', async () => {
  const clock = fakeClock();
  const timers = manualTimers();
  let runs = 0;
  const db = { select: () => ({ from: async () => [] }) }; // no lane state yet
  const scheduler = createSeazonaScheduler({
    db, now: clock.now, log: silent, timers, firstDelayMs: 5_000,
    run: async () => {
      runs += 1;
      return { ok: true, results: { invoices: { ok: true } } };
    },
  });
  scheduler.start();
  assert.equal(timers.pending[0].ms, 5_000);
  await timers.fire();
  assert.equal(runs, 1);
  assert.equal(timers.pending[0].ms, 15_000, 'a lane that never ran is due now; the floor is 15 seconds');
  assert.equal(scheduler.status().lastRun.ok, true);
  await scheduler.stop();
  assert.equal(timers.pending[0].cleared, true);
});

describe('Seazona adapter on the integration port', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let registry;

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
  });
  after(async () => handle?.close());
  afterEach(async () => {
    await registry?.stop();
    registry = null;
  });

  async function boot(env, adapterOptions = {}) {
    const adapter = createSeazonaAdapter({ env, ...adapterOptions });
    registry = createIntegrations({ env, adapters: [adapter], log: silent });
    await registry.start(db);
    return adapter;
  }

  async function tablesPresent() {
    const { rows } = await db.execute(sql`select count(*)::int as n from pg_tables where schemaname = 'public' and tablename like 'seazona\\_%'`);
    return rows[0].n;
  }

  test('off, it creates none of its tables; on, all of them', async () => {
    registry = createIntegrations({ env: {}, adapters: [createSeazonaAdapter({ env: {} })], log: silent });
    await registry.start(db);
    assert.equal(await tablesPresent(), 0);
    const health = await registry.whenEnabled('seazona', () => 'unreachable');
    assert.equal(health.code, 'integration_off');
    await registry.stop();

    await boot(REPLAY_ENV);
    assert.equal(await tablesPresent(), seazonaSchema.tables.length);
  });

  test('replay mode never starts the background sync; live mode does', async () => {
    const replayTimers = manualTimers();
    await boot(REPLAY_ENV, { timers: replayTimers });
    assert.equal(replayTimers.pending.length, 0);
    const [replay] = registry.with('health');
    assert.equal((await replay.capabilities.health()).scheduler, null);
    await registry.stop();

    const liveTimers = manualTimers();
    const fetchImpl = createReplayFetch({ responses: [] }); // a live adapter that cannot reach a network
    await boot(LIVE_ENV, { timers: liveTimers, fetchImpl });
    assert.equal(liveTimers.pending.length, 1, 'live mode schedules the sync');
    const [live] = registry.with('health');
    const health = await live.capabilities.health();
    assert.equal(health.mode, 'live');
    assert.equal(health.scheduled, true);
    assert.ok(!JSON.stringify(health).includes('example.test'), 'health never shows the host');
  });

  test('pullWorkItems gives complete and shipped orders with their invoice, and withdraws the rest', async () => {
    await db.execute(sql`truncate seazona_orders, seazona_invoices, seazona_clients, seazona_lane_state, seazona_order_read_failures`);
    const clock = fakeClock('2026-10-01T12:00:00.000Z');
    await boot(REPLAY_ENV);
    const settings = requireSeazonaSettings(REPLAY_ENV);
    const sync = async (responses, only) => runSeazonaSync(db, createSeazonaClient({
      settings, db, fetchImpl: createReplayFetch({ responses }), now: clock.now, sleepFn: clock.sleep,
    }), { settings, now: clock.now, only, force: true });
    await sync(loadReplay(BILLING_REPLAY).responses, ['invoices', 'orders_recent', 'clients']);

    const [adapter] = registry.with('pullWorkItems');
    const first = await adapter.capabilities.pullWorkItems(null);
    assert.deepEqual(first.items.map((item) => item.sourceId), ['ORD-1001']);
    const [crown] = first.items;
    assert.equal(crown.status, 'Complete');
    assert.equal(crown.shipped, false);
    assert.equal(crown.orderedOn, '2026-09-29');
    assert.equal(crown.invoice.invoiceNumber, '5001');
    assert.equal(crown.invoice.totalCents, 24200);
    assert.equal(crown.client.email, 'accounts@example.test');
    assert.equal(crown.patientReference, null);
    assert.deepEqual(first.withdrawn, [{ sourceId: 'ORD-1002', status: 'In Production', reason: 'not_billable', ledgerHold: null }]);

    // Nothing changed: the next page is empty.
    const again = await adapter.capabilities.pullWorkItems(first.cursor);
    assert.deepEqual([again.items, again.withdrawn], [[], []]);

    // Seazona deletes the order: it is withdrawn, never billable.
    clock.advance(10 * 60_000);
    await sync([{ path: 'orders/ORD-1001', status: 404 }], ['orders_active']);
    const afterDelete = await adapter.capabilities.pullWorkItems(again.cursor);
    assert.deepEqual(afterDelete.items, []);
    assert.deepEqual(afterDelete.withdrawn, [{
      sourceId: 'ORD-1001',
      status: 'Deleted in Seazona',
      reason: 'deleted_in_seazona',
      ledgerHold: { sourceSystem: 'seazona', sourceJobRef: 'ORD-1001', holdState: 'review', reason: 'the order was deleted in Seazona' },
    }]);
    const everything = await adapter.capabilities.pullWorkItems(null);
    assert.ok(!everything.items.some((item) => item.sourceId === 'ORD-1001'), 'a deleted order is out of billing from any cursor');
  });

  test('listCustomers adds the clients only orders name, so their jobs find a customer', async () => {
    await boot(REPLAY_ENV);
    const [adapter] = registry.with('pullWorkItems');
    const before = await adapter.capabilities.listCustomers();
    await db.execute(sql`insert into seazona_orders (id, client_id, company, status, record_hash, first_seen_at, last_synced_at, last_changed_at)
      values ('ORD-9001', 'CLI-ORDERS-ONLY', ' Example Orders Practice ', 'Shipped', 'h', now(), now(), now())`);
    const after = await adapter.capabilities.listCustomers();
    assert.deepEqual(after.filter((c) => !before.some((b) => b.id === c.id)), [{ id: 'CLI-ORDERS-ONLY', name: 'Example Orders Practice' }]);
    await db.execute(sql`delete from seazona_orders where id = 'ORD-9001'`);
  });

  test('GET /health shows the adapter, its mode and each failing order', async () => {
    await boot(REPLAY_ENV);
    await db.execute(sql`truncate seazona_lane_state`);
    await db.execute(sql`insert into seazona_lane_state (lane, status, failure_count, last_error, failure_details)
      values ('orders_active', 'failed', 1, 'Seazona active order reads failed for 2 of 3: ORD-7001 (HTTP 500), ORD-7002 (timeout)',
      ${JSON.stringify({ attempted: 3, failed: 2, failures: [{ id: 'ORD-7001', httpStatus: 500, kind: 'http' }, { id: 'ORD-7002', httpStatus: null, kind: 'timeout' }] })}::jsonb)`);
    const app = createApp({ build: {}, integrations: registry });
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
      const body = await res.json();
      assert.equal(res.status, 200, 'an integration problem does not fail the health check');
      const [seazona] = body.integrations;
      assert.equal(seazona.id, 'seazona');
      assert.equal(seazona.state, 'ready');
      assert.equal(seazona.health.mode, 'replay');
      assert.equal(seazona.health.ok, false);
      const lane = seazona.health.lanes.find((entry) => entry.lane === 'orders_active');
      assert.match(lane.lastError, /ORD-7001 \(HTTP 500\), ORD-7002 \(timeout\)/);
      assert.deepEqual(lane.failureDetails.failures.map((f) => f.id), ['ORD-7001', 'ORD-7002']);
    } finally {
      server.close();
    }
  });
});
