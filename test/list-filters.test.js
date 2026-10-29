import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// The Filter chip on Reconcile and Invoices: the same groups and rows as on
// Jobs (job-view.js), on each page's own fields. Synthetic data only.
const ui = new URL('../server/ui/', import.meta.url);
registerHooks({
  resolve: (specifier, context, next) => next(specifier.startsWith('/assets/ui/') ? new URL(specifier.slice('/assets/ui/'.length), ui).href : specifier, context),
});
const { keptRows, reconcileRows } = await import('../server/ui/reconcile.js');
const { keptInvoices } = await import('../server/ui/invoicing.js');
const { invoiceKindOf } = await import('/assets/ui/list-views.js');

const FIELD = '6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a';
const rows = reconcileRows({
  jobs: [
    { id: 'j1', clientName: 'Beta Clinic', practitioner: 'Dr B', status: 'Shipped', jobDate: '2026-03-02', totalCents: 5000, possible: 1, sourceSystem: 'lab', sourceJobRef: '101' },
    { id: 'j2', clientName: 'Alpha Clinic', practitioner: 'Dr A', status: 'In lab', jobDate: '2026-03-09', totalCents: 12000, possible: 0, sourceSystem: 'lab', sourceJobRef: '102' },
  ],
  invoices: [{ id: 'i1', number: 'INV-9', clientName: 'Beta Clinic', status: 'draft', issueDate: '2026-03-05', totalCents: 5000, possible: 1 }],
});
const values = new Map([[`lab\u0000101\u0000${FIELD}`, 'opt-rush']]);
const kindOf = (field) => ({ type: 'choice', status: 'choice', client: 'choice', practitioner: 'choice', date: 'date', total: 'number', match: 'check', [`field:${FIELD}`]: 'choice' })[field] ?? null;
const keep = (view, q = '') => keptRows(rows, view, q, { kindOf, valueOf: (row, id) => values.get(`${row.key}\u0000${id}`) ?? null, now: '2026-03-10' }).map((r) => r.id);
const one = (filters, match = 'all') => ({ match: 'all', groups: [{ match, filters }] });

test('Reconcile filters by Status, and a job-only field never hides invoices', () => {
  assert.deepEqual(keep(one([{ field: 'status', op: 'is', value: ['Shipped'] }])), ['j1']);
  assert.deepEqual(keep(one([{ field: 'practitioner', op: 'is', value: ['Dr A'] }])), ['i1', 'j2']);
  assert.deepEqual(keep(one([{ field: `field:${FIELD}`, op: 'is', value: ['opt-rush'] }])), ['j1', 'i1'], 'a custom field reads the job by its source key');
});

test('Reconcile groups join with And / Or, and dates use ClickUp ranges', () => {
  const jobs = { match: 'all', filters: [{ field: 'type', op: 'is', value: ['job'] }] };
  const big = { match: 'all', filters: [{ field: 'total', op: 'gt', value: 100 }] };
  assert.deepEqual(keep({ match: 'all', groups: [jobs, big] }), ['j2']);
  assert.deepEqual(keep({ match: 'any', groups: [jobs, big] }), ['j1', 'j2']);
  assert.deepEqual(keep(one([{ field: 'date', op: 'is', value: 'thisweek' }])), ['j2']);
  assert.deepEqual(keep(one([{ field: 'date', op: 'is', value: 'lastweek' }]), 'beta'), ['j1', 'i1']);
});

test('Invoices filters the rows of the tab shown', () => {
  const invoices = [
    { id: 'a', number: 'INV-1', contactName: 'Beta Clinic', reference: 'Dr B - P1', issueDate: '2026-03-02', totalCents: 5000, problems: [] },
    { id: 'b', number: null, contactName: 'Alpha Clinic', reference: null, createdAt: '2026-03-09T01:00:00Z', totalCents: 12000, problems: [{ message: 'No price' }] },
  ];
  const kept = (view) => keptInvoices(invoices, view, '2026-03-10').map((i) => i.id);
  assert.deepEqual(kept(one([{ field: 'client', op: 'is', value: ['Alpha Clinic'] }])), ['b']);
  assert.deepEqual(kept(one([{ field: 'problem', op: 'yes' }])), ['b']);
  assert.deepEqual(kept(one([{ field: 'reference', op: 'has', value: 'dr b' }])), ['a']);
  assert.deepEqual(kept(one([{ field: 'number', op: 'unset' }])), ['b']);
  assert.deepEqual(kept(one([{ field: 'date', op: 'is', value: 'thisweek' }])), ['b'], 'a draft uses the day it was made');
  assert.deepEqual(kept(one([{ field: 'total', op: 'lt', value: 100 }, { field: 'problem', op: 'yes' }], 'any')), ['a', 'b']);
});

