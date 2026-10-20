import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { priceItemLinks, priceItems, reviewItems, TAX_CODES } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';
import { remapJobs } from './line-mapping.js';
import { openReview, resolveReview } from './review.js';

// The price list (docs/PRICE_LIST.md). Flow's own price items are the source
// of truth: a lab adds, changes and archives them here with no integration
// connected. Each connected system that keeps its own price list (Xero items,
// Seazona products) offers it through the port's `listPriceItems`, read from
// Flow's copy, so nothing here calls another system.
//
// A link joins one record of a system's list to one price item:
//   - Flow links by itself when both sides have the same code;
//   - a person links the rest;
//   - an accounting system (Xero) has one record per price item at most; a
//     work system (Seazona) can link many products to one price item.
// The price check compares each price item with its linked records. A
// difference is an alert only (review item `price_check`): Flow never changes
// a price on either side. "Mark resolved" accepts what the check found; the
// same finding never opens again, a new one does.

const invalid = (message) => new FlowError('invalid', message);
const REVIEW_KIND = 'price_check';
const MAX_ITEMS = 5000;
const FINDING_KINDS = Object.freeze(['price', 'tax', 'missing', 'not_linked']);
export { FINDING_KINDS };

const codeKey = (value) => String(value ?? '').trim().toLowerCase();

const shortText = (value, name, max, { required = false } = {}) => {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    if (required) throw invalid(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max) throw invalid(`${name} must be text of ${max} characters at most`);
  return value.trim();
};

// A price item as the API takes it. `partial` reads a change: only the fields
// it names.
export function readPriceItem(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('the price item must be an object');
  const known = ['code', 'name', 'description', 'unitAmountCents', 'taxCode', 'accountCode'];
  const unknown = Object.keys(raw).filter((k) => !known.includes(k));
  if (unknown.length) throw invalid(`unknown field: ${unknown[0]}`);
  const out = {};
  const has = (key) => !partial || key in raw;
  if (has('code')) out.code = shortText(raw.code, 'code', 30, { required: true });
  if (has('name')) out.name = shortText(raw.name, 'name', 200, { required: true });
  if (has('description')) out.description = shortText(raw.description, 'description', 1000);
  if (has('unitAmountCents')) {
    const cents = raw.unitAmountCents;
    if (!Number.isInteger(cents) || cents < 0 || cents > 100_000_000) throw invalid('unitAmountCents must be whole cents, 0 or more');
    out.unitAmountCents = cents;
  }
  if (has('taxCode')) {
    const taxCode = raw.taxCode ?? 'GST';
    if (!TAX_CODES.includes(taxCode)) throw invalid(`taxCode must be one of ${TAX_CODES.join(', ')}`);
    out.taxCode = taxCode;
  }
  if (has('accountCode')) out.accountCode = shortText(raw.accountCode, 'accountCode', 20);
  return out;
}

const shapeItem = (r) => ({
  id: r.id, code: r.code, name: r.name, description: r.description, unitAmountCents: r.unitAmountCents,
  taxCode: r.taxCode, accountCode: r.accountCode, archivedAt: r.archivedAt, updatedAt: r.updatedAt,
});

const conflictOf = (error) => error?.code === '23505' || error?.cause?.code === '23505';

async function loadItem(db, organisationId, id) {
  const [row] = await db.select().from(priceItems).where(and(eq(priceItems.organisationId, organisationId), eq(priceItems.id, id)));
  if (!row) throw notFound('price item');
  return row;
}

export async function createPriceItem(db, organisationId, raw, { personId = null } = {}) {
  const item = readPriceItem(raw);
  const [{ count }] = await db.select({ count: sql`count(*)::int` }).from(priceItems).where(eq(priceItems.organisationId, organisationId));
  if (count >= MAX_ITEMS) throw invalid(`an organisation can have ${MAX_ITEMS} price items at most`);
  try {
    const [row] = await db.insert(priceItems).values({ organisationId, ...item, updatedBy: personId }).returning();
    await remapJobs(db, organisationId);
    return shapeItem(row);
  } catch (error) {
    if (conflictOf(error)) throw new FlowError('conflict', `the code ${item.code} is already on the price list`);
    throw error;
  }
}

