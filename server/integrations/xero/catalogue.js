import { sql } from 'drizzle-orm';
import { readInvoicingSettings } from '../../core/invoicing-rules.js';
import { externalIdFor } from '../../core/links.js';
import { withXeroLane } from './governor.js';

// Flow's copy of a connected organisation's Xero contacts and items. A sync
// reads them all (a few calls: contacts 100 a page, items in one) and
// replaces the copy in one transaction, so invoice preview can match
// contacts and item codes without spending Xero calls. Creating a missing
// client (create-contact.js) writes one row into this copy; it does not
// change any other Xero contact. Flow never changes a Xero item.

// Xero dates come as "/Date(1792000000000+0000)/" or ISO text.
export function parseXeroDate(value) {
  if (!value) return null;
  const legacy = /^\/Date\((-?\d+)/.exec(String(value));
  const at = legacy ? Number(legacy[1]) : Date.parse(value);
  return Number.isFinite(at) ? new Date(at) : null;
}

// Names compare case-insensitively with spaces collapsed, as Xero's own
// contact name check does.
export function normaliseName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const toCents = (amount) => (typeof amount === 'number' && Number.isFinite(amount) ? Math.round(amount * 100) : null);
const blank = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

function phoneOf(contact, type) {
  const phone = (contact.Phones ?? []).find((item) => item.PhoneType === type);
  if (!phone) return null;
  return [phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].map(blank).filter(Boolean).join(' ') || null;
}

function addressOf(contact) {
  const list = contact.Addresses ?? [];
  const raw = list.find((item) => item.AddressType === 'POBOX') ?? list.find((item) => item.AddressType === 'STREET');
  if (!raw) return null;
  const address = {
    line1: blank(raw.AddressLine1),
    line2: blank(raw.AddressLine2),
    city: blank(raw.City),
    region: blank(raw.Region),
    postalCode: blank(raw.PostalCode),
    country: blank(raw.Country),
  };
  const kept = Object.fromEntries(Object.entries(address).filter(([, value]) => value));
  return Object.keys(kept).length ? kept : null;
}

export function mapContact(contact) {
  return {
    xeroContactId: contact.ContactID,
    name: String(contact.Name ?? '').trim(),
    firstName: blank(contact.FirstName),
    lastName: blank(contact.LastName),
    email: contact.EmailAddress || null,
    phone: phoneOf(contact, 'DEFAULT'),
    mobile: phoneOf(contact, 'MOBILE'),
    accountNumber: blank(contact.AccountNumber),
    taxNumber: blank(contact.TaxNumber),
    address: addressOf(contact),
    status: contact.ContactStatus || 'ACTIVE',
    isCustomer: Boolean(contact.IsCustomer),
    isSupplier: Boolean(contact.IsSupplier),
    salesTracking: (contact.SalesTrackingCategories ?? []).map((t) => ({ category: t.TrackingCategoryName, option: t.TrackingOptionName })),
    xeroUpdatedAt: parseXeroDate(contact.UpdatedDateUTC),
  };
}

export function mapItem(item) {
  return {
    xeroItemId: item.ItemID,
    code: String(item.Code ?? '').trim(),
    name: item.Name || null,
    description: item.Description || null,
    isSold: item.IsSold !== false,
    salesUnitAmountCents: toCents(item.SalesDetails?.UnitPrice),
    salesAccountCode: item.SalesDetails?.AccountCode || null,
    salesTaxType: item.SalesDetails?.TaxType || null,
    xeroUpdatedAt: parseXeroDate(item.UpdatedDateUTC),
  };
}

export async function upsertContact(db, organisationId, contact) {
  const address = contact.address ? JSON.stringify(contact.address) : null;
  await db.execute(sql`
    insert into xero_contacts (
      organisation_id, xero_contact_id, name, first_name, last_name, email, phone, mobile,
      account_number, tax_number, address, status, is_customer, is_supplier, sales_tracking, xero_updated_at, synced_at)
    values (
      ${organisationId}, ${contact.xeroContactId}, ${contact.name}, ${contact.firstName ?? null}, ${contact.lastName ?? null},
      ${contact.email ?? null}, ${contact.phone ?? null}, ${contact.mobile ?? null}, ${contact.accountNumber ?? null},
      ${contact.taxNumber ?? null}, ${address}::jsonb, ${contact.status}, ${contact.isCustomer}, ${contact.isSupplier},
      ${JSON.stringify(contact.salesTracking ?? [])}::jsonb, ${contact.xeroUpdatedAt ?? null}, now())
    on conflict (organisation_id, xero_contact_id) do update set
      name = excluded.name, first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email,
      phone = excluded.phone, mobile = excluded.mobile, account_number = excluded.account_number,
      tax_number = excluded.tax_number, address = excluded.address, status = excluded.status,
      is_customer = excluded.is_customer, is_supplier = excluded.is_supplier, sales_tracking = excluded.sales_tracking,
      xero_updated_at = excluded.xero_updated_at, synced_at = now()`);
}

async function replaceContacts(tx, organisationId, contacts) {
  const ids = contacts.map((c) => c.xeroContactId);
  await tx.execute(sql`delete from xero_contacts where organisation_id = ${organisationId}
    and not (xero_contact_id = any(${sql.param(ids)}::text[]))`);
  for (const contact of contacts) await upsertContact(tx, organisationId, contact);
}

async function replaceItems(tx, organisationId, items) {
  const ids = items.map((i) => i.xeroItemId);
  await tx.execute(sql`delete from xero_items where organisation_id = ${organisationId}
    and not (xero_item_id = any(${sql.param(ids)}::text[]))`);
  for (const i of items) {
    await tx.execute(sql`
      insert into xero_items (organisation_id, xero_item_id, code, name, description, is_sold, sales_unit_amount_cents, sales_account_code, sales_tax_type, xero_updated_at, synced_at)
      values (${organisationId}, ${i.xeroItemId}, ${i.code}, ${i.name}, ${i.description}, ${i.isSold}, ${i.salesUnitAmountCents}, ${i.salesAccountCode}, ${i.salesTaxType}, ${i.xeroUpdatedAt}, now())
      on conflict (organisation_id, xero_item_id) do update set
        code = excluded.code, name = excluded.name, description = excluded.description, is_sold = excluded.is_sold,
        sales_unit_amount_cents = excluded.sales_unit_amount_cents, sales_account_code = excluded.sales_account_code,
        sales_tax_type = excluded.sales_tax_type, xero_updated_at = excluded.xero_updated_at, synced_at = now()`);
  }
}

// Xero's DefaultSalesTax ("Tax Inclusive", "Tax Exclusive", "No Tax", or the
// LineAmountTypes names): true, false, or null when Xero gave none.
export function salesTaxInclusive(organisation) {
  const value = String(organisation?.DefaultSalesTax ?? '').replace(/[^a-z]/gi, '').toLowerCase();
  if (value === 'taxinclusive' || value === 'inclusive') return true;
  if (['taxexclusive', 'exclusive', 'notax'].includes(value)) return false;
  return null;
}

// Xero is the source for GST: each Flow price item takes its Xero item's tax
// (by the price list's link, else the same code), and "Prices include GST"
// takes Xero's default. A Xero item with no tax type leaves the Flow item as
// it is.
async function followXeroTax(tx, organisationId, { inclusive, taxTypes = {} }) {
  if (inclusive !== null) {
    await tx.execute(sql`insert into invoicing_settings (organisation_id, amounts_include_tax) values (${organisationId}, ${inclusive})
      on conflict (organisation_id) do update set amounts_include_tax = excluded.amounts_include_tax, updated_at = now()
      where invoicing_settings.amounts_include_tax is distinct from excluded.amounts_include_tax`);
  }
  const gst = [...new Set(['OUTPUT', 'OUTPUT2', taxTypes.GST].filter(Boolean))];
  await tx.execute(sql`
    update price_items p set tax_code = x.tax_code, updated_at = now()
    from (
      select p2.id, case when xi.sales_tax_type = any(${sql.param(gst)}::text[]) then 'GST' else 'GST_FREE' end as tax_code
      from price_items p2
      left join lateral (
        select external_id from price_item_links pl
        where pl.organisation_id = ${organisationId} and pl.price_item_id = p2.id and pl.system = 'xero'
        order by pl.created_at desc limit 1) l on true
      join xero_items xi on xi.organisation_id = ${organisationId}
        and (case when l.external_id is not null then xi.xero_item_id = l.external_id else xi.code = p2.code end)
      where p2.organisation_id = ${organisationId} and p2.archived_at is null and xi.sales_tax_type is not null
    ) x
    where p.id = x.id and p.tax_code <> x.tax_code`);
}

// Reads every Xero contact and item and replaces Flow's copy. A failed read
// leaves the copy as it was and records the failure.
export async function syncCatalogue(db, runtime, organisationId, { startedBy = null } = {}) {
  return runtime.serial(organisationId, () => withXeroLane('sync', async () => {
    const { client } = await runtime.clientFor(db, organisationId);
    const { rows: [run] } = await db.execute(sql`insert into xero_sync_runs (organisation_id, started_by) values (${organisationId}, ${startedBy}) returning id, started_at`);
    try {
      const contacts = (await client.listContacts()).map(mapContact).filter((c) => c.xeroContactId && c.name);
      // An item without a code cannot go on an invoice line by code.
      const items = (await client.listItems()).map(mapItem).filter((i) => i.xeroItemId && i.code);
      // Xero's own default for sales lines (Financial settings): Flow's
      // "Prices include GST" follows it. An unread or unknown answer changes nothing.
      // "GST from Xero" off (Settings, Invoicing): the read leaves both alone.
      const { taxFromXero } = await readInvoicingSettings(db, organisationId);
      const inclusive = taxFromXero ? salesTaxInclusive(await client.getOrganisation().catch(() => null)) : null;
      await db.transaction(async (tx) => {
        await replaceContacts(tx, organisationId, contacts);
        await replaceItems(tx, organisationId, items);
        if (taxFromXero) await followXeroTax(tx, organisationId, { inclusive, taxTypes: runtime.settings.taxTypes });
        await tx.execute(sql`update xero_sync_runs set status = 'succeeded', finished_at = now(), contact_count = ${contacts.length}, item_count = ${items.length} where id = ${run.id}`);
      });
      return { id: run.id, status: 'succeeded', contactCount: contacts.length, itemCount: items.length };
    } catch (error) {
      await db.execute(sql`update xero_sync_runs set status = 'failed', finished_at = now(), error_code = ${error.code ?? 'xero_sync_failed'}, error_message = ${String(error.message).slice(0, 500)} where id = ${run.id}`);
      throw error;
    }
  }));
}

export async function lastSync(db, organisationId) {
  const { rows } = await db.execute(sql`
    select id, status, started_at, finished_at, contact_count, item_count, error_code, error_message
    from xero_sync_runs where organisation_id = ${organisationId} order by started_at desc limit 1`);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    contactCount: row.contact_count,
    itemCount: row.item_count,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
  };
}

