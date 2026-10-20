import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { getInvoice, updateDraftInvoice } from '../server/core/invoices.js';
import {
  CHANGED_REASON,
  FIELD_OWNERS,
  REVIEW_CHANGED,
  REVIEW_STATUS_BACK,
  STATUS_BACK_REASON,
  compareThreeWays,
  draftInvoiceForObligation,
  explainObligation,
  observeJob,
  observeWithdrawn,
  recordAccountingEvidence,
  setReady,
  useSourceLines,
} from '../server/core/ledger.js';
import { listReview } from '../server/core/review.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Issue #127: the facts an invoice was built from are its merge base; a job
// that changes later is compared three ways; a status that moves back holds
// the job. Conflicts only alert. Synthetic data only (CONTRIBUTING.md).

describe('three-way compare, field by field', () => {
  const line = (unitAmountCents, quantity = 1) => ({ priceItemId: 'p1', description: 'Crown', quantity, unitAmountCents, taxCode: 'GST' });
  const base = { lines: [line(100)], contactId: 'c1' };
  const changedIn = (compare) => Object.fromEntries(compare.fields.map((f) => [f.field, f.changedIn]));

  test('only the work fields are compared, and each field has one owner', () => {
    assert.deepEqual(compareThreeWays(base, base, base).fields.map((f) => [f.field, f.owner]), [['lines', 'work'], ['contactId', 'work']]);
    assert.equal(FIELD_OWNERS.dueDate, 'flow');
    assert.equal(FIELD_OWNERS.payment, 'accounting');
  });

  test('the work system alone changed: offer the new lines', () => {
    const compare = compareThreeWays(base, { ...base, lines: [line(200)] }, base);
    assert.equal(compare.outcome, 'offer');
    assert.deepEqual(changedIn(compare), { lines: 'work', contactId: 'none' });
  });

  test('Flow alone changed: nothing to do', () => {
    const compare = compareThreeWays(base, base, { ...base, lines: [line(150)] });
    assert.equal(compare.outcome, 'none');
    assert.deepEqual(changedIn(compare), { lines: 'flow', contactId: 'none' });
  });

  test('both changed the same way: nothing to do; both changed differently: a conflict', () => {
    assert.equal(compareThreeWays(base, { ...base, lines: [line(200)] }, { ...base, lines: [line(200)] }).outcome, 'none');
    const compare = compareThreeWays(base, { ...base, lines: [line(200)] }, { ...base, lines: [line(150)] });
    assert.equal(compare.outcome, 'conflict');
    assert.equal(changedIn(compare).lines, 'both');
  });

  test('a change in the work system after the invoice left Flow is a conflict', () => {
    assert.equal(compareThreeWays(base, { ...base, contactId: 'c2' }, base, { sent: true }).outcome, 'conflict');
  });

  test('line order does not count as a change', () => {
    const two = [line(100), line(300)];
    assert.equal(compareThreeWays({ ...base, lines: two }, { ...base, lines: [...two].reverse() }, { ...base, lines: two }).outcome, 'none');
  });
});

