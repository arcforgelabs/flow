import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, getInvoice } from '../server/core/invoices.js';
import { autoDraftJobs, saveInvoicingSettings } from '../server/core/invoicing-rules.js';
import { observeJob, recordAccountingEvidence, setReady } from '../server/core/ledger.js';
import { checkReferenceTemplate, refreshReferences, renderReference } from '../server/core/references.js';
import { billingObligations, invoices } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// The invoice Reference comes from the lab's rule (server/core/references.js),
// never from a work system id. Synthetic names only.

describe('the Reference rule', () => {
  test('tokens take the job\'s fields; a missing one drops out with its spacer', () => {
    const rule = '{practitioner} - {patient}';
    assert.equal(renderReference(rule, { practitioner: 'Dr Example', patient: 'Pat Sample' }), 'Dr Example - Pat Sample');
    assert.equal(renderReference(rule, { practitioner: 'Dr Example', patient: null }), 'Dr Example');
    assert.equal(renderReference(rule, { practitioner: null, patient: 'Pat Sample' }), 'Pat Sample');
    assert.equal(renderReference(rule, {}), null);
    assert.equal(renderReference('', { practitioner: 'Dr Example' }), null);
    assert.equal(renderReference('Job for {patient}.', { patient: 'Pat  Sample' }), 'Job for Pat Sample.');
    assert.equal(checkReferenceTemplate(rule), null);
    assert.match(checkReferenceTemplate('{doctor}'), /unknown token \{doctor\}/);
  });
});

describe('References on drafts', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let practice;
  let counter = 0;
  const NOW = new Date('2026-10-19T02:00:00.000Z');
  const patients = new Map();
  const asked = [];
  // A fake work system that keeps patient names; `read` stands for a call.
  const work = {
    id: 'seazona',
    capabilities: {
      async jobReferenceFields({ sourceJobRef, read }) {
        if (patients.has(sourceJobRef)) return { patient: patients.get(sourceJobRef) };
        if (!read) return { patient: null };
        asked.push(sourceJobRef);
        return { patient: null, asked: true };
      },
    },
  };

  before(async () => {
    handle = await freshDatabase();
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(handle.db, lab.id, { code: 'CROWN', name: 'Crown', unitAmountCents: 20000 });
  });
  after(async () => handle?.close());

  async function job({ practitioner = 'Dr Example' } = {}) {
    const ref = `job-${++counter}`;
    const row = await observeJob(handle.db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: ref, caseRef: ref, practitioner,
      contactId: practice.id, sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
    });
    await setReady(handle.db, lab.id, row.id, { actor: 'person:test' });
    await recordAccountingEvidence(handle.db, lab.id, row.id, { state: 'not_found', actor: 'test', checkedAt: NOW });
    return row;
  }
  const invoiceOf = async (row) => {
    const [o] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, row.id));
    return getInvoice(handle.db, lab.id, o.invoiceId);
  };

  test('an automatic draft gets the rule\'s Reference, never the job\'s id', async () => {
    const one = await job();
    patients.set(one.sourceJobRef, 'Pat Sample');
    const two = await job();
    await autoDraftJobs(handle.db, lab.id, { work, now: NOW });
    assert.equal((await invoiceOf(one)).reference, 'Dr Example - Pat Sample');
    // No patient name yet: the practitioner alone.
    assert.equal((await invoiceOf(two)).reference, 'Dr Example');
  });

  test('the refresh fixes drafts Flow wrote, keeps a typed Reference and the status, and caps calls', async () => {
    const { referenceTemplate: template } = { referenceTemplate: '{practitioner} - {patient}' };
    const old = await job();
    const typed = await job();
    const later = await job();
    await autoDraftJobs(handle.db, lab.id, { work, now: NOW });
    // As an earlier release wrote it: the work system's id.
    const oldInvoice = await invoiceOf(old);
    await handle.db.update(invoices).set({ reference: old.sourceJobRef, readyAt: NOW }).where(eq(invoices.id, oldInvoice.id));
    const typedInvoice = await invoiceOf(typed);
    await handle.db.update(invoices).set({ reference: 'PO 778' }).where(eq(invoices.id, typedInvoice.id));
    patients.set(old.sourceJobRef, 'Pat Old');
    patients.set(typed.sourceJobRef, 'Pat Typed');
    patients.set(later.sourceJobRef, 'Pat Later');

    const result = await refreshReferences(handle.db, lab.id, { template, work, reads: 1 });
    assert.ok(result.updated >= 2);
    assert.equal((await invoiceOf(old)).reference, 'Dr Example - Pat Old');
    assert.notEqual((await invoiceOf(old)).readyAt, null);
    assert.equal((await invoiceOf(typed)).reference, 'PO 778');
    assert.equal((await invoiceOf(later)).reference, 'Dr Example - Pat Later');
    // Jobs with no name yet ask the work system once each pass, up to the cap.
    assert.ok(asked.length <= 1);

    // A draft not made from a job is never touched.
    const own = await createDraftInvoice(handle.db, lab.id, { contactId: practice.id, reference: null, lines: [] });
    await refreshReferences(handle.db, lab.id, { template, work });
    assert.equal((await getInvoice(handle.db, lab.id, own.id)).reference, null);
  });

  test('the rule is a setting; an unknown token is refused', async () => {
    await assert.rejects(saveInvoicingSettings(handle.db, lab.id, { referenceTemplate: '{doctor} - {patient}' }), /unknown token/);
    const saved = await saveInvoicingSettings(handle.db, lab.id, { referenceTemplate: '{patient}' });
    assert.equal(saved.referenceTemplate, '{patient}');
  });
});
