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
