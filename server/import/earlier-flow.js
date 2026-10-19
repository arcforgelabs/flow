import { sql } from 'drizzle-orm';
import { contacts, organisations, priceItems } from '../db/schema.js';

// A one-off move of an installation's records from the earlier Flow codebase
// (its PostgreSQL database, read only) into a new, empty Flow database.
//
// What moves is only what the earlier database holds as a fact:
// - contacts, from its copy of the accounting system's contacts;
// - the price list, from its copy of the accounting system's sold items;
// - the invoice prefix and next number, so the first invoice Flow issues
//   follows the last one the accounting system holds.
// Patient and case details, sync state and logins never move. Integrations
// read their own records again from their source once they are on.
//
// planImport is pure: it turns the source rows into the rows to write and a
// list of every source row it leaves out, with the reason. applyImport writes
// the plan in one transaction and checks each table's count before it commits.

const SOURCE_QUERIES = {
  contacts: `SELECT contact_id, name, email_address, status, raw_json FROM xero_catalog_contacts ORDER BY contact_id`,
  items: `SELECT item_code, name, description, sales_details_json, is_sold FROM xero_catalog_items ORDER BY item_code`,
  invoices: `SELECT invoice_number, type FROM xero_catalog_invoices WHERE invoice_number IS NOT NULL`,
};

// Accounting tax types that charge GST on a sale. Every other set type is GST
// free (exempt, export, outside the GST system).
const GST_TAX_TYPES = new Set(['OUTPUT', 'OUTPUT2']);
const SKIPPED_CONTACT_STATUSES = new Set(['ARCHIVED', 'GDPRREQUEST']);

export async function readEarlierFlow(pool) {
  const source = {};
  for (const [name, query] of Object.entries(SOURCE_QUERIES)) {
    source[name] = (await pool.query(query)).rows;
  }
  return source;
}

