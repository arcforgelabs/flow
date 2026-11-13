import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineLookupText, mapLine, mapLines, mappingContext, quantityOf, readMapping, readMappingConfig } from '../server/core/line-mapping.js';

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

test('an approximate catalog name cannot supply unknown source tax', () => {
  const context = mappingContext({ items: [{ code: 'SYNTH', name: 'Synthetic crown', unitAmountCents: 10000, taxCode: 'GST' }] });
  for (const taxCode of [null, undefined]) {
    const source = { description: 'Synthetic unknown-tax service', accountCode: '200', quantity: 1, unitAmountCents: 10000, taxCode };
    const [mapped] = mapLines([source], context);
    assert.equal(mapped.taxCode, taxCode);
    assert.equal(mapped.itemCode, null);
    assert.equal(mapped.description, source.description);
    assert.equal(mapped.unitAmountCents, 10000);
  }
});

test('exact items and saved choices can supply tax when the source gives none', () => {
  const item = { id: 'synthetic-item', code: 'SYNTH', name: 'Synthetic crown', unitAmountCents: 10000, taxCode: 'GST' };
  const unknown = { description: 'Synthetic unknown-tax service', quantity: 1, unitAmountCents: 10000, taxCode: null };
  const cases = [
    { source: { ...unknown, itemCode: 'SYNTH' } },
    { source: { ...unknown, itemCode: '9001' }, links: [{ externalCode: '9001', priceItemId: item.id }] },
    { source: { ...unknown, description: item.name } },
    { source: { ...unknown, description: item.name }, config: { steps: ['catalog_name_price'] } },
    ...['saved', 'price_alias', 'alias'].flatMap((kind) => [null, 'GST_FREE'].map((taxCode) => ({
      source: unknown, mappings: [{ kind, match: 'exact', label: 'synthetic unknown tax service', unitAmountCents: 10000, itemCode: 'SYNTH', taxCode }],
      taxCode: taxCode ?? 'GST',
    }))),
  ];
  for (const { source, taxCode = 'GST', ...options } of cases) {
    const [mapped] = mapLines([source], mappingContext({ items: [item], ...options }));
    assert.equal(mapped.itemCode, 'SYNTH');
    assert.equal(mapped.taxCode, taxCode);
  }
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

test('with lineTax work, source tax takes precedence over saved item and account choices', () => {
  for (const kind of ['alias', 'account']) {
    const mappings = [{ kind, match: 'exact', label: 'sample adjustment', itemCode: 'RLN', accountCode: '200', taxCode: 'GST' }];
    const context = mappingContext({ items, mappings, config: { lineTax: 'work' } });
    assert.equal(mapLine(line('Sample adjustment', 1000), context).taxCode, 'GST_FREE');
    assert.equal(mapLine(line('Sample adjustment', 1000, { taxCode: null }), context).taxCode, 'GST');
  }
  const context = mappingContext({ items: [], mappings: [{ kind: 'account', match: 'exact', label: 'sample adjustment', accountCode: '200' }] });
  assert.equal(mapLine(line('Sample adjustment', -1000, { taxCode: null }), context).taxCode, null);
});

test('by default the price item gives the GST and a different work flag stays on the line', () => {
  const context = mappingContext({ items });
  const flagged = mapLine(line('Special Tray', 5500, { taxCode: 'GST' }), context);
  assert.equal(flagged.taxCode, 'GST_FREE');
  assert.equal(flagged.workTaxCode, 'GST');
  const agrees = mapLine(line('Special Tray', 5500), context);
  assert.equal(agrees.taxCode, 'GST_FREE');
  assert.equal('workTaxCode' in agrees, false);
  assert.equal(mapLine(line('Special Tray', 5500, { taxCode: null }), context).taxCode, 'GST_FREE');
  // lineTax work keeps the work system's flag.
  assert.equal(mapLine(line('Special Tray', 5500, { taxCode: 'GST' }), mappingContext({ items, config: { lineTax: 'work' } })).taxCode, 'GST');
  assert.throws(() => readMappingConfig({ lineTax: 'xero' }), /lineTax must be one of work, list/);
  assert.equal(readMappingConfig({}).lineTax, 'list');
  assert.equal(readMappingConfig({ lineTax: 'work' }).lineTax, 'work');
});

test('a line no step answers keeps no code, so the ledger holds the job', () => {
  const [mapped] = mapLines([line('Something new', 999)], mappingContext({ items }));
  assert.equal(mapped.itemCode, null);
  assert.equal(mapped.accountCode, null);
  // An archived price item never maps.
  assert.equal(mapLine(line('Bite Block', 4500), mappingContext({ items })).itemCode, null);
});

test('a linked product maps at any price, and a waiting line keeps the work system code', () => {
  const linked = mappingContext({ items: items.map((item) => ({ ...item, id: `id-${item.code}` })), links: [{ priceItemId: `id-${items[0].code}`, externalCode: '2101' }] });
  const line = { itemCode: '2101', description: 'A name no step knows', unitAmountCents: 12345, taxCode: 'GST_FREE' };
  const mapped = mapLine(line, linked);
  assert.deepEqual([mapped.itemCode, mapped.mappedBy, mapped.unitAmountCents], [items[0].code, 'linked', 12345]);
  const waits = mapLine(line, mappingContext({ items }));
  assert.deepEqual([waits.itemCode, waits.workCode], [null, '2101']);
  assert.equal(mapLine({ ...line, itemCode: null }, mappingContext({ items })).workCode, undefined);
});

test('a saved choice can be for a discount line below zero; other kinds cannot', () => {
  assert.equal(readMapping({ kind: 'saved', label: 'Family discount', unitAmountCents: -17500, itemCode: 'DISC' }).unitAmountCents, -17500);
  assert.throws(() => readMapping({ kind: 'price_alias', label: 'Family discount', unitAmountCents: -17500, itemCode: 'DISC' }), /zero or more/);
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
