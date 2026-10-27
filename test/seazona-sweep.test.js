import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { readBillableWork } from '../server/integrations/seazona/feed.js';
import { runSeazonaSync } from '../server/integrations/seazona/lanes.js';
import { seazonaClients, seazonaInvoices, seazonaOrders, seazonaSweepFindings } from '../server/integrations/seazona/schema.js';
import { resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import { readSweepHealth } from '../server/integrations/seazona/sweep.js';
import { skipWithoutDatabase } from './support/db.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';

// Issue #126: the slow re-check sweep finds the edits and deletes that the
// cursor lanes miss. The fake Seazona answers lists the way the API guide
// says (support.seazona.net/Api.html). Synthetic data only.

const CAP = 50;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const settingsFor = (env = {}) => resolveSeazonaSettings({
  SEAZONA_MODE: 'replay',
  SEAZONA_REPLAY_FILE: new URL('./fixtures/seazona/billing.json', import.meta.url).pathname,
  SEAZONA_ORDER_LOOKBACK_DAYS: '1',
  SEAZONA_INVOICE_LOOKBACK_DAYS: '30',
  SEAZONA_LIST_CAP: String(CAP),
  SEAZONA_SWEEP_CALLS_PER_RUN: '25',
  ...env,
});

const parseUtc = (value) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);

