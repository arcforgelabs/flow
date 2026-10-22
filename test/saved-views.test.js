import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_VIEW } from '../server/ui/job-view.js';
import { MAX_SAVED_VIEWS, normaliseSavedViews, pageViewCheck, sameView } from '../server/ui/list-views.js';
import { findPersonById, normaliseViews, seedFirstOwner, setPersonSavedViews, setPersonView } from '../server/auth/people.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// A person's named views of a list page and their default (list-views.js,
// saved-views.js), as ClickUp's view tabs. Synthetic data only.

const late = { match: 'all', groups: [{ match: 'all', filters: [{ field: 'due', op: 'is', value: 'overdue' }] }] };

test('saved views keep only good entries; a default must name one of them', () => {
  assert.deepEqual(normaliseSavedViews('jobs', null), { list: [], default: null });
  const saved = normaliseSavedViews('jobs', {
    list: [
      { id: 'a1', name: '  Late jobs ', view: { layout: 'list', ...late } },
      { id: 'a1', name: 'Twice', view: {} },
      { id: 'bad id!', name: 'Bad', view: {} },
      { id: 'b2', name: '   ', view: {} },
      { id: 'c3', name: 'x'.repeat(80), view: { layout: 'grid' } },
    ],
    default: 'a1',
  });
  assert.deepEqual(saved.list.map((v) => v.id), ['a1', 'c3']);
  assert.equal(saved.list[0].name, 'Late jobs');
  assert.equal(saved.list[0].view.layout, 'list');
  assert.deepEqual(saved.list[0].view.groups, late.groups);
  assert.equal(saved.list[1].name.length, 60);
  assert.equal(saved.list[1].view.layout, DEFAULT_VIEW.layout, 'a bad view value falls back');
  assert.equal(saved.default, 'a1');
  assert.equal(normaliseSavedViews('jobs', { list: saved.list, default: 'gone' }).default, null);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, view: {} }));
  assert.equal(normaliseSavedViews('jobs', { list: many }).list.length, MAX_SAVED_VIEWS);
});

test('each page checks its own view: Invoices and Reconcile keep only their filter fields', () => {
  const field = 'field:6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a';
  const view = { match: 'any', groups: [{ match: 'all', filters: [{ field: 'client', op: 'is', value: ['A'] }, { field: 'stage', op: 'is', value: ['B'] }, { field, op: 'set' }] }] };
  assert.deepEqual(pageViewCheck('invoices')(view).groups[0].filters.map((f) => f.field), ['client', field]);
  assert.deepEqual(pageViewCheck('reconcile')(view).groups[0].filters.map((f) => f.field), ['client', field]);
  const columns = { match: 'all', groups: [{ match: 'all', filters: [{ field: 'due', op: 'is', value: 'overdue' }, { field: 'linked', op: 'is', value: ['lab'] }, { field: 'stage', op: 'is', value: ['B'] }] }] };
  assert.deepEqual(pageViewCheck('invoices')(columns).groups[0].filters.map((f) => f.field), ['due', 'linked']);
  for (const page of ['nope', 'constructor', '__proto__']) assert.equal(pageViewCheck(page), null);
  assert.deepEqual(normaliseSavedViews('nope', { list: [{ id: 'a', name: 'A', view: {} }] }), { list: [], default: null });
  assert.equal(sameView('invoices', { groups: [] }, {}), true);
  assert.equal(sameView('invoices', view, {}), false);
});

describe('saved views follow the account', { skip: skipWithoutDatabase }, () => {
  let handle;
  before(async () => { handle = await freshDatabase(); });
  after(async () => { await handle?.close?.(); });

  test('saving one page keeps the other pages and the working view', async () => {
    const owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await setPersonView(handle.db, { id: owner.id, page: 'jobs', view: { group: 'client' } });
    const jobs = await setPersonSavedViews(handle.db, { id: owner.id, page: 'jobs', saved: { list: [{ id: 'v1', name: 'Late', view: late }], default: 'v1' } });
    assert.equal(jobs.default, 'v1');
    await setPersonSavedViews(handle.db, { id: owner.id, page: 'invoices', saved: { list: [{ id: 'v2', name: 'Mine', view: {} }] } });
    await setPersonView(handle.db, { id: owner.id, page: 'jobs', view: { group: 'stage' } });
    const views = normaliseViews((await findPersonById(handle.db, owner.id)).views);
    assert.equal(views.jobs.group, 'stage');
    assert.deepEqual(views.saved.jobs.list.map((v) => v.name), ['Late']);
    assert.equal(views.saved.jobs.default, 'v1');
    assert.deepEqual(views.saved.invoices, { list: [{ id: 'v2', name: 'Mine', view: { match: 'all', groups: [] } }], default: null });
    await assert.rejects(setPersonSavedViews(handle.db, { id: owner.id, page: 'constructor', saved: {} }), { code: 'not_found' });
  });
});