// When contacts and items were last copied from Xero, or null.
export async function lastSuccessfulSyncAt(db, organisationId) {
  const { rows } = await db.execute(sql`select max(finished_at) as at from xero_sync_runs where organisation_id = ${organisationId} and status = 'succeeded'`);
  return rows[0]?.at ?? null;
}

const contactRow = (row) => ({
  xeroContactId: row.xero_contact_id,
  name: row.name,
  firstName: row.first_name ?? null,
  lastName: row.last_name ?? null,
  email: row.email,
  phone: row.phone ?? null,
  mobile: row.mobile ?? null,
  accountNumber: row.account_number ?? null,
  taxNumber: row.tax_number ?? null,
  address: row.address ?? null,
  status: row.status,
  isCustomer: row.is_customer,
  isSupplier: row.is_supplier,
  salesTracking: row.sales_tracking,
  xeroUpdatedAt: row.xero_updated_at,
  syncedAt: row.synced_at,
});

const itemRow = (row) => ({
  xeroItemId: row.xero_item_id,
  code: row.code,
  name: row.name,
  description: row.description,
  isSold: row.is_sold,
  salesUnitAmountCents: row.sales_unit_amount_cents,
  salesAccountCode: row.sales_account_code,
  salesTaxType: row.sales_tax_type,
  syncedAt: row.synced_at,
});

