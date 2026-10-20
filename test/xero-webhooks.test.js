import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { IMPORT_KIND, queueChangesRead, REFRESH_MS, runImportOnce } from '../server/integrations/xero/import.js';
import { dailyCheck, DAILY_FLAG_MAX, readInbox, runWebhookWork, signatureValid, summaryDiffers, WEBHOOK_REFRESH_MS } from '../server/integrations/xero/webhooks.js';
import { request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, quietLog, scriptedXero, seedLab, TENANT, xeroAnswer } from './support/xero.js';

// Xero's webhooks and the daily check (issue #45). Xero is replayed with
// synthetic answers; each webhook is signed here with a synthetic key.

const KEY = 'synthetic-webhook-key';
const sign = (body, key = KEY) => createHmac('sha256', key).update(body).digest('base64');
const at = (iso) => `/Date(${Date.parse(iso)}+0000)/`;
const invoice = (id, extra = {}) => ({
  InvoiceID: id, Type: 'ACCREC', InvoiceNumber: `INV-${id}`, Contact: { ContactID: 'c1' }, Status: 'AUTHORISED',
  Date: at('2026-10-01T00:00:00Z'), SubTotal: 200, TotalTax: 20, Total: 220, AmountDue: 220, AmountPaid: 0, AmountCredited: 0,
  LineItems: [{ LineItemID: `l-${id}`, ItemCode: 'CROWN', Quantity: 1, UnitAmount: 200, LineAmount: 200, TaxAmount: 20 }],
  UpdatedDateUTC: at('2026-10-02T00:00:00Z'),
  ...extra,
});
const event = (category, resourceId, tenantId = TENANT) => ({
  resourceUrl: `https://api.xero.com/api.xro/2.0/x/${resourceId}`, resourceId, eventDateUtc: '2026-10-20T01:00:00.000',
  eventType: 'UPDATE', eventCategory: category, tenantId, tenantType: 'ORGANISATION',
});

test('a signature is the base64 HMAC-SHA256 of the raw body with the webhook key', () => {
  const body = '{"events":[]}';
  assert.equal(signatureValid(KEY, Buffer.from(body), sign(body)), true);
  assert.equal(signatureValid(KEY, Buffer.from(body), sign(body, 'other-key')), false);
  assert.equal(signatureValid(KEY, Buffer.from(`${body} `), sign(body)), false, 'any change to the body fails');
  assert.equal(signatureValid(KEY, Buffer.from(body), ''), false);
  assert.equal(signatureValid(null, Buffer.from(body), sign(body)), false);
});

test('a summary differs from the copy by status, money or a later change time', () => {
  const row = { status: 'AUTHORISED', total_cents: 22000, amount_due_cents: 22000, amount_paid_cents: 0, amount_credited_cents: 0, xero_updated_at: new Date('2026-10-02T00:00:00Z') };
  const summary = { Status: 'AUTHORISED', Total: 220, AmountDue: 220, AmountPaid: 0, AmountCredited: 0, UpdatedDateUTC: at('2026-10-02T00:00:00Z') };
  assert.equal(summaryDiffers(row, summary), false);
  assert.equal(summaryDiffers(row, { ...summary, AmountDue: 120, AmountPaid: 100 }), true, 'a part payment');
  assert.equal(summaryDiffers(row, { ...summary, Status: 'VOIDED' }), true);
  assert.equal(summaryDiffers(row, { ...summary, UpdatedDateUTC: at('2026-10-03T00:00:00Z') }), true);
});

