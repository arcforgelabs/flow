import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createOrganisation } from '../server/core/directory.js';
import { createRegistry } from '../server/integrations/port.js';
import { seazonaOrders, seazonaStageMoves } from '../server/integrations/seazona/schema.js';
import { orderLink, resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import {
  HAND_OFF_MS, cancelStageMove, expiredStageMoves, readPersonSettings, requestStageMove, settleStageMoves, waitingStageMoves, writePersonSetting,
} from '../server/integrations/seazona/stage-moves.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { skipWithoutDatabase } from './support/db.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';

// Stage moves on the Jobs board become hand-offs: Seazona's API cannot change
// an order's status, so Flow never calls it for one. Synthetic data only.
const quiet = { info() {}, warn() {}, error() {} };

const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('the order page link comes from one pasted order link', () => {
  const base = { SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: 'x.json' };
  const settings = resolveSeazonaSettings({ ...base, SEAZONA_ORDER_PAGE_URL: `https://lab.example.test/orders/${GUID}/view` });
  assert.equal(settings.orderPageUrl, 'https://lab.example.test/orders/{order}/view');
  assert.deepEqual(orderLink(settings, { sourceJobRef: 'A 1' }), { url: 'https://lab.example.test/orders/A%201/view', exact: true });
  assert.equal(resolveSeazonaSettings({ ...base, SEAZONA_ORDER_PAGE_URL: 'https://lab.example.test/orders/' }).orderPageUrl, null);
  assert.equal(resolveSeazonaSettings({ ...base, SEAZONA_ORDER_PAGE_URL: `http://lab.example.test/orders/${GUID}` }).orderPageUrl, null);
  assert.equal(orderLink(resolveSeazonaSettings(base), { sourceJobRef: 'A' }), null);
  // With no order page, a lab's API address still gives its Seazona home page.
  assert.deepEqual(orderLink({ orderPageUrl: null, baseUrl: 'https://examplelab.seazonaapi.net/v1' }, { sourceJobRef: 'A' }), { url: 'https://examplelab.seazona.net/', exact: false });
});

describe('stage moves against PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  const clock = fakeClock('2026-10-20T00:00:00.000Z');
  const order = (id, status) => ({
    id, status, lines: [], recordHash: id, firstSeenAt: new Date(clock.now()), lastSyncedAt: new Date(clock.now()), lastChangedAt: new Date(clock.now()),
  });

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
    await db.insert(seazonaOrders).values([order('ORD-1', 'In Production'), order('ORD-2', 'In Production'), order('ORD-3', 'Quality Check')]);
  });

  after(async () => handle?.close());

  test('a move records a hand-off, and never a status Seazona does not use', async () => {
    const move = await requestStageMove(db, { orderId: 'ORD-1', toStatus: 'quality check', personId: 'p1', settings: { orderPageUrl: 'https://lab.example.test/o/{order}' }, now: clock.now() });
    assert.equal(move.kind, 'hand_off');
    assert.deepEqual([move.from, move.to, move.openUrl, move.openExact], ['In Production', 'Quality Check', 'https://lab.example.test/o/ORD-1', true]);
    assert.equal(Date.parse(move.expiresAt) - Date.parse(move.requestedAt), HAND_OFF_MS);
    await assert.rejects(requestStageMove(db, { orderId: 'ORD-1', toStatus: 'Invented', now: clock.now() }), /no status named/);
    await assert.rejects(requestStageMove(db, { orderId: 'ORD-9', toStatus: 'Quality Check', now: clock.now() }), /no Seazona order/);
    await assert.rejects(requestStageMove(db, { orderId: 'ORD-3', toStatus: 'Quality Check', now: clock.now() }), /already/);
    assert.deepEqual([...(await waitingStageMoves(db)).keys()], ['ORD-1']);
  });

  test('the sync settles a move when Seazona has the new status', async () => {
    await db.update(seazonaOrders).set({ status: 'Quality Check' }).where(eq(seazonaOrders.id, 'ORD-1'));
    assert.deepEqual(await settleStageMoves(db, { now: clock.now() }), { done: 1, expired: 0 });
    assert.equal((await waitingStageMoves(db)).size, 0);
  });

  test('a move nobody makes expires after a day, and shows in the alert for a week', async () => {
    await requestStageMove(db, { orderId: 'ORD-2', toStatus: 'Quality Check', now: clock.now() });
    clock.advance(HAND_OFF_MS - 1);
    assert.deepEqual(await settleStageMoves(db, { now: clock.now() }), { done: 0, expired: 0 });
    clock.advance(1);
    assert.deepEqual(await settleStageMoves(db, { now: clock.now() }), { done: 0, expired: 1 });
    assert.deepEqual((await expiredStageMoves(db, { now: clock.now() })).map((m) => m.orderId), ['ORD-2']);
    assert.equal((await expiredStageMoves(db, { now: clock.now() + 8 * HAND_OFF_MS })).length, 0);
  });

  test('a person can take a waiting move back', async () => {
    await requestStageMove(db, { orderId: 'ORD-2', toStatus: 'Quality Check', now: clock.now() });
    assert.deepEqual(await cancelStageMove(db, { orderId: 'ORD-2', now: clock.now() }), { cancelled: true });
    assert.deepEqual(await cancelStageMove(db, { orderId: 'ORD-2', now: clock.now() }), { cancelled: false });
    const [row] = await db.select().from(seazonaStageMoves).where(eq(seazonaStageMoves.orderId, 'ORD-2'));
    assert.equal(row.state, 'cancelled');
  });

  test('"Ask before stage moves" is each person\'s own, on by default', async () => {
    assert.equal((await readPersonSettings(db, 'p1'))[0].value, true);
    await writePersonSetting(db, 'p1', { key: 'askBeforeStageMoves', value: false });
    assert.equal((await readPersonSettings(db, 'p1'))[0].value, false);
    assert.equal((await readPersonSettings(db, 'p2'))[0].value, true);
    await assert.rejects(writePersonSetting(db, 'p1', { key: 'askBeforeStageMoves', value: 'no' }), /on or off/);
    await assert.rejects(writePersonSetting(db, 'p1', { key: 'other', value: true }), /no such setting/);
  });
});

