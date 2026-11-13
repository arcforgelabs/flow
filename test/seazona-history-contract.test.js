import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { readBackfill, startBackfill, stopBackfill } from '../server/integrations/seazona/history/backfill.js';
import { createApiBatch } from '../server/integrations/seazona/history/index.js';
import { runSeazonaSync } from '../server/integrations/seazona/lanes.js';
import { seazonaHistoryJobs } from '../server/integrations/seazona/schema.js';
import { resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import { resetFailedLanes, resetStoppedLanes } from '../server/integrations/seazona/store.js';
import { skipWithoutDatabase } from './support/db.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';

// The history backfill's contract (docs/SEAZONA.md, "The backfill's limits"):
// it stays inside the rate limit, and it never retries without end.
// Synthetic data only (CONTRIBUTING.md): no real lab, practice, dentist or patient.

const DAY_MS = 86_400_000;
const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

// A small Seazona: its order list answers the orders placed on or after
// `ordered`, oldest first, in pages, as Seazona's guide says. `answer`
// may replace any answer: (path, query, nth request of that path) -> Response.
function fakeSeazona(orders, { answer = () => null, ignorePage = false } = {}) {
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1\//, '');
    const query = Object.fromEntries(url.searchParams);
    requests.push({ path, query });
    const nth = requests.filter((r) => r.path === path).length;
    const forced = answer(path, query, nth);
    if (forced) return forced;
    if (path === 'orders/') {
      const from = query.ordered.slice(0, 10);
      const size = Number(query.pageSize);
      const page = ignorePage ? 1 : Number(query.page ?? 1);
      const rows = orders.filter((o) => o.day >= from).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      return json(200, rows.slice((page - 1) * size, page * size).map((o) => ({ id: o.id, ordered: `${o.day}T09:00:00` })));
    }
    const order = orders.find((o) => `orders/${o.id}` === path);
    if (!order) return json(404);
    return json(200, { id: order.id, invoiceNumber: `S-${order.id}`, company: 'Example Dental', clientName: 'Dr Example', status: 'Shipped', ordered: '02/01/2020', products: [{ id: 'P1', name: 'Crown', code: 'CROWN', price: 200 }] });
  };
  return { fetchImpl, requests, lists: () => requests.filter((r) => r.path === 'orders/'), reads: (id) => requests.filter((r) => r.path === `orders/${id}`) };
}

