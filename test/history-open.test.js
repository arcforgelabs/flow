import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { seedFirstOwner, invitePerson } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createOrganisation, createContact } from '../server/core/directory.js';
import { createDraftInvoice, getInvoice, issueInvoice } from '../server/core/invoices.js';
import { ingestHistory, ingestWork, linkCustomers, runPipelineOnce } from '../server/core/pipeline.js';
import { createIntegrations } from '../server/integrations/index.js';
import { createSeazonaAdapter } from '../server/integrations/seazona/index.js';
import { createApiBatch, stageApiJobs } from '../server/integrations/seazona/history/index.js';
import { orderToHistoryJob } from '../server/integrations/seazona/history/backfill.js';
import { mapOrder, mapClient } from '../server/integrations/seazona/map.js';
import { upsertRecords } from '../server/integrations/seazona/store.js';
import { seazonaHistoryJobs } from '../server/integrations/seazona/schema.js';
import { openDatabase } from '../server/db/index.js';
import { billingObligations } from '../server/db/schema.js';
import { fakeClock, freshSeazonaDatabase } from './support/seazona.js';
import { skipWithoutDatabase } from './support/db.js';
import { fakeClerk, request, clerkBrowserStub, TEST_PUBLISHABLE_KEY } from './support/clerk.js';

