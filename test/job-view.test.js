import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  DEFAULT_VIEW, fieldGroup, fieldIdOf, fieldLanes, filterCount, filterJobs, groupJobs, keptStatuses, laneOf, matchesFilter, normaliseJobsView, sortJobs,
} from '../server/ui/job-view.js';
import {
  findPersonById, normaliseViews, seedFirstOwner, setPersonAppearance, setPersonView,
} from '../server/auth/people.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// A person's own view of the Jobs page (server/ui/job-view.js). Synthetic data only.

const jobs = [
  { id: 1, clientName: 'Beta Clinic', practitioner: 'Dr B', status: 'New', dueOn: '2026-01-05', totalCents: 500 },
  { id: 2, clientName: 'alpha Clinic', practitioner: null, status: 'Shipped', dueOn: null, orderedOn: '2026-01-01', totalCents: 9000 },
  { id: 3, clientName: 'Gamma Clinic', practitioner: 'Dr A', status: 'New', dueOn: '2026-01-03', totalCents: null },
];
const ids = (list) => list.map((job) => job.id);

test('a saved view keeps only known values; anything else falls back to the default', () => {
  assert.deepEqual(normaliseJobsView(null), DEFAULT_VIEW);
  assert.deepEqual(normaliseJobsView([]), DEFAULT_VIEW);
  assert.deepEqual(normaliseJobsView({
    layout: 'list', group: 'client', groupDir: 'desc', sorts: [{ by: 'total', dir: 'desc' }, { by: 'total' }, { by: 'size' }, 'x'], match: 'any', extra: 1,
    filters: [{ field: 'status', op: 'is', value: ['Shipped', 'Shipped', 7, ''] }, { field: 'colour', op: 'is' }, { field: 'total', op: 'contains' }, { field: 'problem', op: 'yes', value: 'x' }],
  }), {
    ...DEFAULT_VIEW, layout: 'list', group: 'client', groupDir: 'desc', sorts: [{ by: 'total', dir: 'desc' }], match: 'any',
    filters: [{ field: 'status', op: 'is', value: ['Shipped'] }, { field: 'problem', op: 'yes', value: null }],
  });
  assert.deepEqual(normaliseJobsView({ layout: 'grid', group: 'colour', groupDir: 'up', sorts: 'due', match: 'some' }), DEFAULT_VIEW);
  assert.equal(normaliseJobsView({ filters: Array.from({ length: 30 }, () => ({ field: 'problem', op: 'yes' })) }).filters.length, 20);
  assert.equal(normaliseJobsView({ filters: [{ field: 'status', op: 'is', value: Array.from({ length: 300 }, (_, i) => `S${i}`) }] }).filters[0].value.length, 100);
});

test('a view saved before filter and sort rows keeps its filters and sort, as rows', () => {
  const view = normaliseJobsView({ hide: ['Shipped', 7], late: true, problems: true, mine: true, sort: 'total', dir: 'desc' });
  assert.deepEqual(view.filters, [
    { field: 'status', op: 'not', value: ['Shipped'] },
    { field: 'due', op: 'overdue', value: null },
    { field: 'problem', op: 'yes', value: null },
    { field: 'assignee', op: 'is', value: ['me'] },
  ]);
  assert.deepEqual(view.sorts, [{ by: 'total', dir: 'desc' }]);
  assert.deepEqual(normaliseJobsView({ sort: 'board', dir: 'desc' }).sorts, []);
});

test('a custom field can filter and sort, by its id', () => {
  const id = '6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a';
  const view = normaliseJobsView({ filters: [{ field: `field:${id}`, op: 'has', value: 'rush' }, { field: 'field:x', op: 'is' }, { field: `field:${id}`, op: 'nope' }], sorts: [{ by: `field:${id}`, dir: 'desc' }] });
  assert.deepEqual(view.filters, [{ field: `field:${id}`, op: 'has', value: 'rush' }]);
  assert.deepEqual(view.sorts, [{ by: `field:${id}`, dir: 'desc' }]);
});

test('a view keeps its known columns and custom field columns, once each', () => {
  const id = '6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a';
  assert.deepEqual(normaliseJobsView({ columns: ['due', 'ordered', 'due', 'colour', `field:${id}`, 'field:x'] }).columns, ['due', 'ordered', `field:${id}`]);
  assert.deepEqual(normaliseJobsView({ columns: [] }).columns, []);
  assert.deepEqual(normaliseJobsView({}).columns, [...DEFAULT_VIEW.columns]);
});

const ctx = {
  valueOf: (job, field) => ({ status: job.status, client: job.clientName, practitioner: job.practitioner, due: job.dueOn, total: job.totalCents == null ? null : job.totalCents / 100, problem: job.id !== 1, assignee: job.id === 3 ? 'p1' : null })[field] ?? null,
  late: (job) => job.id === 3,
  me: 'p1',
  today: '2026-01-04',
};
const keep = (filters, match = 'all') => ids(filterJobs(jobs, normaliseJobsView({ filters, match }), ctx));

