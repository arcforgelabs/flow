import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { createDraftInvoice, getInvoice } from '../server/core/invoices.js';
import { invoiceViews, markNotReady } from '../server/core/sending.js';
import {
  autoDraftJobs, effectiveSettings, INVOICING_DEFAULTS, readCustomerBilling, readInvoicingSettings, ruleBlockers,
  saveCustomerBilling, saveInvoicingSettings, sendModeSummary,
} from '../server/core/invoicing-rules.js';
import { starterRules } from '../server/core/invoice-rules.js';
import { listAutomations, runAutomations, saveAutomation, statusMatches, workStatuses } from '../server/core/automations.js';
import { explainObligation, observeJob, recordAccountingEvidence, setReady } from '../server/core/ledger.js';
import { billingObligations, invoices } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// The invoicing rules decide when Flow drafts a ready job's invoice by itself,
// and the automations mark jobs ready and run the drafts. The accounting
// system is a fake that answers from a synthetic copy.

const NOW = new Date('2026-10-19T02:00:00.000Z');
const settings = { ...INVOICING_DEFAULTS, billable: true, defaultPractitioner: null };
const job = (overrides = {}) => ({
  readyAt: NOW, totalCents: 22000, practitioner: null, jobDate: '2026-10-10',
  lines: [{ itemCode: 'CROWN', lineAmountCents: 20000 }], ...overrides,
});

