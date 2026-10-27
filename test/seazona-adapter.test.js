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
    // The next timer that is still set.
    next() {
      while (pending[0]?.cleared) pending.shift();
      return pending[0];
    },
    async fire() {
      const timer = this.next();
      pending.shift();
      if (timer) await timer.fn();
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
  assert.equal(timers.next().ms, 5_000);
  await timers.fire();
  assert.equal(runs, 1);
  assert.equal(timers.next().ms, 15_000, 'a lane that never ran is due now; the floor is 15 seconds');
  assert.equal(scheduler.status().lastRun.ok, true);
  await scheduler.stop();
  assert.equal(timers.next(), undefined, 'stop clears the next run');
});

test('a run that never ends is reported once, and the next run starts without it (issue #143)', async () => {
  const clock = fakeClock();
  const timers = manualTimers();
  const errors = [];
  const log = { info() {}, warn() {}, error: (line) => errors.push(line) };
  const db = { select: () => ({ from: async () => [] }) };
  let release;
  let runs = 0;
  const scheduler = createSeazonaScheduler({
    db, now: clock.now, log, timers, firstDelayMs: 1, stuckMs: 20 * 60_000,
    run: () => {
      runs += 1;
      if (runs === 1) return new Promise((resolve) => { release = () => resolve({ ok: true, results: {} }); });
      return Promise.resolve({ ok: true, results: { invoices: { ok: true } } });
    },
  });
  scheduler.start();
  const hung = timers.fire(); // the first run starts and never ends
  await new Promise((resolve) => setImmediate(resolve));
  const watchdog = timers.next();
  assert.equal(watchdog.ms, 20 * 60_000);
  await timers.fire();
  assert.deepEqual(errors, ['[seazona] a sync run has not ended after 20 minutes; the next run starts without it']);
  assert.ok(scheduler.status().stuckSince);
  assert.equal(timers.next().ms, 15_000, 'the next run is scheduled');

  await timers.fire(); // the second run ends as normal
  assert.equal(runs, 2);
  assert.equal(scheduler.status().stuckSince, null);
  const scheduled = timers.pending.filter((t) => !t.cleared).length;
  release();
  await hung;
  assert.equal(timers.pending.filter((t) => !t.cleared).length, scheduled, 'the late run schedules nothing');
  assert.equal(errors.length, 1);
  await scheduler.stop();
});

