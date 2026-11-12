import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import {
  accountingItemsFor, addRuleItem, createRule, deleteRule, exceptDraft, exceptJob, FIELDS, listRuleExceptions, listRules, readRule, removeRuleException, ruleNonChargeable, rulePending, ruleReasons, ruleSkip, starterRules, TESTS, updateRule,
} from '../server/core/invoice-rules.js';
import { deleteDraft, getInvoice } from '../server/core/invoices.js';
import { autoDraftJobs, saveInvoicingSettings } from '../server/core/invoicing-rules.js';
import { describeObligations } from '../server/core/job-board.js';
import { draftInvoiceForObligation, explainObligation, observeJob, setReady } from '../server/core/ledger.js';
import { invoiceView, invoiceViews, markReady, sendAllReady } from '../server/core/sending.js';
import { billingObligations, invoices, obligationEvents } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Invoice rules a lab builds: When a job is ready, If every condition
// matches, Then it waits, is never drafted, is Pending or is non-chargeable.
// The data is synthetic.

const NOW = new Date('2026-10-19T02:00:00.000Z');
const job = (overrides = {}) => ({
  readyAt: NOW, totalCents: 22000, practitioner: null, jobDate: '2026-10-10', sourceStatus: 'Shipped',
  contactId: 'c-1', lines: [{ itemCode: 'CROWN', lineAmountCents: 20000 }], ...overrides,
});
const rule = (conditions, action = 'wait', name = 'Test') => ({ name, enabled: true, trigger: 'job_ready', conditions, action: { kind: action } });
const reasons = (conditions, o = job(), customer = {}) => ruleReasons([rule(conditions)], o, { customer, now: NOW });

