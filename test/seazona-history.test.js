import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createIntegrations } from '../server/integrations/index.js';
import { createSeazonaAdapter } from '../server/integrations/seazona/index.js';
import { parseCsv } from '../server/integrations/seazona/history/csv.js';
import {
  applyBatch,
  cancelBatch,
  createApiBatch,
  decideJobs,
  historyJobIssues,
  historySummary,
  listBatches,
  readBatch,
  readHistoryWork,
  stageApiJobs,
  stageBatch,
} from '../server/integrations/seazona/history/index.js';
import { detectColumns, groupJobs, moneyCents, readRow } from '../server/integrations/seazona/history/read.js';
import { seazonaClients, seazonaHistoryJobs, seazonaHistoryRows, seazonaInvoices, seazonaOrders } from '../server/integrations/seazona/schema.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';
import { createSeazonaClient } from '../server/integrations/seazona/client.js';
import { runSeazonaSync } from '../server/integrations/seazona/lanes.js';
import { createReplayFetch } from '../server/integrations/seazona/replay.js';
import { resolveSeazonaSettings } from '../server/integrations/seazona/settings.js';
import { orderToHistoryJob, readBackfill, startBackfill } from '../server/integrations/seazona/history/backfill.js';

// Synthetic data only (CONTRIBUTING.md): no real lab, practice, dentist or patient.

const HEADER = 'Invoice #,Due Date,Company Name,Doctor Name,Patient,Item,Item Amount,Item Taxable,Total';
const csvOf = (...lines) => [HEADER, ...lines].join('\r\n');

describe('Seazona CSV reading', () => {
  test('reads quotes, commas, doubled quotes, line breaks and a byte order mark', () => {
    const { headers, rows } = parseCsv('﻿A,B\r\n"x, y","say ""hi"""\n"two\nlines",3\n\n');
    assert.deepEqual(headers, ['A', 'B']);
    assert.deepEqual(rows.map((r) => r.cells), [['x, y', 'say "hi"'], ['two\nlines', '3']]);
    assert.throws(() => parseCsv('A\n"open'), /no closing quote/);
  });

  test('guesses columns, lists unknown ones, and says what is missing', () => {
    const found = detectColumns(['Invoice #', 'Due Date', 'Company Name', 'Item', 'Item Amount', 'Shade Notes']);
    assert.equal(found.columns.invoiceNumber, 'Invoice #');
    assert.deepEqual(found.ignored, ['Shade Notes']);
    assert.deepEqual(found.missing, []);
    assert.deepEqual(detectColumns(['Company', 'Item']).missing, ['itemAmount', 'date']);
    assert.equal(detectColumns(['Client Name', 'Item', 'Amount', 'Date', 'Company'], { doctorName: 'Client Name' }).columns.doctorName, 'Client Name');
  });

  test('reads money and flags bad rows', () => {
    assert.equal(moneyCents('$1,234.50'), 123450);
    assert.equal(moneyCents('(12.00)'), -1200);
    assert.equal(moneyCents('abc'), undefined);
    const headers = HEADER.split(',');
    const { columns } = detectColumns(headers);
    const bad = readRow(['', '31/02/2024', '', 'Dr A', '', 'Crown', 'ten', 'Yes', ''], headers, columns);
    assert.deepEqual(bad.problems.sort(), ['bad_amount', 'bad_dueDate', 'missing_company', 'missing_date'].sort());
  });

  test('groups lines into jobs; a job with no number is keyed without the patient', () => {
    const headers = HEADER.split(',');
    const { columns } = detectColumns(headers);
    const rows = [
      ['INV-1', '05/03/2024', 'Example Dental', 'Dr Example', 'Pat A', 'Crown', '100.00', 'Yes', '110.00'],
      ['INV-1', '05/03/2024', 'Example Dental', 'Dr Example', 'Pat A', 'Post', '50.00', 'Yes', '165.00'],
      ['', '06/03/2024', 'Example Dental', 'Dr Example', 'Pat B', 'Splint', '80.00', 'No', '80.00'],
      ['', '06/03/2024', 'Example Dental', 'Dr Example', 'Pat C', 'Splint', '80.00', 'No', '80.00'],
    ].map((cells, i) => ({ rowNumber: i + 1, ...readRow(cells, headers, columns) }));
    const { jobs } = groupJobs(rows);
    assert.equal(jobs.length, 3);
    assert.deepEqual(jobs[0].findings.map((f) => f.code), ['conflicting_totals']);
    const keys = jobs.slice(1).map((j) => j.jobKey);
    assert.match(keys[0], /^grp:[0-9a-f]{24}$/);
    assert.equal(keys[1], `${keys[0]}#2`);
    assert.ok(!keys.join().includes('Pat'));
  });
});

