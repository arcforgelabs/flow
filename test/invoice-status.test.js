import assert from 'node:assert/strict';
import test from 'node:test';

import { emailedStage, INVOICE_TABS, invoiceTab, OLD_TABS } from '../server/core/invoice-status.js';

test('one rule puts each invoice on one tab; the first that fits wins', () => {
  const tab = (status, extra = {}) => invoiceTab({ status, connected: true, ...extra });
  // Void wins over every view and stage.
  assert.equal(tab('void', { view: 'problem', stage: 'paid' }), 'void');
  // No charge wins over a problem: it is never sent.
  assert.equal(tab('draft', { view: 'non_chargeable' }), 'non_chargeable');
  assert.equal(tab('draft', { view: 'problem' }), 'pending');
  assert.equal(tab('issued', { view: 'problem', stage: 'approved' }), 'pending');
  assert.equal(tab('draft'), 'ready');
  // On its way to the accounting system: Draft, whatever the old stage said.
  assert.equal(tab('issued', { view: 'sending', stage: 'paid' }), 'draft');
  assert.deepEqual(
    [null, 'draft', 'pending', 'approved', 'sent', 'paid', 'void'].map((stage) => tab('issued', { stage })),
    ['draft', 'draft', 'pending', 'awaiting_payment', 'awaiting_payment', 'paid', 'void'],
  );
});

test('with no accounting system an issued invoice awaits payment', () => {
  assert.equal(invoiceTab({ status: 'issued', stage: 'paid' }), 'awaiting_payment');
  assert.equal(invoiceTab({ status: 'draft' }), 'ready');
});

test('every old tab name reads as a tab of today', () => {
  for (const tab of Object.values(OLD_TABS)) assert.ok(INVOICE_TABS.includes(tab), tab);
  assert.equal(OLD_TABS.sent, 'awaiting_payment');
  assert.deepEqual(['sent', 'approved', 'paid', null].map(emailedStage), [true, false, false, false]);
});
