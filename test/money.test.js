import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invoiceTotals, lineTotals } from '../server/core/money.js';

test('GST is 10% per line, rounded half away from zero', () => {
  assert.deepEqual(lineTotals({ quantity: 1, unitAmountCents: 22000, taxCode: 'GST' }), { lineAmountCents: 22000, taxCents: 2200 });
  assert.deepEqual(lineTotals({ quantity: 1, unitAmountCents: 5, taxCode: 'GST' }), { lineAmountCents: 5, taxCents: 1 });
  assert.deepEqual(lineTotals({ quantity: 1, unitAmountCents: 4, taxCode: 'GST' }), { lineAmountCents: 4, taxCents: 0 });
  assert.deepEqual(lineTotals({ quantity: 1, unitAmountCents: -5, taxCode: 'GST' }), { lineAmountCents: -5, taxCents: -1 });
  assert.deepEqual(lineTotals({ quantity: 3, unitAmountCents: 1999, taxCode: 'GST' }), { lineAmountCents: 5997, taxCents: 600 });
});

test('GST-free lines carry no tax', () => {
  assert.deepEqual(lineTotals({ quantity: 2, unitAmountCents: 7500, taxCode: 'GST_FREE' }), { lineAmountCents: 15000, taxCents: 0 });
});

test('bad quantities, amounts and tax codes are refused', () => {
  assert.throws(() => lineTotals({ quantity: 0, unitAmountCents: 100, taxCode: 'GST' }), /quantity/);
  assert.throws(() => lineTotals({ quantity: 1.5, unitAmountCents: 100, taxCode: 'GST' }), /quantity/);
  assert.throws(() => lineTotals({ quantity: 1, unitAmountCents: 10.5, taxCode: 'GST' }), /whole cents/);
  assert.throws(() => lineTotals({ quantity: 1, unitAmountCents: 100, taxCode: 'VAT' }), /tax code/);
});

test('invoice totals add the rounded lines', () => {
  const lines = [
    lineTotals({ quantity: 1, unitAmountCents: 5, taxCode: 'GST' }),
    lineTotals({ quantity: 1, unitAmountCents: 5, taxCode: 'GST' }),
  ];
  assert.deepEqual(invoiceTotals(lines), { subtotalCents: 10, taxCents: 2, totalCents: 12 });
});