describe('the rules for one job', () => {
  test('a ready status is one of the chosen statuses, in any case', () => {
    assert.equal(statusMatches('Shipped', ['shipped']), true);
    assert.equal(statusMatches(' SHIPPED ', ['shipped']), true);
    assert.equal(statusMatches('Order shipped', ['shipped']), false);
    assert.equal(statusMatches('Complete', ['shipped', 'delivered']), false);
    assert.equal(statusMatches('Complete and  await return', ['complete and await return']), true);
    assert.equal(statusMatches(null, ['shipped']), false);
  });

  // The lab's checks are invoice rules (invoice-rules.js); these are the
  // starter rules made from the earlier fixed settings.
  const rules = (overrides = {}) => starterRules({ ...INVOICING_DEFAULTS, ...overrides });

  test('a ready job with a total passes; each rule it matches gives a reason', () => {
    const check = (o, effective = settings) => ruleBlockers(o, effective, { now: NOW, rules: rules() });
    assert.deepEqual(check(job()), []);
    assert.deepEqual(check(job({ readyAt: null })), ['the job is not marked ready to invoice']);
    assert.deepEqual(check(job({ totalCents: 0 })), ['rule "No amount": waits for a person']);
    assert.deepEqual(check(job(), { ...settings, billable: false }), ['rule "Customer not billable": not drafted by rule']);
    assert.deepEqual(check(job({ jobDate: '2026-06-01' })), ['rule "Old job": waits for a person']);
    // With no rules, only Flow's ready stage counts.
    assert.deepEqual(ruleBlockers(job({ totalCents: 0 }), settings, { now: NOW }), []);
  });

  test('a practitioner, when required, is the job\'s own or the customer\'s default', () => {
    const strict = rules({ requirePractitioner: true });
    const reason = ['rule "Practitioner required": waits for a person'];
    assert.deepEqual(ruleBlockers(job(), settings, { now: NOW, rules: strict }), reason);
    assert.deepEqual(ruleBlockers(job({ practitioner: 'Dr Example' }), settings, { now: NOW, rules: strict }), []);
    assert.deepEqual(ruleBlockers(job(), { ...settings, defaultPractitioner: 'Dr Default' }, { now: NOW, rules: strict }), []);
    // Off in the starter set until the lab turns it on.
    assert.deepEqual(ruleBlockers(job(), settings, { now: NOW, rules: rules() }), []);
  });

  test('a rush line must be the set share of the other lines, to the cent', () => {
    const rush = rules({ rushItemCode: 'RUSH', rushPercent: 20 });
    const lines = (cents) => [{ itemCode: 'CROWN', lineAmountCents: 20000 }, { itemCode: 'rush', lineAmountCents: cents }];
    assert.deepEqual(ruleBlockers(job({ lines: lines(4000) }), settings, { now: NOW, rules: rush }), []);
    assert.deepEqual(ruleBlockers(job({ lines: lines(4001) }), settings, { now: NOW, rules: rush }), []);
    assert.deepEqual(ruleBlockers(job({ lines: lines(5000) }), settings, { now: NOW, rules: rush }), ['rule "Rush charge share": waits for a person']);
    assert.deepEqual(ruleBlockers(job({ lines: lines(5000) }), settings, { now: NOW, rules: rules() }), []);
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

  // A job the matcher found no invoice for, after the copy last changed. It is
  // marked ready unless the test says not.
  async function cleared({ contact = practice, status = 'Shipped', invoiceRef = null, ready = true } = {}) {
    const row = await observeJob(handle.db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, sourceInvoiceRef: invoiceRef, caseRef: `CASE-${counter}`,
      contactId: contact.id, sourceStatus: status, jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
    });
    if (ready) await setReady(handle.db, lab.id, row.id, { actor: 'person:test' });
    await recordAccountingEvidence(handle.db, lab.id, row.id, { state: 'not_found', actor: 'test', checkedAt: NOW });
    return row;
  }
  const reload = async (row) => (await handle.db.select().from(billingObligations).where(eq(billingObligations.id, row.id)))[0];

  test('settings start at the defaults, change with checks, and a customer can override them', async () => {
    assert.deepEqual(await readInvoicingSettings(handle.db, lab.id), INVOICING_DEFAULTS);
    const saved = await saveInvoicingSettings(handle.db, lab.id, { paymentTermsDays: 14 });
    assert.equal(saved.paymentTermsDays, 14);
    await assert.rejects(saveInvoicingSettings(handle.db, lab.id, { readyStatuses: ['shipped'] }), /unknown setting/);
    await assert.rejects(saveInvoicingSettings(handle.db, lab.id, { sendMode: 'fax' }), /sendMode must be one of/);
    await assert.rejects(saveInvoicingSettings(handle.db, lab.id, { staleDays: 0 }), /staleDays/);
    await assert.rejects(saveInvoicingSettings(handle.db, lab.id, { colour: 'red' }), /unknown setting/);
    assert.deepEqual(await readCustomerBilling(handle.db, lab.id, quiet.id),
      { billable: true, defaultPractitioner: null, autoDraft: null, sendMode: null, paymentTermsDays: null });
    const own = await saveCustomerBilling(handle.db, lab.id, quiet.id, { billable: false });
    assert.equal(own.billable, false);

    // The Invoices page says how invoices go out, and how many customers differ.
    assert.deepEqual(await sendModeSummary(handle.db, lab.id), { mode: 'accounting_draft', otherCustomers: 0 });
    await saveCustomerBilling(handle.db, lab.id, quiet.id, { sendMode: 'approve_and_email' });
    assert.deepEqual(await sendModeSummary(handle.db, lab.id), { mode: 'accounting_draft', otherCustomers: 1 });
    await saveCustomerBilling(handle.db, lab.id, quiet.id, { sendMode: 'accounting_draft' });
    assert.deepEqual(await sendModeSummary(handle.db, lab.id), { mode: 'accounting_draft', otherCustomers: 0 });
    await saveCustomerBilling(handle.db, lab.id, quiet.id, { sendMode: null });
  });

  test('a cleared, ready job gets a draft in Flow with the customer\'s terms; the rest wait', async () => {
    copy = { state: { complete: true, fresh: true, changedAt: new Date(NOW.getTime() - 60_000) }, invoices: [] };
    const ready = await cleared();
    const notShipped = await cleared({ ready: false });
    const notBillable = await cleared({ contact: quiet });
    const result = await autoDraftJobs(handle.db, lab.id, { accounting, now: NOW });
    assert.deepEqual(result, { drafted: 1, waiting: 1, off: 0, refused: 0, readFirst: 0 });
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

  test('a customer with drafts off gets none', async () => {
    const other = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Manual Clinic' });
    await saveCustomerBilling(handle.db, lab.id, other.id, { autoDraft: false });
    const row = await cleared({ contact: other });
    const result = await autoDraftJobs(handle.db, lab.id, { accounting, now: NOW });
    assert.equal(result.off, 1);
    assert.equal((await reload(row)).invoiceId, null);
  });

  test('with no accounting system, a ready job nobody checked drafts from Flow\'s own records', async () => {
    const row = await observeJob(handle.db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`,
      contactId: practice.id, sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
    });
    await setReady(handle.db, lab.id, row.id, { actor: 'person:test' });
    assert.equal((await explainObligation(handle.db, lab.id, row.id, { now: NOW, accounting: false })).view, 'ready');
    assert.equal((await autoDraftJobs(handle.db, lab.id, { accounting, now: NOW })).drafted, 0);
    assert.ok((await autoDraftJobs(handle.db, lab.id, { now: NOW })).drafted >= 1);
    assert.ok((await reload(row)).invoiceId);
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

  test('the accounting system reads its changes once before the first draft; a failed read drafts nothing', async () => {
    copy = { state: { complete: true, fresh: true, changedAt: new Date(NOW.getTime() - 60_000) }, invoices: [] };
    let reads = 0;
    let answer = { state: 'unavailable', reason: 'Xero calls are stopped' };
    let meanwhile = async () => {};
    const reading = { ...accounting, capabilities: { ...accounting.capabilities, readChanges: async () => { reads += 1; await meanwhile(); return answer; } } };

    const first = await cleared();
    const second = await cleared();
    let result = await autoDraftJobs(handle.db, lab.id, { accounting: reading, now: NOW });
    assert.equal(reads, 1, 'one read for the pass');
    assert.equal(result.accountingRead, 'waiting');
    assert.equal(result.drafted, 0);
    assert.equal((await reload(first)).invoiceId, null);

    // Someone invoiced the first job in the accounting system meanwhile: the
    // read finds it, so only the second job is drafted.
    reads = 0;
    answer = { state: 'read', changed: 0 };
    meanwhile = async () => handle.db.update(billingObligations).set({ accountingState: 'authorised' }).where(eq(billingObligations.id, first.id));
    result = await autoDraftJobs(handle.db, lab.id, { accounting: reading, now: NOW });
    assert.equal(reads, 1);
    assert.equal(result.accountingRead, 'read');
    assert.equal((await reload(first)).invoiceId, null);
    assert.ok((await reload(second)).invoiceId);

    // A read that changed the copy runs the matcher before the draft.
    meanwhile = async () => {};
    answer = { state: 'read', changed: 1 };
    copy.state.changedAt = new Date(NOW.getTime() + 1000);
    const third = await cleared();
    const later = new Date(NOW.getTime() + 5000);
    await autoDraftJobs(handle.db, lab.id, { accounting: reading, now: later });
    const after = await reload(third);
    assert.equal(after.accountingCheckedAt.getTime(), later.getTime(), 'the matcher checked the job again');
    assert.ok(after.invoiceId);
    copy.state.changedAt = new Date(NOW.getTime() - 60_000);
  });

  test('the automations mark jobs ready from their status, then draft them; each is on or off', async () => {
    copy = { state: { complete: true, fresh: true, changedAt: new Date(NOW.getTime() - 60_000) }, invoices: [] };
    const list = await listAutomations(handle.db, lab.id);
    assert.deepEqual(list.map((a) => [a.key, a.place, a.enabled]), [
      ['map_lines', 'seazona', true], ['mark_ready_from_work_status', 'seazona', true], ['draft_when_ready', 'invoicing', true],
      ['ready_when_drafted', 'invoicing', true], ['reference_from_rule', 'invoicing', true]]);
    await assert.rejects(saveAutomation(handle.db, lab.id, 'mark_ready_from_work_status', { config: { statuses: [] } }), /statuses/);
    await assert.rejects(saveAutomation(handle.db, lab.id, 'mark_ready_from_work_status', { enabled: 'yes' }), /true or false/);
    await assert.rejects(saveAutomation(handle.db, lab.id, 'nothing', { enabled: true }), { code: 'not_found' });

    const shipped = await cleared({ ready: false });
    const inLab = await cleared({ status: 'In production', ready: false });
    // The menu lists each status the work system reported, most jobs first.
    const statuses = await workStatuses(handle.db, lab.id);
    assert.equal(statuses[0].label, 'Shipped');
    assert.deepEqual(statuses.find((s) => s.value === 'in production'), { value: 'in production', label: 'In production', jobs: 1 });
    const keptBack = await cleared({ ready: false });
    // A person put this one back in work: the routine leaves it to people.
    await setReady(handle.db, lab.id, keptBack.id, { actor: 'person:test' });
    await setReady(handle.db, lab.id, keptBack.id, { ready: false, actor: 'person:test' });

    await saveAutomation(handle.db, lab.id, 'draft_when_ready', { enabled: false });
    const first = await runAutomations(handle.db, lab.id, { accounting, now: NOW });
    // This job, and the shipped job an earlier test left in work.
    assert.deepEqual(first, { mark_ready_from_work_status: { marked: 2 }, ready_when_drafted: { marked: 0 }, reference_from_rule: { updated: 0 } });
    const marked = await explainObligation(handle.db, lab.id, shipped.id, { now: NOW });
    assert.equal(marked.view, 'ready');
    assert.equal(marked.events.find((e) => e.kind === 'ready').actor, 'automation:mark_ready_from_work_status');
    assert.equal((await reload(inLab)).readyAt, null);
    assert.equal((await reload(keptBack)).readyAt, null);

    await saveAutomation(handle.db, lab.id, 'draft_when_ready', { enabled: true });
    const second = await runAutomations(handle.db, lab.id, { accounting, now: NOW });
    assert.ok(second.draft_when_ready.drafted >= 1);
    assert.ok((await reload(shipped)).invoiceId);
    assert.equal((await reload(keptBack)).invoiceId, null);

    // The routine's drafts go straight to Ready, with no person's name on them.
    const invoiceOf = async (job) => (await handle.db.select().from(invoices).where(eq(invoices.id, (await reload(job)).invoiceId)))[0];
    assert.equal(second.ready_when_drafted.marked, second.draft_when_ready.drafted);
    const auto = await invoiceOf(shipped);
    assert.ok(auto.readyAt);
    assert.equal(auto.readyBy, null);
    assert.deepEqual((await invoiceViews(handle.db, lab.id)).ready.includes(auto.id), true);
    // A person moved it back to Drafts: the routine leaves it there.
    await markNotReady(handle.db, lab.id, [auto.id]);
    assert.deepEqual((await runAutomations(handle.db, lab.id, { accounting, now: NOW })).ready_when_drafted, { marked: 0 });
    assert.equal((await invoiceOf(shipped)).readyAt, null);
    // A person's own draft is never marked by the routine.
    const own = await createDraftInvoice(handle.db, lab.id, { contactId: auto.contactId, lines: [] });
    await runAutomations(handle.db, lab.id, { accounting, now: NOW });
    assert.equal((await handle.db.select().from(invoices).where(eq(invoices.id, own.id)))[0].readyAt, null);

    // With no accounting system connected, the draft routine still drafts:
    // Flow's own records are the check.
    const saved = await saveAutomation(handle.db, lab.id, 'mark_ready_from_work_status', { config: { statuses: ['In production'] } });
    assert.deepEqual(saved.config.statuses, ['in production']);
    const local = await runAutomations(handle.db, lab.id, { now: NOW });
    assert.deepEqual(local.mark_ready_from_work_status, { marked: 1 });
    assert.ok((await reload(inLab)).readyAt);
    assert.ok((await reload(inLab)).invoiceId);
    assert.equal(local.ready_when_drafted.marked, 1);

    // Off: a new draft stays in Drafts.
    await saveAutomation(handle.db, lab.id, 'ready_when_drafted', { enabled: false });
    const later = await cleared();
    const off = await runAutomations(handle.db, lab.id, { now: NOW });
    assert.equal(off.ready_when_drafted, undefined);
    assert.equal((await invoiceOf(later)).readyAt, null);
  });
});