describe('Seazona history import', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  const now = () => Date.parse('2026-10-20T00:00:00Z');

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    await db.execute(sql`truncate seazona_orders, seazona_invoices, seazona_clients, seazona_history_batches,
      seazona_history_rows, seazona_history_batch_jobs, seazona_history_jobs restart identity`);
    const at = new Date(now());
    const mirrored = { recordHash: 'h', firstSeenAt: at, lastSyncedAt: at, lastChangedAt: at };
    await db.insert(seazonaClients).values([
      { id: 'C1', company: 'Example Dental', ...mirrored },
      { id: 'C2', company: 'Twin Practice', ...mirrored },
      { id: 'C3', company: 'Twin Practice Pty Ltd', ...mirrored },
    ]);
    await db.insert(seazonaInvoices).values({ invoiceNumber: 'INV-2', totalCents: 9900, ...mirrored });
    await db.insert(seazonaOrders).values({ id: '5002', invoiceNumber: 'INV-2', company: 'Example Dental', subtotalCents: 9000, ...mirrored });
  });

  const file = () => csvOf(
    'INV-1,05/03/2024,Example Dental,Dr Example,Pat A,Crown,100.00,Yes,110.00',
    'INV-2,06/03/2024,Example Dental,Dr Example,Pat B,Splint,90.00,Yes,99.00',
    'INV-3,07/03/2024,Twin Practice,Dr Other,Pat C,Night guard,60.00,No,60.00',
    'INV-4,07/03/2024,Unknown Clinic,Dr Other,Pat D,Model,20.00,No,20.00',
    'INV-5,,Example Dental,Dr Example,Pat E,Crown,100.00,Yes,110.00',
  );

  test('stages, reconciles, waits for a person, applies, and feeds history jobs', async () => {
    const staged = await stageBatch(db, { csv: file(), fileName: 'invoices.csv', createdBy: 'person:test', now });
    assert.equal(staged.status, 'reconciled');
    assert.equal(staged.counts.rows, 5);
    assert.equal(staged.counts.rowsWithProblems, 1);
    assert.equal(staged.counts.jobs, 4);
    assert.equal(staged.counts.new, 3);
    assert.equal(staged.counts.needs_person, 1);

    // No patient field is stored unless the installation keeps one.
    const stored = await db.select().from(seazonaHistoryRows);
    assert.ok(stored.every((r) => r.fields.patient === null));

    const batch = await readBatch(db, staged.id);
    const byKey = Object.fromEntries(batch.jobs.map((j) => [j.jobKey, j]));
    assert.equal(byKey['inv:INV-2'].mirrorOrderId, '5002');
    assert.equal(byKey['inv:INV-2'].clientId, 'C1');
    assert.deepEqual(byKey['inv:INV-3'].findings.map((f) => f.code), ['client_ambiguous']);
    assert.deepEqual(byKey['inv:INV-4'].findings.map((f) => f.code), ['client_unknown']);
    assert.deepEqual(batch.problemRows.map((r) => r.problems), [['missing_date']]);
    assert.equal((await readBatch(db, staged.id, { outcome: 'waiting' })).jobs.length, 1);

    // The same file again finds its batch.
    const again = await stageBatch(db, { csv: file(), createdBy: 'person:test', now });
    assert.equal(again.id, staged.id);
    assert.equal(again.duplicate, true);

    await decideJobs(db, staged.id, [{ jobKey: 'inv:INV-3', decision: 'import', clientId: 'C2' }], { by: 'person:test', now });
    const applied = await applyBatch(db, staged.id, { by: 'person:test', now });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.applied, 4);
    const history = await db.select().from(seazonaHistoryJobs);
    assert.equal(history.find((h) => h.jobKey === 'inv:INV-3').clientId, 'C2');
    await assert.rejects(applyBatch(db, staged.id, { by: 'person:test', now }), /applied/);

    const work = await readHistoryWork(db, { limit: 3 });
    assert.equal(work.items.length, 3);
    assert.equal(work.more, true);
    assert.ok(work.items.every((i) => i.historical));
    const rest = await readHistoryWork(db, { cursor: work.cursor, limit: 3 });
    assert.equal(rest.items.length, 1);
    const all = [...work.items, ...rest.items];
    // A job the API copy holds uses its order id, so the two are one job.
    assert.equal(all.find((i) => i.jobKey === 'inv:INV-2').ledgerJob.sourceJobRef, '5002');
    assert.equal(all.find((i) => i.jobKey === 'inv:INV-1').ledgerJob.sourceJobRef, 'history:inv:INV-1');
  });

  test('a later file with the same job is "same"; a changed one waits for a person', async () => {
    const first = await stageBatch(db, { csv: csvOf('INV-1,05/03/2024,Example Dental,Dr Example,Pat A,Crown,100.00,Yes,110.00'), createdBy: 'person:test', now });
    await applyBatch(db, first.id, { by: 'person:test', now });
    const same = await stageBatch(db, { csv: csvOf('INV-1,05/03/2024,Example Dental,Dr Example,Pat A,Crown,100.00,Yes,110.00', ''), createdBy: 'person:test', now });
    assert.equal(same.counts.same, 1);
    const changed = await stageBatch(db, { csv: csvOf('INV-1,05/03/2024,Example Dental,Dr Example,Pat A,Crown,120.00,Yes,132.00'), createdBy: 'person:test', now });
    assert.equal(changed.counts.changed, 1);
    assert.equal(changed.counts.willImport, 0);
    const applied = await applyBatch(db, changed.id, { by: 'person:test', now });
    assert.equal(applied.applied + applied.updated, 0);
    const [kept] = await db.select().from(seazonaHistoryJobs);
    assert.equal(kept.subtotalCents, 10000);
  });

  test('refuses a file without the columns it needs, and a cancelled batch stays cancelled', async () => {
    await assert.rejects(stageBatch(db, { csv: 'Name,Notes\nA,B', createdBy: 'person:test', now }), /missing columns/);
    const staged = await stageBatch(db, { csv: file(), createdBy: 'person:test', now });
    await cancelBatch(db, staged.id);
    await assert.rejects(applyBatch(db, staged.id, { by: 'person:test', now }), /cancelled/);
  });
});

