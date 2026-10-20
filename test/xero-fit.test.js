import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canFit, scoreFit, sureFits } from '../server/integrations/xero/fit.js';

// How sure a Xero invoice is one Flow invoice (server/integrations/xero/fit.js).
// Synthetic data only.

const xero = (over = {}) => ({ id: 'X1', number: 'INV-1', contactId: 'C1', totalCents: 27500, issuedOn: '2026-10-18', itemCodes: ['CROWN'], reference: null, ...over });
const flow = (over = {}) => ({ id: 'F1', contactId: 'C1', totalCents: 27500, subtotalCents: 25000, date: '2026-10-18', itemCodes: ['CROWN'], reference: null, jobs: [], ...over });
const names = (scored) => scored.signals.map((s) => s.signal);

test('the same client, total, items and day score as a sure fit', () => {
  const scored = scoreFit(xero(), flow());
  assert.deepEqual(names(scored), ['client', 'total', 'items_same', 'date_close']);
  assert.equal(scored.score, 13);
  assert.ok(canFit(xero(), flow(), scored));
});

test('hard evidence: the job is tied to the Xero invoice, or its work-system number is the Xero number', () => {
  assert.equal(scoreFit(xero(), flow({ jobs: [{ accountingRef: 'X1' }] })).hard, 'job_tied');
  const reissued = scoreFit(xero({ number: 'SZ-104', contactId: null, totalCents: 1 }), flow({ jobs: [{ sourceInvoiceRef: 'SZ-104R' }] }));
  assert.equal(reissued.hard, 'work_invoice_number');
  assert.ok(canFit(xero({ contactId: null }), flow(), reissued), 'hard evidence fits with no client match');
});

test('other items, another Reference or another client lower the fit', () => {
  assert.ok(names(scoreFit(xero({ itemCodes: ['NGH'] }), flow())).includes('items_differ'));
  assert.ok(names(scoreFit(xero({ reference: 'Dr A - B. Patient' }), flow({ reference: 'Dr A - C. Patient' }))).includes('reference_differs'));
  assert.ok(names(scoreFit(xero({ reference: 'dr a  - b. patient' }), flow({ reference: 'Dr A - B. Patient' }))).includes('reference_same'));
  assert.equal(canFit(xero({ contactId: 'C2' }), flow(), scoreFit(xero({ contactId: 'C2' }), flow())), false);
  assert.equal(canFit(xero({ issuedOn: '2026-12-01' }), flow(), scoreFit(xero({ issuedOn: '2026-12-01' }), flow())), false, 'more than two weeks apart');
  assert.ok(names(scoreFit(xero({ totalCents: 27500 }), flow({ totalCents: 25000, subtotalCents: 25000 }))).includes('total_gst'));
});

test('sure needs a clear lead both ways', () => {
  assert.deepEqual([...sureFits([{ xeroId: 'X1', flowId: 'F1', score: 13 }])], [['X1', 'F1']]);
  assert.equal(sureFits([{ xeroId: 'X1', flowId: 'F1', score: 10 }]).size, 0, 'too weak');
  assert.equal(sureFits([{ xeroId: 'X1', flowId: 'F1', score: 13 }, { xeroId: 'X1', flowId: 'F2', score: 12 }]).size, 0, 'two Flow invoices fit');
  assert.equal(sureFits([{ xeroId: 'X1', flowId: 'F1', score: 13 }, { xeroId: 'X2', flowId: 'F1', score: 13 }]).size, 0, 'two Xero invoices fit');
  assert.deepEqual([...sureFits([{ xeroId: 'X1', flowId: 'F1', score: 13 }, { xeroId: 'X2', flowId: 'F1', score: 8 }, { xeroId: 'X2', flowId: 'F2', score: 13 }])], [['X1', 'F1'], ['X2', 'F2']]);
  assert.deepEqual([...sureFits([{ xeroId: 'X1', flowId: 'F1', score: 6, hard: 'job_tied' }])], [['X1', 'F1']]);
  assert.equal(sureFits([{ xeroId: 'X1', flowId: 'F1', score: 16, hard: 'job_tied' }, { xeroId: 'X1', flowId: 'F2', score: 6, hard: 'job_tied' }]).size, 0, 'two hard ties wait');
});
