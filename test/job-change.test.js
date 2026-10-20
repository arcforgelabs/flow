import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { updateDraftInvoice } from '../server/core/invoices.js';
import {
  diffJobLines, draftInvoiceForObligation, jobChangeFor, observeJob, recordAccountingEvidence, useSourceLines,
} from '../server/core/ledger.js';
import { orderLink, orderUrlTemplate } from '../server/integrations/seazona/settings.js';
import { changeRows, changeSummary } from '../server/ui/job-change.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// The "job changed" problem on an invoice: was / now per changed fact, and
// "Open in Seazona" from a link the lab pastes. Synthetic data only.

const line = (itemCode, quantity, unitAmountCents, description = itemCode) => ({ itemCode, description, quantity, unitAmountCents, taxCode: 'GST' });
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

describe('was and now, line by line', () => {
  test('a changed quantity and price on the same item', () => {
    const changes = diffJobLines([line('CRN', 1, 100)], [line('CRN', 2, 150)]);
    assert.deepEqual(changes.map((c) => [c.change, c.position, c.fields]), [['changed', 1, ['quantity', 'price']]]);
  });

  test('a new item in the place of an old one is one replaced line', () => {
    const changes = diffJobLines([line('A', 1, 100), line('B', 1, 50)], [line('Z', 1, 120), line('B', 1, 50)]);
    assert.deepEqual(changes.map((c) => [c.change, c.position, c.was.code, c.now.code]), [['replaced', 1, 'A', 'Z']]);
  });

  test('added and removed lines, and line order is no change', () => {
    assert.deepEqual(diffJobLines([line('A', 1, 1), line('B', 1, 1)], [line('B', 1, 1), line('A', 1, 1)]), []);
    const changes = diffJobLines([line('A', 1, 1)], [line('A', 1, 1), line('B', 2, 5)]);
    assert.deepEqual(changes.map((c) => [c.change, c.position]), [['added', 2]]);
    assert.deepEqual(diffJobLines([line('A', 1, 1), line('B', 1, 1)], [line('A', 1, 1)]).map((c) => [c.change, c.position]), [['removed', 2]]);
  });

  test('rows in plain words, with the total last', () => {
    const change = {
      systemName: 'Seazona',
      canAdopt: true,
      contact: null,
      lines: diffJobLines([line('T12', 1, 19500, 'Partial 1–2 teeth'), line('TEETH', 1, 2500)], [line('T34', 1, 24500, 'Partial 3–4 teeth'), line('TEETH', 2, 2500)]),
      total: { was: 22000, now: 29500 },
    };
    assert.deepEqual(changeRows(change, money).map((r) => [r.field, r.was, r.now]), [
      ['Line 1 · item', 'T12 · Partial 1–2 teeth', 'T34 · Partial 3–4 teeth'],
      ['Line 1 · price', '$195.00', '$245.00'],
      ['Line 2 · qty', '1', '2'],
      ['Total', '$220.00', '$295.00'],
    ]);
    assert.equal(changeSummary(change, 4), 'The job changed in Seazona after this invoice was made. 4 changes.');
    assert.match(changeSummary({ ...change, canAdopt: false, sent: true }, 1), /after this invoice was sent\. 1 change\./);
  });
});

describe('Open in Seazona', () => {
  const id = '3f9c2b10-1d2e-4a5b-8c7d-0e1f2a3b4c5d';

  test('the order id in a pasted address becomes {ref}', () => {
    assert.equal(orderUrlTemplate(`https://lab.seazona.net/Orders/View.aspx?id=${id}`), 'https://lab.seazona.net/Orders/View.aspx?id={ref}');
    assert.equal(orderUrlTemplate('https://lab.seazona.net/order/{ref}'), 'https://lab.seazona.net/order/{ref}');
    assert.equal(orderUrlTemplate('https://lab.seazona.net/home'), null, 'no order id: no pattern');
    assert.equal(orderUrlTemplate('http://lab.seazona.net/x/' + id), null, 'https only');
  });

  test('the link to one order, else the lab home page from the API address, else none', () => {
    const settings = { orderUrlTemplate: 'https://lab.seazona.net/o?id={ref}', baseUrl: 'https://lab.seazonaapi.net/v1' };
    assert.deepEqual(orderLink(settings, { sourceJobRef: id }), { url: `https://lab.seazona.net/o?id=${id}`, exact: true });
    assert.deepEqual(orderLink({ ...settings, orderUrlTemplate: null }, { sourceJobRef: id }), { url: 'https://lab.seazona.net/', exact: false });
    assert.equal(orderLink({ orderUrlTemplate: null, baseUrl: 'https://api.example.com/v1' }, { sourceJobRef: id }), null);
  });
});

describe('the job change on an invoice', { skip: skipWithoutDatabase }, () => {
  let handle;
  let db;
  let lab;
  let practice;
  let jobNumber = 0;
  const actor = 'user:test';

  before(async () => {
    handle = await freshDatabase();
    db = handle.db;
    lab = await createOrganisation(db, { name: 'Example Lab' });
    practice = await createContact(db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 22000 });
    await createPriceItem(db, lab.id, { code: 'BRG', name: 'Bridge', unitAmountCents: 50000 });
  });

  after(async () => handle?.close());

  const drafted = async () => {
    const report = { sourceSystem: 'worksystem', sourceJobRef: `JOB-${++jobNumber}`, contactId: practice.id, sourceStatus: 'Shipped', lines: [{ itemCode: 'CRN' }] };
    const obligation = await observeJob(db, lab.id, report);
    await recordAccountingEvidence(db, lab.id, obligation.id, { state: 'not_found', actor });
    const { invoice } = await draftInvoiceForObligation(db, lab.id, obligation.id, { actor, liveCheck: async () => ({ state: 'not_found' }) });
    return { report, obligation, invoice };
  };

  test('no change: nothing to show', async () => {
    const { invoice } = await drafted();
    assert.equal(await jobChangeFor(db, lab.id, invoice.id), null);
  });

  test('only the work system changed: was and now, and the change can be adopted', async () => {
    const { report, obligation, invoice } = await drafted();
    await observeJob(db, lab.id, { ...report, lines: [{ itemCode: 'CRN', quantity: 2 }] });
    const change = await jobChangeFor(db, lab.id, invoice.id);
    assert.equal(change.jobId, obligation.id);
    assert.equal(change.canAdopt, true);
    assert.deepEqual(change.lines.map((l) => [l.change, l.fields, l.was.quantity, l.now.quantity]), [['changed', ['quantity'], 1, 2]]);
    assert.deepEqual(change.total, { was: 24200, now: 48400 });
    const { invoice: adopted } = await useSourceLines(db, lab.id, obligation.id, { actor });
    assert.equal(await jobChangeFor(db, lab.id, invoice.id), null, 'adopted: the problem is gone');
    assert.ok(adopted.readyAt, 'the draft matches a job ready to invoice, so it goes to Ready');
  });

  test('both changed: shown, but not to adopt', async () => {
    const { report, invoice } = await drafted();
    await updateDraftInvoice(db, lab.id, invoice.id, { lines: [{ description: 'Crown, adjusted', quantity: 1, unitAmountCents: 20000, taxCode: 'GST' }] });
    await observeJob(db, lab.id, { ...report, lines: [{ itemCode: 'BRG' }] });
    const change = await jobChangeFor(db, lab.id, invoice.id);
    assert.equal(change.canAdopt, false);
    assert.deepEqual(change.lines.map((l) => [l.change, l.was.code, l.now.code]), [['replaced', 'CRN', 'BRG']]);
  });
});