describe('Seazona history import routes', { skip: skipWithoutDatabase }, () => {
  const quiet = { info() {}, warn() {}, error() {} };
  const env = {
    FLOW_INTEGRATIONS: 'seazona',
    SEAZONA_MODE: 'replay',
    SEAZONA_REPLAY_FILE: fileURLToPath(new URL('./fixtures/seazona/billing.json', import.meta.url)),
  };
  let handle;
  let registry;
  let app;
  let ownerToken;
  let staffToken;

  before(async () => {
    handle = await freshDatabase();
    registry = createIntegrations({ env, adapters: [createSeazonaAdapter({ env })], log: quiet });
    await registry.start(handle.db);
    const clerk = fakeClerk();
    const owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await invitePerson(handle.db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    staffToken = clerk.signIn(clerk.addUser({ email: 'staff@example.test' }));
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations: registry, log: quiet });
  });
  after(async () => {
    await registry?.stop?.();
    await handle?.close();
  });

  test('an owner uploads, reads and applies a batch; staff cannot upload', async () => {
    const body = { csv: csvOf('INV-9,05/03/2024,Example Dental,Dr Example,Pat A,Crown,100.00,Yes,110.00'), fileName: 'export.csv' };
    const denied = await request(app, '/api/seazona/history/batches', { token: staffToken, method: 'POST', body });
    assert.equal(denied.status, 403);
    const bad = await request(app, '/api/seazona/history/batches', { token: ownerToken, method: 'POST', body: { csv: 'Name\nA' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.details.missing, ['company', 'item', 'itemAmount', 'date']);
    const staged = await request(app, '/api/seazona/history/batches', { token: ownerToken, method: 'POST', body });
    assert.equal(staged.status, 201);
    const id = staged.body.batch.id;
    const read = await request(app, `/api/seazona/history/batches/${id}`, { token: staffToken });
    assert.equal(read.body.batch.jobs[0].jobKey, 'inv:INV-9');
    const applied = await request(app, `/api/seazona/history/batches/${id}/apply`, { token: ownerToken, method: 'POST' });
    assert.equal(applied.body.batch.applied, 1);
    const summary = await request(app, '/api/seazona/history', { token: staffToken });
    assert.equal(summary.body.history.jobs, 1);
    const columns = await request(app, '/api/seazona/history/columns', { token: staffToken });
    assert.ok(columns.body.columns.some((c) => c.field === 'invoiceNumber'));
  });
});

describe('Seazona history backfill from the API', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let clock;
  const settings = resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: 'unused.json', SEAZONA_HISTORY_CALLS_PER_RUN: '4' });

  before(async () => {
    handle = await freshSeazonaDatabase();
    db = handle.db;
  });
  after(async () => handle?.close());
  beforeEach(async () => {
    await db.execute(sql`truncate seazona_orders, seazona_clients, seazona_lane_state, seazona_record_read_failures,
      seazona_history_batches, seazona_history_rows, seazona_history_batch_jobs, seazona_history_jobs restart identity`);
    clock = fakeClock('2026-10-20T00:00:00.000Z');
    const at = new Date(clock.now());
    await db.insert(seazonaOrders).values({ id: 'LIVE-1', company: 'Example Dental', recordHash: 'h', firstSeenAt: at, lastSyncedAt: at, lastChangedAt: at });
  });

  const order = (id, invoiceNumber) => ({ id, invoiceNumber, company: 'Example Dental', clientName: 'Dr Example', status: 'Shipped', ordered: '02/01/2020', due: '05/01/2020', products: [{ id: 'P1', name: 'Crown', code: 'CROWN', price: 200 }] });
  const responses = [
    { path: 'orders/', query: { ordered: '2020-01-02T00:00:00' }, body: [{ id: 'H-1' }, { id: 'LIVE-1' }, { id: 'H-2' }] },
    { path: 'orders/', query: { ordered: '2020-01-03T00:00:00' }, body: [{ id: 'H-3' }] },
    { path: 'orders/H-1', body: order('H-1', 'S-1') },
    { path: 'orders/H-2', status: 404 },
    { path: 'orders/H-3', body: order('H-3', 'S-3') },
  ];
  const run = async (calls) => {
    const fetchImpl = createReplayFetch({ responses });
    const client = createSeazonaClient({ settings, db, fetchImpl, now: clock.now, sleepFn: clock.sleep, random: () => 0 });
    const result = await runSeazonaSync(db, client, { settings, now: clock.now, only: ['history'] });
    calls.push(...fetchImpl.calls.map((c) => c.path));
    return result.results.history;
  };

  test('walks each day, skips what the live copy holds, keeps its place, and writes history', async () => {
    const idle = await run([]);
    assert.equal(idle.idle, true, 'no calls until a person starts one');
    const started = await startBackfill(db, { from: '2020-01-02', through: '2020-01-03', createdBy: 'person:test', settings, now: clock.now });
    assert.equal(started.running, true);
    await assert.rejects(startBackfill(db, { from: '2020-01-02', createdBy: 'person:test', settings, now: clock.now }), /already running/);

    const calls = [];
    const first = await run(calls);
    assert.equal(first.calls, 4);
    assert.deepEqual(calls, ['orders/', 'orders/H-1', 'orders/H-2', 'orders/']);
    const second = await run(calls);
    assert.equal(second.backfill.running, false);
    assert.ok(!calls.includes('orders/LIVE-1'), 'an order the live copy holds is not read again');

    const history = await db.select().from(seazonaHistoryJobs);
    assert.deepEqual(history.map((h) => h.jobKey).sort(), ['case:H-1', 'case:H-3']);
    assert.equal(history.find((h) => h.jobKey === 'case:H-1').invoiceNumber, 'S-1');
    const work = await readHistoryWork(db);
    assert.equal(work.items.find((i) => i.jobKey === 'case:H-1').ledgerJob.sourceJobRef, 'H-1');
    const batch = (await readBackfill(db));
    assert.equal(batch.ordersRead, 2);
    const [summary] = await listBatches(db);
    assert.equal(summary.profile, 'api_orders');
    assert.equal(summary.status, 'reconciled');
  });

  test('pages through a list that answers orders on or after the day, and stops after the last day', async () => {
    const paged = resolveSeazonaSettings({ SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: 'unused.json', SEAZONA_HISTORY_CALLS_PER_RUN: '25', SEAZONA_HISTORY_PAGE_SIZE: '2' });
    const fetchImpl = createReplayFetch({
      responses: [
        { path: 'orders/', query: { ordered: '2020-01-02T00:00:00', page: '1' }, body: [{ id: 'H-1', ordered: '2020-01-02T09:00:00' }, { id: 'H-2', ordered: '2020-01-03T10:00:00' }] },
        { path: 'orders/', query: { ordered: '2020-01-02T00:00:00', page: '2' }, body: [{ id: 'H-3', ordered: '2020-01-03T11:00:00' }, { id: 'H-4', ordered: '2020-01-09T08:00:00' }] },
        { path: 'orders/H-1', body: order('H-1', 'S-1') },
        { path: 'orders/H-2', body: order('H-2', 'S-2') },
        { path: 'orders/H-3', body: order('H-3', 'S-3') },
      ],
    });
    await startBackfill(db, { from: '2020-01-02', through: '2020-01-03', createdBy: 'person:test', settings: paged, now: clock.now });
    const client = createSeazonaClient({ settings: paged, db, fetchImpl, now: clock.now, sleepFn: clock.sleep, random: () => 0 });
    const result = (await runSeazonaSync(db, client, { settings: paged, now: clock.now, only: ['history'] })).results.history;
    assert.deepEqual(fetchImpl.calls.map((c) => c.path), ['orders/', 'orders/H-1', 'orders/H-2', 'orders/', 'orders/H-3']);
    assert.equal(result.backfill.running, false);
    assert.equal(result.backfill.reachedDay, '2020-01-03');
    const history = await db.select().from(seazonaHistoryJobs);
    assert.deepEqual(history.map((h) => h.jobKey).sort(), ['case:H-1', 'case:H-2', 'case:H-3'], 'an order after the last day is not read');
  });

  test('a job a person must decide is an issue on its job card, until a person decides it', async () => {
    const at = new Date(clock.now());
    const mirrored = { recordHash: 'h', firstSeenAt: at, lastSyncedAt: at, lastChangedAt: at };
    await db.insert(seazonaClients).values([{ id: 'C2', company: 'Twin Practice', ...mirrored }, { id: 'C3', company: 'Twin Practice Pty Ltd', ...mirrored }]);
    const batch = await createApiBatch(db, { createdBy: 'person:test', from: '2020-01-01', through: '2020-01-31', at });
    const job = { ...orderToHistoryJob({ ...order('H-9', 'S-9'), id: 'H-9', lines: [], subtotalCents: 20000 }), company: 'Twin Practice' };
    const staged = await stageApiJobs(db, batch.id, [{ jobKey: 'case:H-9', job }], { at });
    assert.equal(staged.waiting, 1);

    const issues = await historyJobIssues(db, ['H-9', 'H-0']);
    assert.deepEqual(Object.keys(issues), ['H-9']);
    assert.equal(issues['H-9'][0].phrase, 'Seazona client is unclear');
    assert.equal(issues['H-9'][0].href, `/integrations/seazona?batch=${batch.id}&job=case%3AH-9`);
    assert.equal((await historySummary(db)).waitingForPerson, 1);

    await decideJobs(db, batch.id, [{ jobKey: 'case:H-9', decision: 'import', clientId: 'C2' }], { by: 'person:test', now: clock.now });
    assert.deepEqual(await historyJobIssues(db, ['H-9']), {});
    assert.equal((await historySummary(db)).waitingForPerson, 0);
  });
});
