import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sql } from 'drizzle-orm';
import { saveAutomation } from '../server/core/automations.js';
import { createContact, getContact, listContacts, updateContact } from '../server/core/contacts.js';
import { createOrganisation } from '../server/core/directory.js';
import { externalIdFor, linkRecord } from '../server/core/links.js';
import { linkCustomers } from '../server/core/pipeline.js';
import { listReview } from '../server/core/review.js';
import { upsertContact } from '../server/integrations/xero/catalogue.js';
import {
  CONTACT_DIFFERS, fieldsOf, planContactSync, syncContactEdits, syncContactsForAll, xeroContactChanges,
} from '../server/integrations/xero/contact-sync.js';
import { matchCustomer } from '../server/integrations/xero/create-contact.js';
import { listCustomers } from '../server/integrations/xero/lookup.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, quietLog, scriptedXero, xeroAnswer } from './support/xero.js';

const flowSide = (fields) => fieldsOf({ name: 'Harbour Dental', ...fields });

test('the side that changed a field since the base wins; both changed is a clash', () => {
  const base = flowSide({ email: 'a@x.example', phone: '1' });
  const plan = planContactSync(
    flowSide({ email: 'b@x.example', phone: '1', accountNumber: 'X' }),
    flowSide({ email: 'a@x.example', phone: '2', accountNumber: 'Y' }),
    base,
  );
  assert.deepEqual(plan.toXero, { email: 'b@x.example' });
  assert.deepEqual(plan.toFlow, { phone: '2' });
  assert.deepEqual(plan.clashes, [{ field: 'accountNumber', flow: 'X', xero: 'Y' }]);
  assert.equal(plan.base.accountNumber, null);
  assert.equal(plan.base.email, 'b@x.example');
});

test('the first compare fills blanks from either side and stops at values that differ', () => {
  const plan = planContactSync(
    flowSide({ email: 'a@x.example', taxNumber: '1' }),
    flowSide({ phone: '02 9000', taxNumber: '2', address: { city: 'Sydney ' } }),
    null,
  );
  assert.deepEqual(plan.toXero, { email: 'a@x.example' });
  assert.deepEqual(plan.toFlow, { phone: '02 9000', address: { city: 'Sydney' } });
  assert.deepEqual(plan.clashes.map((c) => c.field), ['taxNumber']);
});

test('a Xero body holds only the changed fields, and a blank clears one', () => {
  assert.deepEqual(xeroContactChanges({ email: null, name: 'New' }), { Name: 'New', EmailAddress: '' });
  const body = xeroContactChanges({ mobile: '0400', address: { city: 'Perth' } });
  assert.deepEqual(body.Phones, [{ PhoneType: 'MOBILE', PhoneNumber: '0400', PhoneAreaCode: '', PhoneCountryCode: '' }]);
  assert.deepEqual(body.Addresses.map((a) => [a.AddressType, a.City]), [['POBOX', 'Perth'], ['STREET', 'Perth']]);
});