// A change to a price item. Invoice lines keep the price they were made with;
// jobs not yet invoiced map again on the next pipeline run.
export async function updatePriceItem(db, organisationId, id, raw, { personId = null } = {}) {
  const row = await loadItem(db, organisationId, id);
  const changes = readPriceItem(raw, { partial: true });
  if (!Object.keys(changes).length) return shapeItem(row);
  try {
    const [saved] = await db.update(priceItems).set({ ...changes, updatedBy: personId, updatedAt: sql`now()` })
      .where(eq(priceItems.id, row.id)).returning();
    await remapJobs(db, organisationId);
    return shapeItem(saved);
  } catch (error) {
    if (conflictOf(error)) throw new FlowError('conflict', `the code ${changes.code} is already on the price list`);
    throw error;
  }
}

// Archives (or brings back) a price item. An archived item keeps its invoice
// lines and its links; new lines no longer map to it.
export async function archivePriceItem(db, organisationId, id, { archived = true, personId = null } = {}) {
  const row = await loadItem(db, organisationId, id);
  const [saved] = await db.update(priceItems)
    .set({ archivedAt: archived ? (row.archivedAt ?? sql`now()`) : null, updatedBy: personId, updatedAt: sql`now()` })
    .where(eq(priceItems.id, row.id)).returning();
  await remapJobs(db, organisationId);
  return shapeItem(saved);
}

// Each connected system's list, by system id: { id, name, kind, syncedAt,
// items, byId }. A system that cannot answer is left out (it is off, or its
// copy is not there yet).
export async function readCatalogues(organisationId, systems = [], { log = console } = {}) {
  const out = new Map();
  for (const adapter of systems) {
    try {
      const answer = await adapter.capabilities.listPriceItems({ organisationId });
      if (!answer || !Array.isArray(answer.items)) continue;
      const items = answer.items.filter((i) => i && i.id);
      out.set(adapter.id, {
        id: adapter.id,
        name: adapter.name,
        kind: answer.kind === 'accounting' ? 'accounting' : 'work',
        syncedAt: answer.syncedAt ?? null,
        items,
        byId: new Map(items.map((i) => [String(i.id), i])),
      });
    } catch (error) {
      log.warn?.(`[price-list] ${adapter.id} price list could not be read: ${error.message}`);
    }
  }
  return out;
}

async function readLinks(db, organisationId) {
  return db.select().from(priceItemLinks).where(eq(priceItemLinks.organisationId, organisationId))
    .orderBy(asc(priceItemLinks.system), asc(priceItemLinks.externalCode));
}

// Links each record of a system's list whose code is a price item's code, when
// neither side is linked yet in a way that stops it. Answers how many it made.
export async function linkByCode(db, organisationId, catalogue, { items = null, links = null } = {}) {
  const all = items ?? await db.select().from(priceItems).where(eq(priceItems.organisationId, organisationId));
  const existing = links ?? await readLinks(db, organisationId);
  const mine = existing.filter((l) => l.system === catalogue.id);
  const linkedExternal = new Set(mine.map((l) => String(l.externalId)));
  const linkedItem = new Set(mine.map((l) => l.priceItemId));
  const byCode = new Map(all.filter((i) => !i.archivedAt).map((i) => [codeKey(i.code), i]));
  const rows = [];
  for (const record of catalogue.items) {
    const item = byCode.get(codeKey(record.code));
    if (!item || !codeKey(record.code) || linkedExternal.has(String(record.id))) continue;
    if (catalogue.kind === 'accounting' && linkedItem.has(item.id)) continue;
    rows.push({ organisationId, priceItemId: item.id, system: catalogue.id, externalId: String(record.id), externalCode: record.code ?? null, matchedBy: 'code' });
    linkedExternal.add(String(record.id));
    linkedItem.add(item.id);
  }
  if (!rows.length) return 0;
  const made = await db.insert(priceItemLinks).values(rows).onConflictDoNothing().returning({ id: priceItemLinks.id });
  return made.length;
}

// A person's link: `externalId` in `system`'s list goes to this price item.
// For an accounting system it replaces the item's earlier link; a record
// linked elsewhere moves here.
async function writeLink(db, organisationId, priceItemId, { system, externalId }, { catalogues, personId }) {
  const item = await loadItem(db, organisationId, priceItemId);
  const catalogue = catalogues.get(system);
  if (!catalogue) throw new FlowError('conflict', `${system} is not connected, or its price list has not been read yet`);
  const record = catalogue.byId.get(String(externalId ?? ''));
  if (!record) throw notFound(`${catalogue.name} record`);
  return db.transaction(async (tx) => {
    await tx.delete(priceItemLinks).where(and(
      eq(priceItemLinks.organisationId, organisationId), eq(priceItemLinks.system, system), eq(priceItemLinks.externalId, String(record.id)),
    ));
    if (catalogue.kind === 'accounting') {
      await tx.delete(priceItemLinks).where(and(
        eq(priceItemLinks.organisationId, organisationId), eq(priceItemLinks.system, system), eq(priceItemLinks.priceItemId, item.id),
      ));
    }
    const [row] = await tx.insert(priceItemLinks).values({
      organisationId, priceItemId: item.id, system, externalId: String(record.id), externalCode: record.code ?? null, matchedBy: 'person', createdBy: personId,
    }).returning();
    return row;
  });
}