describe('one rule against one job', () => {
  test('a rule must name a known field, a test that field takes, and a value of its kind', () => {
    assert.deepEqual(readRule({ name: ' Old ', conditions: [{ field: 'job_age_days', test: 'more_than', value: 30 }], action: { kind: 'wait' } }),
      { name: 'Old', icon: null, enabled: true, conditions: [{ field: 'job_age_days', test: 'more_than', value: 30 }], action: { kind: 'wait' } });
    const bad = (raw, pattern) => assert.throws(() => readRule({ name: 'x', action: { kind: 'wait' }, ...raw }), pattern);
    bad({ conditions: [] }, /1 to 10 conditions/);
    bad({ conditions: [{ field: 'colour', test: 'is', value: 'red' }] }, /unknown field colour/);
    bad({ conditions: [{ field: 'job_total', test: 'has', value: 1 }] }, /Job total takes/);
    bad({ conditions: [{ field: 'job_total', test: 'more_than', value: 'lots' }] }, /must be a number/);
    bad({ conditions: [{ field: 'customer_billable', test: 'is', value: 'no' }] }, /true or false/);
    bad({ conditions: [{ field: 'job_status', test: 'is_one_of', value: [] }] }, /pick 1 to 50/);
    bad({ conditions: [{ field: 'line_share', test: 'is', value: 20 }] }, /pick the line item/);
    bad({ name: '', conditions: [{ field: 'practitioner', test: 'is_empty' }] }, /needs a name/);
    bad({ action: { kind: 'email' }, conditions: [{ field: 'practitioner', test: 'is_empty' }] }, /action must be one of/);
    bad({ owner: 'x', conditions: [{ field: 'practitioner', test: 'is_empty' }] }, /unknown field: owner/);
    bad({ icon: 'not-an-icon', conditions: [{ field: 'practitioner', test: 'is_empty' }] }, /Lucide icon/);
  });

  test('every condition must match; each field reads the job, its customer or its lines', () => {
    assert.deepEqual(reasons([{ field: 'job_age_days', test: 'more_than', value: 8 }]), ['rule "Test": waits for a person']);
    assert.deepEqual(reasons([{ field: 'job_age_days', test: 'more_than', value: 9 }]), []);
    assert.deepEqual(reasons([{ field: 'job_total', test: 'more_than', value: 200 }]), ['rule "Test": waits for a person']);
    assert.deepEqual(reasons([{ field: 'job_total', test: 'more_than', value: 220 }]), []);
    assert.deepEqual(reasons([{ field: 'job_status', test: 'is', value: 'shipped' }]).length, 1);
    assert.deepEqual(reasons([{ field: 'job_status', test: 'is_one_of', value: ['Delivered', 'SHIPPED'] }]).length, 1);
    assert.deepEqual(reasons([{ field: 'customer', test: 'is', value: 'c-1' }]).length, 1);
    assert.deepEqual(reasons([{ field: 'customer', test: 'is_not', value: 'c-1' }]), []);
    assert.deepEqual(reasons([{ field: 'line_item', test: 'has', value: 'crown' }]).length, 1);
    assert.deepEqual(reasons([{ field: 'line_item', test: 'has_not', value: 'crown' }]), []);
    assert.deepEqual(reasons([{ field: 'practitioner', test: 'is_empty' }], job(), { defaultPractitioner: 'Dr Default' }), []);
    assert.deepEqual(reasons([{ field: 'customer_billable', test: 'is', value: false }], job(), { billable: false }).length, 1);
    // Both conditions must match.
    assert.deepEqual(reasons([{ field: 'job_total', test: 'more_than', value: 200 }, { field: 'job_status', test: 'is', value: 'delivered' }]), []);
    // A line share is false while the job has no such line.
    assert.deepEqual(reasons([{ field: 'line_share', item: 'RUSH', test: 'is_not', value: 20 }]), []);
  });

  test('a rule that is off, and a skip, read as people expect', () => {
    const off = { ...rule([{ field: 'job_total', test: 'more_than', value: 0 }]), enabled: false };
    assert.deepEqual(ruleRunner([off]), []);
    assert.deepEqual(ruleRunner([rule([{ field: 'job_total', test: 'more_than', value: 0 }], 'skip', 'Free work')]), ['rule "Free work": not drafted by rule']);
  });

  test('text tests read a practitioner or a Reference as a person would', () => {
    const p = (practitioner, condition) => reasons([{ field: 'practitioner', ...condition }], job({ practitioner })).length === 1;
    assert.equal(p('Not Listed', { test: 'is_one_of', value: ['not listed', 'Unknown'] }), true);
    assert.equal(p('Dr Ann Lee', { test: 'is_not_one_of', value: ['Dr Ann Lee', 'Dr Ben Ng'] }), false);
    assert.equal(p('Dr Ann Le', { test: 'is_not_one_of', value: ['Dr Ann Lee', 'Dr Ben Ng'] }), true);
    assert.equal(p('Ann', { test: 'one_word' }), true);
    assert.equal(p('Dr Ann Lee', { test: 'one_word' }), false);
    assert.equal(p('Dr Ann Lee - 21764', { test: 'has_number' }), true);
    // A part that is only a number is the client's reference; a number beside words is not.
    assert.equal(p('Dr Ann Lee - 21764', { test: 'number_in_words' }), false);
    assert.equal(p('Dr Ann Lee - Coral Smith (OIQ-9902)', { test: 'number_in_words' }), true);
    assert.equal(p('Dr Ann Lee - Coral Smith 28072185', { test: 'number_in_words' }), true);
    assert.equal(p('Dr Ann Lee - Coral Smith', { test: 'number_in_words' }), false);
    assert.equal(p('Dr Ann Lee', { test: 'does_not_start_with', value: 'dr ' }), false);
    assert.equal(p('Ann Lee', { test: 'does_not_start_with', value: 'Dr ' }), true);
    assert.equal(p('Not  Listed', { test: 'contains', value: 'not listed' }), true);
    assert.equal(p('Dr Ann Lee', { test: 'does_not_contain', value: 'listed' }), true);
    // Customer contains reads the customer's name, ignoring case and extra spaces.
    const named = (name, test, value) => reasons([{ field: 'customer', test, value }], job(), { name }).length === 1;
    assert.equal(named('North - Example Group', 'contains', 'example'), true);
    assert.equal(named('NORTH  -  EXAMPLE GROUP', 'contains', 'Example'), true);
    assert.equal(named('North - Example Group', 'contains', '  EXAMPLE  '), true);
    assert.equal(named('North - Example Group', 'contains', 'other'), false);
    assert.equal(named('North - Example Group', 'does_not_contain', 'example'), false);
    assert.equal(named('North - Example Group', 'does_not_contain', 'other'), true);
    assert.equal(named('Harbour Smiles', 'does_not_contain', 'example'), true);
    // An empty name matches no word test, the same as an empty practitioner.
    assert.equal(named(null, 'contains', 'example'), false);
    assert.equal(named(null, 'does_not_contain', 'example'), false);
    // is still matches the contact id, not the name.
    assert.equal(reasons([{ field: 'customer', test: 'is', value: 'c-1' }], job(), { name: 'North - Example Group' }).length, 1);
    assert.deepEqual(FIELDS.customer.tests, [...TESTS.choice.filter((t) => t !== 'is_empty'), 'contains', 'does_not_contain', 'is_empty']);
    assert.throws(() => readRule({ name: 'x', conditions: [{ field: 'customer', test: 'starts_with', value: 'ex' }], action: { kind: 'skip' } }), /Customer takes/);
    // An empty practitioner matches no word test; "is empty" finds it.
    for (const test of ['one_word', 'has_number', 'number_in_words', 'does_not_start_with', 'is_not_one_of']) {
      assert.equal(p(null, { test, value: test.endsWith('of') ? ['Dr Ann Lee'] : 'Dr' }), false, test);
    }
    // Earlier tests read as before.
    assert.equal(p(null, { test: 'is_not', value: 'Dr Ann Lee' }), true);
  });

  test('a pending rule needs a note, never stops a draft, and gives the draft its note', () => {
    const flag = { name: 'Practitioner not known', conditions: [{ field: 'practitioner', test: 'is', value: 'Not Listed' }], action: { kind: 'pending', note: ' Put the practitioner in the job. ' } };
    assert.deepEqual(readRule(flag).action, { kind: 'pending', note: 'Put the practitioner in the job.' });
    assert.throws(() => readRule({ ...flag, action: { kind: 'pending' } }), /needs a note/);
    assert.throws(() => readRule({ ...flag, action: { kind: 'pending', note: 'x'.repeat(201) } }), /needs a note/);
    // The Reference is on the draft only.
    const ref = [{ field: 'reference', test: 'has_number' }];
    assert.throws(() => readRule({ ...flag, conditions: ref, action: { kind: 'wait' } }), /Reference is on the draft only/);
    assert.deepEqual(readRule({ ...flag, conditions: ref }).conditions, ref);

    const rules = [{ ...readRule(flag), id: 'r-1', trigger: 'job_ready' }, { ...readRule({ ...flag, name: 'Number in Reference', conditions: ref }), id: 'r-2', trigger: 'job_ready' }];
    const odd = job({ practitioner: 'Not Listed', reference: 'Not Listed - Ann - 13909' });
    assert.deepEqual(ruleReasons(rules, odd, { now: NOW }), []);
    assert.deepEqual(rulePending(rules, odd, { now: NOW }), [
      { code: 'rule', message: 'Put the practitioner in the job.', short: 'Practitioner not known', rule: 'r-1', fields: ['practitioner'], resolution: { kind: 'rule_review' } },
      { code: 'rule', message: 'Put the practitioner in the job.', short: 'Number in Reference', rule: 'r-2', fields: ['reference'], resolution: { kind: 'rule_review' } },
    ]);
    assert.deepEqual(rulePending(rules, job({ practitioner: 'Dr Ann Lee', reference: 'Dr Ann Lee - Ben Ng' }), { now: NOW }), []);
    assert.deepEqual(rulePending([{ ...rules[0], enabled: false }], odd, { now: NOW }), []);
    assert.throws(() => rulePending([{ ...rules[0], id: null }], odd, { now: NOW }), { code: 'warning_resolution_required' });
  });

  test('every item is in accounting: lines with a code must send as an accounting item, and the reason names the rest', async () => {
    const missing = [{ field: 'accounting_item', test: 'is', value: false }];
    const two = job({ lines: [{ itemCode: 'CROWN', lineAmountCents: 20000 }, { itemCode: 'POST', lineAmountCents: 0 }, { accountCode: '200', label: 'Freight', lineAmountCents: 1500 }] });
    const run = (items) => ruleReasons([rule(missing, 'wait', 'No Xero item')], two, { now: NOW, items });
    assert.deepEqual(run(new Set(['CROWN'])), ['rule "No Xero item": waits for a person (not in accounting: POST)']);
    // A line booked to an account has no item, so it does not count.
    assert.deepEqual(run(new Set(['CROWN', 'POST'])), []);
    // No accounting system, or its list never read: the field has no value.
    assert.deepEqual(run(null), []);
    assert.deepEqual(ruleReasons([rule([{ field: 'accounting_item', test: 'is', value: true }])], two, { now: NOW }), []);
    const pending = { ...rule(missing, 'pending', 'No Xero item'), id: 'r-x', action: { kind: 'pending', note: 'Link the item in Price list.' } };
    assert.equal(rulePending([pending], two, { now: NOW, items: new Set() })[0].message, 'Link the item in Price list. (not in accounting: CROWN, POST)');

    // One call for a run of jobs, and only when an enabled rule reads the field.
    const asked = [];
    const accounting = { capabilities: { itemMatches: async ({ codes }) => { asked.push(codes); return ['CROWN']; } } };
    const saved = [{ ...rule(missing), id: 'r-1' }];
    assert.deepEqual(await accountingItemsFor(accounting, 'org', saved, [two, job()]), new Set(['CROWN']));
    assert.deepEqual(asked, [['CROWN', 'POST']]);
    assert.equal(await accountingItemsFor(accounting, 'org', [{ ...saved[0], enabled: false }], [two]), null);
    assert.equal(await accountingItemsFor(null, 'org', saved, [two]), null);
    assert.equal(await accountingItemsFor({ capabilities: { itemMatches: async () => null } }, 'org', saved, [two]), null);
  });

  test('a skip rule holds a matching draft; a wait rule does not', () => {
    const skip = { ...rule([{ field: 'customer', test: 'contains', value: 'example' }], 'skip', 'Own branches'), id: 'r-9', trigger: 'job_ready' };
    const wait = { ...rule([{ field: 'customer', test: 'contains', value: 'example' }], 'wait', 'Hold branches'), id: 'r-8', trigger: 'job_ready' };
    const opts = { customer: { name: 'North - Example Group' }, now: NOW };
    assert.deepEqual(ruleSkip([skip, wait], job(), opts), [{
      code: 'rule',
      message: 'Rule "Own branches": not invoiced. Void this draft or change the rule.',
      short: 'Own branches',
      rule: 'r-9',
      fields: ['customer'],
      resolution: { kind: 'rule_review' },
    }]);
    assert.deepEqual(ruleSkip([{ ...skip, enabled: false }], job(), opts), []);
    assert.deepEqual(ruleSkip([skip], job(), { customer: { name: 'Harbour Smiles' }, now: NOW }), []);
    assert.deepEqual(ruleReasons([skip], job(), opts), ['rule "Own branches": not drafted by rule']);
  });

  test('a non-chargeable rule lets the job draft, and names the rule on a matching draft', () => {
    const kept = { ...rule([{ field: 'customer', test: 'contains', value: 'example' }], 'non_chargeable', 'Own branches'), id: 'r-7' };
    const opts = { customer: { name: 'North - Example Group' }, now: NOW };
    assert.deepEqual(readRule({ name: 'Own branches', conditions: kept.conditions, action: { kind: 'non_chargeable' } }).action, { kind: 'non_chargeable' });
    assert.deepEqual(ruleReasons([kept], job(), opts), []);
    assert.deepEqual(ruleNonChargeable([kept], job(), opts), [{
      code: 'non_chargeable', message: 'Rule "Own branches": non-chargeable. Flow keeps it and never sends it.', short: 'Own branches', rule: 'r-7',
    }]);
    assert.deepEqual(ruleNonChargeable([kept], job(), { customer: { name: 'Harbour Smiles' }, now: NOW }), []);
    assert.deepEqual(ruleNonChargeable([{ ...kept, enabled: false }], job(), opts), []);
  });

  test('the starter rules come from the earlier settings', () => {
    assert.deepEqual(starterRules({ staleDays: 90 }).map((r) => [r.starterKey, r.enabled]),
      [['not_billable', true], ['zero_total', true], ['old_job', true], ['practitioner', false]]);
    const rush = starterRules({ staleDays: 30, requirePractitioner: true, rushItemCode: 'RUSH', rushPercent: 25 });
    assert.equal(rush.find((r) => r.starterKey === 'old_job').conditions[0].value, 30);
    assert.equal(rush.find((r) => r.starterKey === 'practitioner').enabled, true);
    assert.deepEqual(rush.find((r) => r.starterKey === 'rush_share').conditions, [{ field: 'line_share', item: 'RUSH', test: 'is_not', value: 25 }]);
    for (const r of rush) readRule({ name: r.name, enabled: r.enabled, conditions: r.conditions, action: r.action });
  });
});

