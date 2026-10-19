import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { getInvoice } from '../server/core/invoices.js';
import {
  autoDraftJobs, effectiveSettings, INVOICING_DEFAULTS, readCustomerBilling, readInvoicingSettings, ruleBlockers,
  saveCustomerBilling, saveInvoicingSettings, statusIsReady,
} from '../server/core/invoicing-rules.js';
import { observeJob, recordAccountingEvidence } from '../server/core/ledger.js';
import { billingObligations } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// The invoicing rules decide when Flow drafts a job's invoice by itself. The
// accounting system is a fake that answers from a synthetic copy.

const NOW = new Date('2026-10-19T02:00:00.000Z');
const settings = { ...INVOICING_DEFAULTS, billable: true, defaultPractitioner: null };
const job = (overrides = {}) => ({
  sourceStatus: 'Shipped', totalCents: 22000, practitioner: null, jobDate: '2026-10-10',
  lines: [{ itemCode: 'CROWN', lineAmountCents: 20000 }], ...overrides,
});

describe('the rules for one job', () => {
  test('a ready status is one of the lab\'s statuses, as whole words in any case', () => {
    assert.equal(statusIsReady('Shipped', ['shipped']), true);
    assert.equal(statusIsReady('Order SHIPPED', ['shipped']), true);
    assert.equal(statusIsReady('Complete', ['shipped', 'delivered']), false);
    assert.equal(statusIsReady('Complete and await return', ['complete and await return']), true);
    assert.equal(statusIsReady('Unshipped', ['shipped']), false);
  });

  test('a shipped job with a total passes; each rule it fails gives a reason', () => {
    assert.deepEqual(ruleBlockers(job(), settings, { now: NOW }), []);
    assert.deepEqual(ruleBlockers(job({ sourceStatus: 'Complete' }), settings, { now: NOW }),
      ['the job\'s status "Complete" is not one of shipped, delivered']);
    assert.deepEqual(ruleBlockers(job({ sourceStatus: null }), settings, { now: NOW }),
      ['the work system has not reported the job\'s status yet']);
    assert.deepEqual(ruleBlockers(job({ totalCents: 0 }), settings, { now: NOW }), ['the job\'s total is zero or less']);
    assert.deepEqual(ruleBlockers(job(), { ...settings, billable: false }, { now: NOW }), ['the customer is not billable']);
    assert.deepEqual(ruleBlockers(job({ jobDate: '2026-06-01' }), settings, { now: NOW }), ['the job is more than 90 days old']);
  });

  test('a practitioner, when required, is the job\'s own or the customer\'s default', () => {
    const strict = { ...settings, requirePractitioner: true };
    assert.deepEqual(ruleBlockers(job(), strict, { now: NOW }), ['the job names no practitioner, and the customer has no default one']);
    assert.deepEqual(ruleBlockers(job({ practitioner: 'Dr Example' }), strict, { now: NOW }), []);
    assert.deepEqual(ruleBlockers(job(), { ...strict, defaultPractitioner: 'Dr Default' }, { now: NOW }), []);
  });

  test('a rush line must be the set share of the other lines, to the cent', () => {
    const rush = { ...settings, rushItemCode: 'RUSH', rushPercent: 20 };
    const lines = (cents) => [{ itemCode: 'CROWN', lineAmountCents: 20000 }, { itemCode: 'rush', lineAmountCents: cents }];
    assert.deepEqual(ruleBlockers(job({ lines: lines(4000) }), rush, { now: NOW }), []);
    assert.deepEqual(ruleBlockers(job({ lines: lines(5000) }), rush, { now: NOW }),
      ['the rush charge is 50.00, not 20% of the other lines (40.00)']);
    assert.deepEqual(ruleBlockers(job({ lines: lines(5000) }), settings, { now: NOW }), []);
  });

  test('a customer\'s own setting wins; a null takes the organisation\'s', () => {
    const own = effectiveSettings(INVOICING_DEFAULTS, { billable: false, sendMode: 'approve_and_email', autoDraft: null, paymentTermsDays: 7 });
    assert.equal(own.billable, false);
    assert.equal(own.sendMode, 'approve_and_email');
    assert.equal(own.autoDraft, true);
    assert.equal(own.paymentTermsDays, 7);
    assert.equal(effectiveSettings(INVOICING_DEFAULTS).sendMode, 'accounting_draft');
  });
});