export async function linkPriceItem(db, organisationId, priceItemId, { system, externalId }, { catalogues, personId = null }) {
  const link = await writeLink(db, organisationId, priceItemId, { system, externalId }, { catalogues, personId });
  await remapJobs(db, organisationId);
  return link;
}

// Many links at once (Reconcile prices, "Link sure matches"): each one as
// linkPriceItem makes it, then one remap. A link that fails stops the rest;
// the ones before it stay.
export const MAX_LINKS_AT_ONCE = 500;
export async function linkPriceItems(db, organisationId, links, { catalogues, personId = null }) {
  if (!Array.isArray(links) || !links.length) throw invalid('links must be a list of { priceItemId, system, externalId }');
  if (links.length > MAX_LINKS_AT_ONCE) throw invalid(`${MAX_LINKS_AT_ONCE} links at once at most`);
  const made = [];
  try {
    for (const link of links) {
      if (!link || typeof link !== 'object' || !link.priceItemId || !link.system || !link.externalId) {
        throw invalid('each link needs priceItemId, system and externalId');
      }
      made.push(await writeLink(db, organisationId, link.priceItemId, link, { catalogues, personId }));
    }
  } finally {
    if (made.length) await remapJobs(db, organisationId);
  }
  return made;
}

export async function unlinkPriceItem(db, organisationId, linkId) {
  const rows = await db.delete(priceItemLinks)
    .where(and(eq(priceItemLinks.organisationId, organisationId), eq(priceItemLinks.id, linkId))).returning();
  if (!rows.length) throw notFound('link');
  await remapJobs(db, organisationId);
}

// What differs between one price item and its linked records. Pure: the
// caller passes the item, its links and the catalogues.
export function findingsFor(item, links, catalogues) {
  const findings = [];
  for (const catalogue of catalogues.values()) {
    const mine = links.filter((l) => l.system === catalogue.id);
    if (!mine.length && catalogue.kind === 'accounting') {
      findings.push({ system: catalogue.id, kind: 'not_linked', code: item.code });
      continue;
    }
    for (const link of mine) {
      const record = catalogue.byId.get(String(link.externalId));
      const base = { system: catalogue.id, externalId: String(link.externalId), externalCode: record?.code ?? link.externalCode ?? null };
      if (!record) {
        findings.push({ ...base, kind: 'missing' });
        continue;
      }
      if (record.unitAmountCents !== null && record.unitAmountCents !== undefined && record.unitAmountCents !== item.unitAmountCents) {
        findings.push({ ...base, kind: 'price', flow: item.unitAmountCents, other: record.unitAmountCents });
      }
      if (record.taxCode && record.taxCode !== item.taxCode) {
        findings.push({ ...base, kind: 'tax', flow: item.taxCode, other: record.taxCode });
      }
    }
  }
  return findings;
}

// The same findings always give the same signature, so an accepted finding
// is never raised again, and a changed one is.
export function findingsSignature(item, findings) {
  const parts = findings.map((f) => [f.system, f.kind, f.externalId ?? '', f.flow ?? '', f.other ?? ''].join('|')).sort();
  return `${item.unitAmountCents}|${item.taxCode}|${parts.join(';')}`;
}

const moneyAtRisk = (findings) => findings.reduce((max, f) => (f.kind === 'price' ? Math.max(max, Math.abs(f.flow - f.other)) : max), 0);

async function lastClosedSignatures(db, organisationId, ids) {
  if (!ids.length) return new Map();
  const rows = await db.select({ flowId: reviewItems.flowId, evidence: reviewItems.evidence, state: reviewItems.state, resolution: reviewItems.resolution })
    .from(reviewItems)
    .where(and(eq(reviewItems.organisationId, organisationId), eq(reviewItems.kind, REVIEW_KIND), inArray(reviewItems.flowId, ids)))
    .orderBy(desc(reviewItems.updatedAt));
  const out = new Map();
  for (const row of rows) if (!out.has(row.flowId)) out.set(row.flowId, row);
  return out;
}