describe('merge base and status moves back in the ledger', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let practice;
  let jobNumber = 0;
  const actor = 'user:test';
  const notFound = async () => ({ state: 'not_found' });

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
    practice = await createContact(db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
    await createPriceItem(db, lab.id, { code: 'BRG', name: 'Bridge', unitAmountCents: 50000 });
  });

  after(async () => handle?.close());

  const job = (overrides = {}) => ({
    sourceSystem: 'worksystem',
    sourceJobRef: `JOB-${++jobNumber}`,
    contactId: practice.id,
    sourceStatus: 'Shipped',
    lines: [{ itemCode: 'CRN' }],
    ...overrides,
  });

  const drafted = async (overrides) => {
    const report = job(overrides);
    const obligation = await observeJob(db, lab.id, report);
    await recordAccountingEvidence(db, lab.id, obligation.id, { state: 'not_found', actor });
    const { invoice } = await draftInvoiceForObligation(db, lab.id, obligation.id, { actor, liveCheck: notFound });
    return { report, obligation, invoice };
  };

  const openItem = async (kind, flowId) => (await listReview(db, lab.id, { kind })).find((r) => r.flowId === flowId) ?? null;

  test('drafting keeps the facts the invoice was built from', async () => {
    const { obligation } = await drafted();
    const { obligation: row } = await explainObligation(db, lab.id, obligation.id);
    assert.equal(row.draftBasis.totalCents, 24200);
    assert.equal(row.draftBasis.contactId, practice.id);
    assert.equal(row.draftBasis.sourceStatus, 'Shipped');
    assert.deepEqual(row.draftBasis.lines.map((l) => [l.itemCode, l.unitAmountCents]), [['CRN', 22000]]);
  });

  test('the work system alone changed: review, an alert, and "Use new lines" updates only Flow\'s draft', async () => {
    const { report, obligation, invoice } = await drafted();
    const changed = await observeJob(db, lab.id, { ...report, lines: [{ itemCode: 'CRN', quantity: 2 }] });
    assert.deepEqual([changed.holdState, changed.holdReason], ['review', CHANGED_REASON]);
    const item = await openItem(REVIEW_CHANGED, obligation.id);
    assert.equal(item.evidence.outcome, 'offer');
    assert.equal(item.evidence.canUseNewLines, true);
    assert.equal(item.moneyAtRiskCents, 48400);
    assert.equal((await getInvoice(db, lab.id, invoice.id)).totalCents, 24200, 'the alert changes nothing');

    const { obligation: used, invoice: updated } = await useSourceLines(db, lab.id, obligation.id, { actor });
    assert.equal(updated.totalCents, 48400);
    assert.equal(used.holdState, 'none');
    assert.equal(used.draftBasis.totalCents, 48400, 'the new lines are the new merge base');
    assert.equal(await openItem(REVIEW_CHANGED, obligation.id), null);
    assert.equal((await explainObligation(db, lab.id, obligation.id)).events.at(-1).kind, 'source_lines_used');
  });

  test('a job that changes back to what the invoice was built from needs nothing', async () => {
    const { report, obligation } = await drafted();
    await observeJob(db, lab.id, { ...report, lines: [{ itemCode: 'BRG' }] });
    const back = await observeJob(db, lab.id, report);
    assert.equal(back.holdState, 'none');
    assert.equal(await openItem(REVIEW_CHANGED, obligation.id), null);
  });

  test('both changed: a conflict alert only, and "Use new lines" is refused', async () => {
    const { report, obligation, invoice } = await drafted();
    await updateDraftInvoice(db, lab.id, invoice.id, { lines: [{ description: 'Crown, adjusted', quantity: 1, unitAmountCents: 20000, taxCode: 'GST' }] });
    const changed = await observeJob(db, lab.id, { ...report, lines: [{ itemCode: 'BRG' }] });
    assert.equal(changed.holdState, 'review');
    const item = await openItem(REVIEW_CHANGED, obligation.id);
    assert.equal(item.evidence.outcome, 'conflict');
    assert.equal(item.evidence.canUseNewLines, false);
    await assert.rejects(useSourceLines(db, lab.id, obligation.id, { actor }), { code: 'conflict' });
    assert.equal((await getInvoice(db, lab.id, invoice.id)).totalCents, 22000, 'Flow never writes to settle a conflict');
  });

  test('a change after the invoice reached the accounting system is a conflict alert only', async () => {
    const { report, obligation } = await drafted();
    await recordAccountingEvidence(db, lab.id, obligation.id, { state: 'drafted', accountingRef: 'ACC-9', matchedBy: 'flow_invoice', actor });
    await observeJob(db, lab.id, { ...report, lines: [{ itemCode: 'BRG' }] });
    const item = await openItem(REVIEW_CHANGED, obligation.id);
    assert.deepEqual([item.evidence.outcome, item.evidence.sent], ['conflict', true]);
    await assert.rejects(useSourceLines(db, lab.id, obligation.id, { actor }), { code: 'conflict' });
  });

  test('a status that moves back clears an unsent ready mark, and the alert closes when it is billable again', async () => {
    const report = job();
    const obligation = await observeJob(db, lab.id, report);
    await setReady(db, lab.id, obligation.id, { actor });
    const back = { sourceSystem: report.sourceSystem, sourceJobRef: report.sourceJobRef, sourceStatus: 'In Production' };
    const { obligation: cleared, action } = await observeWithdrawn(db, lab.id, back);
    assert.equal(action, 'ready_cleared');
    assert.equal(cleared.readyAt, null);
    assert.equal(cleared.sourceStatus, 'In Production');
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'in_work');
    assert.ok(await openItem(REVIEW_STATUS_BACK, obligation.id));
    // The hourly report of the same status does nothing more.
    assert.equal((await observeWithdrawn(db, lab.id, back)).action, 'none');
    assert.equal((await listReview(db, lab.id, { kind: REVIEW_STATUS_BACK })).find((r) => r.flowId === obligation.id).seenCount, 1);

    await observeJob(db, lab.id, report);
    assert.equal(await openItem(REVIEW_STATUS_BACK, obligation.id), null);
  });

  test('a status that moves back after the invoice was made sends the job to review, once', async () => {
    const { report, obligation } = await drafted();
    const back = { sourceSystem: report.sourceSystem, sourceJobRef: report.sourceJobRef, sourceStatus: 'In Production' };
    const { obligation: held, action } = await observeWithdrawn(db, lab.id, back);
    assert.equal(action, 'review');
    assert.deepEqual([held.holdState, held.holdReason], ['review', STATUS_BACK_REASON]);
    assert.equal((await explainObligation(db, lab.id, obligation.id)).view, 'review_required');
    assert.equal((await openItem(REVIEW_STATUS_BACK, obligation.id)).evidence.to, 'In Production');
    assert.equal((await observeWithdrawn(db, lab.id, back)).action, 'none');
  });

  test('a status that moves back on a job not ready and with no invoice only stores the status', async () => {
    const report = job();
    const obligation = await observeJob(db, lab.id, report);
    const { obligation: row, action } = await observeWithdrawn(db, lab.id, { sourceSystem: report.sourceSystem, sourceJobRef: report.sourceJobRef, sourceStatus: 'On Hold' });
    assert.deepEqual([action, row.sourceStatus, row.holdState], ['status', 'On Hold', 'none']);
    assert.equal(await openItem(REVIEW_STATUS_BACK, obligation.id), null);
  });

  test('an older report never moves a status back', async () => {
    const report = job();
    const obligation = await observeJob(db, lab.id, report);
    await setReady(db, lab.id, obligation.id, { actor });
    const { action } = await observeWithdrawn(db, lab.id, {
      sourceSystem: report.sourceSystem, sourceJobRef: report.sourceJobRef, sourceStatus: 'In Production', observedAt: '2026-01-01T00:00:00Z',
    });
    assert.equal(action, 'none');
  });
});