test('"Assignee is Me" keeps only the jobs the person has', () => {
  const filters = [{ field: 'assignee', op: 'is', value: ['me'] }];
  assert.equal(filterCount(normaliseJobsView({ filters })), 1);
  assert.deepEqual(keep(filters), [3]);
});

test('a view can have no grouping: one plain list', () => {
  assert.equal(normaliseJobsView({ layout: 'list', group: 'none' }).group, 'none');
});

test('the account sends back only the pages Flow knows', () => {
  assert.deepEqual(normaliseViews(null), {});
  assert.deepEqual(normaliseViews({ jobs: { group: 'stage' }, other: { a: 1 } }), { jobs: { ...DEFAULT_VIEW, group: 'stage' } });
});

test('filter rows: each operator, all rows or any row, and a row still being filled in keeps every job', () => {
  assert.deepEqual(keep([{ field: 'status', op: 'not', value: ['Shipped'] }]), [1, 3]);
  assert.deepEqual(keep([{ field: 'status', op: 'is', value: ['Shipped'] }]), [2]);
  assert.deepEqual(keep([{ field: 'due', op: 'overdue' }]), [3], 'overdue on the due date is the late check');
  assert.deepEqual(keep([{ field: 'problem', op: 'yes' }, { field: 'status', op: 'not', value: ['New'] }]), [2]);
  assert.deepEqual(keep([{ field: 'problem', op: 'no' }, { field: 'status', op: 'is', value: ['Shipped'] }], 'any'), [1, 2]);
  assert.deepEqual(keep([{ field: 'practitioner', op: 'unset' }]), [2]);
  assert.deepEqual(keep([{ field: 'total', op: 'gt', value: 10 }]), [2]);
  assert.deepEqual(keep([{ field: 'due', op: 'before', value: '2026-01-04' }]), [3]);
  assert.deepEqual(keep([{ field: 'status', op: 'is', value: [] }, { field: 'total', op: 'eq' }]), [1, 2, 3]);
  assert.equal(filterCount(normaliseJobsView({ filters: [{ field: 'status', op: 'is', value: [] }, { field: 'due', op: 'set' }] })), 1);
  assert.deepEqual(ids(filterJobs(jobs, normaliseJobsView({ filters: [{ field: 'field:6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a', op: 'set' }] }), { ...ctx, kindOf: () => null })), [1, 2, 3], 'a deleted custom field filters nothing');
});

test('one value against one filter row', () => {
  const at = { today: '2026-03-10' };
  assert.equal(matchesFilter({ op: 'today' }, '2026-03-10', at), true);
  assert.equal(matchesFilter({ op: 'next7' }, '2026-03-17', at), true);
  assert.equal(matchesFilter({ op: 'next7' }, '2026-03-18', at), false);
  assert.equal(matchesFilter({ op: 'last7' }, '2026-03-03', at), true);
  assert.equal(matchesFilter({ op: 'last7' }, '2026-03-10', at), false);
  assert.equal(matchesFilter({ op: 'overdue' }, '2026-03-09', at), true, 'a custom date is overdue once it has passed');
  assert.equal(matchesFilter({ op: 'has', value: ' Rush ' }, 'A rush job', at), true);
  assert.equal(matchesFilter({ op: 'is', value: 'rush' }, 'Rush', at), true);
  assert.equal(matchesFilter({ op: 'unset' }, false, at), true, 'an unticked box is not set');
  assert.equal(matchesFilter({ op: 'lt', value: 5 }, null, at), false);
});

test('a status filter hides the lanes it leaves out; with "any", every lane shows', () => {
  const labels = ['New', 'Hold', 'Shipped'];
  assert.deepEqual(keptStatuses(normaliseJobsView({ filters: [{ field: 'status', op: 'not', value: ['Hold'] }] }), labels), ['New', 'Shipped']);
  assert.deepEqual(keptStatuses(normaliseJobsView({ filters: [{ field: 'status', op: 'is', value: ['Hold'] }] }), labels), ['Hold']);
  assert.deepEqual(keptStatuses(normaliseJobsView({ match: 'any', filters: [{ field: 'status', op: 'is', value: ['Hold'] }] }), labels), labels);
});

test('sorting keeps jobs with no value last, in either direction', () => {
  const sort = (sorts) => ids(sortJobs(jobs, normaliseJobsView({ sorts })));
  assert.deepEqual(sort([]), [1, 2, 3], 'the lab system order');
  assert.deepEqual(sort([{ by: 'due' }]), [2, 3, 1], 'the order date stands in when there is no due date');
  assert.deepEqual(sort([{ by: 'client' }]), [2, 1, 3], 'case does not matter');
  assert.deepEqual(sort([{ by: 'total', dir: 'desc' }]), [2, 1, 3]);
  assert.deepEqual(sort([{ by: 'total' }]), [1, 2, 3]);
  assert.deepEqual(sort([{ by: 'practitioner', dir: 'desc' }]), [1, 3, 2]);
});

