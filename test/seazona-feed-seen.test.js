import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createOrganisation } from '../server/core/directory.js';
import { ledgerView, observeJob } from '../server/core/ledger.js';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { readBillableWork } from '../server/integrations/seazona/feed.js';
import { runSeazonaSync } from '../server/integrations/seazona/lanes.js';
import { createReplayFetch, loadReplay } from '../server/integrations/seazona/replay.js';
import { resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import { skipWithoutDatabase } from './support/db.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';

// The billing feed reports an order again after a read that found no change,
// at most once an hour, so its ledger report never goes out of date while the
// lanes keep reading it. Synthetic data only (CONTRIBUTING.md).

const BILLING_REPLAY = fileURLToPath(new URL('./fixtures/seazona/billing.json', import.meta.url));
const HOUR = 60 * 60_000;

async function readAll(db, cursor) {
  const items = [];
  for (;;) {
    const page = await readBillableWork(db, { cursor });
    items.push(...page.items);
    cursor = page.cursor;
    if (!page.more) return { items, cursor };
  }
}

describe('Seazona billing feed: a read with no change', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  const clock = fakeClock('2026-10-01T12:00:00.000Z');
  const settings = resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: BILLING_REPLAY, SEAZONA_ORDER_LOOKBACK_DAYS: '3' });
  const sync = () => runSeazonaSync(db, createSeazonaClient({
    settings, db, fetchImpl: createReplayFetch({ responses: loadReplay(BILLING_REPLAY).responses }), now: clock.now, sleepFn: clock.sleep,
  }), { settings, now: clock.now, force: true });

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
  });
  after(async () => handle?.close());

  test('is not reported again in the same hour', async () => {
    await sync();
    const first = await readAll(db, null);
    assert.deepEqual(first.items.map((item) => item.sourceId), ['ORD-1001']);
    await observeJob(db, lab.id, { ...first.items[0].ledgerJob, contactId: null });

    clock.advance(10 * 60_000);
    await sync();
    const again = await readAll(db, first.cursor);
    assert.equal(again.items.length, 0, 'nothing changed and the hour did not turn');
  });

  test('is reported again in a later hour, so the ledger report stays current', async () => {
    const { cursor } = await readAll(db, null);
    clock.advance(2 * 24 * HOUR);
    const readFrom = clock.now();
    await sync(); // Seazona answers the same order: no change
    const later = await readAll(db, cursor);
    assert.deepEqual(later.items.map((item) => item.sourceId), ['ORD-1001']);
    assert.ok(Date.parse(later.items[0].syncedAt) >= readFrom, 'the item carries the time of the new read');

    const obligation = await observeJob(db, lab.id, { ...later.items[0].ledgerJob, contactId: null });
    assert.equal(obligation.sourceSeenAt.toISOString(), later.items[0].syncedAt);
    const { reasons } = ledgerView(obligation, { now: new Date(clock.now()) });
    assert.ok(!reasons.includes('the work system report is out of date'), reasons.join('; '));
  });

  test('an order no lane reads again is not reported again, and its report goes out of date', async () => {
    const { cursor } = await readAll(db, null);
    clock.advance(2 * 24 * HOUR);
    const later = await readAll(db, cursor);
    assert.equal(later.items.length, 0);
    const obligation = await observeJob(db, lab.id, { ...(await readBillableWork(db)).items[0].ledgerJob, contactId: null });
    const { reasons } = ledgerView(obligation, { now: new Date(clock.now()) });
    assert.ok(reasons.includes('the work system report is out of date'));
  });
});
