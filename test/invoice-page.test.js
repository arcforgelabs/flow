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

test('one invoice says what Send does with it', () => {
  const ready = { sendMode: { ...on, mode: 'accounting_draft' } };
  assert.equal(draftNote('Xero', ready, true), 'Flow sends this invoice to Xero as a draft. You approve and send it in Xero.');
  assert.equal(draftNote('Xero', ready, false), 'Finalise it, then send it to Xero.');
  assert.equal(draftNote(null, {}, true), 'A person checked it. A saved change keeps it ready.');
  assert.equal(draftNote(null, {}, false), 'Flow gives it a number when you issue it.');
});
