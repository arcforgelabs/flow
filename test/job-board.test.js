import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixes, invoiceStage, matches, NO_STATUS, orderStatuses, problemSummary,
} from '../server/ui/job-board.js';

// The Jobs board's rules (server/ui/job-board.js). Synthetic data only.

test('the board columns are the work system statuses, new work first and final ones last', () => {
  const statuses = [
    { label: 'Delivered', firstSeenAt: '2026-01-01T00:00:00Z' },
    { label: 'Cancelled', firstSeenAt: '2026-01-01T00:00:00Z' },
    { label: 'In Production', firstSeenAt: '2026-01-03T00:00:00Z' },
    { label: 'Shipped', firstSeenAt: '2026-01-01T00:00:00Z' },
    { label: 'Polishing', firstSeenAt: '2026-01-02T00:00:00Z' },
    { label: 'New', firstSeenAt: '2026-01-05T00:00:00Z' },
    { label: 'Complete', firstSeenAt: '2026-01-01T00:00:00Z' },
    { label: 'Design', firstSeenAt: '2026-01-04T00:00:00Z' },
  ];
  assert.deepEqual(orderStatuses(statuses, [{ status: null }]), [
    'New', 'Design', 'Polishing', 'In Production', NO_STATUS, 'Complete', 'Shipped', 'Delivered', 'Cancelled',
  ]);
});

test('a job\'s invoice stage follows its obligation; a job in work has none', () => {
  const base = { reasons: [], waitingFor: [], invoiceProblems: [] };
  const stage = (o) => invoiceStage({ ...base, ...o });
  assert.equal(invoiceStage(null), null);
  assert.equal(stage({ view: 'in_work' }), null);
  assert.equal(stage({ view: 'ready' }), 'drafted', 'every check passes: the automation drafts it next');
  assert.equal(stage({ view: 'ready', waitingFor: ['rule "Big jobs": waits for a person'] }), 'problem');
  for (const view of ['pending', 'review_required', 'held']) assert.equal(stage({ view }), 'problem');
  assert.equal(stage({ view: 'drafted', invoiceStatus: 'draft', invoiceView: 'to_check' }), 'drafted');
  assert.equal(stage({ view: 'drafted', invoiceStatus: 'draft', invoiceView: 'problem' }), 'problem');
  assert.equal(stage({ view: 'drafted', invoiceStatus: 'draft', invoiceView: 'ready' }), 'ready');
  assert.equal(stage({ view: 'drafted', invoiceStatus: 'issued', invoiceView: 'sending' }), 'invoiced');
  assert.equal(stage({ view: 'drafted', invoiceStatus: 'issued', invoiceView: 'problem' }), 'problem', 'the accounting system refused it');
  assert.equal(stage({ view: 'drafted', invoiceStatus: 'void' }), 'problem');
  assert.equal(stage({ view: 'invoiced' }), 'invoiced');
  assert.equal(stage({ view: 'paid' }), 'paid');
});

test('each problem is a short label, what is wrong, and what to do', () => {
  const pending = {
    view: 'pending',
    reasons: ['the accounting system was not checked', 'a line does not map to a price item', 'the job has no customer contact'],
    waitingFor: [],
    invoiceProblems: [],
  };
  const found = fixes(pending, { accountingName: 'Xero' });
  assert.deepEqual(found.map((f) => f.label), ['Not checked in Xero', 'No price code', 'Client not linked']);
  assert.ok(found.every((f) => f.text.endsWith('.') && f.todo.endsWith('.')));
  assert.equal(problemSummary(found), 'Not checked in Xero +2');

  const draft = {
    view: 'drafted', invoiceStatus: 'draft', invoiceView: 'problem', reasons: ['a draft invoice exists'], waitingFor: [],
    invoiceProblems: [
      { code: 'line_no_item', message: 'Line 1 has no price item.' },
      { code: 'line_no_item', message: 'Line 2 has no price item.' },
      { code: 'xero_contact_missing', message: 'No Xero contact is named "Example".' },
    ],
  };
  const drafted = fixes(draft, { accountingName: 'Xero' });
  assert.deepEqual(drafted.map((f) => f.label), ['No price code', 'No price code', 'Client not in Xero']);
  assert.equal(problemSummary(drafted), 'No price code +1', 'the same label counts once');
  assert.deepEqual(fixes({ ...draft, invoiceView: 'to_check' }), [], 'no problem, nothing to fix');
});

test('search finds a job by case, client or practitioner', () => {
  const job = { caseRef: 'CASE-77', clientName: 'Example Practice', practitioner: 'Dr Sample', obligation: null };
  for (const q of ['case-77', 'example', 'SAMPLE', '']) assert.ok(matches(job, q), q);
  assert.ok(!matches(job, 'nothing'));
});
