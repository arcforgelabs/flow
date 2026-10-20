import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { readSeazonaSyncHealth, runSeazonaSync } from '../server/integrations/seazona/lanes.js';
import { seazonaInvoices, seazonaOrders } from '../server/integrations/seazona/schema.js';
import { resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import { skipWithoutDatabase } from './support/db.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';

// Issue #125: a Seazona list at the row cap must not hold its lane for ever.
// The fake Seazona here answers lists the way the API guide says
// (support.seazona.net/Api.html): invoices modified on or after
// `lastModified`, oldest change first, cut at the cap; orders placed on or
// after `ordered`, oldest first, in stable pages. Synthetic data only.

const CAP = 50;
const SECOND = 1000;

const settingsFor = (env = {}) => resolveSeazonaSettings({
  SEAZONA_MODE: 'replay',
  SEAZONA_REPLAY_FILE: new URL('./fixtures/seazona/billing.json', import.meta.url).pathname,
  SEAZONA_ORDER_LOOKBACK_DAYS: '1',
  SEAZONA_LIST_CAP: String(CAP),
  ...env,
});

// Seazona writes lastModified in UTC with no zone suffix.
const seazonaTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '');
const parseUtc = (value) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);

function fakeSeazona({ invoices = [], orders = [], ignorePaging = false } = {}) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  async function fetchImpl(input) {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^.*\/v1\//, '').replace(/^\//, '');
    const query = Object.fromEntries(url.searchParams);
    calls.push({ path, query });
    if (path === 'invoices/') {
      const since = parseUtc(query.lastModified);
      const rows = invoices.filter((row) => parseUtc(row.lastModified) >= since)
        .sort((a, b) => parseUtc(a.lastModified) - parseUtc(b.lastModified) || a.id.localeCompare(b.id));
      return json(rows.slice(0, CAP));
    }
    if (path.startsWith('invoices/')) {
      const row = invoices.find((candidate) => candidate.id === decodeURIComponent(path.slice('invoices/'.length)));
      return row ? json({ ...row, productServiceItems: [] }) : json('Not found', 404);
    }
    if (path === 'orders/') {
      const since = parseUtc(query.ordered);
      const size = Number(query.pageSize ?? 100);
      const page = ignorePaging ? 1 : Number(query.page ?? 1);
      const rows = orders.filter((row) => parseUtc(row.ordered) >= since)
        .sort((a, b) => parseUtc(a.ordered) - parseUtc(b.ordered) || a.id.localeCompare(b.id));
      return json(rows.slice((page - 1) * size, page * size));
    }
    if (path.startsWith('orders/')) {
      const row = orders.find((candidate) => candidate.id === decodeURIComponent(path.slice('orders/'.length)));
      return row ? json({ ...row, products: [] }) : json('Not found', 404);
    }
    return json([]);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

const invoice = (n, lastModifiedMs) => ({
  id: `INV-ID-${n}`,
  invoiceNumber: 7000 + n,
  clientId: 'CL-1',
  company: 'Example Practice',
  status: 'Open',
  lastModified: seazonaTime(lastModifiedMs),
  subtotal: 100,
  tax: 10,
  total: 110,
});

const order = (n, orderedMs) => ({
  id: `ORD-${9000 + n}`,
  company: 'Example Practice',
  clientName: 'Dr Example',
  status: 'In Production',
  ordered: seazonaTime(orderedMs),
});

describe('Seazona lists at the row cap (issue #125)', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let clock;

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    await db.execute(sql`truncate seazona_orders, seazona_invoices, seazona_lane_state, seazona_order_read_failures,
      seazona_record_read_failures, seazona_api_requests, seazona_api_governor`);
    clock = fakeClock('2026-10-01T12:00:00.000Z');
  });

  async function run(seazona, { env = {}, only }) {
    const settings = settingsFor(env);
    const client = createSeazonaClient({ settings, db, fetchImpl: seazona, now: clock.now, sleepFn: clock.sleep, random: () => 0 });
    return runSeazonaSync(db, client, { settings, now: clock.now, only, force: true });
  }
  const laneHealth = async (lane, env = {}) => (await readSeazonaSyncHealth(db, settingsFor(env), { now: clock.now }))
    .lanes.find((row) => row.lane === lane);
  const laneState = async (lane) => (await db.execute(sql`select cursor_time, cursor from seazona_lane_state where lane = ${lane}`)).rows[0];

  test('120 changed invoices in one window, cap 50: the lane stores all 120 and moves its cursor', async () => {
    const start = Date.parse('2026-10-01T00:00:00Z');
    // A bulk change: 120 invoices modified within one minute, 2 per second.
    const invoices = Array.from({ length: 120 }, (_, i) => invoice(i, start + Math.floor(i / 2) * SECOND));
    const seazona = fakeSeazona({ invoices });
    const result = await run(seazona, { only: ['invoices'] });
    assert.equal(result.results.invoices.ok, true, JSON.stringify(result.results.invoices));
    assert.equal((await db.select().from(seazonaInvoices)).length, 120);
    const state = await laneState('invoices');
    assert.ok(new Date(state.cursor_time).getTime() > start, 'the cursor moved');
    assert.equal((await laneHealth('invoices')).status, 'ok');

    // The next run asks from the new cursor and reads nothing again.
    clock.advance(3 * 60_000);
    const detailsBefore = seazona.calls.filter((call) => call.path.startsWith('invoices/INV')).length;
    const again = await run(seazona, { only: ['invoices'] });
    assert.equal(again.results.invoices.ok, true);
    assert.equal(seazona.calls.filter((call) => call.path.startsWith('invoices/INV')).length, detailsBefore);
  });

  test('a run that reaches its page limit keeps an exact cursor, and the next run goes on from it', async () => {
    const start = Date.parse('2026-10-01T00:00:00Z');
    const invoices = Array.from({ length: 120 }, (_, i) => invoice(i, start + i * SECOND));
    const seazona = fakeSeazona({ invoices });
    const env = { SEAZONA_LIST_PAGES_PER_RUN: '1' };
    const first = await run(seazona, { env, only: ['invoices'] });
    assert.equal(first.results.invoices.ok, true, JSON.stringify(first.results.invoices));
    assert.equal((await db.select().from(seazonaInvoices)).length, CAP);
    assert.equal((await laneHealth('invoices', env)).status, 'ok');
    for (let runs = 0; runs < 3; runs += 1) {
      clock.advance(3 * 60_000);
      await run(seazona, { env, only: ['invoices'] });
    }
    assert.equal((await db.select().from(seazonaInvoices)).length, 120);
    // Each later list asked from the last row it had, never 5 minutes back.
    const asked = seazona.calls.filter((call) => call.path === 'invoices/').map((call) => call.query.lastModified);
    assert.ok(parseUtc(asked[1]) >= start + (CAP - 1) * SECOND, asked[1]);
  });

  test('a full list inside one second cannot split, so the lane holds and keeps its cursor', async () => {
    const start = Date.parse('2026-10-01T00:00:00Z');
    const invoices = Array.from({ length: 60 }, (_, i) => invoice(i, start + 30 * 60_000));
    const seazona = fakeSeazona({ invoices });
    const result = await run(seazona, { only: ['invoices'] });
    assert.equal(result.results.invoices.ok, false);
    assert.equal(result.results.invoices.code, 'seazona_list_at_cap');
    const health = await laneHealth('invoices');
    assert.equal(health.status, 'held');
    assert.equal(health.lastSuccessAt, null);
    // The rows it could read are kept.
    assert.equal((await db.select().from(seazonaInvoices)).length, CAP);
  });

  test('a day with 120 orders is read page by page, and the lane moves on', async () => {
    const day = Date.parse('2026-10-01T00:00:00Z');
    const orders = Array.from({ length: 120 }, (_, i) => order(i, day + 60_000 * i));
    const seazona = fakeSeazona({ orders });
    const result = await run(seazona, { only: ['orders_recent'] });
    assert.equal(result.results.orders_recent.ok, true, JSON.stringify(result.results.orders_recent));
    assert.equal((await db.select().from(seazonaOrders)).length, 120);
    const pages = seazona.calls.filter((call) => call.path === 'orders/' && call.query.ordered.startsWith('2026-10-01'));
    assert.deepEqual(pages.map((call) => [call.query.page, call.query.pageSize]), [['1', '50'], ['2', '50'], ['3', '50']]);
    assert.equal((await laneHealth('orders_recent')).status, 'ok');
  });

  test('when Seazona answers the same page again, the order lane holds', async () => {
    const day = Date.parse('2026-10-01T00:00:00Z');
    const orders = Array.from({ length: 80 }, (_, i) => order(i, day + 60_000 * i));
    const seazona = fakeSeazona({ orders, ignorePaging: true });
    const result = await run(seazona, { only: ['orders_recent'] });
    assert.equal(result.results.orders_recent.ok, false);
    assert.equal(result.results.orders_recent.code, 'seazona_list_at_cap');
    assert.equal((await laneHealth('orders_recent')).status, 'held');
  });
});