describe('the work moves API with the Seazona adapter', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let staffToken;
  let calls = 0;
  const clock = fakeClock('2026-10-20T00:00:00.000Z');

  before(async () => {
    handle = await freshSeazonaDatabase();
    await createOrganisation(handle.db, { name: 'Example Lab' });
    const now = new Date(clock.now());
    await handle.db.insert(seazonaOrders).values([
      { id: 'ORD-7', status: 'In Production', lines: [], recordHash: 'a', firstSeenAt: now, lastSyncedAt: now, lastChangedAt: now },
      { id: 'ORD-8', status: 'Quality Check', lines: [], recordHash: 'b', firstSeenAt: now, lastSyncedAt: now, lastChangedAt: now },
    ]);
    const { createSeazonaAdapter } = await import('../server/integrations/seazona/index.js');
    // Sandbox mode: the scheduler stays off. Any call to Seazona fails the test.
    const adapter = createSeazonaAdapter({
      env: { SEAZONA_MODE: 'sandbox', SEAZONA_API_BASE_URL: 'https://seazona.example.test', SEAZONA_API_CLIENT_ID: 'id', SEAZONA_API_CLIENT_SECRET: 'secret' },
      fetchImpl: async () => { calls += 1; throw new Error('no call to Seazona is expected'); },
      now: clock.now,
    });
    const integrations = createRegistry({ log: quiet, env: {} });
    integrations.register(adapter);
    integrations.enable('seazona');
    await integrations.start(handle.db);
    const clerk = fakeClerk();
    const owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await invitePerson(handle.db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    staffToken = clerk.signIn(clerk.addUser({ email: 'staff@example.test' }));
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log: quiet });
  });

  after(async () => handle?.close());

  const call = (path, options = {}) => request(app, `/api/work${path}`, { token: staffToken, ...options });

  test('a move answers a hand-off, the board carries it, and Seazona gets no call', async () => {
    const moved = await call('/moves', { method: 'POST', body: { sourceSystem: 'seazona', sourceJobRef: 'ORD-7', toStatus: 'Quality Check' } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.move.kind, 'hand_off');
    assert.equal(moved.body.move.openUrl, null);
    const board = await request(app, '/api/invoicing/board', { token: staffToken });
    const card = board.body.jobs.find((j) => j.sourceJobRef === 'ORD-7');
    assert.equal(card.pendingMove.to, 'Quality Check');
    assert.equal(card.status, 'In Production');
    assert.equal(card.link, null);

    const unknown = await call('/moves', { method: 'POST', body: { sourceSystem: 'nothing', sourceJobRef: 'ORD-7', toStatus: 'Quality Check' } });
    assert.equal(unknown.status, 409);
    const cancelled = await call('/moves/cancel', { method: 'POST', body: { sourceSystem: 'seazona', sourceJobRef: 'ORD-7' } });
    assert.equal(cancelled.body.cancelled, true);
    assert.equal(calls, 0);
  });

  test('each person reads and changes only their own settings', async () => {
    const read = await call('/my-settings');
    assert.deepEqual(read.body.integrations.map((i) => [i.integration, i.settings.map((s) => [s.key, s.value])]), [['seazona', [['askBeforeStageMoves', true]]]]);
    const changed = await call('/my-settings', { method: 'PUT', body: { integration: 'seazona', key: 'askBeforeStageMoves', value: false } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.settings[0].value, false);
    assert.equal((await call('/my-settings', { method: 'PUT', body: { integration: 'seazona', key: 'askBeforeStageMoves', value: 'off' } })).status, 400);
  });
});
