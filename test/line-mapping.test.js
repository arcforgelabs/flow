import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineLookupText, mapLine, mapLines, mappingContext, quantityOf, readMapping } from '../server/core/line-mapping.js';

// A work system's lines carry its own codes and labels; the lab's price list
// has the accounting codes. Every name here is made up.
const items = [
  { code: 'FLD', name: 'Full Lower Denture', unitAmountCents: 30000, taxCode: 'GST_FREE' },
  { code: 'RLN', name: 'Reline - Full Denture', unitAmountCents: 25000, taxCode: 'GST_FREE' },
  { code: 'SPT', name: 'Special Tray', unitAmountCents: 5500, taxCode: 'GST_FREE' },
  { code: 'TTH', name: 'Teeth', unitAmountCents: 1250, taxCode: 'GST_FREE' },
  { code: 'OLD', name: 'Bite Block', unitAmountCents: 4500, taxCode: 'GST', archivedAt: new Date() },
];
const line = (description, unitAmountCents, extra = {}) => ({ itemCode: '9001', description, quantity: 1, unitAmountCents, taxCode: 'GST_FREE', ...extra });

test('lookup text drops sizes, arch and per-set words', () => {
  assert.equal(lineLookupText('Crown - Upper 4'), 'crown');
  assert.equal(lineLookupText('Teeth - (per set)'), 'teeth');
  assert.deepEqual(quantityOf('Teeth (6 x $12.50)'), { base: 'Teeth', quantity: 6, unitAmountCents: 1250 });
});

test('a work system code that is not a price item code falls through to the name', () => {
  const mapped = mapLine(line('Special Tray', 5500), mappingContext({ items }));
  assert.equal(mapped.itemCode, 'SPT');
  assert.equal(mapped.mappedBy, 'catalog_name');
  assert.equal(mapped.unitAmountCents, 5500);
});

test('the same code wins first', () => {
  const mapped = mapLine(line('Anything', 100, { itemCode: 'fld' }), mappingContext({ items }));
  assert.equal(mapped.itemCode, 'FLD');
  assert.equal(mapped.mappedBy, 'same_code');
});

test('a saved choice for a label at a price wins over the name steps', () => {
  const mappings = [{ kind: 'saved', match: 'exact', label: 'full denture reline', unitAmountCents: 25000, itemCode: 'RLN' }];
  const mapped = mapLine(line('Full Denture Reline', 25000), mappingContext({ items, mappings }));
  assert.equal(mapped.itemCode, 'RLN');
  assert.equal(mapped.mappedBy, 'saved');
});

test('the closest name at the same price maps a label no row knows', () => {
  const mapped = mapLine(line('Full Denture Reline', 25000), mappingContext({ items }));
  assert.equal(mapped.itemCode, 'RLN');
  assert.equal(mapped.mappedBy, 'catalog_score');
});

test('a label with its own quantity keeps it, and the work system amount stays', () => {
  const mapped = mapLine(line('Teeth (6 x $12.50)', 7500), mappingContext({ items }));
  assert.equal(mapped.itemCode, 'TTH');
  assert.equal(mapped.quantity, 6);
  assert.equal(mapped.unitAmountCents, 1250);
});

test('an account row books a surcharge line to an account', () => {
  const mappings = [{ kind: 'account', match: 'starts_with', label: 'priority', accountCode: '200', description: 'Priority turnaround' }];
  const mapped = mapLine(line('Priority turnaround 20%', 4000), mappingContext({ items, mappings }));
  assert.equal(mapped.accountCode, '200');
  assert.equal(mapped.itemCode, null);
});

test('a line no step answers keeps no code, so the ledger holds the job', () => {
  const [mapped] = mapLines([line('Something new', 999)], mappingContext({ items }));
  assert.equal(mapped.itemCode, null);
  assert.equal(mapped.accountCode, null);
  // An archived price item never maps.
  assert.equal(mapLine(line('Bite Block', 4500), mappingContext({ items })).itemCode, null);
});

test('zero lines drop only when the routine says so', () => {
  assert.equal(mapLines([line('Special Tray', 0)], mappingContext({ items })).length, 1);
  assert.equal(mapLines([line('Special Tray', 0)], mappingContext({ items, config: { zeroLines: 'drop' } })).length, 0);
});

test('a mapping row is checked before it is saved', () => {
  assert.throws(() => readMapping({ kind: 'saved', label: 'x', itemCode: 'FLD' }), /unit price/);
  assert.throws(() => readMapping({ kind: 'account', label: 'x' }), /account code/);
  assert.deepEqual(readMapping({ kind: 'alias', label: 'Crown - Upper 4', itemCode: 'CRN' }).label, 'crown');
});