test('the scheduler reports a lane failure once, and again only when it changes', async () => {
  const clock = fakeClock();
  const timers = manualTimers();
  const errors = [];
  const log = { info() {}, warn() {}, error: (line) => errors.push(line) };
  const db = { select: () => ({ from: async () => [] }) };
  const outcomes = [
    { ok: false, status: 'failed', code: 'seazona_api_request_failed', error: 'HTTP 500' },
    { ok: false, status: 'failed', code: 'seazona_api_request_failed', error: 'HTTP 502' },
    { ok: false, status: 'failed', code: 'seazona_api_circuit_open', error: 'paused' },
    { ok: true, newlyQuarantined: 2 },
    { ok: false, status: 'stopped', code: 'seazona_api_halted', error: 'refused' },
  ];
  const scheduler = createSeazonaScheduler({
    db, now: clock.now, log, timers, firstDelayMs: 1,
    run: async () => ({ ok: false, results: { invoices: outcomes.shift() } }),
  });
  scheduler.start();
  for (let i = 0; i < 5; i += 1) await timers.fire();
  await scheduler.stop();
  assert.deepEqual(errors, [
    '[seazona] invoices lane failed: seazona_api_request_failed',
    '[seazona] invoices lane failed: seazona_api_circuit_open',
    '[seazona] invoices: records quarantined after repeated failed reads',
    '[seazona] invoices lane stopped: seazona_api_halted',
  ]);
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
    const { rows } = await db.execute(sql`select count(*)::int as n from pg_tables where schemaname = 'flow' and tablename like 'seazona\\_%'`);
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
    assert.deepEqual(first.withdrawn.map(({ ledgerWithdrawn, ...entry }) => entry), [{ sourceId: 'ORD-1002', status: 'In Production', reason: 'not_billable' }]);
    const { observedAt, ...notBillable } = first.withdrawn[0].ledgerWithdrawn;
    assert.ok(observedAt, 'the ledger gets the time of the last read');
    assert.deepEqual(notBillable, {
      sourceSystem: 'seazona', sourceJobRef: 'ORD-1002', sourceStatus: 'In Production', deleted: false, reason: null, actor: 'system:seazona',
    });

    // Nothing changed: the next page is empty.
    const again = await adapter.capabilities.pullWorkItems(first.cursor);
    assert.deepEqual([again.items, again.withdrawn], [[], []]);

    // Seazona deletes the order: it is withdrawn, never billable.
    clock.advance(10 * 60_000);
    await sync([{ path: 'orders/ORD-1001', status: 404 }], ['orders_active']);
    const afterDelete = await adapter.capabilities.pullWorkItems(again.cursor);
    assert.deepEqual(afterDelete.items, []);
    assert.deepEqual(afterDelete.withdrawn.map(({ ledgerWithdrawn: { observedAt, ...withdrawn }, ...entry }) => ({ ...entry, withdrawn })), [{
      sourceId: 'ORD-1001',
      status: 'Deleted in Seazona',
      reason: 'deleted_in_seazona',
      withdrawn: {
        sourceSystem: 'seazona', sourceJobRef: 'ORD-1001', sourceStatus: 'Deleted in Seazona', deleted: true, reason: 'the order was deleted in Seazona', actor: 'system:seazona',
      },
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
    assert.deepEqual(after.filter((c) => !before.some((b) => b.id === c.id)), [{
      id: 'CLI-ORDERS-ONLY', name: 'Example Orders Practice', contact: { kind: 'customer', name: 'Example Orders Practice' },
    }]);
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

  test('a lane that ran before and is late makes health not ok, and a person sees it (issue #143)', async () => {
    const liveTimers = manualTimers();
    await boot(LIVE_ENV, { timers: liveTimers, fetchImpl: createReplayFetch({ responses: [] }) });
    await db.execute(sql`truncate seazona_lane_state, seazona_api_governor`);
    const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000);
    await db.execute(sql`insert into seazona_lane_state (lane, status, failure_count, last_success_at, last_attempt_at) values
      ('invoices', 'ok', 0, ${hoursAgo(3)}, ${hoursAgo(3)}),
      ('clients', 'stopped', 1, ${hoursAgo(0.1)}, ${hoursAgo(0.1)}),
      ('orders_recent', 'ok', 0, ${hoursAgo(0.01)}, ${hoursAgo(0.01)})`);
    const [live] = registry.with('health');
    const health = await live.capabilities.health();
    assert.equal(health.ok, false);
    const lane = (name) => health.lanes.find((entry) => entry.lane === name);
    assert.deepEqual([lane('invoices').stale, lane('invoices').fresh], [true, false]);
    assert.equal(lane('orders_recent').stale, false);
    assert.equal(lane('history').stale, false, 'a lane that never ran is not late');

    const alerts = await live.capabilities.alerts();
    assert.deepEqual(alerts.map((a) => [a.id, a.tone]), [['reads-stopped', 'danger'], ['reads-late', 'warn']]);
    assert.match(alerts[0].title, /^Seazona refused Flow's request for practices\./);
    assert.match(alerts[1].title, /^Flow has not read invoices from Seazona on time\./);
    assert.ok(!/lane|orders_recent/.test(alerts.map((a) => a.title).join(' ')), 'no engine words');

    await db.execute(sql`update seazona_lane_state set last_success_at = now(), status = 'ok'`);
    assert.equal((await live.capabilities.health()).ok, true);
    assert.deepEqual(await live.capabilities.alerts(), []);
  });
});
