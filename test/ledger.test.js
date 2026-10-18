import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { getInvoice } from '../server/core/invoices.js';
import {
  draftInvoiceForObligation,
  explainObligation,
  listObligations,
  listPendingWritebacks,
  observeJob,
  recordAccountingEvidence,
  recordPayment,
  recordWritebackResult,
  setHold,
} from '../server/core/ledger.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Synthetic data only (CONTRIBUTING.md).
describe('billing obligation ledger', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let otherLab;
  let practice;
  let jobNumber = 0;
  const actor = 'user:test';
  const notFound = async () => ({ state: 'not_found' });

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
    otherLab = await createOrganisation(db, { name: 'Other Lab' });
    practice = await createContact(db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
  });

  after(async () => handle?.close());

  const job = (overrides = {}) => ({
    sourceSystem: 'worksystem',
    sourceJobRef: `JOB-${++jobNumber}`,
    caseRef: `CASE-${jobNumber}`,
    contactId: practice.id,
    shippedOn: '2026-10-17',
    lines: [{ itemCode: 'CRN' }],
    ...overrides,
  });

  const readyObligation = async (overrides) => {
    const obligation = await observeJob(db, lab.id, job(overrides));
    return recordAccountingEvidence(db, lab.id, obligation.id, { state: 'not_found', actor });
  };

  test('one billable job gives one obligation with a stable identity', async () => {
    const report = job();
    const first = await observeJob(db, lab.id, report);
    const again = await observeJob(db, lab.id, report);
    assert.equal(again.id, first.id);
    assert.equal(first.totalCents, 24200);
    assert.equal(first.mappingComplete, true);
    const { events } = await explainObligation(db, lab.id, first.id);
    assert.deepEqual(events.map((e) => e.kind), ['observed']);
  });

  test('each view is explained by the stored evidence', async () => {
    const unchecked = await observeJob(db, lab.id, job());
    assert.equal((await explainObligation(db, lab.id, unchecked.id)).view, 'pending');

    const unmapped = await observeJob(db, lab.id, job({ lines: [{ itemCode: 'NEW', description: 'New item', unitAmountCents: 500 }] }));
    await recordAccountingEvidence(db, lab.id, unmapped.id, { state: 'not_found', actor });
    const pending = await explainObligation(db, lab.id, unmapped.id);
    assert.equal(pending.view, 'pending');
    assert.deepEqual(pending.reasons, ['a line does not map to a price item']);

    const ready = await readyObligation();
    assert.equal((await explainObligation(db, lab.id, ready.id)).view, 'ready');
    await setHold(db, lab.id, ready.id, { holdState: 'held', reason: 'waiting for the practice', actor });
    const held = await explainObligation(db, lab.id, ready.id);
    assert.deepEqual([held.view, held.reasons], ['held', ['waiting for the practice']]);
    assert.deepEqual(held.events.map((e) => e.kind), ['observed', 'accounting_checked', 'held']);
  });

  test('a draft is made only when the evidence and a live check allow it, and shows at once', async () => {
    const obligation = await readyObligation();
    const checked = [];
    const { invoice } = await draftInvoiceForObligation(db, lab.id, obligation.id, {
      actor,
      liveCheck: async (o) => { checked.push(o.sourceJobRef); return { state: 'not_found' }; },
    });
    assert.deepEqual(checked, [obligation.sourceJobRef]);
    assert.equal(invoice.totalCents, 24200);
    assert.equal((await getInvoice(db, lab.id, invoice.id)).reference, obligation.caseRef);
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'drafted');
    await assert.rejects(
      draftInvoiceForObligation(db, lab.id, obligation.id, { actor, liveCheck: notFound }),
      { code: 'not_ready' },
    );
  });

  test('a draft fails closed on any doubt, and the refusal is recorded', async () => {
    const cases = [
      [async () => ({ state: 'authorised' }), /reports authorised/],
      [async () => { throw new Error('timed out'); }, /check failed: timed out/],
      [async () => ({}), /reports nothing/],
    ];
    for (const [liveCheck, reason] of cases) {
      const obligation = await readyObligation();
      await assert.rejects(
        draftInvoiceForObligation(db, lab.id, obligation.id, { actor, liveCheck }),
        (error) => error.code === 'not_ready' && reason.test(error.details.reasons.join('; ')),
      );
      const { view, events } = await explainObligation(db, lab.id, obligation.id);
      assert.equal(view, 'ready');
      assert.equal(events.at(-1).kind, 'draft_refused');
    }

    const stale = await readyObligation({ observedAt: '2026-01-01T00:00:00Z' });
    let called = false;
    await assert.rejects(
      draftInvoiceForObligation(db, lab.id, stale.id, { actor, liveCheck: async () => { called = true; return { state: 'not_found' }; } }),
      (error) => error.details.reasons.includes('the work system report is out of date'),
    );
    assert.equal(called, false);
  });

  test('a job with an invoice never becomes ready from a stale or loose report', async () => {
    const obligation = await observeJob(db, lab.id, job());
    await recordAccountingEvidence(db, lab.id, obligation.id, {
      state: 'authorised', accountingRef: 'ACC-1', matchedBy: 'source_invoice_ref', actor,
    });
    const gone = await recordAccountingEvidence(db, lab.id, obligation.id, { state: 'not_found', actor });
    assert.equal(gone.accountingState, 'conflict');
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'review_required');

    const loose = await readyObligation();
    const guessed = await recordAccountingEvidence(db, lab.id, loose.id, {
      state: 'authorised', accountingRef: 'ACC-2', matchedBy: 'amount_and_date', actor,
    });
    assert.equal(guessed.accountingState, 'ambiguous');
    assert.equal(guessed.accountingRef, null);
    assert.equal((await explainObligation(db, lab.id, loose.id)).view, 'review_required');
  });

  test('a job that changes after its invoice goes to review', async () => {
    const report = job();
    const obligation = await observeJob(db, lab.id, report);
    await recordAccountingEvidence(db, lab.id, obligation.id, { state: 'not_found', actor });
    await draftInvoiceForObligation(db, lab.id, obligation.id, { actor, liveCheck: notFound });
    const changed = await observeJob(db, lab.id, { ...report, lines: [{ itemCode: 'CRN', quantity: 2 }] });
    assert.equal(changed.holdState, 'review');
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'review_required');
  });

  test('payment in full sends the paid status back with its evidence; a part payment does not', async () => {
    const obligation = await observeJob(db, lab.id, job());
    await recordAccountingEvidence(db, lab.id, obligation.id, {
      state: 'authorised', accountingRef: 'ACC-10', accountingUrl: 'https://accounting.example.test/invoices/ACC-10',
      matchedBy: 'flow_invoice', actor,
    });
    const payment = { paidOn: '2026-10-18', reconciled: true, matchedBy: 'accounting_ref', actor };

    await assert.rejects(
      recordPayment(db, lab.id, obligation.id, { ...payment, paymentRef: 'PAY-0', amountCents: 100, matchedBy: 'amount' }),
      { code: 'unmatched_payment' },
    );
    const part = await recordPayment(db, lab.id, obligation.id, { ...payment, paymentRef: 'PAY-1', amountCents: 10000 });
    assert.deepEqual([part.accountingState, part.paidCents], ['part_paid', 10000]);
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'invoiced');
    assert.deepEqual(await listPendingWritebacks(db, lab.id), []);

    await recordPayment(db, lab.id, obligation.id, { ...payment, paymentRef: 'PAY-1', amountCents: 10000 });
    const paid = await recordPayment(db, lab.id, obligation.id, { ...payment, paymentRef: 'PAY-2', amountCents: 14200, reference: 'REMIT-7' });
    assert.deepEqual([paid.accountingState, paid.paidCents], ['paid', 24200]);
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'paid');

    const [writeback] = await listPendingWritebacks(db, lab.id, { targetSystem: 'worksystem' });
    assert.equal(writeback.status, 'paid');
    assert.equal(writeback.evidence.accountingUrl, 'https://accounting.example.test/invoices/ACC-10');
    assert.deepEqual(writeback.evidence.payments.map((p) => [p.paymentRef, p.amountCents, p.reconciled]), [
      ['PAY-1', 10000, true], ['PAY-2', 14200, true],
    ]);

    const failed = await recordWritebackResult(db, lab.id, writeback.id, { outcome: 'failed', error: 'work system is down', actor });
    assert.deepEqual([failed.state, failed.attempts], ['failed', 1]);
    assert.equal((await listPendingWritebacks(db, lab.id)).length, 1);
    const sent = await recordWritebackResult(db, lab.id, writeback.id, { outcome: 'sent', actor });
    assert.deepEqual([sent.state, sent.attempts, sent.lastError], ['sent', 2, null]);
    assert.deepEqual(await listPendingWritebacks(db, lab.id), []);
    const { events } = await explainObligation(db, lab.id, obligation.id);
    assert.deepEqual(events.map((e) => e.kind).slice(-5), ['payment_recorded', 'payment_recorded', 'paid', 'writeback_failed', 'writeback_sent']);
  });

  test('a payment needs a confirmed invoice', async () => {
    const obligation = await readyObligation();
    await assert.rejects(
      recordPayment(db, lab.id, obligation.id, { paymentRef: 'PAY-9', paidOn: '2026-10-18', amountCents: 100, matchedBy: 'accounting_ref', actor }),
      { code: 'not_linked' },
    );
  });

  test('the reasons for a state cannot be changed or removed', async () => {
    const obligation = await observeJob(db, lab.id, job());
    await assert.rejects(handle.pool.query('UPDATE obligation_events SET kind = $1 WHERE obligation_id = $2', ['x', obligation.id]), /append-only/);
    await assert.rejects(handle.pool.query('DELETE FROM obligation_events WHERE obligation_id = $1', [obligation.id]), /append-only/);
  });

  test('one organisation cannot read or use another organisation\'s obligations', async () => {
    const obligation = await observeJob(db, lab.id, job());
    await assert.rejects(explainObligation(db, otherLab.id, obligation.id), { code: 'not_found' });
    await assert.rejects(setHold(db, otherLab.id, obligation.id, { holdState: 'held', reason: 'x', actor }), { code: 'not_found' });
    assert.deepEqual(await listObligations(db, otherLab.id), []);
    const otherLines = [{ description: 'Crown', unitAmountCents: 22000 }];
    await assert.rejects(observeJob(db, otherLab.id, job({ lines: otherLines })), (error) => error.cause?.constraint === 'billing_obligations_contact_same_org');
  });
});