// The price check. Links by code first, then compares every live price item
// with its linked records and keeps one review item per price item in step:
// opened or refreshed while something differs, closed when nothing does.
// `only` checks one price item. Reads Flow's copies only.
export async function checkPrices(db, organisationId, { catalogues, only = null, actor = 'flow:price-check' }) {
  const items = await db.select().from(priceItems).where(eq(priceItems.organisationId, organisationId));
  let linked = 0;
  for (const catalogue of catalogues.values()) linked += await linkByCode(db, organisationId, catalogue, { items });
  const links = await readLinks(db, organisationId);
  const live = items.filter((i) => !i.archivedAt && (!only || i.id === only));
  const latest = await lastClosedSignatures(db, organisationId, live.map((i) => i.id));
  const summary = { linked, checked: live.length, differing: 0, opened: 0, closed: 0, accepted: 0 };
  for (const item of live) {
    const findings = findingsFor(item, links.filter((l) => l.priceItemId === item.id), catalogues);
    const signature = findingsSignature(item, findings);
    const last = latest.get(item.id);
    if (!findings.length) {
      if (last?.state === 'open') {
        await db.update(reviewItems).set({ state: 'resolved', resolution: 'prices_agree', resolvedBy: actor, resolvedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(eq(reviewItems.organisationId, organisationId), eq(reviewItems.kind, REVIEW_KIND), eq(reviewItems.flowId, item.id), eq(reviewItems.state, 'open')));
        summary.closed += 1;
      }
      continue;
    }
    summary.differing += 1;
    if (last && last.resolution === 'accepted' && last.evidence?.signature === signature) {
      summary.accepted += 1;
      continue;
    }
    await openReview(db, organisationId, {
      kind: REVIEW_KIND,
      entity: 'price_item',
      flowId: item.id,
      systems: [...new Set(findings.map((f) => f.system))],
      evidence: { code: item.code, name: item.name, signature, findings },
      moneyAtRiskCents: moneyAtRisk(findings),
    });
    if (last?.state !== 'open') summary.opened += 1;
  }
  return summary;
}

// "Mark resolved": checks the one price item again, then accepts what is
// still different, so the same finding stays closed.
export async function acceptFindings(db, organisationId, priceItemId, { catalogues, actor }) {
  await loadItem(db, organisationId, priceItemId);
  await checkPrices(db, organisationId, { catalogues, only: priceItemId, actor });
  const [open] = await db.select().from(reviewItems).where(and(
    eq(reviewItems.organisationId, organisationId), eq(reviewItems.kind, REVIEW_KIND),
    eq(reviewItems.flowId, priceItemId), eq(reviewItems.state, 'open'),
  ));
  if (!open) return { state: 'agree' };
  await resolveReview(db, organisationId, open.id, { resolution: 'accepted', actor });
  return { state: 'accepted' };
}

// Everything the price list screen shows: each price item with its links,
// the linked records and what differs; each system's records that link to no
// price item; and the systems themselves. Reads Flow's copies only.
export async function readPriceList(db, organisationId, { catalogues }) {
  const [items, links, open] = await Promise.all([
    db.select().from(priceItems).where(eq(priceItems.organisationId, organisationId)).orderBy(asc(priceItems.code)),
    readLinks(db, organisationId),
    db.select({ flowId: reviewItems.flowId }).from(reviewItems)
      .where(and(eq(reviewItems.organisationId, organisationId), eq(reviewItems.kind, REVIEW_KIND), eq(reviewItems.state, 'open'))),
  ]);
  const alerting = new Set(open.map((r) => r.flowId));
  const linksOf = new Map();
  for (const link of links) {
    if (!linksOf.has(link.priceItemId)) linksOf.set(link.priceItemId, []);
    linksOf.get(link.priceItemId).push(link);
  }
  const linked = new Set(links.map((l) => `${l.system}:${l.externalId}`));
  return {
    systems: [...catalogues.values()].map((c) => ({ id: c.id, name: c.name, kind: c.kind, syncedAt: c.syncedAt, count: c.items.length })),
    items: items.map((item) => {
      const mine = linksOf.get(item.id) ?? [];
      return {
        ...shapeItem(item),
        alert: alerting.has(item.id),
        findings: item.archivedAt ? [] : findingsFor(item, mine, catalogues),
        links: mine.map((l) => {
          const record = catalogues.get(l.system)?.byId.get(String(l.externalId)) ?? null;
          return { id: l.id, system: l.system, externalId: l.externalId, externalCode: l.externalCode, matchedBy: l.matchedBy, record };
        }),
      };
    }),
    unlinked: [...catalogues.values()].map((c) => ({
      system: c.id,
      records: c.items.filter((r) => r.sold !== false && !linked.has(`${c.id}:${r.id}`)),
    })),
  };
}