test('a second sort orders the jobs the first one ties', () => {
  const tied = [...jobs, { id: 4, clientName: 'Delta', status: 'New', totalCents: 500 }];
  assert.deepEqual(ids(sortJobs(tied, normaliseJobsView({ sorts: [{ by: 'total' }, { by: 'client', dir: 'desc' }] }))), [4, 1, 2, 3]);
  const id = '6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a';
  const key = (job, by) => (by === `field:${id}` ? { 1: 'b', 2: null, 3: 'a' }[job.id] : null);
  assert.deepEqual(ids(sortJobs(jobs, normaliseJobsView({ sorts: [{ by: `field:${id}` }] }), key)), [3, 1, 2]);
});

test('groups keep their given order, keep empty ones, and add any label not given', () => {
  const groups = groupJobs(jobs, ['New', 'Hold'], (job) => job.status);
  assert.deepEqual(groups.map((g) => [g.label, ids(g.jobs)]), [['New', [1, 3]], ['Hold', []], ['Shipped', [2]]]);
});

test('a view can group by a custom field, by its id', () => {
  const id = '0a1b2c3d-0000-4000-8000-000000000001';
  assert.equal(normaliseJobsView({ group: fieldGroup(id) }).group, `field:${id}`);
  assert.equal(fieldIdOf(`field:${id}`), id);
  assert.equal(normaliseJobsView({ group: 'field:nope' }).group, 'status');
  assert.equal(fieldIdOf('status'), null);
});

test("a custom field's lanes: Not set first, live options in order, and an archived option a job still has", () => {
  const field = { type: 'dropdown', options: [{ id: 'a', name: 'Urgent', color: 'red' }, { id: 'b', name: 'Low' }, { id: 'c', name: 'Old', archived: true }, { id: 'd', name: 'Gone', archived: true }] };
  const values = { 1: 'a', 2: 'c', 3: null };
  const lanes = fieldLanes(field, { jobs: jobs.map((j) => j.id), valueOf: (id) => values[id] ?? null });
  assert.deepEqual(lanes.map((l) => [l.label, l.value]), [['Not set', null], ['Urgent', 'a'], ['Low', 'b'], ['Old (archived)', 'c']]);
  assert.equal(laneOf(lanes, 'a'), 'Urgent');
  assert.equal(laneOf(lanes, null), 'Not set');
  assert.equal(laneOf(lanes, 'unknown'), 'Not set');
  const person = fieldLanes({ type: 'person' }, { people: [{ id: 'p1', name: 'Ana' }], jobs: [1, 2], valueOf: (id) => (id === 2 ? 'p9' : null) });
  assert.deepEqual(person.map((l) => l.label), ['Not set', 'Ana', 'Former person 1']);
  const box = fieldLanes({ type: 'checkbox' });
  assert.deepEqual(box.map((l) => [l.label, l.value]), [['No', null], ['Yes', true]]);
  assert.equal(laneOf(box, false), 'No');
  assert.equal(laneOf(box, true), 'Yes');
});

describe('a saved view follows the account', { skip: skipWithoutDatabase }, () => {
  let handle;
  before(async () => { handle = await freshDatabase(); });
  after(async () => { await handle?.close?.(); });

  test('saving the Jobs view keeps the other saved settings', async () => {
    const owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await setPersonAppearance(handle.db, { id: owner.id, appearance: { colorMode: 'dark' } });
    const filters = [{ field: 'status', op: 'not', value: ['Hold'] }];
    const saved = await setPersonView(handle.db, { id: owner.id, page: 'jobs', view: { group: 'client', filters, bad: 1 } });
    assert.deepEqual(saved, { ...DEFAULT_VIEW, group: 'client', filters });
    await setPersonView(handle.db, { id: owner.id, page: 'jobs', view: { sorts: [{ by: 'total', dir: 'desc' }] } });
    const row = await findPersonById(handle.db, owner.id);
    assert.deepEqual(normaliseViews(row.views), { jobs: { ...DEFAULT_VIEW, sorts: [{ by: 'total', dir: 'desc' }] } });
    assert.equal(row.appearance.colorMode, 'dark');
    await assert.rejects(setPersonView(handle.db, { id: owner.id, page: 'nope', view: {} }), { code: 'not_found' });
    for (const page of ['constructor', '__proto__', 'toString']) {
      await assert.rejects(setPersonView(handle.db, { id: owner.id, page, view: {} }), { code: 'not_found' });
    }
  });
});