function parseJson(text) {
  if (text === null || text === undefined || text === '') return {};
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The earlier codebase stored some accounting payloads as the API sent them
// (`UnitPrice`) and some as its SDK returned them (`unitPrice`).
function field(object, name) {
  return object[name] ?? object[name[0].toLowerCase() + name.slice(1)];
}

function isTrue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

// A decimal amount to whole cents, half away from zero, without float drift.
export function toCents(amount) {
  const text = String(amount ?? '').trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const digits = (fraction + '000').slice(0, 3);
  let cents = Number(whole) * 100 + Number(digits.slice(0, 2));
  if (Number(digits[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return sign === '-' && cents !== 0 ? -cents : cents;
}

function planContacts(rows, skipped) {
  const planned = [];
  const seen = new Set();
  for (const row of rows) {
    const key = row.contact_id;
    const name = String(row.name ?? '').trim();
    const status = String(row.status ?? '').toUpperCase();
    if (!name) {
      skipped.push({ table: 'contacts', key, reason: 'no_name' });
      continue;
    }
    if (SKIPPED_CONTACT_STATUSES.has(status)) {
      skipped.push({ table: 'contacts', key, reason: `status_${status.toLowerCase()}` });
      continue;
    }
    const raw = parseJson(row.raw_json);
    if (raw === null) {
      skipped.push({ table: 'contacts', key, reason: 'unreadable_raw_json' });
      continue;
    }
    const customer = isTrue(field(raw, 'IsCustomer'));
    const supplier = isTrue(field(raw, 'IsSupplier'));
    // A contact the accounting system has never billed or paid is most often
    // a new customer, so it comes across as one.
    const kinds = supplier && !customer ? ['supplier'] : supplier ? ['customer', 'supplier'] : ['customer'];
    const email = String(row.email_address ?? '').trim() || null;
    for (const kind of kinds) {
      const unique = `${kind}\u0000${name}`;
      if (seen.has(unique)) {
        skipped.push({ table: 'contacts', key, reason: `duplicate_${kind}_name` });
        continue;
      }
      seen.add(unique);
      planned.push({ sourceKey: key, kind, name, email });
    }
  }
  return planned;
}

function planPriceItems(rows, skipped, defaulted) {
  const planned = [];
  for (const row of rows) {
    const key = row.item_code;
    const code = String(row.item_code ?? '').trim();
    const name = String(row.name ?? '').trim() || String(row.description ?? '').trim();
    if (!isTrue(row.is_sold)) {
      skipped.push({ table: 'price_items', key, reason: 'not_sold' });
      continue;
    }
    if (!code || !name) {
      skipped.push({ table: 'price_items', key, reason: 'no_code_or_name' });
      continue;
    }
    const sales = parseJson(row.sales_details_json);
    if (sales === null) {
      skipped.push({ table: 'price_items', key, reason: 'unreadable_sales_details' });
      continue;
    }
    const unitAmountCents = toCents(field(sales, 'UnitPrice'));
    if (unitAmountCents === null) {
      skipped.push({ table: 'price_items', key, reason: 'no_sales_price' });
      continue;
    }
    const taxType = String(field(sales, 'TaxType') ?? '').trim().toUpperCase();
    if (!taxType) defaulted.push({ table: 'price_items', key, reason: 'no_tax_type_used_gst' });
    const taxCode = !taxType || GST_TAX_TYPES.has(taxType) ? 'GST' : 'GST_FREE';
    planned.push({ sourceKey: key, code, name, unitAmountCents, taxCode });
  }
  return planned;
}

// The prefix and next number after the highest sales invoice number, so Flow
// never issues a number the accounting system already holds.
function planNumbering(rows, fallbackPrefix) {
  const byPrefix = new Map();
  for (const row of rows) {
    if (String(row.type ?? '').toUpperCase() !== 'ACCREC') continue;
    const match = /^(.*?)(\d+)$/.exec(String(row.invoice_number ?? '').trim());
    if (!match) continue;
    const [, prefix, digits] = match;
    const entry = byPrefix.get(prefix) ?? { count: 0, highest: 0 };
    entry.count += 1;
    entry.highest = Math.max(entry.highest, Number(digits));
    byPrefix.set(prefix, entry);
  }
  // The prefix most invoices use is the organisation's numbering.
  let best = null;
  for (const [prefix, entry] of byPrefix) {
    if (!best || entry.count > best.count) best = { prefix, ...entry };
  }
  if (!best) return { invoicePrefix: fallbackPrefix, nextInvoiceNumber: 1, basis: 'no_sales_invoices' };
  return { invoicePrefix: best.prefix, nextInvoiceNumber: best.highest + 1, basis: 'highest_sales_invoice' };
}

export function planImport(source, { fallbackPrefix = 'INV-' } = {}) {
  const skipped = [];
  const defaulted = [];
  return {
    contacts: planContacts(source.contacts ?? [], skipped),
    priceItems: planPriceItems(source.items ?? [], skipped, defaulted),
    numbering: planNumbering(source.invoices ?? [], fallbackPrefix),
    skipped,
    defaulted,
  };
}

// Counts and reasons only. Names, emails and amounts stay out of logs.
export function summarisePlan(plan) {
  const reasons = {};
  for (const entry of [...plan.skipped, ...plan.defaulted]) {
    const key = `${entry.table}: ${entry.reason}`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  return {
    contacts: {
      customer: plan.contacts.filter((c) => c.kind === 'customer').length,
      supplier: plan.contacts.filter((c) => c.kind === 'supplier').length,
    },
    priceItems: plan.priceItems.length,
    numbering: plan.numbering,
    leftOutOrDefaulted: reasons,
  };
}

async function countRows(tx, table, organisationId) {
  const [{ count }] = (await tx.execute(
    sql`select count(*)::int as count from ${table} where organisation_id = ${organisationId}`,
  )).rows;
  return count;
}

// Writes the plan into a database that has no organisation yet. Everything
// is one transaction: any error, or a count that does not match, writes
// nothing.
export async function applyImport(db, plan, { organisationName }) {
  if (!organisationName?.trim()) throw new Error('organisationName is required');
  return db.transaction(async (tx) => {
    const [{ count: existing }] = (await tx.execute(sql`select count(*)::int as count from ${organisations}`)).rows;
    if (existing > 0) throw new Error('the target database already has an organisation; import only into a new Flow database');

    const [organisation] = await tx.insert(organisations).values({
      name: organisationName.trim(),
      invoicePrefix: plan.numbering.invoicePrefix,
      nextInvoiceNumber: plan.numbering.nextInvoiceNumber,
    }).returning();
    const organisationId = organisation.id;

    for (const contact of plan.contacts) {
      await tx.insert(contacts).values({ organisationId, kind: contact.kind, name: contact.name, email: contact.email });
    }
    for (const item of plan.priceItems) {
      await tx.insert(priceItems).values({
        organisationId, code: item.code, name: item.name, unitAmountCents: item.unitAmountCents, taxCode: item.taxCode,
      });
    }

    const counts = {
      contacts: await countRows(tx, contacts, organisationId),
      priceItems: await countRows(tx, priceItems, organisationId),
    };
    if (counts.contacts !== plan.contacts.length || counts.priceItems !== plan.priceItems.length) {
      throw new Error(`row counts do not match the plan: ${JSON.stringify(counts)}`);
    }
    return { organisationId, counts };
  });
}
