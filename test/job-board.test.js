import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  caseNumber, fixes, GO, invoiceStage, matches, NO_STATUS, orderStatuses, problemSummary,
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
  const found = fixes(pending);
  assert.deepEqual(found.map((f) => f.label), ['Not checked yet', 'No price code', 'Client not linked']);
  assert.ok(found.every((f) => f.text.endsWith('.') && f.todo.endsWith('.')));
  assert.ok(found.every((f) => f.go === null || GO.includes(f.go)));
  assert.equal(problemSummary(found), 'Not checked yet +2');

  const draft = {
    view: 'drafted', invoiceStatus: 'draft', invoiceView: 'problem', reasons: ['a draft invoice exists'], waitingFor: [],
    invoiceProblems: [
      { code: 'line_no_item', message: 'Line 1 has no price item.' },
      { code: 'line_no_item', message: 'Line 2 has no price item.' },
      { code: 'xero_contact_missing', message: 'No Xero contact is named "Example".' },
    ],
  };
  const drafted = fixes(draft);
  assert.deepEqual(drafted.map((f) => f.label), ['No price code', 'No price code', 'Invoice problem']);
  assert.ok(drafted.every((f) => f.go === 'invoice'), 'each invoice problem opens the invoice');
  assert.equal(problemSummary(drafted), 'No price code +1', 'the same label counts once');
  assert.deepEqual(fixes({ ...draft, invoiceView: 'to_check' }), [], 'no problem, nothing to fix');
});

test('a job fix points to Flow\'s invoice or the work system, never an accounting system', () => {
  const review = (reason) => fixes({ view: 'review_required', reasons: [reason], waitingFor: [], invoiceProblems: [] })[0];
  const unclear = review('the accounting evidence is ambiguous');
  assert.deepEqual(unclear, { label: 'No invoice', text: 'This job has no invoice.', todo: null, go: 'choose' }, 'one line; the buttons are the instruction');
  assert.equal(review('the accounting evidence is conflict').go, 'work');
  assert.equal(review('invoice INV-1 was voided').go, 'invoice');
  assert.equal(review('the job changed after its invoice was made').go, 'review', 'the job panel\'s Review sidecar');
  const sent = fixes({
    view: 'drafted', invoiceStatus: 'draft', invoiceView: 'problem', reasons: [], waitingFor: [],
    invoiceProblems: [{ code: 'xero_item_missing', message: 'No Xero item has code NGH.' }, { code: 'xero_push_failed', message: 'Xero said no.' }],
  });
  assert.deepEqual(sent.map((f) => f.label), ['Invoice problem', 'Not sent']);
  for (const f of [unclear, ...sent, ...fixes({ view: 'pending', reasons: ['the accounting system was not checked', 'the accounting system reports authorised'], waitingFor: [], invoiceProblems: [] })]) {
    assert.doesNotMatch(`${f.label} ${f.text} ${f.todo ?? ''}`, /xero|accounting/i, f.label);
  }
});

test('a changed job shows one fix, not the hold and its draft\'s copy of it', () => {
  // The ledger's hold (review_required) and the draft check (sending.js,
  // job_review) are one fact.
  const job = {
    view: 'review_required', holdState: 'review', reasons: ['the job changed after its invoice was made'], waitingFor: [],
    invoiceId: 'inv-1', invoiceStatus: 'draft', invoiceView: 'problem',
    invoiceProblems: [{ code: 'job_review', message: 'The job needs a look before this invoice goes: the job changed after its invoice was made.' }],
  };
  const found = fixes(job);
  assert.deepEqual(found.map((f) => [f.label, f.go]), [['Job changed', 'review']]);
  assert.ok(found[0].text.split(' ').length <= 8, 'a short line');
  // A real problem on the draft still shows next to it.
  const more = fixes({ ...job, invoiceProblems: [...job.invoiceProblems, { code: 'no_lines', message: 'The invoice has no lines.' }] });
  assert.deepEqual(more.map((f) => f.label), ['Job changed', 'No lines']);
  // Two problems with the same words show once.
  const twice = fixes({ ...job, invoiceProblems: [{ code: 'xero_a', message: 'x' }, { code: 'xero_b', message: 'y' }] });
  assert.deepEqual(twice.map((f) => f.label), ['Job changed', 'Invoice problem']);
});

test('a case number is never a record id', () => {
  assert.equal(caseNumber({ caseRef: 'CASE-77' }), 'CASE-77');
  assert.equal(caseNumber({ caseRef: null, sourceJobRef: 'JOB-9' }), 'JOB-9');
  assert.equal(caseNumber({ caseRef: 'd19937a7-fdea-47d5-9fbc-35a29a68c12f' }), null);
});

test('search finds a job by case, client or practitioner', () => {
  const job = { caseRef: 'CASE-77', clientName: 'Example Practice', practitioner: 'Dr Sample', obligation: null };
  for (const q of ['case-77', 'example', 'SAMPLE', '']) assert.ok(matches(job, q), q);
  assert.ok(!matches(job, 'nothing'));
});
