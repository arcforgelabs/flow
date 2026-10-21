import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftNote, sendModeNote } from '../server/ui/invoice-notes.js';

// The notes on the Invoices page and one invoice (server/ui/invoicing.js).
// One fact per sentence; they follow the accounting system's settings.

const on = { connected: true, writesAllowed: true };

test('the Ready note follows the send mode', () => {
  assert.equal(sendModeNote('Xero', { ...on, mode: 'accounting_draft' }), 'Flow sends each invoice to Xero as a draft. You approve and send it in Xero.');
  assert.equal(sendModeNote('Xero', { ...on, mode: 'approve_and_email', otherCustomers: 2 }),
    'Flow sends each invoice to Xero as approved. Xero emails it to the customer at once. 2 customers have a different setting.');
  assert.equal(sendModeNote('Xero', { connected: false }), 'Xero is not connected. Connect it in Integrations before you send.');
  assert.equal(sendModeNote(null, null), 'No accounting system is on. Flow keeps each invoice here only.');
});

test('one invoice warns only when Send cannot work', () => {
  const ready = { sendMode: { ...on, mode: 'accounting_draft' } };
  assert.equal(draftNote('Xero', ready), null, 'the Send dialog says what Send does');
  assert.equal(draftNote(null, {}), null, 'no accounting system: nothing to warn about');
  assert.equal(draftNote('Xero', { sendMode: { connected: false } }), 'Xero is not connected. Connect it in Integrations before you send.');
  assert.equal(draftNote('Xero', { sendMode: { connected: true, writesAllowed: false } }), 'Xero does not take invoices from Flow yet. Turn this on in Integrations, Xero.');
});
