import { and, asc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { contacts, CONTACT_KINDS, customerBillingSettings } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';

// Flow's own contacts (docs/CONTACTS.md). A contact is a customer or a
// supplier the lab bills or buys from. The fields are what Xero needs to
// bill them and what Seazona keeps for the practice a job belongs to.
// Practitioners are people at that practice. Flow stores no patient.

const NAME_MAX = 255;
const TEXT_MAX = 255;
const SHORT_MAX = 50;
const PRACTITIONERS_MAX = 30;
const ADDRESS_KEYS = ['line1', 'line2', 'city', 'region', 'postalCode', 'country'];

const invalid = (message) => new FlowError('invalid', message);

function text(value, name, max) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw invalid(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw invalid(`${name} is too long (${max} characters at most)`);
  return trimmed;
}

function readAddress(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('address must be an object');
  const out = {};
  for (const key of ADDRESS_KEYS) {
    const value = text(raw[key], `address.${key}`, TEXT_MAX);
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function readPractitioners(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw invalid('practitioners must be a list');
  if (raw.length > PRACTITIONERS_MAX) throw invalid(`a contact has ${PRACTITIONERS_MAX} practitioners at most`);
  return raw.map((item, index) => {
    const at = `practitioner ${index + 1}`;
    const source = typeof item === 'string' ? { name: item } : item;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw invalid(`${at} must be a name`);
    const name = text(source.name, `${at} name`, NAME_MAX);
    if (!name) throw invalid(`${at} needs a name`);
    const email = text(source.email, `${at} email`, TEXT_MAX);
    return email ? { name, email } : { name };
  });
}

// The fields a create or an update may set. `partial` is an update: only the
// keys the caller sent are returned.
export function readContact(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('contact must be an object');
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  if (!partial || has('kind')) {
    if (!CONTACT_KINDS.includes(input.kind)) throw invalid(`kind must be ${CONTACT_KINDS.join(' or ')}`);
    out.kind = input.kind;
  }
  if (!partial || has('name')) {
    const name = text(input.name, 'name', NAME_MAX);
    if (!name) throw invalid('contact name is required');
    out.name = name;
  }
  if (!partial || has('firstName')) out.firstName = text(input.firstName, 'firstName', NAME_MAX);
  if (!partial || has('lastName')) out.lastName = text(input.lastName, 'lastName', NAME_MAX);
  if (!partial || has('email')) out.email = text(input.email, 'email', TEXT_MAX);
  if (!partial || has('phone')) out.phone = text(input.phone, 'phone', SHORT_MAX);
  if (!partial || has('mobile')) out.mobile = text(input.mobile, 'mobile', SHORT_MAX);
  if (!partial || has('accountNumber')) out.accountNumber = text(input.accountNumber, 'accountNumber', SHORT_MAX);
  if (!partial || has('taxNumber')) out.taxNumber = text(input.taxNumber, 'taxNumber', SHORT_MAX);
  if (!partial || has('taxRate')) out.taxRate = text(input.taxRate, 'taxRate', SHORT_MAX);
  if (!partial || has('address')) out.address = readAddress(input.address);
  if (!partial || has('practitioners')) out.practitioners = readPractitioners(input.practitioners);
  if (!partial || has('active')) {
    if (input.active != null && typeof input.active !== 'boolean') throw invalid('active must be true or false');
    out.active = input.active !== false;
  }
  // Only when sent: a new contact is never hidden by default.
  if (has('hidden')) {
    if (typeof input.hidden !== 'boolean') throw invalid('hidden must be true or false');
    out.hidden = input.hidden;
  }
  return out;
}

function duplicate(error, kind) {
  const code = error?.code ?? error?.cause?.code;
  if (code === '23505') throw new FlowError('conflict', `A ${kind ?? 'contact'} with this name already exists.`);
  throw error;
}

// A hidden contact of that name (not a client, docs/CONTACTS.md) is the usual
// reason when the lists do not show it: say so. Read before the write, so a
// caller's transaction is never left aborted.
async function refuseHiddenName(db, organisationId, { kind, name }) {
  const [same] = await db.select({ id: contacts.id }).from(contacts).where(and(
    eq(contacts.organisationId, organisationId), eq(contacts.kind, kind), eq(contacts.name, name), eq(contacts.hidden, true),
  ));
  if (same) throw new FlowError('conflict', `A hidden ${kind} with this name exists. Show it in Contacts, Hidden.`, { contactId: same.id });
}

export function presentContact(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    mobile: row.mobile ?? null,
    accountNumber: row.accountNumber ?? null,
    taxNumber: row.taxNumber ?? null,
    taxRate: row.taxRate ?? null,
    address: row.address ?? null,
    practitioners: row.practitioners ?? [],
    active: row.active !== false,
    hidden: row.hidden === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createContact(db, organisationId, input) {
  const values = readContact(input);
  await refuseHiddenName(db, organisationId, values);
  try {
    const [row] = await db.insert(contacts).values({ organisationId, ...values }).returning();
    return row;
  } catch (error) {
    duplicate(error, values.kind);
  }
}

export async function getContact(db, organisationId, id) {
  const [row] = await db.select().from(contacts)
    .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, id)));
  if (!row) throw notFound('contact');
  return row;
}

export async function updateContact(db, organisationId, id, input) {
  const current = await getContact(db, organisationId, id);
  const patch = readContact(input, { partial: true });
  if (!Object.keys(patch).length) return current;
  try {
    const [row] = await db.update(contacts)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(contacts.organisationId, organisationId), eq(contacts.id, id)))
      .returning();
    return row;
  } catch (error) {
    duplicate(error, patch.kind ?? current.kind);
  }
}

