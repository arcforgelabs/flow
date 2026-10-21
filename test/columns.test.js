import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanColumnIds, cleanWidths, COLUMN_MIN, endWidth, INVOICE_COLUMNS, LEAD_WIDTH, MAX_WIDTH, moveColumn, normaliseJobsView, normaliseListView, PRICE_COLUMNS, RECONCILE_COLUMNS, TAIL_WIDTH, tableWidth, widthOf,
} from '../server/ui/job-view.js';
import { normaliseViews } from '../server/auth/people.js';

// A list's column order and widths (server/ui/columns.js draws them; the
// rules are in server/ui/job-view.js). Synthetic data only.

test('a column is never narrower than its kind allows, nor wider than the most', () => {
  assert.equal(widthOf({ id: 'due', kind: 'date' }, {}), 120, 'no saved width: the kind starts the column');
  assert.equal(widthOf({ id: 'due', kind: 'date' }, { due: 10 }), COLUMN_MIN.date);
  assert.equal(widthOf({ id: 'client', kind: 'client' }, { client: 90 }), COLUMN_MIN.client);
  assert.equal(widthOf({ id: 'note', kind: 'text' }, { note: 5000 }), MAX_WIDTH);
  assert.equal(widthOf({ id: 'note', kind: 'text' }, { note: 211.6 }), 212);
});

test('the end column fills the row to the window edge; the other columns keep their widths', () => {
  const columns = [{ id: 'client', kind: 'client' }, { id: 'due', kind: 'date' }];
  const need = tableWidth(columns, { client: 300 }, 1);
  assert.equal(need, 300 + 120 + LEAD_WIDTH + TAIL_WIDTH);
  // A wide window: the end column takes the rest, so the table is exactly the window.
  assert.equal(endWidth(need, 1718.6), 1718 - (need - TAIL_WIDTH));
  assert.equal(need - TAIL_WIDTH + endWidth(need, 1718.6), 1718);
  // A narrow window, or one not drawn yet: the end column keeps its least
  // width and the table scrolls sideways.
  assert.equal(endWidth(need, 400), TAIL_WIDTH);
  assert.equal(endWidth(need, 0), TAIL_WIDTH);
});

test('saved widths keep only column ids and pixel counts in range', () => {
  const field = 'field:0b6d6d43-5d9c-4c5e-9d11-3f3b0a3c2a10';
  assert.deepEqual(cleanWidths({ due: 120, [field]: 300.4, total: 'wide', 'x y': 100, tiny: 2, huge: 9999 }), { due: 120, [field]: 300 });
  assert.deepEqual(cleanWidths(null), {});
  assert.deepEqual(cleanWidths([100]), {});
});

test('a column moves to a place; the others keep their order', () => {
  const ids = ['practitioner', 'patient', 'stage', 'due', 'total'];
  assert.deepEqual(moveColumn(ids, 'practitioner', 3), ['patient', 'stage', 'due', 'practitioner', 'total']);
  assert.deepEqual(moveColumn(ids, 'total', 0), ['total', 'practitioner', 'patient', 'stage', 'due']);
  assert.deepEqual(moveColumn(ids, 'stage', 99), ['practitioner', 'patient', 'due', 'total', 'stage']);
});

test('a saved column order keeps known ids once each', () => {
  assert.deepEqual(cleanColumnIds(['total', 'date', 'total', 'nope', 7], (id) => ['total', 'date'].includes(id)), ['total', 'date']);
  assert.equal(cleanColumnIds('total', () => true), null);
});

test('the Jobs view keeps column widths; Invoices and Reconcile keep columns and widths', () => {
  assert.deepEqual(normaliseJobsView({ widths: { due: 140, bad: 'x' } }).widths, { due: 140 });
  assert.deepEqual(normaliseListView(null, INVOICE_COLUMNS), { columns: Object.keys(INVOICE_COLUMNS), widths: {} });
  assert.deepEqual(normaliseListView({ columns: ['total', 'client', 'other'], widths: { total: 150 } }, INVOICE_COLUMNS), { columns: ['total', 'client'], widths: { total: 150 } });
  assert.deepEqual(normaliseViews({ reconcile: { columns: ['date', 'kind'] }, invoices: { widths: { client: 300 } } }), {
    invoices: { columns: Object.keys(INVOICE_COLUMNS), widths: { client: 300 } },
    reconcile: { columns: ['date', 'kind'], widths: {} },
  });
  assert.ok(Object.keys(RECONCILE_COLUMNS).includes('possible'));
  // The Price list keeps its columns and widths the same way.
  assert.deepEqual(normaliseViews({ 'price-list': { columns: ['name', 'code', 'nope'], widths: { name: 320 } } })['price-list'], { columns: ['name', 'code'], widths: { name: 320 } });
  assert.deepEqual(normaliseListView(null, PRICE_COLUMNS).columns, ['code', 'name', 'price', 'tax']);
});
