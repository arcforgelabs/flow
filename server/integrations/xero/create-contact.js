import { createHash } from 'node:crypto';
import { getContact } from '../../core/contacts.js';
import { linkRecord } from '../../core/links.js';
import { mapContact, matchContactFor, normaliseName, upsertContact } from './catalogue.js';
import { xeroError } from './client.js';
import { readConnection } from './connections.js';
import { withXeroLane } from './governor.js';
import { writesAllowed } from './settings.js';

// Creates the Xero contact for one Flow contact (docs/CONTACTS.md). Flow's
// contact stays the record. Xero gets a copy, and this file stores that copy
// and the identity-map link. A second press for the same contact finds the
// first and creates nothing.

const PERSONS_MAX = 5;

export function xeroContactBody(contact) {
  const body = {
    Name: contact.name,
    IsCustomer: contact.kind === 'customer',
    IsSupplier: contact.kind === 'supplier',
  };
  if (contact.firstName) body.FirstName = contact.firstName;
  if (contact.lastName) body.LastName = contact.lastName;
  if (contact.email) body.EmailAddress = contact.email;
  if (contact.accountNumber) body.AccountNumber = contact.accountNumber;
  if (contact.taxNumber) body.TaxNumber = contact.taxNumber;
  const phones = [];
  if (contact.phone) phones.push({ PhoneType: 'DEFAULT', PhoneNumber: contact.phone });
  if (contact.mobile) phones.push({ PhoneType: 'MOBILE', PhoneNumber: contact.mobile });
  if (phones.length) body.Phones = phones;
  const address = contact.address;
  if (address && (address.line1 || address.city || address.postalCode)) {
    const lines = {
      AddressLine1: address.line1 || '',
      AddressLine2: address.line2 || '',
      City: address.city || '',
      Region: address.region || '',
      PostalCode: address.postalCode || '',
      Country: address.country || '',
    };
    body.Addresses = [{ AddressType: 'POBOX', ...lines }, { AddressType: 'STREET', ...lines }];
  }
  const people = (contact.practitioners ?? []).slice(0, PERSONS_MAX).map((person) => {
    const [first, ...rest] = String(person.name).trim().split(/\s+/);
    const out = { FirstName: first, IncludeInEmails: false };
    if (rest.length) out.LastName = rest.join(' ');
    if (person.email) out.EmailAddress = person.email;
    return out;
  });
  if (people.length) body.ContactPersons = people;
  return body;
}

function idempotencyKey(organisationId, contactId, body) {
  const digest = createHash('sha256').update([organisationId, contactId, JSON.stringify(body)].join('\u0000')).digest('hex');
  return `flow-xero-contact-${digest.slice(0, 40)}`;
}

async function remember(db, organisationId, flowId, xeroContact, matchedBy) {
  const mapped = mapContact(xeroContact);
  await upsertContact(db, organisationId, mapped);
  const link = await linkRecord(db, organisationId, {
    entity: 'contact', flowId, system: 'xero', externalId: mapped.xeroContactId, matchedBy,
  });
  return { contact: mapped, link: link.outcome };
}

function activeNamed(contacts, name) {
  const wanted = normaliseName(name);
  return contacts.filter((contact) => contact.ContactStatus !== 'ARCHIVED' && normaliseName(contact.Name) === wanted);
}

// What a pending invoice, or the contact page, can offer. No Xero calls.
export async function matchCustomer(db, runtime, { organisationId, contactId }) {
  const connection = await readConnection(db, organisationId);
  const connected = Boolean(connection && connection.mode === runtime.settings.mode);
  if (!connected) return { state: 'off', offerCreate: false, xeroContactId: null, name: null };
  const contact = await getContact(db, organisationId, contactId);
  const match = await matchContactFor(db, organisationId, { contactId, name: contact.name });
  return {
    state: match.state,
    offerCreate: match.state === 'missing' && runtime.settings.createContacts && writesAllowed(runtime.settings),
    xeroContactId: match.contact?.xeroContactId ?? null,
    name: match.contact?.name ?? null,
  };
}

export async function createCustomer(db, runtime, { organisationId, contactId, actor = null }) {
  if (!runtime.settings.createContacts) {
    throw xeroError('xero_create_contacts_off', 'Creating Xero clients is off. Add the client in Xero, then sync. Or turn Create missing clients on.', { status: 409 });
  }
  runtime.assertWritesAllowed();
  const flowContact = await getContact(db, organisationId, contactId);
  const known = await matchContactFor(db, organisationId, { contactId, name: flowContact.name });
  if (known.state === 'ambiguous') {
    throw xeroError('xero_contact_ambiguous', `More than one Xero contact is named "${flowContact.name}". Merge or rename them in Xero, then sync.`, { status: 409 });
  }
  if (known.state === 'matched') {
    const linked = await linkRecord(db, organisationId, {
      entity: 'contact', flowId: contactId, system: 'xero', externalId: known.contact.xeroContactId, matchedBy: known.by === 'link' ? 'created_by_flow' : 'exact_name',
    });
    return { outcome: 'existing', contact: known.contact, link: linked.outcome, actor };
  }

  return runtime.serial(organisationId, () => withXeroLane('writes', async () => {
    const { client } = await runtime.clientFor(db, organisationId);
    await runtime.assertEnvironment(client);
    const live = await client.findContactsByName(flowContact.name);
    const active = activeNamed(live, flowContact.name);
    if (active.length > 1) {
      throw xeroError('xero_contact_ambiguous', `More than one Xero contact is named "${flowContact.name}". Merge or rename them in Xero, then sync.`, { status: 409 });
    }
    if (!active.length && live.length) {
      throw xeroError('xero_contact_archived', `A Xero contact named "${flowContact.name}" is archived. Restore it in Xero, then sync.`, { status: 409 });
    }
    if (active.length === 1) {
      const kept = await remember(db, organisationId, contactId, active[0], 'exact_name');
      return { outcome: 'existing', ...kept };
    }
    const body = xeroContactBody(flowContact);
    const created = await client.createContact(body, { idempotencyKey: idempotencyKey(organisationId, contactId, body) });
    const kept = await remember(db, organisationId, contactId, created, 'created_by_flow');
    return { outcome: 'created', ...kept };
  }));
}