// Real authenticated routes, PostgreSQL and adapter; only Seazona and Clerk
// are synthetic. Covers the read-on-open contract, not the later sweep tier.
describe('held history read on open', { skip: skipWithoutDatabase }, () => {
  let handle, db, lab, contact, registry, adapter, app, secondHandle, secondRegistry, secondApp, token, staffToken, owner;
  let clock, counter = 0, calls = [], responses = new Map(), waitForRead = null;
  const quiet = { info() {}, warn() {}, error() {} };
  const env = { FLOW_INTEGRATIONS: 'seazona', SEAZONA_MODE: 'replay', SEAZONA_REPLAY_FILE: 'unused.json', SEAZONA_API_MAX_RETRIES: '0' };
  before(async () => {
    handle = await freshSeazonaDatabase(); db = handle.db;
    clock = fakeClock('2026-10-29T12:00:00Z');
    lab = await createOrganisation(db, { name: 'Example Lab' });
    contact = await createContact(db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await upsertRecords(db, 'clients', [mapClient({ id: 'CL-1', company: 'Example Practice' })], { at: new Date(clock.now()) });
    await linkCustomers(db, lab.id, { system: 'seazona', customers: [{ id: 'CL-1', name: 'Example Practice' }] });
    const fetchImpl = async url => {
      const path = new URL(url).pathname.replace('/v1/', '');
      calls.push(path);
      if (waitForRead) await waitForRead;
      const answer = responses.get(path) ?? { status: 404 };
      return new Response(answer.body ? JSON.stringify(answer.body) : '', { status: answer.status ?? 200 });
    };
    adapter = createSeazonaAdapter({ env, now: clock.now, fetchImpl });
    registry = createIntegrations({ env, adapters: [adapter], log: quiet });
    await registry.start(db);
    const clerk = fakeClerk();
    owner = await seedFirstOwner(db, 'owner@example.test');
    await invitePerson(db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    token = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    staffToken = clerk.signIn(clerk.addUser({ email: 'staff@example.test' }));
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    const auth = { settings, clerk, personAuth };
    app = createApp({ database: handle, auth, integrations: registry, log: quiet });
    secondHandle = openDatabase({ url: process.env.FLOW_TEST_DATABASE_URL, max: 4 });
    secondRegistry = createIntegrations({ env, adapters: [createSeazonaAdapter({ env, now: clock.now, fetchImpl })], log: quiet });
    await secondRegistry.start(secondHandle.db);
    secondApp = createApp({ database: secondHandle, auth, integrations: secondRegistry, log: quiet });
  });
  after(async () => { await secondRegistry?.stop(); await secondHandle?.close(); await registry?.stop(); await handle?.close(); });
  beforeEach(async () => {
    calls = []; responses.clear(); waitForRead = null;
    clock.advance(3 * 3600_000);
    await db.execute(sql`truncate seazona_api_governor, seazona_api_requests`);
  });
  const open = (job, { worker = app, ...options } = {}) => request(worker, `/api/invoicing/jobs/${job.id}/open`, { token, method: 'POST', body: {}, ...options });
  const reload = async job => (await db.select().from(billingObligations).where(eq(billingObligations.id, job.id)))[0];
  const history = async ref => (await db.select().from(seazonaHistoryJobs).where(eq(seazonaHistoryJobs.caseRef, ref)))[0];
  async function fixture() {
    clock.advance(1);
    const ref = `OLD-${++counter}`;
    const detail = { id: ref, clientId: 'CL-1', company: 'Example Practice', clientName: 'Dr Example', invoiceNumber: `INV-${counter}`, status: 'Shipped', ordered: '2026-07-01', due: '2026-07-07', products: [{ description: 'Saved crown', code: 'CROWN', amount: 100, taxable: true }] };
    const at = new Date(clock.now() - 3 * 3600_000);
    const batch = await createApiBatch(db, { createdBy: owner.id, from: '2026-07-01', through: '2026-07-01', at });
    await stageApiJobs(db, batch.id, [{ jobKey: `case:${ref}`, job: orderToHistoryJob(mapOrder({}, detail)) }], { at });
    await db.execute(sql`delete from pipeline_cursors where organisation_id = ${lab.id} and name = 'seazona.history'`);
    await ingestHistory(db, lab.id, { adapter });
    const [job] = await db.select().from(billingObligations).where(eq(billingObligations.sourceJobRef, ref));
    assert.ok(job, 'the real history import creates the held job');
    responses.set(`orders/${ref}`, { body: detail });
    return { ref, detail, job };
  }

  test('stale open reads once, keeps new lines held, and cannot draft through the pipeline', async () => {
    const { ref, detail, job } = await fixture();
    detail.products[0].description = 'New crown'; detail.products[0].amount = 140;
    const res = await open(job);
    assert.equal(res.status, 200);
    assert.equal(res.body.refresh.state, 'read');
    const saved = await reload(job);
    assert.equal(saved.lines[0].description, 'New crown');
    assert.equal(saved.lines[0].unitAmountCents, 14000);
    assert.equal(saved.holdState, 'held'); assert.equal(saved.holdReason, 'history_import');
    const checked = (await history(ref)).lastCheckedAt;
    const repeated = await open(job, { token: staffToken });
    assert.equal(repeated.body.refresh.state, 'fresh');
    assert.deepEqual(calls, [`orders/${ref}`]);
    await runPipelineOnce(db, registry, { now: new Date(clock.now()) });
    assert.equal((await reload(job)).invoiceId, null);
    assert.equal((await reload(job)).holdState, 'held');
    assert.equal((await db.execute(sql`select count(*)::int as n from seazona_orders where id = ${ref}`)).rows[0].n, 0);
    clock.advance(2 * 3600_000 + 1);
    const previousChanged = (await history(ref)).lastChangedAt;
    assert.equal((await open(job)).body.refresh.state, 'read');
    assert.ok((await history(ref)).lastCheckedAt > checked);
    assert.equal((await history(ref)).lastChangedAt.getTime(), previousChanged.getTime(), 'unchanged content does not advance content time');
  });

  test('two workers coalesce concurrent opens without exhausting the connection pool', async () => {
    const { ref, job } = await fixture();
    let release; waitForRead = new Promise(resolve => { release = resolve; });
    const started = open(job);
    // Observe the real persisted claim, rather than guessing a timer duration.
    while (!(await history(ref)).lastAttemptAt) await new Promise(resolve => setImmediate(resolve));
    const repeats = await Promise.all(Array.from({ length: 5 }, () => open(job, { worker: secondApp })));
    assert.ok(repeats.every(r => r.body.refresh.state === 'waiting'));
    release(); assert.equal((await started).body.refresh.state, 'read');
    assert.deepEqual(calls, [`orders/${ref}`]);
    assert.equal((await open(job)).body.refresh.state, 'fresh');
  });

  test('failed and stopped reads retain the saved copy and last successful time; 404 is explicit and held', async () => {
    const { ref, job } = await fixture();
    assert.equal((await open(job)).body.refresh.state, 'read');
    const before = await history(ref);
    clock.advance(3 * 3600_000);
    responses.set(`orders/${ref}`, { status: 500 });
    const failed = await open(job);
    assert.equal(failed.body.refresh.state, 'unavailable');
    assert.equal(failed.body.refresh.checkedAt, before.lastCheckedAt.toISOString());
    assert.deepEqual((await history(ref)).lines, before.lines);
    assert.equal((await history(ref)).lastChangedAt.getTime(), before.lastChangedAt.getTime());
    await open(job); assert.equal(calls.length, 2, 'failed repeats wait a minute');
    clock.advance(61_000); responses.set(`orders/${ref}`, { status: 200 });
    assert.equal((await open(job)).body.refresh.state, 'unavailable', 'an empty response preserves the copy');
    assert.deepEqual((await history(ref)).lines, before.lines);
    clock.advance(61_000);
    await db.execute(sql`update seazona_api_governor set halted_reason = 'auth'`);
    assert.equal((await open(job)).body.refresh.state, 'unavailable'); assert.equal(calls.length, 3);
    await db.execute(sql`update seazona_api_governor set halted_reason = null`);
    clock.advance(61_000); responses.set(`orders/${ref}`, { status: 404 });
    const gone = await open(job);
    assert.equal(gone.body.refresh.deleted, true);
    assert.equal((await reload(job)).holdState, 'held');
    assert.equal((await reload(job)).sourceStatus, 'Deleted in Seazona');
    assert.deepEqual((await history(ref)).lines, before.lines);
  });

  test('signed-out and wrong-organisation opens cannot call Seazona; each person has five calls per minute', async () => {
    const { job } = await fixture();
    assert.equal((await open(job, { token: undefined })).status, 401);
    const other = await createOrganisation(db, { name: 'Other Example Lab' });
    assert.equal((await open(job, { body: { organisationId: other.id } })).status, 404);
    // Name the organisation explicitly now that this fixture has two.
    try { for (let i = 0; i < 6; i++) {
      const f = await fixture(); clock.advance(2001);
      const r = await open(f.job, { worker: i % 2 ? secondApp : app, body: { organisationId: lab.id } });
      assert.equal(r.body.refresh.state, i < 5 ? 'read' : 'unavailable');
      if (i === 5) assert.match(r.body.refresh.reason, /Five order reads/);
    }
    assert.equal(calls.length, 5);
    } finally { await db.execute(sql`delete from organisations where id = ${other.id}`); }
  });

  test('a history/live overlap stays one held job and an issued invoice never changes', async () => {
    const { ref, detail, job } = await fixture();
    const invoice = await createDraftInvoice(db, lab.id, { contactId: contact.id, lines: [{ description: 'Issued crown', unitAmountCents: 10000, accountCode: '200', taxCode: 'GST' }] });
    await issueInvoice(db, lab.id, invoice.id, { issuedBy: owner.id, issueDate: '2026-10-01' });
    await db.update(billingObligations).set({ invoiceId: invoice.id }).where(eq(billingObligations.id, job.id));
    const before = await getInvoice(db, lab.id, invoice.id);
    detail.products[0].amount = 190;
    await upsertRecords(db, 'orders', [mapOrder({}, detail)], { at: new Date(clock.now()) });
    await ingestWork(db, lab.id, { adapter });
    assert.equal((await reload(job)).holdState, 'held');
    assert.equal((await open(job)).body.refresh.state, 'read');
    assert.equal((await reload(job)).holdState, 'held');
    assert.equal((await db.execute(sql`select count(*)::int as n from billing_obligations where source_job_ref = ${ref}`)).rows[0].n, 1);
    assert.deepEqual(await getInvoice(db, lab.id, invoice.id), before);
  });

  test('desktop and phone show the saved copy during a real read, then Updated and new lines', { timeout: 30000 }, async () => {
    const { ref, detail } = await fixture();
    const browser = await chromium.launch();
    const server = app.listen(0);
    let release;
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.setDefaultTimeout(10000);
      await page.route('https://clerk.example.test/**', route => route.fulfill({ contentType: 'text/javascript', body: clerkBrowserStub({ token, email: 'owner@example.test', name: 'Example Owner' }) }));
      await page.goto(`http://127.0.0.1:${server.address().port}/integrations/seazona`);
      await page.locator('.fx-history').getByRole('link', { name: 'Jobs', exact: true }).click();
      assert.match(page.url(), /jobs\?history=include/);
      for (const width of [1280, 375]) {
        clock.advance(3 * 3600_000);
        waitForRead = new Promise(resolve => { release = resolve; });
        detail.products[0].description = `Checked crown ${width}`;
        await page.setViewportSize({ width, height: width === 375 ? 667 : 800 });
        await page.goto(`http://127.0.0.1:${server.address().port}/jobs?history=include&q=${ref}`);
        await page.locator('.fx-job').first().click();
        await page.getByRole('dialog').waitFor();
        await page.getByText('Checking…', { exact: true }).waitFor();
        assert.match(await page.getByRole('dialog').innerText(), /Saved crown|Checked crown 1280/);
        if (process.env.HISTORY_SCREENSHOTS) {
          mkdirSync(process.env.HISTORY_SCREENSHOTS, { recursive: true });
          await page.screenshot({ animations: 'disabled', path: `${process.env.HISTORY_SCREENSHOTS}/open-${width}-checking.png` });
        }
        release();
        await page.getByText(`Checked crown ${width}`, { exact: true }).waitFor();
        await page.getByText('Updated', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.HISTORY_SCREENSHOTS) await page.screenshot({ animations: 'disabled', path: `${process.env.HISTORY_SCREENSHOTS}/open-${width}-updated.png` });
      }
      // Opening its linked invoice checks the job, while the issued document
      // keeps the lines the customer was sent.
      const { job } = await fixture();
      clock.advance(2001);
      const invoice = await createDraftInvoice(db, lab.id, { contactId: contact.id, lines: [{ description: 'Issued ceramic', unitAmountCents: 10000, taxCode: 'GST' }] });
      await issueInvoice(db, lab.id, invoice.id, { issuedBy: owner.id, issueDate: '2026-10-01' });
      await db.update(billingObligations).set({ invoiceId: invoice.id }).where(eq(billingObligations.id, job.id));
      const answer = responses.get(`orders/${job.sourceJobRef}`);
      answer.body.clientName = 'Dr Checked';
      waitForRead = new Promise(resolve => { release = resolve; });
      await page.goto(`http://127.0.0.1:${server.address().port}/invoices/${invoice.id}`);
      await page.getByText('Checking…', { exact: true }).waitFor();
      await page.getByText('Issued ceramic', { exact: true }).waitFor();
      const completed = page.waitForResponse(response => response.url().endsWith('/open'));
      release();
      assert.equal((await (await completed).json()).refresh.state, 'read');
      assert.equal((await reload(job)).practitioner, 'Dr Checked');
      await page.getByText('Dr Checked', { exact: true }).waitFor();
      await page.getByText('Updated', { exact: true }).waitFor();
      assert.equal((await getInvoice(db, lab.id, invoice.id)).lines[0].description, 'Issued ceramic');
    } catch (error) {
      console.error('Browser error:', error.message);
      const page = browser.contexts()[0]?.pages()[0];
      if (process.env.HISTORY_SCREENSHOTS && page) await page.screenshot({ animations: 'disabled', path: `${process.env.HISTORY_SCREENSHOTS}/failure.png` });
      throw error;
    } finally { release?.(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
  });
});
