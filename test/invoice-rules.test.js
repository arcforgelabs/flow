import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import {
  createRule, deleteRule, listRules, readRule, ruleReasons, starterRules, updateRule,
} from '../server/core/invoice-rules.js';
import { autoDraftJobs, saveInvoicingSettings } from '../server/core/invoicing-rules.js';
import { observeJob, setReady } from '../server/core/ledger.js';
import { billingObligations } from '../server/db/schema.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Invoice rules a lab builds: When a job is ready, If every condition
// matches, Then it waits or is never drafted. The data is synthetic.

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
      { name: 'Old', enabled: true, conditions: [{ field: 'job_age_days', test: 'more_than', value: 30 }], action: { kind: 'wait' } });
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
    const renamed = await updateRule(handle.db, lab.id, made.id, { name: 'No crown' });
    assert.equal(renamed.name, 'No crown');
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
});