describe('Xero webhooks', { skip: skipWithoutDatabase }, () => {
  let handle;
  let app;
  let lab;
  let xero;

  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero({ XERO_WEBHOOK_KEY: KEY, XERO_MIRROR_PAGE_SIZE: '2' });
    const booted = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
    app = booted.app;
    lab = await seedLab(handle, booted.clerk);
    await connectDirectly(handle, xero.runtime, lab.organisation.id);
    // A complete copy: each resource has finished a pass.
    for (const resource of ['invoices', 'credit_notes', 'payments']) {
      await handle.db.execute(sql`insert into xero_mirror_cursors (organisation_id, resource, passes, last_pass_finished_at)
        values (${lab.organisation.id}, ${resource}, 1, now())`);
    }
  });
  after(async () => handle?.close());
  beforeEach(() => {
    xero.clock.at += 10 * 60_000;
    xero.runtime.remember(lab.organisation.id, { access_token: 'synthetic-access-0', expires_in: 1800 });
  });

  const org = () => lab.organisation.id;
  const deliver = (payload, signature = sign(JSON.stringify(payload))) => request(app, '/api/xero/webhooks', {
    method: 'POST', body: payload, headers: { 'x-xero-signature': signature },
  });
  const pending = async () => (await handle.db.execute(sql`select resource, resource_id, source from xero_webhook_events
    where pending order by resource, resource_id`)).rows;

  test('Xero\'s intent-to-receive check passes: 200 with no body when signed, 401 when not', async () => {
    const good = await deliver({ events: [], firstEventSequence: 0, lastEventSequence: 0, entropy: 'X' });
    assert.equal(good.status, 200);
    assert.equal(good.text, '');
    const bad = await deliver({ events: [], entropy: 'Y' }, sign('something else'));
    assert.equal(bad.status, 401);
    assert.equal(bad.text, '');
  });

  test('a signed event is saved for its organisation; another tenant\'s is dropped; a repeat is one row', async () => {
    const payload = { events: [event('INVOICE', 'w1'), event('INVOICE', 'w1'), event('CONTACT', 'c1'), event('INVOICE', 'w9', 'not-connected')] };
    const res = await deliver(payload);
    assert.equal(res.status, 200);
    assert.deepEqual((await pending()).map((r) => `${r.resource}:${r.resource_id}:${r.source}`), ['contacts:c1:webhook', 'invoices:w1:webhook']);
  });

  test('waiting invoices are read by id in one call, into the copy, and leave the inbox', async () => {
    await handle.db.execute(sql`update xero_webhook_events set pending = false where resource = 'contacts'`);
    const replay = xero.script([xeroAnswer('Invoices', { Invoices: [invoice('w1', { Status: 'PAID', AmountDue: 0, AmountPaid: 220 })] }, { query: { IDs: 'w1', page: 1 } })]);
    const read = await readInbox(handle.db, xero.runtime, org());
    assert.equal(read.invoices.read, 1);
    assert.equal(read.invoices.inserted, 1);
    assert.equal(replay.calls.length, 1);
    const { rows: [copy] } = await handle.db.execute(sql`select status, amount_paid_cents from xero_invoices where xero_invoice_id = 'w1'`);
    assert.equal(copy.status, 'PAID');
    assert.equal(Number(copy.amount_paid_cents), 22000);
    assert.deepEqual(await pending(), []);
  });

  test('a credit note event reads the credit note changes; an unknown category needs no call', async () => {
    await deliver({ events: [event('CREDITNOTE', 'cn1'), event('PREPAYMENT', 'pp1')] });
    const replay = xero.script([xeroAnswer('CreditNotes', { CreditNotes: [] }, { query: { page: 1 } })]);
    await readInbox(handle.db, xero.runtime, org());
    assert.equal(replay.calls.length, 1);
    assert.equal(replay.calls[0].path.endsWith('/CreditNotes'), true);
    assert.deepEqual(await pending(), []);
  });

  test('while webhooks arrive, the poll waits an hour instead of 15 minutes', async () => {
    await handle.db.execute(sql`delete from background_jobs where kind = ${IMPORT_KIND}`);
    await queueChangesRead(handle.db, org());
    const empty = (path) => xeroAnswer(path, { [path]: [] }, { query: { page: 1 } });
    xero.script([empty('Invoices'), empty('CreditNotes'), empty('Payments')]);
    const ran = await runImportOnce(handle.db, xero.runtime);
    assert.equal(ran.outcome, 'succeeded', ran.job.lastError);
    const { rows: [next] } = await handle.db.execute(sql`select run_after from background_jobs where kind = ${IMPORT_KIND} and state = 'queued'`);
    const wait = new Date(next.run_after) - Date.now();
    assert.ok(wait > REFRESH_MS + 60_000 && wait <= WEBHOOK_REFRESH_MS, `next read in ${wait} ms`);

    // A day with no webhook: back to 15 minutes.
    await handle.db.execute(sql`update xero_webhook_events set received_at = now() - interval '2 days'`);
    await handle.db.execute(sql`update background_jobs set run_after = now() where kind = ${IMPORT_KIND} and state = 'queued'`);
    xero.script([empty('Invoices'), empty('CreditNotes'), empty('Payments')]);
    await runImportOnce(handle.db, xero.runtime);
    const { rows: [again] } = await handle.db.execute(sql`select run_after from background_jobs where kind = ${IMPORT_KIND} and state = 'queued'`);
    assert.ok(new Date(again.run_after) - Date.now() <= REFRESH_MS);
  });

  test('the daily check finds a part payment, a new invoice and one Xero no longer lists, then reads them by id', async () => {
    // The copy: w1 (PAID, from above), d1 (live) and d2 (live, gone from Xero).
    for (const id of ['d1', 'd2']) {
      await handle.db.execute(sql`insert into xero_invoices (organisation_id, xero_invoice_id, type, status, total_cents, amount_due_cents,
          amount_paid_cents, amount_credited_cents, xero_updated_at, record_hash)
        values (${org()}, ${id}, 'ACCREC', 'AUTHORISED', 22000, 22000, 0, 0, '2026-10-02T00:00:00Z', 'h')`);
    }
    const summary = (inv) => { const { LineItems, ...rest } = inv; return rest; };
    const replay = xero.script([xeroAnswer('Invoices', { Invoices: [
      summary(invoice('w1', { Status: 'PAID', AmountDue: 0, AmountPaid: 220 })),
      // A part payment that did not move Xero's change time.
      summary(invoice('d1', { AmountDue: 120, AmountPaid: 100 })),
      summary(invoice('n1')),
    ] }, { query: { summaryOnly: 'true', page: 1 } })]);
    const check = await dailyCheck(handle.db, xero.runtime, org());
    assert.equal(replay.calls.length, 1, 'one call reads every invoice in summary');
    assert.deepEqual({ read: check.read, flagged: check.flagged }, { read: 3, flagged: 3 });
    assert.deepEqual((await pending()).map((r) => `${r.resource_id}:${r.source}`), ['d1:daily_check', 'd2:daily_check', 'n1:daily_check']);

    xero.script([xeroAnswer('Invoices', { Invoices: [invoice('d1', { AmountDue: 120, AmountPaid: 100 }), invoice('d2', { Status: 'DELETED' }), invoice('n1')] }, { query: { page: 1 } })]);
    const read = await readInbox(handle.db, xero.runtime, org());
    assert.equal(read.invoices.read, 3);
    const { rows } = await handle.db.execute(sql`select xero_invoice_id, status, amount_paid_cents from xero_invoices
      where xero_invoice_id in ('d1', 'd2', 'n1') order by xero_invoice_id`);
    assert.deepEqual(rows.map((r) => `${r.xero_invoice_id}:${r.status}:${r.amount_paid_cents}`), ['d1:AUTHORISED:10000', 'd2:DELETED:0', 'n1:AUTHORISED:0']);
    assert.ok(DAILY_FLAG_MAX >= 50);
  });

  test('the worker runs a due daily check once a day, and a failing read waits longer each time', async () => {
    const log = quietLog();
    const holds = new Map();
    await handle.db.execute(sql`delete from xero_daily_checks`);
    xero.script([xeroAnswer('Invoices', { Invoices: [] }, { query: { summaryOnly: 'true', page: 1 } })]);
    await runWebhookWork(handle.db, xero.runtime, { log, holds });
    const { rows: [first] } = await handle.db.execute(sql`select last_finished_at from xero_daily_checks`);
    assert.ok(first.last_finished_at, 'the check ran');
    // Xero listed none of the copy's live rows, so they wait to be read by id.
    assert.equal((await pending()).length, 3);
    await handle.db.execute(sql`update xero_webhook_events set pending = false`);
    const replay = xero.script([]);
    await runWebhookWork(handle.db, xero.runtime, { log, holds });
    assert.equal(replay.calls.length, 0, 'not again the same day');

    // A pending read whose call fails: error once, then a wait.
    await deliver({ events: [event('INVOICE', 'f1')] });
    xero.script([xeroAnswer('Invoices', { Message: 'boom' }, { status: 500, repeat: true })]);
    await runWebhookWork(handle.db, xero.runtime, { log, holds });
    const calls = xero.script([xeroAnswer('Invoices', { Message: 'boom' }, { status: 500, repeat: true })]);
    await runWebhookWork(handle.db, xero.runtime, { log, holds });
    assert.equal(calls.calls.length, 0, 'it waits before the next try');
    assert.equal(log.lines.filter((l) => /reading waiting changes/.test(l)).length, 1);
    assert.equal(holds.get(org()).failures, 1);
  });

  test('without a webhook key, the endpoint does not answer', async () => {
    const other = scriptedXero({});
    const booted = await bootFlow(handle, { runtime: other.runtime, log: other.log });
    const res = await request(booted.app, '/api/xero/webhooks', { method: 'POST', body: { events: [] }, headers: { 'x-xero-signature': sign('{"events":[]}') } });
    assert.equal(res.status, 404);
    await booted.integrations.stop?.();
  });
});
