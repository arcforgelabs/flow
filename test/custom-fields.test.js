import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { invitePerson, seedFirstOwner } from '../server/auth/people.js';
import { createPersonAuth } from '../server/auth/session.js';
import { createOrganisation } from '../server/core/directory.js';
import {
  archiveField, createField, deleteField, ensureAssignee, integrationConnectedAt, jobFieldHistory, listFields, listJobFieldValues, readField, readGroupColors,
  readOptions, setGroupColor, setJobFieldValue, TYPE_COLORS, updateField,
} from '../server/core/custom-fields.js';
import { createRegistry } from '../server/integrations/port.js';
import { fakeClerk, request, TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';

// Custom fields for jobs (docs/CUSTOM_FIELDS.md). Every name and job here is
// made up.
const quiet = { info() {}, warn() {}, error() {} };

// A work system whose job statuses show as a read-only Stage field.
const workSystem = {
  id: 'worksystem', name: 'Work system',
  capabilities: {
    health: async () => ({ ok: true }),
    listWork: async () => ({
      items: [],
      statuses: [{ label: 'In lab', final: false, firstSeenAt: '2026-03-02T00:00:00.000Z' }, { label: 'Shipped', final: true, firstSeenAt: '2026-03-04T00:00:00.000Z' }],
    }),
  },
};

test('a field is checked before it is saved', () => {
  const field = readField({ name: '  Priority  ', type: 'dropdown', options: [{ name: 'High', color: 'red' }, { name: 'Low' }] });
  assert.equal(field.name, 'Priority');
  assert.equal(field.options.length, 2);
  assert.ok(field.options.every((o) => o.id));
  assert.equal(field.options[1].color, 'gray');
  assert.throws(() => readField({ name: '', type: 'text' }), /name is required/i);
  assert.throws(() => readField({ name: 'X', type: 'formula' }), /type/);
  assert.throws(() => readField({ name: 'X', type: 'dropdown', options: [{ name: 'A' }, { name: 'a' }] }), /two options are named/);
  assert.throws(() => readField({ type: 'text' }, { partial: true, previous: { type: 'dropdown', options: [] } }), /type/);
  assert.equal(readField({ name: 'X', type: 'text', color: 'pink' }).color, 'pink');
  assert.equal(readField({ color: null }, { partial: true, previous: { type: 'text' } }).color, null);
  assert.throws(() => readField({ name: 'X', type: 'text', color: 'orange' }), /color/);
});

test('an option a person drops is kept as archived, so old values still read', () => {
  const [high, low] = readOptions([{ name: 'High' }, { name: 'Low' }]);
  const next = readOptions([{ id: high.id, name: 'Urgent' }], [high, low]);
  assert.deepEqual(next.map((o) => [o.id, o.name, Boolean(o.archived)]), [[high.id, 'Urgent', false], [low.id, 'Low', true]]);
});

describe('custom fields against PostgreSQL', { skip: skipWithoutDatabase }, () => {
  let handle;
  let lab;
  let app;
  let owner;
  let ownerToken;
  let staffToken;
  const job = { sourceSystem: 'worksystem', sourceJobRef: 'CASE-1001' };
  const call = (path, options = {}) => request(app, `/api/custom-fields${path}`, { token: ownerToken, ...options });

  before(async () => {
    handle = await freshDatabase();
    lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    const integrations = createRegistry({ log: quiet, env: {} });
    integrations.register(workSystem);
    integrations.enable('worksystem');
    await integrations.start(handle.db);
    const clerk = fakeClerk();
    owner = await seedFirstOwner(handle.db, 'owner@example.test');
    await invitePerson(handle.db, { email: 'staff@example.test', role: 'staff', invitedBy: owner.id });
    ownerToken = clerk.signIn(clerk.addUser({ email: 'owner@example.test', google: true, password: false }));
    staffToken = clerk.signIn(clerk.addUser({ email: 'staff@example.test' }));
    const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
    const personAuth = createPersonAuth({ db: handle.db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
    app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log: quiet });
  });

  after(async () => handle?.close());

  test('names are unique among live fields, and the type is fixed', async () => {
    const field = await createField(handle.db, lab.id, { name: 'Shade checked', type: 'checkbox' });
    await assert.rejects(createField(handle.db, lab.id, { name: 'shade CHECKED', type: 'text' }), /already exists/);
    await assert.rejects(updateField(handle.db, lab.id, field.id, { type: 'text' }), /type/);
    await archiveField(handle.db, lab.id, field.id);
    const again = await createField(handle.db, lab.id, { name: 'Shade checked', type: 'checkbox' });
    await assert.rejects(archiveField(handle.db, lab.id, field.id, { archived: false }), /already exists/);
    assert.deepEqual((await listFields(handle.db, lab.id)).map((f) => f.id), [again.id]);
    await archiveField(handle.db, lab.id, again.id);
  });

  test('a value is checked by type, and a stale move changes nothing', async () => {
    const field = await createField(handle.db, lab.id, { name: 'Priority', type: 'dropdown', options: [{ name: 'High' }, { name: 'Low' }] });
    const [high, low] = field.options;
    await assert.rejects(setJobFieldValue(handle.db, lab.id, { ...job, fieldId: field.id, value: 'not-an-option' }), /choose one of its options/);

    const first = await setJobFieldValue(handle.db, lab.id, { ...job, fieldId: field.id, value: high.id, expectedUpdatedAt: null }, { personId: owner.id });
    assert.equal(first.value, high.id);
    // Someone who still saw "no value" moves it: refused, with the current value.
    await assert.rejects(
      setJobFieldValue(handle.db, lab.id, { ...job, fieldId: field.id, value: low.id, expectedUpdatedAt: null }),
      (error) => error.code === 'conflict' && error.details.current.value === high.id,
    );
    const second = await setJobFieldValue(handle.db, lab.id, { ...job, fieldId: field.id, value: low.id, expectedUpdatedAt: first.updatedAt }, { personId: owner.id });
    assert.equal(second.value, low.id);

    const values = await listJobFieldValues(handle.db, lab.id, { jobs: [job] });
    assert.deepEqual(values.map((v) => v.value), [low.id]);
    const history = await jobFieldHistory(handle.db, lab.id, job);
    assert.deepEqual(history.map((e) => [e.from, e.to]), [[high.id, low.id], [null, high.id]]);

    const cleared = await setJobFieldValue(handle.db, lab.id, { ...job, fieldId: field.id, value: null });
    assert.equal(cleared.value, null);
    assert.equal((await listJobFieldValues(handle.db, lab.id, { jobs: [job] })).length, 0);
  });

  test('date, number, person and text values', async () => {
    const due = await createField(handle.db, lab.id, { name: 'Promised', type: 'date' });
    await assert.rejects(setJobFieldValue(handle.db, lab.id, { ...job, fieldId: due.id, value: '2026-02-30' }), /date/);
    assert.equal((await setJobFieldValue(handle.db, lab.id, { ...job, fieldId: due.id, value: '2026-11-03' })).value, '2026-11-03');
    const units = await createField(handle.db, lab.id, { name: 'Units', type: 'number' });
    await assert.rejects(setJobFieldValue(handle.db, lab.id, { ...job, fieldId: units.id, value: '3' }), /number/);
    const tech = await createField(handle.db, lab.id, { name: 'Technician', type: 'person' });
    assert.equal((await setJobFieldValue(handle.db, lab.id, { ...job, fieldId: tech.id, value: owner.id })).value, owner.id);
    await assert.rejects(setJobFieldValue(handle.db, lab.id, { ...job, fieldId: tech.id, value: '00000000-0000-4000-8000-000000000000' }), /cannot be chosen/);
  });

  test('the API: staff read and set values, only an owner or admin changes fields', async () => {
    const read = await call('');
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.systemFields.map((f) => [f.id, f.readOnly, f.options.map((o) => o.name)]),
      [['worksystem:stage', true, ['In lab', 'Shipped']]]);
    // Set up in the host's settings: connected when Flow first saw its work.
    assert.equal(read.body.systemFields[0].createdAt, '2026-03-02T00:00:00.000Z');
    assert.equal(read.body.groupColors.dropdown, TYPE_COLORS.dropdown);
    // A person field can name every active person, by name.
    assert.deepEqual(read.body.people.map((p) => p.name).sort(), ['owner', 'staff']);

    const refused = await call('', { method: 'POST', token: staffToken, body: { name: 'Rush', type: 'checkbox' } });
    assert.equal(refused.status, 403);
    const made = await call('', { method: 'POST', body: { name: 'Rush', type: 'checkbox' } });
    assert.equal(made.status, 201);
    const id = made.body.field.id;

    const set = await call('/values', { method: 'PUT', token: staffToken, body: { ...job, fieldId: id, value: true, expectedUpdatedAt: null } });
    assert.equal(set.status, 200);
    const stale = await call('/values', { method: 'PUT', token: staffToken, body: { ...job, fieldId: id, value: false, expectedUpdatedAt: null } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.details.current.value, true);

    const values = await call('/values');
    assert.ok(values.body.values.some((v) => v.fieldId === id && v.value === true));
    const history = await call(`/history?sourceSystem=${job.sourceSystem}&sourceJobRef=${job.sourceJobRef}`);
    assert.equal(history.status, 200);
    assert.ok(history.body.history.some((e) => e.fieldId === id));

    const fields = (await call('')).body.fields.map((f) => f.id);
    const order = await call('/order', { method: 'PUT', body: { ids: [...fields].reverse() } });
    assert.equal(order.status, 200);
    assert.deepEqual(order.body.fields.map((f) => f.id), [...fields].reverse());

    const renamed = await call(`/${id}`, { method: 'PUT', body: { name: 'Rush job' } });
    assert.equal(renamed.body.field.name, 'Rush job');
    const archived = await call(`/${id}/archive`, { method: 'POST', body: { archived: true } });
    assert.equal(archived.body.field.archived, true);
    assert.equal((await call('/nope', { method: 'PUT', body: { name: 'X' } })).status, 404);

    const coloured = await call(`/${id}`, { method: 'PUT', body: { color: 'red' } });
    assert.equal(coloured.status, 409); // archived: bring it back first
    await call(`/${id}/archive`, { method: 'POST', body: { archived: false } });
    assert.equal((await call(`/${id}`, { method: 'PUT', body: { color: 'red' } })).body.field.color, 'red');
    assert.equal((await call('/groups/checkbox', { method: 'PUT', token: staffToken, body: { color: 'pink' } })).status, 403);
    assert.equal((await call('/groups/checkbox', { method: 'PUT', body: { color: 'pink' } })).body.groupColors.checkbox, 'pink');
    assert.equal((await call('/groups/formula', { method: 'PUT', body: { color: 'pink' } })).status, 404);

    assert.equal((await call(`/${id}`, { method: 'DELETE', token: staffToken })).status, 403);
    const deleted = await call(`/${id}`, { method: 'DELETE' });
    assert.deepEqual([deleted.status, deleted.body.deleted.valuesDeleted], [200, 1]);
    assert.ok(!(await call('/values')).body.values.some((v) => v.fieldId === id));
    assert.equal((await call(`/${id}`, { method: 'DELETE' })).status, 404);
  });

  test('delete takes a field, its values and its history; archive keeps them', async () => {
    const field = await createField(handle.db, lab.id, { name: 'Shelf', type: 'text' });
    const otherJob = { sourceSystem: 'worksystem', sourceJobRef: 'CASE-2002' };
    await setJobFieldValue(handle.db, lab.id, { ...otherJob, fieldId: field.id, value: 'B3' });
    assert.equal((await listFields(handle.db, lab.id)).find((f) => f.id === field.id).valueCount, 1);
    const gone = await deleteField(handle.db, lab.id, field.id);
    assert.deepEqual([gone.name, gone.valuesDeleted], ['Shelf', 1]);
    assert.equal((await listJobFieldValues(handle.db, lab.id, { jobs: [otherJob] })).length, 0);
    assert.equal((await jobFieldHistory(handle.db, lab.id, otherJob)).length, 0);
    await assert.rejects(deleteField(handle.db, lab.id, field.id), /not found/);
  });

  test('a group colour is the lab\'s own choice, and null puts back the type\'s colour', async () => {
    await setGroupColor(handle.db, lab.id, 'date', 'red');
    assert.equal((await readGroupColors(handle.db, lab.id)).date, 'red');
    await setGroupColor(handle.db, lab.id, 'date', null);
    assert.equal((await readGroupColors(handle.db, lab.id)).date, TYPE_COLORS.date);
    await assert.rejects(setGroupColor(handle.db, lab.id, 'date', 'orange'), /color/);
  });

  test('an integration is connected when its settings were first saved, else when Flow first saw its work', async () => {
    assert.equal(await integrationConnectedAt(handle.db, 'nothing-here'), null);
    assert.equal(await integrationConnectedAt(handle.db, 'nothing-here', '2026-01-05T00:00:00.000Z'), '2026-01-05T00:00:00.000Z');
    await handle.pool.query("insert into integration_settings (adapter_id, enabled, created_at) values ('worksystem', true, '2025-12-01T00:00:00Z')");
    assert.equal(await integrationConnectedAt(handle.db, 'worksystem', '2026-01-05T00:00:00.000Z'), '2025-12-01T00:00:00.000Z');
    await handle.pool.query("delete from integration_settings where adapter_id = 'worksystem'");
  });

  // Last: a second organisation makes the API ask which one.
  test('every lab gets an Assignee person field once; archived, it does not come back', async () => {
    const other = await createOrganisation(handle.db, { name: 'Second Example Lab' });
    const made = await ensureAssignee(handle.db, other.id);
    assert.deepEqual([made.name, made.type], ['Assignee', 'person']);
    assert.equal(await ensureAssignee(handle.db, other.id), null);
    await archiveField(handle.db, other.id, made.id);
    assert.equal(await ensureAssignee(handle.db, other.id), null);
    assert.deepEqual(await listFields(handle.db, other.id), []);
    // Deleted, it does not come back either.
    await deleteField(handle.db, other.id, made.id);
    assert.equal(await ensureAssignee(handle.db, other.id), null);
    assert.deepEqual(await listFields(handle.db, other.id, { archived: true }), []);
  });

});