describe('contacts with Xero', { skip: skipWithoutDatabase }, () => {
  let handle;
  let xero;
  let org;
  let n = 0;

  before(async () => {
    handle = await freshDatabase();
    xero = scriptedXero();
    await bootFlow(handle, { runtime: xero.runtime });
    org = (await createOrganisation(handle.db, { name: 'Example Lab' })).id;
    await connectDirectly(handle, xero.runtime, org);
  });

  after(async () => handle?.close());

  const xeroId = () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`;
  const copy = (id, name, fields = {}) => upsertContact(handle.db, org, {
    xeroContactId: id, name, status: 'ACTIVE', isCustomer: true, isSupplier: false, ...fields,
  });
  const live = (id, name, fields = {}) => ({ ContactID: id, Name: name, ContactStatus: 'ACTIVE', IsCustomer: true, ...fields });

  async function pair(name, flowFields, xeroFields) {
    const id = xeroId();
    const contact = await createContact(handle.db, org, { kind: 'customer', name, ...flowFields });
    await copy(id, name, xeroFields);
    await linkRecord(handle.db, org, { entity: 'contact', flowId: contact.id, system: 'xero', externalId: id, matchedBy: 'exact_name' });
    return { id, contact };
  }

  test('Add Xero clients makes each Xero client a Flow contact, and never a supplier', async () => {
    const harbour = xeroId();
    const supplier = xeroId();
    await copy(harbour, 'Bay Dental', { email: 'accounts@bay.example', accountNumber: 'BD-1', address: { city: 'Hobart' } });
    await copy(supplier, 'Plaster Supplies', { isCustomer: false, isSupplier: true });
    const customers = await listCustomers(handle.db, org);
    const result = await linkCustomers(handle.db, org, { system: 'xero', customers, adopt: true });
    assert.ok(result.added >= 1);
    const [bay] = await listContacts(handle.db, org, { q: 'Bay Dental' });
    assert.deepEqual([bay.email, bay.accountNumber, bay.address], ['accounts@bay.example', 'BD-1', { city: 'Hobart' }]);
    assert.equal(await externalIdFor(handle.db, org, { system: 'xero', entity: 'contact', flowId: bay.id }), harbour);
    assert.deepEqual(await listContacts(handle.db, org, { q: 'Plaster', kind: null }), []);
  });

  test('a Xero edit reaches Flow with no Xero call, and a later Flow edit reaches Xero', async () => {
    const { id, contact } = await pair('Edit Dental', { email: 'old@edit.example' }, { email: 'old@edit.example' });
    xero.script([]);
    await syncContactEdits(handle.db, xero.runtime, org);
    await copy(id, 'Edit Dental', { email: 'new@edit.example' });
    const none = xero.script([]);
    const first = await syncContactEdits(handle.db, xero.runtime, org);
    assert.equal(first.toFlow, 1);
    assert.equal(none.calls.length, 0);
    assert.equal((await getContact(handle.db, org, contact.id)).email, 'new@edit.example');

    await updateContact(handle.db, org, contact.id, { phone: '02 9000 0000' });
    const replay = xero.script([
      xeroAnswer(`Contacts/${id}`, { Contacts: [live(id, 'Edit Dental', { EmailAddress: 'new@edit.example' })] }),
      xeroAnswer(`Contacts/${id}`, { Contacts: [live(id, 'Edit Dental', {
        EmailAddress: 'new@edit.example', Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: '02 9000 0000' }],
      })] }, { method: 'POST', query: { summarizeErrors: 'false' } }),
    ]);
    const second = await syncContactEdits(handle.db, xero.runtime, org);
    assert.equal(second.toXero, 1);
    const post = replay.calls.find((c) => c.method === 'POST');
    assert.deepEqual(post.body.Contacts[0], {
      Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: '02 9000 0000', PhoneAreaCode: '', PhoneCountryCode: '' }], ContactID: id,
    });
    assert.match(post.headers['Idempotency-Key'], /^flow-xero-contact-edit-[0-9a-f]{40}$/);
    const quiet = xero.script([]);
    const third = await syncContactEdits(handle.db, xero.runtime, org);
    assert.equal(third.toXero, 0);
    assert.equal(quiet.calls.length, 0);
  });

  test('a Flow edit waits while Xero changed the same field live', async () => {
    const { id, contact } = await pair('Moved Dental', { email: 'a@moved.example' }, { email: 'a@moved.example' });
    xero.script([]);
    await syncContactEdits(handle.db, xero.runtime, org);
    await updateContact(handle.db, org, contact.id, { email: 'flow@moved.example' });
    const replay = xero.script([
      xeroAnswer(`Contacts/${id}`, { Contacts: [live(id, 'Moved Dental', { EmailAddress: 'xero@moved.example' })] }),
    ]);
    const result = await syncContactEdits(handle.db, xero.runtime, org);
    assert.equal(replay.calls.filter((c) => c.method === 'POST').length, 0);
    assert.ok(result.waiting >= 1);
    // The copy took Xero's value: the next pass sees both changed, a clash.
    xero.script([]);
    await syncContactEdits(handle.db, xero.runtime, org);
    const match = await matchCustomer(handle.db, xero.runtime, { organisationId: org, contactId: contact.id });
    assert.deepEqual(match.differs, [{ field: 'email', flow: 'flow@moved.example', xero: 'xero@moved.example' }]);
    const open = await listReview(handle.db, org, { kind: CONTACT_DIFFERS });
    assert.ok(open.some((item) => item.flowId === contact.id));

    // A person makes both the same: the item closes.
    await updateContact(handle.db, org, contact.id, { email: 'xero@moved.example' });
    await syncContactEdits(handle.db, xero.runtime, org);
    const after = await listReview(handle.db, org, { kind: CONTACT_DIFFERS });
    assert.ok(!after.some((item) => item.flowId === contact.id));
    assert.deepEqual((await matchCustomer(handle.db, xero.runtime, { organisationId: org, contactId: contact.id })).differs, []);
  });

  test('with writes off, a Flow edit waits and Xero is not called', async () => {
    const { contact } = await pair('Held Dental', {}, {});
    xero.script([]);
    await syncContactEdits(handle.db, xero.runtime, org);
    await updateContact(handle.db, org, contact.id, { email: 'held@held.example' });
    const before = xero.runtime.settings.backgroundJobs;
    xero.runtime.settings.backgroundJobs = false;
    try {
      const replay = xero.script([]);
      const result = await syncContactEdits(handle.db, xero.runtime, org);
      assert.ok(result.waiting >= 1);
      assert.equal(replay.calls.length, 0);
    } finally {
      xero.runtime.settings.backgroundJobs = before;
    }
  });

  test('the worker runs only while Two-way edits is on', async () => {
    const { id, contact } = await pair('Switch Dental', {}, {});
    await copy(id, 'Switch Dental', { email: 'x@switch.example' });
    xero.script([]);
    await syncContactsForAll(handle.db, xero.runtime, { log: quietLog() });
    assert.equal((await getContact(handle.db, org, contact.id)).email, null);
    await saveAutomation(handle.db, org, 'sync_contact_edits', { enabled: true });
    await syncContactsForAll(handle.db, xero.runtime, { log: quietLog() });
    assert.equal((await getContact(handle.db, org, contact.id)).email, 'x@switch.example');
    const { rows } = await handle.db.execute(sql`select base from xero_contact_sync where xero_contact_id = ${id}`);
    assert.equal(rows[0].base.email, 'x@switch.example');
  });
});
