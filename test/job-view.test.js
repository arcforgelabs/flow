import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  DEFAULT_VIEW, filterCount, filterJobs, groupJobs, normaliseJobsView, sortJobs,
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
  }), { layout: 'list', group: 'client', sort: 'total', dir: 'desc', hide: ['Shipped'], late: true, problems: false });
  assert.deepEqual(normaliseJobsView({ layout: 'grid', group: 'colour', sort: 'size', dir: 'up' }), DEFAULT_VIEW);
  assert.equal(normaliseJobsView({ hide: Array.from({ length: 300 }, (_, i) => `S${i}`) }).hide.length, 100);
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
