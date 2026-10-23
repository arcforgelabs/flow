import { and, eq, isNull } from 'drizzle-orm';
import { organisations, priceItems, TAX_CODES } from '../db/schema.js';
import { createContact as insertContact } from './contacts.js';
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

// Contacts live in contacts.js. This name stays so existing callers keep working.
export const createContact = insertContact;

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