// `kind` null lists customers and suppliers. `active` null lists both.
// `hidden` false (the default) leaves out the contacts that are not clients
// (docs/CONTACTS.md, "Hidden contacts"); true lists only those; null, both.
export async function listContacts(db, organisationId, { q = '', kind = 'customer', active = true, hidden = false, limit = 200, offset = 0 } = {}) {
  const where = [eq(contacts.organisationId, organisationId)];
  if (kind) where.push(eq(contacts.kind, kind));
  if (active === true) where.push(eq(contacts.active, true));
  if (active === false) where.push(eq(contacts.active, false));
  if (hidden === true) where.push(eq(contacts.hidden, true));
  if (hidden === false) where.push(eq(contacts.hidden, false));
  const needle = String(q ?? '').trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  if (needle) {
    const like = `%${needle}%`;
    where.push(or(ilike(contacts.name, like), ilike(contacts.email, like), ilike(contacts.accountNumber, like)));
  }
  const rows = await db.select().from(contacts).where(and(...where))
    .orderBy(asc(contacts.name), asc(contacts.id))
    .limit(limit)
    .offset(offset);
  return rows.map(presentContact);
}

// Bill to (docs/CONTACTS.md): the contact each customer's work is billed to
// in the accounting system. A customer with a payer bills to the payer; any
// other bills to itself. Answers a map for every id given.
export async function payersOf(db, organisationId, contactIds) {
  const ids = [...new Set(contactIds.filter(Boolean))];
  const out = new Map(ids.map((id) => [id, id]));
  if (!ids.length) return out;
  const rows = await db.select({ contactId: customerBillingSettings.contactId, payer: customerBillingSettings.billToContactId })
    .from(customerBillingSettings)
    .where(and(eq(customerBillingSettings.organisationId, organisationId), inArray(customerBillingSettings.contactId, ids),
      isNotNull(customerBillingSettings.billToContactId)));
  for (const r of rows) out.set(r.contactId, r.payer);
  return out;
}

// The customers that bill to each payer given, the payer included.
export async function billedBy(db, organisationId, payerIds) {
  const ids = [...new Set(payerIds.filter(Boolean))];
  const out = new Map(ids.map((id) => [id, new Set([id])]));
  if (!ids.length) return out;
  const rows = await db.select({ contactId: customerBillingSettings.contactId, payer: customerBillingSettings.billToContactId })
    .from(customerBillingSettings)
    .where(and(eq(customerBillingSettings.organisationId, organisationId), inArray(customerBillingSettings.billToContactId, ids)));
  for (const r of rows) out.get(r.payer).add(r.contactId);
  return out;
}

// The contact one customer is billed as: its payer, else itself.
export async function billedContact(db, organisationId, contactId) {
  const payer = (await payersOf(db, organisationId, [contactId])).get(contactId);
  return getContact(db, organisationId, payer);
}
