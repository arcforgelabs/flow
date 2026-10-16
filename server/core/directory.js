import { and, eq, isNull } from 'drizzle-orm';
import { contacts, organisations, priceItems, CONTACT_KINDS, TAX_CODES } from '../db/schema.js';
import { FlowError } from './errors.js';

// Organisations, contacts and the price list: the records invoices and bills
// refer to. Every read and write is scoped to one organisation.

export async function createOrganisation(db, { name, invoicePrefix }) {
  if (!name?.trim()) throw new FlowError('invalid', 'organisation name is required');
  const [row] = await db.insert(organisations)
    .values({ name: name.trim(), ...(invoicePrefix ? { invoicePrefix } : {}) })
    .returning();
  return row;
}

export async function createContact(db, organisationId, { kind, name, email = null }) {
  if (!CONTACT_KINDS.includes(kind)) throw new FlowError('invalid', `unknown contact kind: ${kind}`);
  if (!name?.trim()) throw new FlowError('invalid', 'contact name is required');
  const [row] = await db.insert(contacts)
    .values({ organisationId, kind, name: name.trim(), email })
    .returning();
  return row;
}

export async function createPriceItem(db, organisationId, { code, name, unitAmountCents, taxCode = 'GST' }) {
  if (!code?.trim() || !name?.trim()) throw new FlowError('invalid', 'price item code and name are required');
  if (!Number.isSafeInteger(unitAmountCents)) throw new FlowError('invalid', 'unitAmountCents must be whole cents');
  if (!TAX_CODES.includes(taxCode)) throw new FlowError('invalid', `unknown tax code: ${taxCode}`);
  const [row] = await db.insert(priceItems)
    .values({ organisationId, code: code.trim(), name: name.trim(), unitAmountCents, taxCode })
    .returning();
  return row;
}

export async function listPriceItems(db, organisationId) {
  return db.select().from(priceItems)
    .where(and(eq(priceItems.organisationId, organisationId), isNull(priceItems.archivedAt)))
    .orderBy(priceItems.code);
}
