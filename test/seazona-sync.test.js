import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { readSeazonaSyncHealth, runSeazonaSync } from '../server/integrations/seazona/lanes.js';
import { DELETED_STATUS, orderStatusLabel } from '../server/integrations/seazona/map.js';
import { createReplayFetch, loadReplay } from '../server/integrations/seazona/replay.js';
import { seazonaClients, seazonaInvoices, seazonaOrderReadFailures, seazonaOrders, seazonaReference } from '../server/integrations/seazona/schema.js';
import { resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import { skipWithoutDatabase } from './support/db.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';

// Synthetic data only (CONTRIBUTING.md): the replays here and in
// test/fixtures/seazona/ name no real lab, practice, dentist or patient.

const BILLING_REPLAY = fileURLToPath(new URL('./fixtures/seazona/billing.json', import.meta.url));
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const settingsFor = (env = {}) => resolveSeazonaSettings({
  SEAZONA_MODE: 'replay',
  SEAZONA_REPLAY_FILE: BILLING_REPLAY,
  SEAZONA_ORDER_LOOKBACK_DAYS: '1',
  ...env,
});

const order = (id, status = 'In Production') => ({ id, company: 'Example Practice', clientName: 'Dr Example', status, ordered: '30/09/2026' });
const orderDetail = (id, status = 'In Production') => ({ ...order(id, status), products: [{ id: 'P-CROWN', name: 'Example crown', price: 100 }] });

describe('Seazona sync lanes', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let clock;

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    await db.execute(sql`truncate seazona_orders, seazona_invoices, seazona_clients, seazona_reference,
      seazona_lane_state, seazona_order_read_failures, seazona_api_requests, seazona_api_governor`);
    clock = fakeClock('2026-10-01T12:00:00.000Z');
  });

  // One sync run against a replay. Returns the run result and the requests made.
  async function run(responses, { env = {}, only = [], force = true } = {}) {
    const settings = settingsFor(env);
    const fetchImpl = createReplayFetch({ responses });
    const client = createSeazonaClient({ settings, db, fetchImpl, now: clock.now, sleepFn: clock.sleep, random: () => 0 });
    const result = await runSeazonaSync(db, client, { settings, now: clock.now, only, force });
    return { result, calls: fetchImpl.calls, settings };
  }

  const billing = () => loadReplay(BILLING_REPLAY).responses;
  const getOrder = async (id) => (await db.select().from(seazonaOrders).where(eq(seazonaOrders.id, id)))[0];
  const getFailure = async (id) => (await db.select().from(seazonaOrderReadFailures).where(eq(seazonaOrderReadFailures.orderId, id)))[0];

  // Puts orders in the mirror through the recent-order lane.
  async function seed(ids) {
    await run([
      { path: 'orders/', query: { ordered: '*' }, body: ids.map((id) => order(id)) },
      ...ids.map((id) => ({ path: `orders/${id}`, body: orderDetail(id) })),
    ], { only: ['orders_recent'] });
  }

  test('a run fills the mirror with what billing needs, in cents, and nothing clinical', async () => {
    const { result } = await run(billing());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(Object.keys(result.results), ['invoices', 'orders_recent', 'orders_active', 'clients', 'products', 'users']);

    const [invoice] = await db.select().from(seazonaInvoices);
    assert.equal(invoice.invoiceNumber, '5001');
    assert.equal(invoice.totalCents, 24200);
    assert.equal(invoice.discountCents, 1000);
    assert.deepEqual(invoice.lines.map((line) => [line.description, line.amountCents]), [['Example crown', 23000], ['Loyalty discount', -1000]]);
    assert.equal(invoice.patientReference, null);

    const crown = await getOrder('ORD-1001');
    assert.equal(crown.status, 'Complete');
    assert.equal(crown.subtotalCents, 23000);
    assert.equal(crown.patientReference, null);
    assert.equal((await getOrder('ORD-1002')).subtotalCents, 45050);

    const [client] = await db.select().from(seazonaClients).where(eq(seazonaClients.id, 'CL-1'));
    assert.equal(client.email, 'accounts@example.test');
    assert.deepEqual(client.doctors, [{ id: 'DR-1', fullName: 'Dr Example' }]);
    assert.equal(client.active, true);

    const reference = await db.select().from(seazonaReference);
    assert.equal(reference.length, 3);
    assert.equal(reference.find((row) => row.id === 'P-DENT').priceCents, 45050);

    // Notes, files, patient names and staff email never reach the database.
    const { rows } = await db.execute(sql`select
      (select json_agg(o) from seazona_orders o)::text as orders,
      (select json_agg(i) from seazona_invoices i)::text as invoices,
      (select json_agg(c) from seazona_clients c)::text as clients,
      (select json_agg(r) from seazona_reference r)::text as reference`);
    const stored = Object.values(rows[0]).join(' ');
    for (const leak of ['Synthetic Patient', 'clinical note', 'scan.stl', 'Synthetic note', 'tech@example.test', '00 0000 0001']) {
      assert.ok(!stored.includes(leak), `stored ${leak}`);
    }
  });

  test('SEAZONA_KEEP_PATIENT_REFERENCE keeps the patient field as the reference', async () => {
    await run(billing(), { env: { SEAZONA_KEEP_PATIENT_REFERENCE: 'on' }, only: ['invoices', 'orders_recent'] });
    assert.equal((await getOrder('ORD-1001')).patientReference, 'Synthetic Patient A');
    assert.equal((await db.select().from(seazonaInvoices))[0].patientReference, 'Synthetic Patient A');
  });

  test('the first client read asks for every client with an empty lastModified', async () => {
    await db.execute(sql`truncate seazona_lane_state`);
    const { calls } = await run(billing(), { only: ['clients'] });
    const list = calls.find((call) => call.path === 'clients/');
    assert.deepEqual(list.query, { lastModified: '' });
  });

  test('an unchanged list row costs no detail read', async () => {
    await run(billing(), { only: ['invoices', 'orders_recent', 'clients'] });
    clock.advance(10 * MINUTE);
    const { calls, result } = await run(billing(), { only: ['invoices', 'orders_recent', 'clients'] });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => call.path), ['invoices/', 'orders/', 'clients/']);
    assert.equal(result.results.orders_recent.summary.unchanged, 2);
  });

  test('a 404 marks the order deleted in Seazona, keeps its row, and takes it out of the rotation', async () => {
    await seed(['ORD-2001']);
    const before404 = await getOrder('ORD-2001');
    clock.advance(10 * MINUTE);
    const { result } = await run([{ path: 'orders/ORD-2001', status: 404 }], { only: ['orders_active'] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results.orders_active.deletedIds, ['ORD-2001']);

    const deleted = await getOrder('ORD-2001');
    assert.ok(deleted.deletedInSourceAt);
    assert.equal(deleted.status, before404.status, 'the last status Seazona reported is kept');
    assert.equal(orderStatusLabel(deleted), DELETED_STATUS);
    assert.ok(deleted.lastSyncedAt > before404.lastSyncedAt, 'the sync time is refreshed');
    assert.equal(await getFailure('ORD-2001'), undefined, 'a 404 is not a failure');

    // It is never read again by the rotation.
    clock.advance(10 * MINUTE);
    const again = await run([], { only: ['orders_active'] });
    assert.deepEqual(again.calls, []);
    assert.equal((await readSeazonaSyncHealth(db, again.settings, { now: clock.now })).deletedOrders, 1);

    // Seen again in a list, it is read again, and a successful read clears the mark.
    clock.advance(10 * MINUTE);
    await run([
      { path: 'orders/', query: { ordered: '*' }, body: [order('ORD-2001', 'Complete')] },
      { path: 'orders/ORD-2001', body: orderDetail('ORD-2001', 'Complete') },
    ], { only: ['orders_recent'] });
    const back = await getOrder('ORD-2001');
    assert.equal(back.deletedInSourceAt, null);
    assert.equal(orderStatusLabel(back), 'Complete');
  });

  test('a failed read is recorded per order and moves the order to the back of the rotation', async () => {
    await seed(['ORD-3001', 'ORD-3002']);
    const env = { SEAZONA_ACTIVE_ORDERS_PER_RUN: '1' };
    clock.advance(10 * MINUTE);
    // Both were synced at the same time; the tie goes to the lower id.
    const first = await run([{ path: 'orders/ORD-3001', status: 502 }], { env, only: ['orders_active'] });
    assert.deepEqual(first.calls.map((call) => call.path), ['orders/ORD-3001', 'orders/ORD-3001', 'orders/ORD-3001']); // two retries
    const failure = await getFailure('ORD-3001');
    assert.equal(failure.failureCount, 1);
    assert.equal(failure.lastHttpStatus, 502);
    // One of one failed, so this lane run failed; the next run reads the other order.
    assert.equal(first.result.ok, false);
    clock.advance(10 * MINUTE);
    const second = await run([{ path: 'orders/ORD-3002', body: orderDetail('ORD-3002') }], { env, only: ['orders_active'] });
    assert.deepEqual(second.calls.map((call) => call.path), ['orders/ORD-3002']);
  });

  test('after 3 failures an order is quarantined for a day, then gets one more read', async () => {
    await seed(['ORD-4001', 'ORD-4002', 'ORD-4003']);
    const answers = [
      { path: 'orders/ORD-4001', rawBody: '' },
      { path: 'orders/ORD-4002', body: orderDetail('ORD-4002') },
      { path: 'orders/ORD-4003', body: orderDetail('ORD-4003') },
    ];
    for (let i = 0; i < 3; i += 1) {
      clock.advance(10 * MINUTE);
      const { result } = await run(answers, { only: ['orders_active'] });
      assert.equal(result.ok, true, 'one bad order of three never fails the lane');
    }
    const failure = await getFailure('ORD-4001');
    assert.equal(failure.failureCount, 3);
    assert.equal(failure.lastFailureKind, 'empty_response', 'an empty answer is a failure, not a success');
    assert.equal(failure.quarantinedUntil.getTime() - failure.lastAttemptAt.getTime(), DAY);

    clock.advance(10 * MINUTE);
    const quiet = await run(answers, { only: ['orders_active'] });
    assert.ok(!quiet.calls.some((call) => call.path === 'orders/ORD-4001'), 'a quarantined order is not read');
    const health = await readSeazonaSyncHealth(db, quiet.settings, { now: clock.now });
    const active = health.lanes.find((lane) => lane.lane === 'orders_active');
    assert.deepEqual(active.quarantinedOrders.map((o) => [o.id, o.kind, o.failureCount]), [['ORD-4001', 'empty_response', 3]]);

    clock.advance(DAY);
    const retry = await run([...answers.slice(1), { path: 'orders/ORD-4001', body: orderDetail('ORD-4001') }], { only: ['orders_active'] });
    assert.ok(retry.calls.some((call) => call.path === 'orders/ORD-4001'), 'after the quarantine it is read once more');
    assert.equal(await getFailure('ORD-4001'), undefined, 'a successful read clears the record');
  });

  test('the lane fails only when most reads fail, and names each failing order and status', async () => {
    await seed(['ORD-5001', 'ORD-5002', 'ORD-5003']);
    clock.advance(10 * MINUTE);
    const minority = await run([
      { path: 'orders/ORD-5001', status: 500 },
      { path: 'orders/ORD-5002', body: orderDetail('ORD-5002') },
      { path: 'orders/ORD-5003', body: orderDetail('ORD-5003') },
    ], { only: ['orders_active'] });
    assert.equal(minority.result.ok, true);
    assert.deepEqual(minority.result.results.orders_active.failureDetails.failures.map((f) => [f.id, f.httpStatus]), [['ORD-5001', 500]]);

    clock.advance(10 * MINUTE);
    const majority = await run([
      { path: 'orders/ORD-5001', status: 500 },
      { path: 'orders/ORD-5002', error: 'timeout' },
      { path: 'orders/ORD-5003', body: orderDetail('ORD-5003') },
    ], { only: ['orders_active'] });
    const lane = majority.result.results.orders_active;
    assert.equal(lane.ok, false);
    assert.match(lane.error, /failed for 2 of 3: ORD-5001 \(HTTP 500\), ORD-5002 \(timeout\)/);

    const health = await readSeazonaSyncHealth(db, majority.settings, { now: clock.now });
    const active = health.lanes.find((l) => l.lane === 'orders_active');
    assert.equal(health.ok, false);
    assert.equal(active.status, 'failed');
    assert.match(active.lastError, /ORD-5001 \(HTTP 500\)/);
    assert.deepEqual(active.failureDetails.failures.map((f) => [f.id, f.httpStatus, f.kind]), [['ORD-5001', 500, 'http'], ['ORD-5002', null, 'timeout']]);
    assert.ok(!JSON.stringify(health).includes('Synthetic Patient'));
  });

  test('a list exactly at the cap holds the lane and its cursor', async () => {
    const env = { SEAZONA_LIST_CAP: '2' };
    const { result } = await run([
      { path: 'invoices/', query: { lastModified: '*' }, body: [{ invoiceNumber: 1 }, { invoiceNumber: 2 }] },
    ], { env, only: ['invoices'] });
    assert.equal(result.results.invoices.ok, false);
    assert.equal(result.results.invoices.code, 'seazona_list_at_cap');
    const health = await readSeazonaSyncHealth(db, settingsFor(env), { now: clock.now });
    const invoices = health.lanes.find((lane) => lane.lane === 'invoices');
    assert.equal(invoices.status, 'held');
    assert.equal(invoices.lastSuccessAt, null);
  });

  test('one failing lane never stops another', async () => {
    const responses = billing().filter((entry) => entry.path !== 'clients/');
    const { result } = await run(responses);
    assert.equal(result.ok, false);
    assert.equal(result.results.clients.ok, false);
    assert.equal(result.results.invoices.ok, true);
    assert.equal(result.results.products.ok, true);
  });

  test('a 429 stops the lane without counting against any order', async () => {
    await seed(['ORD-6001']);
    clock.advance(10 * MINUTE);
    const { result } = await run([{ path: 'orders/ORD-6001', status: 429, headers: { 'retry-after': '30' } }], { only: ['orders_active'] });
    assert.equal(result.results.orders_active.ok, false);
    assert.ok(result.results.orders_active.retryAfterMs >= 30_000);
    assert.equal(await getFailure('ORD-6001'), undefined);
  });

  test('a lane that is not due waits for its next run', async () => {
    await run(billing(), { only: ['products'] });
    const { calls } = await run(billing(), { force: false });
    assert.ok(!calls.some((call) => call.path === 'products/'), 'products ran a moment ago and are not due');
  });
});
