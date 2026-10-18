import { sql } from 'drizzle-orm';
import { withXeroLane } from './governor.js';

// Flow's copy of a connected organisation's Xero contacts and items. Xero
// owns them: Flow never creates or changes a Xero contact or item. A sync
// reads them all (a few calls: contacts 100 a page, items in one) and
// replaces the copy in one transaction, so invoice preview can match
// contacts and item codes without spending Xero calls.

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

export function mapContact(contact) {
  return {
    xeroContactId: contact.ContactID,
    name: String(contact.Name ?? '').trim(),
    email: contact.EmailAddress || null,
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

async function replaceContacts(tx, organisationId, contacts) {
  const ids = contacts.map((c) => c.xeroContactId);
  await tx.execute(sql`delete from xero_contacts where organisation_id = ${organisationId}
    and not (xero_contact_id = any(${sql.param(ids)}::text[]))`);
  for (const c of contacts) {
    await tx.execute(sql`
      insert into xero_contacts (organisation_id, xero_contact_id, name, email, status, is_customer, is_supplier, sales_tracking, xero_updated_at, synced_at)
      values (${organisationId}, ${c.xeroContactId}, ${c.name}, ${c.email}, ${c.status}, ${c.isCustomer}, ${c.isSupplier}, ${JSON.stringify(c.salesTracking)}::jsonb, ${c.xeroUpdatedAt}, now())
      on conflict (organisation_id, xero_contact_id) do update set
        name = excluded.name, email = excluded.email, status = excluded.status, is_customer = excluded.is_customer,
        is_supplier = excluded.is_supplier, sales_tracking = excluded.sales_tracking,
        xero_updated_at = excluded.xero_updated_at, synced_at = now()`);
  }
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
      await db.transaction(async (tx) => {
        await replaceContacts(tx, organisationId, contacts);
        await replaceItems(tx, organisationId, items);
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
  email: row.email,
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

// The Xero contact for a Flow contact name: exactly one active contact with
// the same name, or why not. Flow never creates a Xero contact (as before):
// a missing or doubled name is for a person to fix in Xero, then sync.
export async function matchContact(db, organisationId, name) {
  const wanted = normaliseName(name);
  const { rows } = await db.execute(sql`select * from xero_contacts where organisation_id = ${organisationId}
    and regexp_replace(lower(trim(name)), '\\s+', ' ', 'g') = ${wanted}`);
  const matches = rows.map(contactRow).filter((c) => c.status === 'ACTIVE' && normaliseName(c.name) === wanted);
  if (matches.length === 1) return { state: 'matched', contact: matches[0] };
  if (matches.length > 1) return { state: 'ambiguous', matches };
  return { state: 'missing' };
}