export async function listContacts(db, organisationId, { q = '', limit = 200 } = {}) {
  const like = `%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await db.execute(sql`select * from xero_contacts where organisation_id = ${organisationId}
    and name ilike ${like} order by lower(name) limit ${Math.min(Math.max(1, Number(limit) || 200), 1000)}`);
  return rows.map(contactRow);
}

export async function listItems(db, organisationId) {
  const { rows } = await db.execute(sql`select * from xero_items where organisation_id = ${organisationId} order by code`);
  return rows.map(itemRow);
}

export async function itemsByCode(db, organisationId, codes) {
  const wanted = [...new Set(codes.filter(Boolean))];
  if (!wanted.length) return new Map();
  const { rows } = await db.execute(sql`select * from xero_items where organisation_id = ${organisationId}
    and code = any(${sql.param(wanted)}::text[])`);
  return new Map(rows.map((row) => [row.code, itemRow(row)]));
}

// The Xero item each Flow price code sends as. A Flow item linked to a Xero
// item (the price list's link, by Xero's ItemID, so a code changed in Xero
// still finds it) sends as that item, under Xero's own code. A link whose
// Xero item has left Xero's list is `linkMissing`: never fall back to the
// Flow code then. A Flow item with no link sends as the Xero item with the
// same code. Codes with neither are absent from the map.
export async function xeroItemsForCodes(db, organisationId, codes) {
  const wanted = [...new Set(codes.filter(Boolean))];
  if (!wanted.length) return new Map();
  const { rows } = await db.execute(sql`
    select p.code as flow_code, l.external_id as link_id, x.*
    from unnest(${sql.param(wanted)}::text[]) as w(code)
    left join price_items p on p.organisation_id = ${organisationId} and p.code = w.code
    left join lateral (
      select external_id from price_item_links pl
      where pl.organisation_id = ${organisationId} and pl.price_item_id = p.id and pl.system = 'xero'
      order by pl.created_at desc limit 1) l on true
    left join xero_items x on x.organisation_id = ${organisationId}
      and (case when l.external_id is not null then x.xero_item_id = l.external_id else x.code = w.code end)`);
  const found = new Map();
  for (const row of rows) {
    const code = row.flow_code;
    if (!code) continue;
    if (row.link_id && !row.xero_item_id) found.set(code, { linkMissing: true, xeroItemId: row.link_id });
    else if (row.xero_item_id) found.set(code, { ...itemRow(row), linked: Boolean(row.link_id) });
  }
  // A code with no Flow price item (an older document) still matches by code.
  const rest = wanted.filter((c) => !found.has(c));
  if (rest.length) for (const [code, item] of await itemsByCode(db, organisationId, rest)) found.set(code, item);
  return found;
}

// The Flow codes that send as a Xero item that sells: the rule field "Every
// item is in accounting" (invoice-rules.js) reads them. A gone link, a
// missing item and an item not set to be sold do not count.
export async function sellingCodes(db, organisationId, codes) {
  const items = await xeroItemsForCodes(db, organisationId, codes);
  return [...items].filter(([, item]) => !item.linkMissing && item.isSold !== false).map(([code]) => code);
}

// The Xero contact for a Flow contact name: exactly one active contact with
// the same name, or why not. A missing name can be created from the Flow
// contact when that setting is on (create-contact.js). A doubled name is
// still for a person to fix in Xero, then sync.
export async function matchContact(db, organisationId, name) {
  const wanted = normaliseName(name);
  const { rows } = await db.execute(sql`select * from xero_contacts where organisation_id = ${organisationId}
    and regexp_replace(lower(trim(name)), '\\s+', ' ', 'g') = ${wanted}`);
  const matches = rows.map(contactRow).filter((c) => c.status === 'ACTIVE' && normaliseName(c.name) === wanted);
  if (matches.length === 1) return { state: 'matched', contact: matches[0] };
  if (matches.length > 1) return { state: 'ambiguous', matches };
  return { state: 'missing' };
}

// The Xero contact for a Flow contact: the identity-map link first, then the
// name. A link Flow made stays matched after a rename on one side.
export async function matchContactFor(db, organisationId, { contactId = null, name }) {
  if (contactId) {
    const linked = await externalIdFor(db, organisationId, { system: 'xero', entity: 'contact', flowId: contactId });
    if (linked) {
      const { rows } = await db.execute(sql`select * from xero_contacts where organisation_id = ${organisationId} and xero_contact_id = ${linked}`);
      const contact = rows[0] ? contactRow(rows[0]) : null;
      if (contact?.status === 'ACTIVE') return { state: 'matched', contact, by: 'link' };
    }
  }
  return matchContact(db, organisationId, name);
}