describe('Seazona history backfill: rate limit and retry contract', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let clock;

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    await db.execute(sql`truncate seazona_orders, seazona_clients, seazona_lane_state, seazona_record_read_failures, seazona_api_governor, seazona_api_requests,
      seazona_history_batches, seazona_history_rows, seazona_history_batch_jobs, seazona_history_jobs restart identity`);
    clock = fakeClock('2026-10-20T00:00:00.000Z');
  });

  const settingsOf = (env = {}) => resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: 'unused.json', SEAZONA_HISTORY_CALLS_PER_RUN: '4', ...env });
  const clientOf = (settings, seazona) => createSeazonaClient({ settings, db, fetchImpl: seazona.fetchImpl, now: clock.now, sleepFn: clock.sleep, random: () => 0 });
  const start = (settings, from, through) => startBackfill(db, { from, through, createdBy: 'person:test', settings, now: clock.now });
  // The scheduler's own pass: only the lanes that are due run, and a stopped lane does not.
  const dueRun = (settings, client) => runSeazonaSync(db, client, { settings, now: clock.now }).then((r) => r.results.history ?? null);
  // Runs the lane whenever it is due for `hours`, as the scheduler would.
  const runFor = async (settings, client, hours) => {
    const results = [];
    for (let i = 0; i < hours * 60; i += 1) {
      const result = await dueRun(settings, client);
      if (result) results.push(result);
      clock.advance(60_000);
    }
    return results;
  };
  const admitted = async () => (await db.execute(sql`select (extract(epoch from admitted_at) * 1000)::float8 as at from seazona_api_requests order by admitted_at`)).rows.map((r) => Number(r.at));

  // Only the history lane calls in these tests: the other lanes wait far off.
  const quietOtherLanes = async () => {
    const far = new Date(clock.now() + 3650 * DAY_MS);
    for (const lane of ['invoices', 'orders_recent', 'orders_active', 'clients', 'products', 'users', 'sweep']) {
      await db.execute(sql`insert into seazona_lane_state (lane, status, next_run_at) values (${lane}, 'ok', ${far})
        on conflict (lane) do update set status = 'ok', next_run_at = ${far}`);
    }
  };
  beforeEach(quietOtherLanes);

  test('a run never sends more than its budget, retries counted, and every request waits its turn in the governor', async () => {
    const settings = settingsOf();
    const orders = Array.from({ length: 12 }, (_, i) => ({ id: `H-${i + 1}`, day: '2020-01-02' }));
    // Each order answers 503 once, then well: every read is two requests.
    const seazona = fakeSeazona(orders, { answer: (path, _query, nth) => (path !== 'orders/' && nth === 1 ? json(503) : null) });
    const client = clientOf(settings, seazona);
    await start(settings, '2020-01-02', '2020-01-02');
    let before = 0;
    for (let run = 0; run < 4; run += 1) {
      await dueRun(settings, client);
      const sent = seazona.requests.length - before;
      before = seazona.requests.length;
      assert.ok(sent <= settings.sync.historyCallsPerRun, `run ${run + 1} sent ${sent} requests`);
      // The 503s open the circuit after 5 in 10 minutes; wait it out.
      clock.advance(10 * 60_000);
    }
    const times = await admitted();
    assert.equal(times.length, seazona.requests.length, 'every request was admitted by the governor first');
    for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= 2_000, 'at least 2 seconds between requests');
    for (const at of times) assert.ok(times.filter((t) => t > at - 60_000 && t <= at).length <= 30, 'never more than 30 in a minute');
  });

  test('the last call of a run does not retry past the budget', async () => {
    const settings = settingsOf({ SEAZONA_HISTORY_CALLS_PER_RUN: '10' });
    const orders = Array.from({ length: 12 }, (_, i) => ({ id: `H-${i + 1}`, day: '2020-01-02' }));
    // The list and eight orders answer well: nine requests. The tenth, order H-9, answers 503 every time.
    const seazona = fakeSeazona(orders, { answer: (path) => (path === 'orders/H-9' ? json(503) : null) });
    const client = clientOf(settings, seazona);
    await start(settings, '2020-01-02', '2020-01-02');
    const first = await dueRun(settings, client);
    assert.equal(seazona.requests.length, 10, 'the tenth request is the last, with no retry');
    assert.equal(first.calls, 10);
    assert.equal(seazona.reads('H-9').length, 1);
    // Earlier in a run a call may still retry, inside what is left.
    clock.advance(2 * 60_000);
    const before = seazona.requests.length;
    await dueRun(settings, client);
    assert.ok(seazona.requests.length - before <= 10);
    assert.equal(seazona.reads('H-9').length, 1 + 3, 'first in the run: its own three tries');
  });

  test('a cursor stored before this change still loads: a stopped read resumes, a running one goes on', async () => {
    const settings = settingsOf();
    const orders = [{ id: 'H-1', day: '2020-01-02' }, { id: 'H-2', day: '2020-01-02' }, { id: 'H-3', day: '2020-01-03' }];
    const seazona = fakeSeazona(orders);
    const client = clientOf(settings, seazona);
    const at = new Date(clock.now());
    const { id: batchId } = await createApiBatch(db, { createdBy: 'person:test', from: '2020-01-02', through: '2020-01-03', at });
    // The shape the lane wrote before: no lastPage and no gaveUp.
    const stored = {
      batchId, from: '2020-01-02', through: '2020-01-03', nextDay: '2020-01-02', page: 2, pending: ['H-2'], done: true, stopped: true,
      days: 0, read: 1, startedAt: '2026-10-19T09:02:00.000Z', endedAt: '2026-10-19T09:03:00.000Z', listDay: '2020-01-02', reached: '2020-01-03',
    };
    const store = (cursor) => db.execute(sql`insert into seazona_lane_state (lane, status, cursor, next_run_at) values ('history', 'ok', ${JSON.stringify(cursor)}::jsonb, ${at})
      on conflict (lane) do update set status = 'ok', cursor = excluded.cursor, next_run_at = excluded.next_run_at`);
    await store(stored);
    const read = await readBackfill(db);
    assert.equal(read.phase, 'stopped');
    assert.equal(read.resumeFrom, '2020-01-02');
    assert.equal(read.ordersRead, 1);
    assert.equal(read.gaveUp, null);
    assert.equal(read.endedAt, '2026-10-19T09:03:00.000Z');
    await runFor(settings, client, 1);
    assert.equal(seazona.requests.length, 0, 'a stopped read makes no request');

    // The same cursor while it ran: the lane goes on from its day, page and waiting orders.
    await store({ ...stored, done: false, stopped: false, endedAt: undefined, page: 1, nextDay: '2020-01-03' });
    assert.equal((await readBackfill(db)).phase, 'running');
    await runFor(settings, client, 1);
    assert.deepEqual(seazona.requests.map((r) => r.path), ['orders/H-2', 'orders/', 'orders/H-3']);
    const done = await readBackfill(db);
    assert.equal(done.phase, 'done');
    assert.equal(done.ordersRead, 3);
  });

  test('a 429 with a long Retry-After: no request goes out until it has passed', async () => {
    const settings = settingsOf();
    const seazona = fakeSeazona([{ id: 'H-1', day: '2020-01-02' }], {
      answer: (path, _query, nth) => (path === 'orders/' && nth === 1 ? json(429, undefined, { 'retry-after': '1800' }) : null),
    });
    const client = clientOf(settings, seazona);
    await start(settings, '2020-01-02', '2020-01-02');
    const asked = clock.now();
    const first = await dueRun(settings, client);
    assert.equal(first.ok, false);
    assert.equal(seazona.requests.length, 1, 'the 429 is not retried into the cooldown');
    assert.ok(clock.now() + first.retryAfterMs >= asked + 1_800_000, 'the lane comes back when the wait has ended');
    await runFor(settings, client, 1);
    assert.ok(seazona.requests.length > 1, 'it reads again afterwards');
    assert.ok(clock.now() >= asked + 1_800_000);
    const times = await admitted();
    assert.ok(times[1] - times[0] >= 1_800_000, `the next request went ${times[1] - times[0]} ms after the 429`);
    assert.equal((await readBackfill(db)).phase, 'done');
  });

  test('a list that keeps failing: the read gives up after the cap, and no hour or day brings a retry', async () => {
    const settings = settingsOf({ SEAZONA_API_MAX_RETRIES: '0' });
    const seazona = fakeSeazona([], { answer: (path) => (path === 'orders/' ? json(503) : null) });
    const client = clientOf(settings, seazona);
    await start(settings, '2020-01-02', '2020-01-03');
    const results = await runFor(settings, client, 12);
    assert.equal(results.length, settings.sync.historyMaxFailedRuns, 'it ran only until the cap');
    assert.equal(results.at(-1).code, 'seazona_history_gave_up');
    const sentAtCap = seazona.requests.length;
    assert.ok(sentAtCap <= settings.sync.historyMaxFailedRuns, `${sentAtCap} requests in all`);

    const read = await readBackfill(db);
    assert.equal(read.phase, 'failed');
    assert.equal(read.nextRunAt, null);
    assert.match(read.cause, /HTTP 503/);
    assert.match(read.cause, /6 runs failed in a row; Flow stopped trying/);
    assert.equal(read.gaveUp.code, 'seazona_api_request_failed');
    assert.equal(read.gaveUp.failedRuns, 6);
    assert.equal(read.gaveUp.day, '2020-01-02');

    // Days pass; a restart and a settings save both leave it alone.
    await runFor(settings, client, 72);
    await resetStoppedLanes(db, { at: new Date(clock.now()) });
    await runFor(settings, client, 2);
    await resetFailedLanes(db, { at: new Date(clock.now()) });
    await runFor(settings, client, 2);
    assert.equal(seazona.requests.length, sentAtCap, 'no request after it gave up');
    assert.equal((await readBackfill(db)).phase, 'failed', 'still failed, with its cause, after a restart');
    assert.match((await readBackfill(db)).cause, /HTTP 503/);
  });

  test('Retry, a person\'s act, starts a read that gave up again', async () => {
    const settings = settingsOf({ SEAZONA_API_MAX_RETRIES: '0', SEAZONA_HISTORY_MAX_FAILED_RUNS: '2' });
    let down = true;
    const seazona = fakeSeazona([{ id: 'H-1', day: '2020-01-02' }], { answer: (path) => (down && path === 'orders/' ? json(503) : null) });
    const client = clientOf(settings, seazona);
    await start(settings, '2020-01-02', '2020-01-02');
    await runFor(settings, client, 1);
    assert.equal((await readBackfill(db)).phase, 'failed');
    assert.equal(seazona.requests.length, 2);
    down = false;
    // What the Retry button does: stop, then start from where it stopped.
    const stopped = await stopBackfill(db, { now: clock.now });
    await start(settings, stopped.resumeFrom, '2020-01-02');
    await runFor(settings, client, 1);
    assert.equal((await readBackfill(db)).phase, 'done');
    assert.deepEqual((await db.select().from(seazonaHistoryJobs)).map((h) => h.jobKey), ['case:H-1']);
  });

  test('an order that keeps failing is read once a run, three times in all, then left out; the walk goes on', async () => {
    const settings = settingsOf({ SEAZONA_API_MAX_RETRIES: '0' });
    const orders = [{ id: 'BAD', day: '2020-01-02' }, { id: 'H-2', day: '2020-01-02' }];
    const seazona = fakeSeazona(orders, { answer: (path) => (path === 'orders/BAD' ? json(500) : null) });
    const client = clientOf(settings, seazona);
    await start(settings, '2020-01-02', '2020-01-02');
    const perRun = [];
    for (let run = 0; run < 6; run += 1) {
      const before = seazona.reads('BAD').length;
      await dueRun(settings, client);
      perRun.push(seazona.reads('BAD').length - before);
      clock.advance(2 * 60_000);
    }
    assert.deepEqual(perRun, [1, 1, 1, 0, 0, 0], 'once a run, and never after the quarantine');
    const read = await readBackfill(db);
    assert.equal(read.phase, 'done');
    assert.equal(read.ordersSkipped, 1);
    assert.deepEqual((await db.select().from(seazonaHistoryJobs)).map((h) => h.jobKey), ['case:H-2']);
    await runFor(settings, client, 48);
    assert.equal(seazona.reads('BAD').length, 3, 'no read again when the quarantine ends');
  });

  test('an order Seazona no longer has (404) is skipped after one request and is not a failed call', async () => {
    const settings = settingsOf();
    const seazona = fakeSeazona([{ id: 'H-1', day: '2020-01-02' }], {
      answer: (path, query) => (path === 'orders/' && query.page === '1' && query.ordered.startsWith('2020-01-02')
        ? json(200, [{ id: 'GONE', ordered: '2020-01-02T08:00:00' }, { id: 'H-1', ordered: '2020-01-02T09:00:00' }]) : null),
    });
    const client = clientOf(settings, seazona);
    await start(settings, '2020-01-02', '2020-01-02');
    await runFor(settings, client, 1);
    assert.equal(seazona.reads('GONE').length, 1);
    const read = await readBackfill(db);
    assert.equal(read.phase, 'done');
    assert.equal(read.ordersSkipped, 0);
    assert.equal((await client.governor.status()).failedToday, 0);
  });

  test('a refused list (400) gives up at once; a refused API client (401) stops every call until a person saves the settings', async () => {
    const settings = settingsOf();
    const refused = fakeSeazona([], { answer: (path) => (path === 'orders/' ? json(400) : null) });
    await start(settings, '2020-01-02', '2020-01-03');
    const client = clientOf(settings, refused);
    await runFor(settings, client, 6);
    await resetStoppedLanes(db, { at: new Date(clock.now()) });
    await runFor(settings, client, 6);
    assert.equal(refused.requests.length, 1, 'one request, and none after a restart');
    const gone = await readBackfill(db);
    assert.equal(gone.phase, 'failed');
    assert.equal(gone.gaveUp.httpStatus, 400);
    await stopBackfill(db, { now: clock.now });

    let secretOk = false;
    const auth = fakeSeazona([{ id: 'H-1', day: '2020-01-02' }], { answer: () => (secretOk ? null : json(401)) });
    const second = clientOf(settings, auth);
    await start(settings, '2020-01-02', '2020-01-02');
    await runFor(settings, second, 6);
    await resetStoppedLanes(db, { at: new Date(clock.now()) });
    await runFor(settings, second, 6);
    assert.equal(auth.requests.length, 1, 'the halt holds across a restart: no second request');
    const halted = await readBackfill(db);
    assert.equal(halted.phase, 'failed');
    assert.equal(halted.gaveUp, null, 'a halt is the governor\'s: the read goes on when a person fixes the API client');
    // A person saves the settings (index.js, start with reconfigured).
    secretOk = true;
    await second.governor.resume();
    await resetFailedLanes(db, { at: new Date(clock.now()) });
    await quietOtherLanes();
    await runFor(settings, second, 1);
    assert.equal((await readBackfill(db)).phase, 'done');
  });

  test('a list that answers the same full page again gives up at once, not page after page', async () => {
    const settings = settingsOf({ SEAZONA_HISTORY_PAGE_SIZE: '2', SEAZONA_HISTORY_CALLS_PER_RUN: '25' });
    const orders = [{ id: 'H-1', day: '2020-01-02' }, { id: 'H-2', day: '2020-01-02' }, { id: 'H-3', day: '2020-01-02' }];
    const seazona = fakeSeazona(orders, { ignorePage: true });
    const client = clientOf(settings, seazona);
    await start(settings, '2020-01-02', '2020-01-02');
    await runFor(settings, client, 24);
    assert.equal(seazona.lists().length, 2, 'page 1, and page 2 that repeats it');
    const read = await readBackfill(db);
    assert.equal(read.phase, 'failed');
    assert.equal(read.gaveUp.code, 'seazona_list_repeats');
    assert.equal(read.gaveUp.page, 2);
  });

  test('a walk from 2010 over empty years costs a few list calls, and ends when the newest order is before the last day', async () => {
    const settings = settingsOf({ SEAZONA_HISTORY_PAGE_SIZE: '2', SEAZONA_HISTORY_CALLS_PER_RUN: '25' });
    // Nothing before 2024, five orders, and none after the last day asked for.
    const orders = [
      { id: 'H-1', day: '2024-06-06' }, { id: 'H-2', day: '2024-06-06' }, { id: 'H-3', day: '2024-07-01' },
      { id: 'H-4', day: '2024-07-02' }, { id: 'H-5', day: '2024-07-03' },
    ];
    const seazona = fakeSeazona(orders);
    const client = clientOf(settings, seazona);
    await start(settings, '2010-01-01', '2024-07-06');
    await runFor(settings, client, 2);
    const read = await readBackfill(db);
    assert.equal(read.phase, 'done');
    assert.equal(read.ordersRead, 5);
    for (const order of orders) assert.equal(seazona.reads(order.id).length, 1, `${order.id} read once`);
    // Three pages from 2010, then one list a day from the newest order's day to the last day.
    assert.deepEqual(seazona.lists().map((r) => `${r.query.ordered.slice(0, 10)} p${r.query.page}`), [
      '2010-01-01 p1', '2010-01-01 p2', '2010-01-01 p3', '2024-07-03 p1', '2024-07-04 p1', '2024-07-05 p1', '2024-07-06 p1',
    ]);
  });
});
