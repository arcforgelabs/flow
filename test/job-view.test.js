import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  cleanFilterView, dateRange, DEFAULT_VIEW, fieldGroup, fieldIdOf, fieldLanes, filterCount, filterJobs, filterRows, groupJobs, keptStatuses, laneOf, matchesFilter,
  normaliseJobsView, sortJobs,
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
    ...DEFAULT_VIEW, layout: 'list', group: 'client', groupDir: 'desc', sorts: [{ by: 'total', dir: 'desc' }],
    groups: [{ match: 'any', filters: [{ field: 'status', op: 'is', value: ['Shipped'] }, { field: 'problem', op: 'yes', value: null }] }],
  });
  assert.deepEqual(normaliseJobsView({ layout: 'grid', group: 'colour', groupDir: 'up', sorts: 'due', match: 'some' }), DEFAULT_VIEW);
  assert.equal(filterRows(normaliseJobsView({ filters: Array.from({ length: 30 }, () => ({ field: 'problem', op: 'yes' })) })).length, 20);
  assert.equal(filterRows(normaliseJobsView({ filters: [{ field: 'status', op: 'is', value: Array.from({ length: 300 }, (_, i) => `S${i}`) }] }))[0].value.length, 100);
});

test('a view saved before filter and sort rows keeps its filters and sort, as rows', () => {
  const view = normaliseJobsView({ hide: ['Shipped', 7], late: true, problems: true, mine: true, sort: 'total', dir: 'desc' });
  assert.deepEqual(filterRows(view), [
    { field: 'status', op: 'not', value: ['Shipped'] },
    { field: 'due', op: 'is', value: 'overdue' },
    { field: 'problem', op: 'yes', value: null },
    { field: 'assignee', op: 'is', value: ['me'] },
  ]);
  assert.deepEqual(view.sorts, [{ by: 'total', dir: 'desc' }]);
  assert.deepEqual(normaliseJobsView({ sort: 'board', dir: 'desc' }).sorts, []);
});

test('a custom field can filter and sort, by its id', () => {
  const id = '6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a';
  const view = normaliseJobsView({ filters: [{ field: `field:${id}`, op: 'has', value: 'rush' }, { field: 'field:x', op: 'is' }, { field: `field:${id}`, op: 'nope' }], sorts: [{ by: `field:${id}`, dir: 'desc' }] });
  assert.deepEqual(filterRows(view), [{ field: `field:${id}`, op: 'has', value: 'rush' }]);
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
  assert.deepEqual(keep([{ field: 'due', op: 'is', value: 'overdue' }]), [3], 'overdue on the due date is the late check');
  assert.deepEqual(keep([{ field: 'problem', op: 'yes' }, { field: 'status', op: 'not', value: ['New'] }]), [2]);
  assert.deepEqual(keep([{ field: 'problem', op: 'no' }, { field: 'status', op: 'is', value: ['Shipped'] }], 'any'), [1, 2]);
  assert.deepEqual(keep([{ field: 'practitioner', op: 'unset' }]), [2]);
  assert.deepEqual(keep([{ field: 'total', op: 'gt', value: 10 }]), [2]);
  assert.deepEqual(keep([{ field: 'due', op: 'is', value: 'before:2026-01-04' }]), [3]);
  assert.deepEqual(keep([{ field: 'due', op: 'before', value: '2026-01-04' }]), [3], 'a row saved before ClickUp dates loads as "Is before"');
  assert.deepEqual(keep([{ field: 'due', op: 'not', value: 'today' }]), [1, 3], 'Is not keeps only jobs that have a day');
  assert.deepEqual(keep([{ field: 'client', op: 'hasnt', value: 'beta' }]), [1, 2, 3], 'a choice field has no "Does not contain"');
  assert.deepEqual(keep([{ field: 'status', op: 'is', value: [] }, { field: 'total', op: 'eq' }]), [1, 2, 3]);
  assert.equal(filterCount(normaliseJobsView({ filters: [{ field: 'status', op: 'is', value: [] }, { field: 'due', op: 'set' }] })), 1);
  assert.deepEqual(ids(filterJobs(jobs, normaliseJobsView({ filters: [{ field: 'field:6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a', op: 'set' }] }), { ...ctx, kindOf: () => null })), [1, 2, 3], 'a deleted custom field filters nothing');
});

test('one value against one filter row', () => {
  const at = { today: '2026-03-10' };
  const day = { ...at, kind: 'date' };
  assert.equal(matchesFilter({ op: 'is', value: 'today' }, '2026-03-10', day), true);
  assert.equal(matchesFilter({ op: 'is', value: 'next7' }, '2026-03-17', day), true);
  assert.equal(matchesFilter({ op: 'is', value: 'next7' }, '2026-03-18', day), false);
  assert.equal(matchesFilter({ op: 'is', value: 'last7' }, '2026-03-03', day), true);
  assert.equal(matchesFilter({ op: 'is', value: 'last7' }, '2026-03-10', day), false);
  assert.equal(matchesFilter({ op: 'is', value: 'overdue' }, '2026-03-09', day), true, 'a custom date is overdue once it has passed');
  assert.equal(matchesFilter({ op: 'is', value: 'between:2026-03-12..2026-03-01' }, '2026-03-05', day), true, 'a range typed backwards still works');
  assert.equal(matchesFilter({ op: 'not', value: 'thismonth' }, null, day), false, 'no day is not "not this month"');
  assert.equal(matchesFilter({ op: 'hasnt', value: 'rush' }, 'Normal', at), true);
  assert.equal(matchesFilter({ op: 'has', value: ' Rush ' }, 'A rush job', at), true);
  assert.equal(matchesFilter({ op: 'is', value: 'rush' }, 'Rush', at), true);
  assert.equal(matchesFilter({ op: 'unset' }, false, at), true, 'an unticked box is not set');
  assert.equal(matchesFilter({ op: 'lt', value: 5 }, null, at), false);
});

