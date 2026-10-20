import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  DEFAULT_VIEW, fieldGroup, fieldIdOf, fieldLanes, filterCount, filterJobs, groupJobs, laneOf, normaliseJobsView, sortJobs,
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
    layout: 'list', group: 'client', sort: 'total', dir: 'desc', hide: ['Shipped', 'Shipped', 7, '', 'x'.repeat(200)], late: true, problems: 'yes', extra: 1,
  }), { ...DEFAULT_VIEW, layout: 'list', group: 'client', sort: 'total', dir: 'desc', hide: ['Shipped'], late: true, problems: false });
  assert.deepEqual(normaliseJobsView({ layout: 'grid', group: 'colour', sort: 'size', dir: 'up' }), DEFAULT_VIEW);
  assert.equal(normaliseJobsView({ hide: Array.from({ length: 300 }, (_, i) => `S${i}`) }).hide.length, 100);
});

test('a view keeps its known columns and custom field columns, once each', () => {
  const id = '6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a';
  assert.deepEqual(normaliseJobsView({ columns: ['due', 'ordered', 'due', 'colour', `field:${id}`, 'field:x'] }).columns, ['due', 'ordered', `field:${id}`]);
  assert.deepEqual(normaliseJobsView({ columns: [] }).columns, []);
  assert.deepEqual(normaliseJobsView({}).columns, [...DEFAULT_VIEW.columns]);
});

test('"Assigned to me" keeps only the jobs the person has', () => {
  const view = normaliseJobsView({ mine: true });
  assert.equal(filterCount(view), 1);
  assert.deepEqual(ids(filterJobs(jobs, view, { status: (j) => j.status, late: () => true, problem: () => true, mine: (j) => j.id === 3 })), [3]);
});

test('a view can have no grouping: one plain list', () => {
  assert.equal(normaliseJobsView({ layout: 'list', group: 'none' }).group, 'none');
});

test('the account sends back only the pages Flow knows', () => {
  assert.deepEqual(normaliseViews(null), {});
  assert.deepEqual(normaliseViews({ jobs: { group: 'stage' }, other: { a: 1 } }), { jobs: { ...DEFAULT_VIEW, group: 'stage' } });
});

test('the filter hides statuses and can keep only late jobs or jobs with a problem', () => {
  const ctx = { status: (job) => job.status, late: (job) => job.id === 3, problem: (job) => job.id !== 1 };
  assert.deepEqual(ids(filterJobs(jobs, normaliseJobsView({ hide: ['Shipped'] }), ctx)), [1, 3]);
  assert.deepEqual(ids(filterJobs(jobs, normaliseJobsView({ late: true }), ctx)), [3]);
  assert.deepEqual(ids(filterJobs(jobs, normaliseJobsView({ problems: true, hide: ['New'] }), ctx)), [2]);
  assert.equal(filterCount(normaliseJobsView({ hide: ['A', 'B'], late: true })), 3);
});

test('sorting keeps jobs with no value last, in either direction', () => {
  const sort = (view) => ids(sortJobs(jobs, normaliseJobsView(view)));
  assert.deepEqual(sort({}), [1, 2, 3], 'the lab system order');
  assert.deepEqual(sort({ dir: 'desc' }), [3, 2, 1]);
  assert.deepEqual(sort({ sort: 'due' }), [2, 3, 1], 'the order date stands in when there is no due date');
  assert.deepEqual(sort({ sort: 'client' }), [2, 1, 3], 'case does not matter');
  assert.deepEqual(sort({ sort: 'total', dir: 'desc' }), [2, 1, 3]);
  assert.deepEqual(sort({ sort: 'total' }), [1, 2, 3]);
  assert.deepEqual(sort({ sort: 'practitioner', dir: 'desc' }), [1, 3, 2]);
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
    const saved = await setPersonView(handle.db, { id: owner.id, page: 'jobs', view: { group: 'client', hide: ['Hold'], bad: 1 } });
    assert.deepEqual(saved, { ...DEFAULT_VIEW, group: 'client', hide: ['Hold'] });
    await setPersonView(handle.db, { id: owner.id, page: 'jobs', view: { sort: 'total', dir: 'desc' } });
    const row = await findPersonById(handle.db, owner.id);
    assert.deepEqual(normaliseViews(row.views), { jobs: { ...DEFAULT_VIEW, sort: 'total', dir: 'desc' } });
    assert.equal(row.appearance.colorMode, 'dark');
    await assert.rejects(setPersonView(handle.db, { id: owner.id, page: 'nope', view: {} }), { code: 'not_found' });
    for (const page of ['constructor', '__proto__', 'toString']) {
      await assert.rejects(setPersonView(handle.db, { id: owner.id, page, view: {} }), { code: 'not_found' });
    }
  });
});
