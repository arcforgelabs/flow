import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceBillingProblems } from '../server/core/ledger.js';

// One GST crown: subtotal 37727, GST 3773, total 41500 (Flow's own sums).
const lines = [{ description: 'Crown', quantity: 1, unitAmountCents: 37727, taxCode: 'GST', lineAmountCents: 37727, taxCents: 3773 }];
const check = (sourceTotals) => sourceBillingProblems({ lines, sourceTotals });

test('a zero source subtotal does not hold an invoice whose total and GST match', () => {
  assert.deepEqual(check({ subtotalCents: 0, taxCents: 3773, totalCents: 41500 }), []);
});

test('a real difference still holds', () => {
  assert.equal(check({ subtotalCents: 37727, taxCents: 3773, totalCents: 41501 }).length, 1);
  assert.equal(check({ subtotalCents: 0, taxCents: 3772, totalCents: 41500 }).length, 1);
  assert.equal(check({ subtotalCents: 0, totalCents: 41500 }).length, 1, 'GST missing: the subtotal is still compared');
  assert.equal(check({ subtotalCents: 0 }).length, 1);
});

// Xero's item sets the shipping line's GST; the work system said GST free.
// Shipping 1500 + GST 150, a GST-free denture 47000: the work system reports
// GST 0 and total 48500, Flow GST 150 and total 48650.
const xeroLines = [
  { description: 'Denture', quantity: 1, unitAmountCents: 47000, taxCode: 'GST_FREE', lineAmountCents: 47000, taxCents: 0 },
  { description: 'Shipping', quantity: 1, unitAmountCents: 1500, taxCode: 'GST', workTaxCode: 'GST_FREE', lineAmountCents: 1500, taxCents: 150 },
];
const xeroCheck = (sourceTotals) => sourceBillingProblems({ lines: xeroLines, sourceTotals });

test('when Xero sets a line GST, only the prices before GST are compared', () => {
  assert.deepEqual(xeroCheck({ subtotalCents: 0, taxCents: 0, totalCents: 48500 }), []);
  assert.deepEqual(xeroCheck({ subtotalCents: 48500 }), []);
  assert.equal(xeroCheck({ subtotalCents: 0, taxCents: 0, totalCents: 48600 }).length, 1, 'a price difference still holds');
});