// A Seazona whose records a test can change between runs. `fail` maps a
// path to a status it answers instead.
function fakeSeazona(state) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const byChange = (a, b) => parseUtc(a.lastModified) - parseUtc(b.lastModified) || a.id.localeCompare(b.id);
  async function fetchImpl(input) {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^.*\/v1\//, '').replace(/^\//, '');
    const query = Object.fromEntries(url.searchParams);
    calls.push({ path, query });
    if (state.fail?.[path]) return json('Refused', state.fail[path]);
    const one = (rows, prefix) => {
      const row = rows.find((candidate) => candidate.id === decodeURIComponent(path.slice(prefix.length)));
      return row ? json(row) : json('Not found', 404);
    };
    if (path === 'clients/') {
      const since = query.lastModified ? parseUtc(query.lastModified) : -Infinity;
      return json(state.clients.filter((row) => parseUtc(row.lastModified) > since).sort(byChange).slice(0, CAP));
    }
    if (path.startsWith('clients/')) return one(state.clients, 'clients/');
    if (path === 'invoices/') {
      const since = parseUtc(query.lastModified);
      return json(state.invoices.filter((row) => parseUtc(row.lastModified) >= since).sort(byChange).slice(0, CAP));
    }
    if (path.startsWith('invoices/')) return one(state.invoices, 'invoices/');
    if (path === 'orders/') {
      const since = parseUtc(query.ordered);
      const size = Number(query.pageSize ?? 100);
      const page = Number(query.page ?? 1);
      const rows = state.orders.filter((row) => parseUtc(row.ordered) >= since)
        .sort((a, b) => parseUtc(a.ordered) - parseUtc(b.ordered) || a.id.localeCompare(b.id));
      return json(rows.slice((page - 1) * size, page * size));
    }
    if (path.startsWith('orders/')) return one(state.orders, 'orders/');
    return json([]);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

const client = (n) => ({ id: `CL-${n}`, accountNumber: `A${n}`, company: `Example Practice ${n}`, lastModified: '2026-09-20T08:00:00' });
const invoice = (n, extra = {}) => ({
  id: `INV-ID-${n}`,
  invoiceNumber: String(7000 + n),
  clientId: 'CL-1',
  status: 'Shipped',
  lastModified: '2026-09-20T10:00:00',
  subtotal: 100,
  tax: 10,
  total: 110,
  productServiceItems: [],
  ...extra,
});
const order = (n, invoiceN, extra = {}) => ({
  id: `ORD-${9000 + n}`,
  invoiceNumber: String(7000 + invoiceN),
  clientId: 'CL-1',
  company: 'Example Practice 1',
  clientName: 'Dr Example',
  status: 'Shipped',
  ordered: '2026-09-20T09:00:00',
  products: [{ id: 'P-1', name: 'Example crown', price: 100 }],
  ...extra,
});

describe('Seazona sweep (issue #126)', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let clock;
  let state;
  let seazona;

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
  });
  after(async () => handle?.close());

  async function run({ env = {}, only }) {
    const settings = settingsFor(env);
    const api = createSeazonaClient({ settings, db, fetchImpl: seazona, now: clock.now, sleepFn: clock.sleep, random: () => 0 });
    return runSeazonaSync(db, api, { settings, now: clock.now, only, force: true });
  }
  const sweep = (env = {}) => run({ env, only: ['sweep'] }).then((result) => result.results.sweep);
  const findings = () => db.select().from(seazonaSweepFindings).orderBy(seazonaSweepFindings.resource, seazonaSweepFindings.recordKey);
  const getOrder = async (id) => (await db.select().from(seazonaOrders).where(eq(seazonaOrders.id, id)))[0];
  const sweepCalls = (from) => seazona.calls.slice(from).map((call) => call.path);

  // Seazona as it was on 20 September, read by the lanes then; then the
  // clock moves to 1 October, past the recent-order window, and the
  // invoice and client lanes read again.
  beforeEach(async () => {
    await db.execute(sql`truncate seazona_orders, seazona_invoices, seazona_clients, seazona_reference, seazona_lane_state,
      seazona_order_read_failures, seazona_record_read_failures, seazona_api_requests, seazona_api_governor, seazona_sweep_findings`);
    state = {
      clients: [client(1), client(2)],
      invoices: [invoice(1), invoice(2)],
      orders: [order(1, 1), order(2, 2), order(3, 2)],
    };
    seazona = fakeSeazona(state);
    clock = fakeClock('2026-09-20T12:00:00.000Z');
    const seeded = await run({ only: ['invoices', 'orders_recent', 'clients'] });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    clock.set('2026-10-01T12:00:00.000Z');
    await run({ only: ['invoices', 'clients'] });
    seazona.calls.length = 0;
  });

  test('an edit to an old shipped order and a deleted old order are found', async () => {
    state.orders[0] = order(1, 1, { status: 'Delivered' });
    state.orders.splice(1, 1); // ORD-9002 is deleted in Seazona

    const result = await sweep();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await getOrder('ORD-9001')).status, 'Delivered');
    assert.ok((await getOrder('ORD-9002')).deletedInSourceAt, 'the row is kept and marked deleted');
    assert.deepEqual(result.found, { changed: 1, created: 0, deleted: 1, missing: 0 });
    assert.deepEqual((await findings()).map((row) => [row.resource, row.recordKey, row.kind]), [
      ['orders', 'ORD-9001', 'changed'],
      ['orders', 'ORD-9002', 'deleted'],
    ]);
    assert.deepEqual(result.reports, ['the sweep found records the sync lanes missed']);

    // The billing feed withdraws the deleted order, so its invoice goes to review.
    const feed = await readBillableWork(db, {});
    assert.deepEqual(feed.withdrawn.map((row) => [row.sourceId, row.reason]), [['ORD-9002', 'deleted_in_seazona']]);
  });

  test('an unchanged old order costs one list call and no detail read', async () => {
    const result = await sweep();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.found, { changed: 0, created: 0, deleted: 0, missing: 0 });
    assert.deepEqual(sweepCalls(0), ['orders/', 'clients/', 'invoices/']);
    assert.deepEqual(result.reports, []);
  });

  test('a client and an invoice gone from Seazona are marked missing, never deleted, and the mark clears', async () => {
    state.clients.splice(1, 1);
    state.invoices.splice(1, 1);
    state.orders.splice(2, 1); // ORD-9003, on the missing invoice

    const result = await sweep();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.found, { changed: 0, created: 0, deleted: 1, missing: 2 });
    assert.equal((await db.select().from(seazonaClients)).length, 2);
    assert.equal((await db.select().from(seazonaInvoices)).length, 2);
    assert.ok(sweepCalls(0).includes('clients/CL-2'), 'a left-out client is read by id first');
    assert.ok(sweepCalls(0).includes('invoices/INV-ID-2'));

    const health = await readSweepHealth(db, settingsFor(), { now: clock.now });
    assert.deepEqual(health.missing, { clients: { count: 1, keys: ['CL-2'] }, invoices: { count: 1, keys: ['7002'] } });
    assert.deepEqual(health.foundLastWeek, { orders: { deleted: 1 } });

    // Seazona lists the client again: the next cycle clears the mark.
    state.clients.push(client(2));
    clock.advance(8 * DAY);
    await run({ only: ['clients'] });
    assert.equal((await sweep()).ok, true);
    const after = await readSweepHealth(db, settingsFor(), { now: clock.now });
    assert.deepEqual(Object.keys(after.missing), ['invoices']);
  });

  test('a change the owning lane will still read is left to it; one it passed is read', async () => {
    // Inside the invoice lane's next read (after its cursor, less the overlap).
    state.invoices[0] = invoice(1, { total: 220, lastModified: '2026-10-01T11:58:00' });
    // Behind the cursor: a change the lane passed by.
    state.invoices[1] = invoice(2, { total: 330 });

    const result = await sweep();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(!sweepCalls(0).includes('invoices/INV-ID-1'), 'left to the invoice lane');
    assert.ok(sweepCalls(0).includes('invoices/INV-ID-2'));
    const [stored] = await db.select().from(seazonaInvoices).where(eq(seazonaInvoices.invoiceNumber, '7002'));
    assert.equal(stored.totalCents, 33000);
    assert.deepEqual((await findings()).map((row) => [row.resource, row.recordKey, row.kind]), [['invoices', '7002', 'changed']]);
  });

  test('the sweep keeps to its share of calls a run and a day, and goes on where it stopped', async () => {
    const env = { SEAZONA_SWEEP_CALLS_PER_RUN: '2', SEAZONA_SWEEP_CALLS_PER_DAY: '3' };
    const first = await sweep(env);
    assert.equal(first.calls, 2);
    clock.advance(15 * MINUTE);
    const second = await sweep(env);
    assert.equal(second.calls, 1);
    assert.equal(second.callsToday, 3);
    clock.advance(15 * MINUTE);
    assert.equal((await sweep(env)).calls, 0);
    assert.deepEqual(sweepCalls(0), ['orders/', 'clients/', 'invoices/']);

    clock.set('2026-10-02T00:05:00.000Z');
    const nextDay = await sweep(env);
    assert.equal(nextDay.callsToday, nextDay.calls);
    const health = await readSweepHealth(db, settingsFor(env), { now: clock.now });
    assert.ok(health.kinds.invoices.lastFinishedAt, 'the invoice check finished on the next run');
    assert.equal(health.callsPerDay, 3);
  });

  test('SEAZONA_SWEEP_CALLS_PER_DAY=0 turns the sweep off', async () => {
    const result = await sweep({ SEAZONA_SWEEP_CALLS_PER_DAY: '0' });
    assert.equal(result.ok, true);
    assert.equal(result.calls, 0);
    assert.equal(seazona.calls.length, 0);
  });

  test('an order whose read fails is not read again in the same cycle', async () => {
    state.orders[0] = order(1, 1, { status: 'Delivered' });
    state.orders[1] = order(2, 2, { status: 'Delivered' });
    state.fail = { 'orders/ORD-9001': 500 };
    // Two calls a run: the day's list and one read, so the day is read again.
    const env = { SEAZONA_API_MAX_RETRIES: '0', SEAZONA_SWEEP_CALLS_PER_RUN: '2' };
    const reads = (id) => seazona.calls.filter((call) => call.path === `orders/${id}`).length;
    assert.equal((await sweep(env)).ok, true);
    assert.equal(reads('ORD-9001'), 1);
    assert.equal(reads('ORD-9002'), 0);
    clock.advance(15 * MINUTE);
    const second = await sweep(env);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(reads('ORD-9001'), 1, 'the failed order waits for the next cycle');
    assert.equal(reads('ORD-9002'), 1);
    assert.equal((await getOrder('ORD-9002')).status, 'Delivered');
  });

  test('an invoice changed before the invoice lane first read is not a miss', async () => {
    // FLOW-HORIZON-K: the invoice lane's first run reads from the start of
    // its UTC day (SEAZONA_INVOICE_LOOKBACK_DAYS=0). An invoice last changed
    // the day before was never the lane's to read, so the sweep must not
    // count it as one the lane missed.
    await db.execute(sql`truncate seazona_invoices, seazona_clients, seazona_lane_state, seazona_sweep_findings, seazona_api_requests, seazona_api_governor`);
    state.invoices = [invoice(1), invoice(3, { lastModified: '2026-09-19T15:00:00' })];
    clock.set('2026-09-20T12:00:00.000Z');
    const env = { SEAZONA_INVOICE_LOOKBACK_DAYS: '0' };
    const seeded = await run({ env, only: ['invoices', 'clients'] });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    clock.set('2026-10-01T12:00:00.000Z');
    await run({ env, only: ['invoices', 'clients'] });
    // A real miss: changed after the lane's first read, behind its cursor.
    state.invoices.push(invoice(4, { lastModified: '2026-09-25T10:00:00' }));

    const result = await sweep(env);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.found, { changed: 0, created: 1, deleted: 0, missing: 0 });
    assert.deepEqual((await findings()).map((row) => [row.resource, row.recordKey, row.kind]), [['invoices', '7004', 'created']]);
    const [list] = seazona.calls.filter((call) => call.path === 'invoices/');
    assert.equal(list.query.lastModified, '2026-09-20T00:00:00.000Z', 'the sweep starts where the lane first read');
  });

  test('Seazona times ahead of Flow by more than the overlap are shown and reported once', async () => {
    state.invoices[0] = invoice(1, { total: 220, lastModified: '2026-10-01T13:00:00' });
    await run({ only: ['invoices'] });
    const first = await sweep();
    assert.ok(first.reports.some((line) => line.includes('ahead of Flow')), JSON.stringify(first.reports));
    clock.advance(15 * MINUTE);
    const second = await sweep();
    assert.ok(!second.reports.some((line) => line.includes('ahead of Flow')));
    const health = await readSweepHealth(db, settingsFor(), { now: clock.now });
    assert.equal(health.highWater.invoices.sourceLastModified, '2026-10-01T13:00:00.000Z');
    assert.equal(health.highWater.invoices.seazonaAhead, true);
    assert.equal(health.highWater.clients.seazonaAhead, false);
  });
});