describe('drafts by rule', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let practice;
  let quiet;
  let copy;
  let counter = 0;

  // The accounting system's copy: complete and fresh unless a test says not.
  const accounting = {
    id: 'accounts',
    capabilities: {
      findInvoices: async ({ numbers = [] }) => ({
        ...copy.state,
        invoices: copy.invoices.filter((i) => numbers.includes(i.number)),
      }),
    },
  };

  before(async () => {
    handle = await freshDatabase();
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice' });
    quiet = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Internal Group' });
    await createPriceItem(handle.db, lab.id, { code: 'CROWN', name: 'Crown', unitAmountCents: 20000 });
  });
  after(async () => handle?.close());

  // A job the matcher found no invoice for, after the copy last changed.
  async function cleared({ contact = practice, status = 'Shipped', invoiceRef = null } = {}) {
    const row = await observeJob(handle.db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, sourceInvoiceRef: invoiceRef, caseRef: `CASE-${counter}`,
      contactId: contact.id, sourceStatus: status, jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
    });
    await recordAccountingEvidence(handle.db, lab.id, row.id, { state: 'not_found', actor: 'test', checkedAt: NOW });
    return row;
  }
  const reload = async (row) => (await handle.db.select().from(billingObligations).where(eq(billingObligations.id, row.id)))[0];

  test('settings start at the defaults, change with checks, and a customer can override them', async () => {
    assert.deepEqual(await readInvoicingSettings(handle.db, lab.id), INVOICING_DEFAULTS);
    const saved = await saveInvoicingSettings(handle.db, lab.id, { paymentTermsDays: 14, readyStatuses: ['Shipped', ' delivered '] });
    assert.equal(saved.paymentTermsDays, 14);
    assert.deepEqual(saved.readyStatuses, ['shipped', 'delivered']);
    await assert.rejects(saveInvoicingSettings(handle.db, lab.id, { sendMode: 'fax' }), /sendMode must be one of/);
    await assert.rejects(saveInvoicingSettings(handle.db, lab.id, { staleDays: 0 }), /staleDays/);
    await assert.rejects(saveInvoicingSettings(handle.db, lab.id, { colour: 'red' }), /unknown setting/);
    assert.deepEqual(await readCustomerBilling(handle.db, lab.id, quiet.id),
      { billable: true, defaultPractitioner: null, autoDraft: null, sendMode: null, paymentTermsDays: null });
    const own = await saveCustomerBilling(handle.db, lab.id, quiet.id, { billable: false });
    assert.equal(own.billable, false);
  });

  test('a cleared, shipped job gets a draft in Flow with the customer\'s terms; the rest wait', async () => {
    copy = { state: { complete: true, fresh: true, changedAt: new Date(NOW.getTime() - 60_000) }, invoices: [] };
    const ready = await cleared();
    const notShipped = await cleared({ status: 'Complete' });
    const notBillable = await cleared({ contact: quiet });
    const result = await autoDraftJobs(handle.db, lab.id, { accounting, now: NOW });
    assert.deepEqual(result, { drafted: 1, waiting: 2, off: 0, refused: 0 });
    const drafted = await reload(ready);
    const invoice = await getInvoice(handle.db, lab.id, drafted.invoiceId);
    assert.equal(invoice.status, 'draft');
    assert.equal(invoice.contactId, practice.id);
    assert.equal(invoice.totalCents, 22000);
    assert.equal(String(invoice.dueDate).slice(0, 10), '2026-11-02');
    assert.equal((await reload(notShipped)).invoiceId, null);
    assert.equal((await reload(notBillable)).invoiceId, null);
    // A second run drafts nothing twice.
    assert.equal((await autoDraftJobs(handle.db, lab.id, { accounting, now: NOW })).drafted, 0);
  });

  test('a customer with drafts off, or an organisation with them off, gets none', async () => {
    const other = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Manual Clinic' });
    await saveCustomerBilling(handle.db, lab.id, other.id, { autoDraft: false });
    const row = await cleared({ contact: other });
    const result = await autoDraftJobs(handle.db, lab.id, { accounting, now: NOW });
    assert.equal(result.off, 1);
    assert.equal((await reload(row)).invoiceId, null);
    await saveInvoicingSettings(handle.db, lab.id, { autoDraft: false });
    assert.equal((await autoDraftJobs(handle.db, lab.id, { accounting, now: NOW })).skipped, 'automatic drafts are off');
    await saveInvoicingSettings(handle.db, lab.id, { autoDraft: true });
  });

  test('a copy that is not fresh drafts nothing; a copy invoice with the job\'s number refuses the draft', async () => {
    const row = await cleared({ invoiceRef: 'SZ-77' });
    copy = { state: { complete: true, fresh: false, changedAt: null }, invoices: [] };
    assert.equal((await autoDraftJobs(handle.db, lab.id, { accounting, now: NOW })).skipped, 'the accounting copy is not complete or not fresh');
    copy = {
      state: { complete: true, fresh: true, changedAt: new Date(NOW.getTime() - 60_000) },
      invoices: [{ id: 'x-77', number: 'SZ-77', state: 'authorised' }],
    };
    const result = await autoDraftJobs(handle.db, lab.id, { accounting, now: NOW });
    assert.equal(result.refused, 1);
    assert.equal((await reload(row)).invoiceId, null);
  });
});