test('filter groups: And / Or inside a group and between groups', () => {
  const view = (match, groups) => normaliseJobsView({ match, groups });
  const shipped = { match: 'all', filters: [{ field: 'status', op: 'is', value: ['Shipped'] }] };
  const drA = { match: 'any', filters: [{ field: 'practitioner', op: 'is', value: ['Dr A'] }, { field: 'total', op: 'gt', value: 50 }] };
  assert.deepEqual(ids(filterJobs(jobs, view('any', [shipped, drA]), ctx)), [2, 3]);
  assert.deepEqual(ids(filterJobs(jobs, view('all', [shipped, drA]), ctx)), [2]);
  assert.deepEqual(ids(filterJobs(jobs, view('all', [shipped, { match: 'all', filters: [{ field: 'status', op: 'is', value: [] }] }]), ctx)), [2], 'a group still being filled in is left out');
  assert.deepEqual(view('any', []).groups, [], 'empty groups are not kept');
  assert.equal(view('any', [shipped]).match, 'any');
  assert.equal(normaliseJobsView({ groups: Array.from({ length: 15 }, () => shipped) }).groups.length, 10);
});

test('a saved filter keeps the old shape as one group, and drops rows a page does not know', () => {
  const kindOf = (field) => ({ client: 'choice', date: 'date' })[field] ?? null;
  assert.deepEqual(cleanFilterView({ match: 'any', filters: [{ field: 'client', op: 'is', value: ['A'] }, { field: 'date', op: 'next7' }, { field: 'stage', op: 'is' }] }, kindOf), {
    match: 'all', groups: [{ match: 'any', filters: [{ field: 'client', op: 'is', value: ['A'] }, { field: 'date', op: 'is', value: 'next7' }] }],
  });
  assert.deepEqual(cleanFilterView(null, kindOf), { match: 'all', groups: [] });
  assert.deepEqual(cleanFilterView({ groups: [{ filters: [{ field: 'date', op: 'is', value: 'later' }] }], match: 'nope' }, kindOf), { match: 'all', groups: [{ match: 'all', filters: [{ field: 'date', op: 'is', value: 'later' }] }] });
});

test("date values are ClickUp's ranges: weeks start on Monday, quarters are calendar quarters", () => {
  const at = '2026-03-11'; // a Wednesday
  assert.deepEqual(dateRange('thisweek', at), { from: '2026-03-09', to: '2026-03-15' });
  assert.deepEqual(dateRange('lastweek', at), { from: '2026-03-02', to: '2026-03-08' });
  assert.deepEqual(dateRange('nextmonth', at), { from: '2026-04-01', to: '2026-04-30' });
  assert.deepEqual(dateRange('lastmonth', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(dateRange('thisquarter', at), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(dateRange('nextquarter', '2026-11-02'), { from: '2027-01-01', to: '2027-03-31' });
  assert.deepEqual(dateRange('earlier', at), { from: null, to: at });
  assert.deepEqual(dateRange('later', at), { from: '2026-03-12', to: null });
  assert.deepEqual(dateRange('next:14', at), { from: at, to: '2026-03-25' });
  assert.deepEqual(dateRange('after:2026-03-01', at), { from: '2026-03-02', to: null });
  assert.equal(dateRange('next:0', at), null);
  assert.equal(dateRange('on:2026-3-1', at), null);
});

test('a status filter hides the lanes it leaves out; with "any", every lane shows', () => {
  const labels = ['New', 'Hold', 'Shipped'];
  assert.deepEqual(keptStatuses(normaliseJobsView({ filters: [{ field: 'status', op: 'not', value: ['Hold'] }] }), labels), ['New', 'Shipped']);
  assert.deepEqual(keptStatuses(normaliseJobsView({ filters: [{ field: 'status', op: 'is', value: ['Hold'] }] }), labels), ['Hold']);
  assert.deepEqual(keptStatuses(normaliseJobsView({ match: 'any', filters: [{ field: 'status', op: 'is', value: ['Hold'] }, { field: 'problem', op: 'yes' }] }), labels), labels);
  const hold = { match: 'all', filters: [{ field: 'status', op: 'is', value: ['Hold'] }] };
  const late = { match: 'all', filters: [{ field: 'due', op: 'is', value: 'overdue' }] };
  assert.deepEqual(keptStatuses(normaliseJobsView({ match: 'all', groups: [hold, late] }), labels), ['Hold']);
  assert.deepEqual(keptStatuses(normaliseJobsView({ match: 'any', groups: [hold, late] }), labels), labels, 'groups joined by Or hide no lane');
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
    assert.deepEqual(saved, { ...DEFAULT_VIEW, group: 'client', groups: [{ match: 'all', filters }] });
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
