import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCodes, nameScore, rankCodes, reconcileRows } from '../server/ui/price-match.js';

// Likely Flow codes for a connected system's record (Price list › Reconcile).
// Every code, name and price here is made up.
const codes = [
  { id: 'i-bb', code: 'BB', name: 'Bite Block', unitAmountCents: 4500, taxCode: 'GST_FREE' },
  { id: 'i-bbr', code: 'BBR', name: 'Bite Block Repair', unitAmountCents: 3000, taxCode: 'GST_FREE' },
  { id: 'i-cc', code: 'CC', name: 'Cast Chrome Frame', unitAmountCents: 39000, taxCode: 'GST_FREE' },
  { id: 'i-blt', code: 'BLT', name: 'Bleach Tray', unitAmountCents: 8000, taxCode: 'GST' },
  { id: 'i-old', code: 'OLD', name: 'Bite Block', unitAmountCents: 4500, taxCode: 'GST_FREE', archivedAt: '2026-01-01' },
];

test('names agree word by word, and a short word starts a long one', () => {
  assert.equal(nameScore('Bite Block', 'bite-block'), 1);
  assert.equal(nameScore('Chrome Framework', 'Cast Chrome Frame'), 0.8);
  assert.equal(nameScore('Bleaching Tray', 'Bleach Tray'), 1);
  assert.equal(nameScore('Splint', 'Bite Block'), 0);
  assert.equal(nameScore('', 'Bite Block'), 0);
});

test('the likely code comes first; sure needs name, price and tax to agree', () => {
  const [best, next] = rankCodes({ id: 'p-1', code: '2106', name: 'Bite Block', unitAmountCents: 4500, taxCode: 'GST_FREE' }, codes);
  assert.equal(best.item.code, 'BB');
  assert.deepEqual([best.name, best.price, best.tax, best.sure], ['same', 'same', 'same', true]);
  assert.equal(next.item.code, 'BBR');
  assert.equal(next.price, 'differs');
  const tray = rankCodes({ id: 'p-2', name: 'Bleaching Tray', unitAmountCents: 8000, taxCode: 'GST_FREE' }, codes)[0];
  assert.equal(tray.item.code, 'BLT');
  assert.equal(tray.tax, 'differs');
  assert.equal(tray.sure, false);
  assert.deepEqual(rankCodes({ id: 'p-3', name: 'Splint', unitAmountCents: 100 }, codes), []);
  assert.ok(rankCodes({ id: 'p-1', name: 'Bite Block' }, codes).every((c) => c.item.code !== 'OLD'));
});

test('a record with the same code as a Flow code is that code', () => {
  const [best] = rankCodes({ id: 'x-1', code: 'cc', name: 'Something else', unitAmountCents: 39000, taxCode: 'GST_FREE' }, codes);
  assert.equal(best.item.code, 'CC');
  assert.equal(best.sure, true);
});

test('two codes that fit as well are not sure', () => {
  const twins = [codes[0], { ...codes[0], id: 'i-bb2', code: 'BB2' }];
  assert.equal(rankCodes({ id: 'p-1', name: 'Bite Block', unitAmountCents: 4500, taxCode: 'GST_FREE' }, twins)[0].sure, false);
});

test('find a code holds every word', () => {
  assert.deepEqual(findCodes('bite rep', codes).map((c) => c.code), ['BBR']);
  assert.deepEqual(findCodes('', codes), []);
});

test('the rows to check: records with no code, then codes that differ', () => {
  const data = {
    systems: [{ id: 'accounts', name: 'Accounts', kind: 'accounting' }, { id: 'work', name: 'Work', kind: 'work' }],
    items: [
      { ...codes[0], findings: [], links: [] },
      { ...codes[3], findings: [{ system: 'work', kind: 'tax', externalId: 'p-9', flow: 'GST', other: 'GST_FREE' }],
        links: [{ id: 'l-1', system: 'work', externalId: 'p-9', record: { id: 'p-9', name: 'Bleaching Tray', unitAmountCents: 8000, taxCode: 'GST_FREE' } }] },
    ],
    unlinked: [{ system: 'work', records: [{ id: 'p-1', name: 'Bite Block', unitAmountCents: 4500, taxCode: 'GST_FREE' }] }, { system: 'gone', records: [{ id: 'z' }] }],
  };
  const rows = reconcileRows(data);
  assert.deepEqual(rows.map((r) => [r.kind, r.key, r.sure]), [['link', 'link:work:p-1', true], ['differs', 'differs:work:i-blt', false]]);
  assert.equal(rows[1].link.id, 'l-1');
  assert.equal(rows[1].record.name, 'Bleaching Tray');
});