test('Invoices filters by its own columns, its job and a custom field', () => {
  const field = '6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a';
  const person = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
  const invoices = [
    {
      id: 'a', number: 'INV-1', contactName: 'Beta Clinic', reference: 'Dr B - P1', issueDate: '2026-03-02', dueDate: '2026-03-01', totalCents: 5000, problems: [], tab: 'approved',
      job: { sourceSystem: 'lab', sourceJobRef: '101', caseRef: 'CASE-101', practitioner: 'Dr B', shippedOn: '2026-03-04' },
      fields: { [field]: true, [person]: 'p1' },
    },
    {
      id: 'b', number: null, contactName: 'Alpha Clinic', reference: null, createdAt: '2026-03-09T01:00:00Z', dueDate: null, totalCents: 12000, problems: [{ message: 'No price' }], tab: 'pending',
      job: null, fields: {},
    },
    {
      id: 'c', number: 'INV-3', contactName: 'Beta Clinic', reference: 'x', issueDate: '2026-03-08', dueDate: '2026-04-01', totalCents: 100, problems: [], tab: 'draft', sending: true,
      job: { sourceSystem: 'other', sourceJobRef: '102', caseRef: '6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5b', practitioner: null, shippedOn: null },
      fields: { [field]: false },
    },
  ];
  const kindOf = invoiceKindOf([{ id: field, type: 'checkbox' }, { id: person, type: 'person' }]);
  const kept = (filters, match = 'all') => keptInvoices(invoices, one(filters, match), '2026-03-10', { kindOf, me: 'p1' }).map((i) => i.id);
  assert.deepEqual(kept([{ field: 'due', op: 'is', value: 'overdue' }]), ['a']);
  assert.deepEqual(kept([{ field: 'status', op: 'is', value: ['sending'] }]), ['c']);
  assert.deepEqual(kept([{ field: 'status', op: 'is', value: ['pending'] }]), ['b']);
  assert.deepEqual(kept([{ field: 'linked', op: 'is', value: ['lab'] }]), ['a']);
  assert.deepEqual(kept([{ field: 'linked', op: 'unset' }]), ['b']);
  assert.deepEqual(kept([{ field: 'case', op: 'has', value: 'case-101' }]), ['a'], 'a record id is not a case number');
  assert.deepEqual(kept([{ field: 'case', op: 'set' }]), ['a']);
  assert.deepEqual(kept([{ field: 'practitioner', op: 'is', value: ['Dr B'] }]), ['a']);
  assert.deepEqual(kept([{ field: 'shipped', op: 'is', value: 'thismonth' }]), ['a']);
  assert.deepEqual(kept([{ field: `field:${field}`, op: 'yes' }]), ['a']);
  assert.deepEqual(kept([{ field: `field:${person}`, op: 'is', value: ['me'] }]), ['a']);
});

// The Price list: Filter, Group and Sort read the same rules on its own
// fields. A code can link to two systems; Linked "Is Xero" keeps it.
test('the Price list filters on Linked, and keeps its Group and Sort', async () => {
  const { normalisePriceView, PRICE_FIELDS, priceValue } = await import('/assets/ui/list-views.js');
  const { filterJobs } = await import('/assets/ui/job-view.js');
  const items = [
    { code: 'AA', links: [{ system: 'xero' }, { system: 'seazona' }] },
    { code: 'BB', links: [{ system: 'seazona' }] },
    { code: 'CC', links: [] },
  ];
  const kept = (op) => filterJobs(items, normalisePriceView({ groups: [{ filters: [{ field: 'linked', op, value: ['xero'] }] }] }),
    { valueOf: priceValue, kindOf: (f) => PRICE_FIELDS[f]?.kind ?? null, late: null, today: '2026-10-29' }).map((i) => i.code);
  assert.deepEqual(kept('is'), ['AA']);
  assert.deepEqual(kept('not'), ['BB', 'CC']);
  const view = normalisePriceView({ group: 'tax', groupDir: 'desc', sorts: [{ by: 'price', dir: 'desc' }, { by: 'nope' }] });
  assert.deepEqual([view.group, view.groupDir, view.sorts], ['tax', 'desc', [{ by: 'price', dir: 'desc' }]]);
  assert.equal(normalisePriceView({ group: 'price' }).group, 'none');
});