function ruleRunner(rules) {
  return ruleReasons(rules, job(), { now: NOW });
}

describe('rules a lab keeps', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let other;
  let practice;
  let counter = 0;

  before(async () => {
    handle = await freshDatabase();
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    other = await createOrganisation(handle.db, { name: 'Other Lab' });
    practice = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Practice' });
    await createPriceItem(handle.db, lab.id, { code: 'CROWN', name: 'Crown', unitAmountCents: 20000 });
  });
  after(async () => handle?.close());

  test('the first read makes the starter rules once, from the settings', async () => {
    await saveInvoicingSettings(handle.db, lab.id, { staleDays: 45, rushItemCode: 'RUSH' });
    const [first, again] = await Promise.all([listRules(handle.db, lab.id), listRules(handle.db, lab.id)]);
    assert.deepEqual(first.map((r) => r.name), ['Customer not billable', 'No amount', 'Old job', 'Practitioner required', 'Rush charge share']);
    assert.deepEqual(again.map((r) => r.id), first.map((r) => r.id));
    assert.equal(first.find((r) => r.name === 'Old job').conditions[0].value, 45);
    // A lab can delete a starter rule; it does not come back.
    await deleteRule(handle.db, lab.id, first.find((r) => r.name === 'Rush charge share').id);
    assert.equal((await listRules(handle.db, lab.id)).length, 4);
  });

  test('a lab adds, changes and deletes its own rules; another lab cannot reach them', async () => {
    const made = await createRule(handle.db, lab.id, {
      name: 'Courier only', conditions: [{ field: 'line_item', test: 'has_not', value: 'CROWN' }], action: { kind: 'skip' },
    });
    assert.equal(made.position, 4);
    assert.equal(made.starter, false);
    assert.equal(made.icon, null);
    // A lab picks the rule's icon, and later changes it; other changes keep it.
    assert.equal((await updateRule(handle.db, lab.id, made.id, { icon: 'truck' })).icon, 'truck');
    const renamed = await updateRule(handle.db, lab.id, made.id, { name: 'No crown' });
    assert.equal(renamed.name, 'No crown');
    assert.equal(renamed.icon, 'truck');
    assert.equal((await listRules(handle.db, lab.id)).find((r) => r.id === made.id).icon, 'truck');
    assert.deepEqual(renamed.conditions, made.conditions);
    await assert.rejects(updateRule(handle.db, lab.id, made.id, { conditions: [] }), /1 to 10 conditions/);
    await assert.rejects(updateRule(handle.db, other.id, made.id, { name: 'Mine' }), { code: 'not_found' });
    await assert.rejects(deleteRule(handle.db, other.id, made.id), { code: 'not_found' });
    assert.ok((await listRules(handle.db, other.id)).every((r) => r.id !== made.id));
    await deleteRule(handle.db, lab.id, made.id);
  });

  test('the draft automation follows the lab\'s rules, with no accounting system', async () => {
    const observe = async (status) => {
      const row = await observeJob(handle.db, lab.id, {
        sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`, contactId: practice.id,
        sourceStatus: status, jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
      });
      await setReady(handle.db, lab.id, row.id, { actor: 'person:test' });
      return row;
    };
    const reload = async (row) => (await handle.db.select().from(billingObligations).where(eq(billingObligations.id, row.id)))[0];
    const held = await observe('Remake');
    const fine = await observe('Shipped');
    await createRule(handle.db, lab.id, { name: 'Remakes', conditions: [{ field: 'job_status', test: 'is', value: 'remake' }], action: { kind: 'wait' } });
    const result = await autoDraftJobs(handle.db, lab.id, { now: NOW });
    assert.equal(result.waiting, 1);
    assert.equal(result.drafted, 1);
    assert.equal((await reload(held)).invoiceId, null);
    assert.ok((await reload(fine)).invoiceId);
  });

  test('a pending rule drafts the job, and its draft is Pending with the note until the cause is fixed', async () => {
    const row = await observeJob(handle.db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`, contactId: practice.id, practitioner: 'Not Listed',
      sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
    });
    await setReady(handle.db, lab.id, row.id, { actor: 'person:test' });
    const made = await createRule(handle.db, lab.id, {
      name: 'Reference not known', conditions: [{ field: 'reference', test: 'starts_with', value: 'not listed' }],
      action: { kind: 'pending', note: 'Put the practitioner in the job, then check the Reference.' },
    });
    await autoDraftJobs(handle.db, lab.id, { now: NOW });
    const [obligation] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, row.id));
    assert.ok(obligation.invoiceId, 'a pending rule never stops the draft');
    let views = await invoiceViews(handle.db, lab.id);
    assert.deepEqual(views.problems.get(obligation.invoiceId), [
      { code: 'rule', message: 'Put the practitioner in the job, then check the Reference.', short: 'Reference not known', rule: made.id, fields: ['reference'], resolution: { kind: 'rule_review' } },
    ]);
    assert.equal(views.ready.includes(obligation.invoiceId), false);
    // Send is a gate: every check runs again at the press.
    await assert.rejects(sendAllReady(handle.db, lab.id, { personId: null, issueDate: '2026-10-21', invoiceIds: [obligation.invoiceId] }),
      { code: 'not_ready', message: /^Not sent: Put the practitioner in the job, then check the Reference\. The invoice is on Pending\.$/ });
    // A person fixes the Reference: the draft is Ready.
    await handle.db.update(invoices).set({ reference: 'Dr Ann Lee - Ben Ng' }).where(eq(invoices.id, obligation.invoiceId));
    views = await invoiceViews(handle.db, lab.id);
    assert.equal(views.problems.has(obligation.invoiceId), false);
    assert.equal(views.ready.includes(obligation.invoiceId), true);
    // Someone edits it again before the press: of the ticked drafts, the one
    // that fails now stays on Pending and the rest go.
    const other = await observeJob(handle.db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`, contactId: practice.id, practitioner: 'Dr Ann Lee',
      sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
    });
    await setReady(handle.db, lab.id, other.id, { actor: 'person:test' });
    await autoDraftJobs(handle.db, lab.id, { now: NOW });
    const [{ invoiceId: good }] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, other.id));
    await handle.db.update(invoices).set({ reference: 'Not Listed - Ben Ng' }).where(eq(invoices.id, obligation.invoiceId));
    const sent = await sendAllReady(handle.db, lab.id, { personId: null, issueDate: '2026-10-21', invoiceIds: [obligation.invoiceId, good] });
    assert.deepEqual([sent.issued, sent.held], [1, 1]);
    const status = async (id) => (await handle.db.select().from(invoices).where(eq(invoices.id, id)))[0].status;
    assert.deepEqual([await status(obligation.invoiceId), await status(good)], ['draft', 'issued']);
    assert.ok((await invoiceViews(handle.db, lab.id)).problems.has(obligation.invoiceId));
    await deleteRule(handle.db, lab.id, made.id);
  });

  test('Send holds a draft a skip rule matches, and sends one it does not', async () => {
    const branch = await createContact(handle.db, lab.id, { kind: 'customer', name: 'North - Example Group' });
    const smiles = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Harbour Smiles' });
    const draftFor = async (contact) => {
      const row = await observeJob(handle.db, lab.id, {
        sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`, contactId: contact.id,
        sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
      });
      await setReady(handle.db, lab.id, row.id, { actor: 'person:test' });
      await autoDraftJobs(handle.db, lab.id, { now: NOW });
      const [obligation] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, row.id));
      assert.ok(obligation.invoiceId);
      return obligation;
    };
    const held = await draftFor(branch);
    const fine = await draftFor(smiles);
    const made = await createRule(handle.db, lab.id, {
      name: 'Own branches', conditions: [{ field: 'customer', test: 'contains', value: 'example' }], action: { kind: 'skip' },
    });
    let views = await invoiceViews(handle.db, lab.id);
    assert.deepEqual(views.problems.get(held.invoiceId), [{
      code: 'rule',
      message: 'Rule "Own branches": not invoiced. Void this draft or change the rule.',
      short: 'Own branches',
      rule: made.id,
      fields: ['customer'],
      resolution: { kind: 'rule_review' },
    }]);
    assert.equal(views.ready.includes(held.invoiceId), false);
    assert.equal(views.ready.includes(fine.invoiceId), true);
    const note = 'Rule "Own branches": not invoiced. Void this draft or change the rule.';
    await assert.rejects(sendAllReady(handle.db, lab.id, { personId: null, issueDate: '2026-10-21', invoiceIds: [held.invoiceId] }),
      { code: 'not_ready', message: `Not sent: ${note} The invoice is on Pending.` });
    const sent = await sendAllReady(handle.db, lab.id, { personId: null, issueDate: '2026-10-21', invoiceIds: [held.invoiceId, fine.invoiceId] });
    assert.deepEqual([sent.issued, sent.held], [1, 1]);
    const status = async (id) => (await handle.db.select().from(invoices).where(eq(invoices.id, id)))[0].status;
    assert.deepEqual([await status(held.invoiceId), await status(fine.invoiceId)], ['draft', 'issued']);

    // A job that arrives after the rule is not drafted. A person can still
    // draft it from the board; Send holds that draft too.
    const later = await observeJob(handle.db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`, contactId: branch.id,
      sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
    });
    await setReady(handle.db, lab.id, later.id, { actor: 'person:test' });
    await autoDraftJobs(handle.db, lab.id, { now: NOW });
    const [waiting] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, later.id));
    assert.equal(waiting.invoiceId, null);
    const { invoice } = await draftInvoiceForObligation(handle.db, lab.id, later.id, { actor: 'person:test', liveCheck: null, now: NOW, reference: 'CASE-hand' });
    views = await invoiceViews(handle.db, lab.id);
    assert.equal(views.problems.get(invoice.id)?.[0]?.message, note);
    assert.equal(views.ready.includes(invoice.id), false);
    await deleteRule(handle.db, lab.id, made.id);
  });

  test('a non-chargeable rule keeps its drafts off Pending and Ready, and nothing sends them', async () => {
    const branch = await createContact(handle.db, lab.id, { kind: 'customer', name: 'South - Example Group' });
    const ready = async () => {
      const row = await observeJob(handle.db, lab.id, {
        sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`, contactId: branch.id,
        sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
      });
      await setReady(handle.db, lab.id, row.id, { actor: 'person:test' });
      return row;
    };
    const reload = async (row) => (await handle.db.select().from(billingObligations).where(eq(billingObligations.id, row.id)))[0];
    // A draft made before the rule moves over from Ready.
    const before = await ready();
    await autoDraftJobs(handle.db, lab.id, { now: NOW });
    const old = (await reload(before)).invoiceId;
    assert.ok((await invoiceViews(handle.db, lab.id)).ready.includes(old));
    const made = await createRule(handle.db, lab.id, {
      name: 'Own branches', conditions: [{ field: 'customer', test: 'contains', value: 'example' }], action: { kind: 'non_chargeable' },
    });
    // A job after the rule is drafted, with its lines and total.
    const after = await ready();
    await autoDraftJobs(handle.db, lab.id, { now: NOW });
    const fresh = (await reload(after)).invoiceId;
    assert.ok(fresh, 'a non-chargeable rule drafts the job');
    assert.equal((await getInvoice(handle.db, lab.id, fresh)).lines.length, 1);
    const views = await invoiceViews(handle.db, lab.id);
    const note = 'Rule "Own branches": non-chargeable. Flow keeps it and never sends it.';
    for (const id of [old, fresh]) {
      assert.deepEqual(views.nonChargeable.get(id), [{ code: 'non_chargeable', message: note, short: 'Own branches', rule: made.id }]);
      assert.equal(views.problems.has(id), false);
      assert.equal(views.ready.includes(id), false);
    }
    assert.equal((await invoiceView(handle.db, lab.id, await getInvoice(handle.db, lab.id, fresh))).view, 'non_chargeable');
    await assert.rejects(sendAllReady(handle.db, lab.id, { personId: null, issueDate: '2026-10-21', invoiceIds: [fresh] }),
      { code: 'not_ready', message: `Not sent: ${note}` });
    assert.equal((await markReady(handle.db, lab.id, [fresh], { personId: null })).marked, 0);
    await sendAllReady(handle.db, lab.id, { personId: null, issueDate: '2026-10-21' });
    assert.equal((await getInvoice(handle.db, lab.id, fresh)).status, 'draft', 'Send all ready leaves it');
    // The rule off: the drafts are Ready again.
    await updateRule(handle.db, lab.id, made.id, { enabled: false });
    assert.ok((await invoiceViews(handle.db, lab.id)).ready.includes(fresh));
    await deleteRule(handle.db, lab.id, made.id);
  });

  test('deleting a never-issued draft frees the job, and a Never draft rule does not draft it again', async () => {
    const observe = async (status) => {
      const row = await observeJob(handle.db, lab.id, {
        sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`, contactId: practice.id,
        sourceStatus: status, jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
      });
      await setReady(handle.db, lab.id, row.id, { actor: 'person:test' });
      return row;
    };
    const reload = async (row) => (await handle.db.select().from(billingObligations).where(eq(billingObligations.id, row.id)))[0];
    const internal = await observe('Internal');
    await autoDraftJobs(handle.db, lab.id, { now: NOW });
    const drafted = await reload(internal);
    assert.ok(drafted.invoiceId, 'the job is drafted before the rule exists');
    const rule = await createRule(handle.db, lab.id, {
      name: 'Never draft', conditions: [{ field: 'job_status', test: 'is', value: 'internal' }], action: { kind: 'skip' },
    });
    await deleteDraft(handle.db, lab.id, drafted.invoiceId, { actor: 'person:test' });
    await assert.rejects(getInvoice(handle.db, lab.id, drafted.invoiceId), { code: 'not_found' });
    const freed = await reload(internal);
    assert.equal(freed.invoiceId, null);
    assert.equal(freed.draftBasis, null);
    const explained = await explainObligation(handle.db, lab.id, internal.id, { accounting: false, now: NOW });
    assert.equal(explained.view, 'ready');
    assert.equal(explained.events.at(-1).kind, 'draft_deleted');

    const open = await observe('Shipped');
    await autoDraftJobs(handle.db, lab.id, { now: NOW });
    assert.equal((await reload(internal)).invoiceId, null, 'a Never draft rule does not draft the job again');
    assert.ok((await reload(open)).invoiceId, 'a job the rule does not match is drafted');
    await deleteRule(handle.db, lab.id, rule.id);
  });

  test('a shipping rule offers Add, or Skip with a reason; the rule lists each exception', async () => {
    await createPriceItem(handle.db, lab.id, { code: 'S/H', name: 'Shipping', unitAmountCents: 1500 });
    const rule = await createRule(handle.db, lab.id, {
      name: 'Shipping', conditions: [{ field: 'line_item', test: 'has_not', value: 'S/H' }],
      action: { kind: 'pending', note: 'Add shipping, or skip with a reason.', addItem: 'S/H' },
    });
    assert.equal(rule.action.addItem, 'S/H');
    const draftOf = async () => {
      const row = await observeJob(handle.db, lab.id, {
        sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`, contactId: practice.id, practitioner: 'Dr Ann Lee',
        sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
      });
      await setReady(handle.db, lab.id, row.id, { actor: 'person:test' });
      await autoDraftJobs(handle.db, lab.id, { now: NOW });
      return (await handle.db.select().from(billingObligations).where(eq(billingObligations.id, row.id)))[0];
    };
    const ruleProblem = async (invoiceId) => ((await invoiceViews(handle.db, lab.id)).problems.get(invoiceId) ?? []).find((p) => p.rule === rule.id);

    // Add: the draft gets one S/H line at the price list's price, and the rule is satisfied.
    const first = await draftOf();
    assert.equal((await ruleProblem(first.invoiceId)).addItem, 'S/H');
    const added = await addRuleItem(handle.db, lab.id, first.invoiceId, rule.id);
    assert.equal(added.totalCents - 20000 - 2000, 1500 + 150, 'crown plus shipping, each with GST');
    await addRuleItem(handle.db, lab.id, first.invoiceId, rule.id);
    assert.equal((await getInvoice(handle.db, lab.id, first.invoiceId)).lines.length, 2, 'a second press adds nothing');
    assert.equal(await ruleProblem(first.invoiceId), undefined);

    // Skip: an exception with a reason; the rule leaves that job alone and lists it.
    const second = await draftOf();
    await assert.rejects(exceptDraft(handle.db, lab.id, second.invoiceId, rule.id, { reason: ' ', actor: 'person:test' }), /reason/);
    await exceptDraft(handle.db, lab.id, second.invoiceId, rule.id, { reason: 'Picked up by the clinic', actor: 'person:test' });
    assert.equal(await ruleProblem(second.invoiceId), undefined);
    const listed = await listRuleExceptions(handle.db, lab.id, rule.id);
    assert.deepEqual(listed.map((e) => [e.obligationId, e.reason]), [[second.id, 'Picked up by the clinic']]);
    assert.equal((await listRules(handle.db, lab.id)).find((r) => r.id === rule.id).exceptions, 1);
    // The job board says what the work system still lacks: the added S/H is
    // on Flow's invoice only; the excepted job needs nothing.
    const needs = async (job) => (await describeObligations(handle.db, lab.id, [{ obligation: job, view: 'pending', reasons: [] }]))[0].sourceNeeds;
    assert.deepEqual((await needs(first)).map((n) => n.item), ['S/H']);
    assert.deepEqual(await needs(second), []);
    // A job can be excepted before it has a draft; another lab's job cannot.
    const third = await observeJob(handle.db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`, contactId: practice.id,
      sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
    });
    assert.deepEqual((await needs(third)).map((n) => n.item), ['S/H']);
    await exceptJob(handle.db, lab.id, third.id, rule.id, { reason: 'Picked up', actor: 'person:test' });
    assert.deepEqual(await needs(third), []);
    const otherLab = await createOrganisation(handle.db, { name: 'Other Lab' });
    await assert.rejects(exceptJob(handle.db, otherLab.id, third.id, rule.id, { reason: 'x', actor: 'person:test' }), /not found/);
    assert.equal((await listRules(handle.db, lab.id)).find((r) => r.id === rule.id).exceptions, 2);
    // The job's history keeps it.
    const events = await handle.db.select().from(obligationEvents).where(eq(obligationEvents.obligationId, second.id));
    assert.ok(events.some((e) => e.kind === 'rule_exception_added' && e.evidence.reason === 'Picked up by the clinic'));
    // An exception ends when the job's lines change: a person looks again.
    await observeJob(handle.db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: third.sourceJobRef, caseRef: third.caseRef, contactId: practice.id,
      sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }, { itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
    });
    const [changed] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, third.id));
    assert.deepEqual((await needs(changed)).map((n) => n.item), ['S/H']);
    assert.equal((await listRuleExceptions(handle.db, lab.id, rule.id)).find((e) => e.obligationId === third.id).current, false);
    // A job whose work system has the item needs nothing, whatever the rule says.
    assert.deepEqual(await needs({ ...changed, lines: [...changed.lines, { itemCode: 'S/H' }] }), []);
    // Taken back, the rule applies again; an unknown exception is not found.
    await removeRuleException(handle.db, lab.id, rule.id, listed[0].id, { actor: 'person:test' });
    assert.ok(await ruleProblem(second.invoiceId));
    await assert.rejects(removeRuleException(handle.db, lab.id, rule.id, listed[0].id), /not found/);
    assert.ok((await handle.db.select().from(obligationEvents).where(eq(obligationEvents.obligationId, second.id))).some((e) => e.kind === 'rule_exception_removed'));
    await deleteRule(handle.db, lab.id, rule.id);
  });

  test('only a rule with an item takes an exception; the item must be on the price list; a $0 item does not satisfy it', async () => {
    const plain = await createRule(handle.db, lab.id, { name: 'Plain', conditions: [{ field: 'job_total', test: 'more_than', value: 0 }], action: { kind: 'pending', note: 'Check it.' } });
    const job = await observeJob(handle.db, lab.id, {
      sourceSystem: 'seazona', sourceJobRef: `job-${++counter}`, caseRef: `CASE-${counter}`, contactId: practice.id,
      sourceStatus: 'Shipped', jobDate: '2026-10-15', lines: [{ itemCode: 'CROWN', description: 'Crown' }], observedAt: NOW,
    });
    await assert.rejects(exceptJob(handle.db, lab.id, job.id, plain.id, { reason: 'No', actor: 'person:test' }), /only a pending rule with an item/);
    await deleteRule(handle.db, lab.id, plain.id);
    await assert.rejects(createRule(handle.db, lab.id, {
      name: 'Missing item', conditions: [{ field: 'line_item', test: 'has_not', value: 'NOPE' }], action: { kind: 'pending', note: 'Add it.', addItem: 'NOPE' },
    }), /no item NOPE/);
    const rule = await createRule(handle.db, lab.id, {
      name: 'Shipping', conditions: [{ field: 'line_item', test: 'has_not', value: 'S/H' }], action: { kind: 'pending', note: 'Add shipping.', addItem: 'S/H' },
    });
    await setReady(handle.db, lab.id, job.id, { actor: 'person:test' });
    await autoDraftJobs(handle.db, lab.id, { now: NOW });
    const [drafted] = await handle.db.select().from(billingObligations).where(eq(billingObligations.id, job.id));
    const ruleProblem = async () => ((await invoiceViews(handle.db, lab.id)).problems.get(drafted.invoiceId) ?? []).find((p) => p.rule === rule.id);
    const added = await addRuleItem(handle.db, lab.id, drafted.invoiceId, rule.id);
    assert.equal(await ruleProblem(), undefined);
    // Edited to $0, the line no longer counts.
    const { updateDraftInvoice } = await import('../server/core/invoices.js');
    await updateDraftInvoice(handle.db, lab.id, drafted.invoiceId, {
      lines: added.lines.map(({ priceItemId, description, quantity, unitAmountCents, taxCode }, i) => ({ priceItemId, description, quantity, taxCode, unitAmountCents: i === 1 ? 0 : unitAmountCents })),
    });
    assert.ok(await ruleProblem());
    await deleteRule(handle.db, lab.id, rule.id);
  });

  test('a customer rule can leave out a list of customers', () => {
    const rule = readRule({
      name: 'Shipping', conditions: [{ field: 'customer', test: 'is_not_one_of', value: ['branch-a', 'branch-b'] }],
      action: { kind: 'pending', note: 'Add shipping.', addItem: 'S/H' },
    });
    const pending = (contactId) => rulePending([{ ...rule, id: 'r1', enabled: true, trigger: 'job_ready' }], { contactId, lines: [] }, { customer: {} });
    assert.equal(pending('practice').length, 1);
    assert.equal(pending('branch-b').length, 0);
  });
});
