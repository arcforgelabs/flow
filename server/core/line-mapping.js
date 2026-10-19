import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { LINE_MAPPING_KINDS, lineMappings, pipelineCursors, priceItemLinks, priceItems } from '../db/schema.js';
import { FlowError, notFound } from './errors.js';

// Line mapping (docs/LINE_MAPPING.md): how each line a work system reports
// finds the lab's price item before the job reaches the ledger. The routine is
// a list of steps, tried in order; the first step that answers wins. Every
// step reads either the lab's price list or the lab's own mapping rows, so no
// lab's labels or codes are fixed in Flow's code.
//
// Before the steps, a line whose code is a linked product of its work system
// (the price list's links, server/core/price-list.js) takes that price item.
// A link is a person's or an exact code's choice, so it always goes first.
//
//   same_code           the line's own code is a price item code
//   account             an account row: a line with no price item (a surcharge)
//   saved               a row a person saved for this label at this price
//   catalog_name        exactly one price item has this name
//   price_alias         a row for this label at this price
//   catalog_name_price  the price items with this name, at this price: one wins,
//                       more than one stops the line for a person
//   catalog_score       the price item at this price whose name is closest
//   alias               a row for this label, or for the start of it
//
// A mapped line keeps the work system's amount and tax flag; the price item
// gives its code, its text and, when the work system gave none, its price and
// tax. With `linePrice: 'list'` the price item's price wins instead. A line
// no step answers keeps no code, so the ledger holds the job.

export const STEPS = Object.freeze([
  'same_code', 'account', 'saved', 'catalog_name', 'price_alias', 'catalog_name_price', 'catalog_score', 'alias',
]);
export const STEP_LABELS = Object.freeze({
  same_code: 'Same code',
  account: 'Account lines',
  saved: 'Saved choices',
  catalog_name: 'Price list name',
  price_alias: 'Label and price',
  catalog_name_price: 'Price list name and price',
  catalog_score: 'Closest name at the same price',
  alias: 'Label',
});
export const ZERO_LINES = Object.freeze(['keep', 'drop']);
// Where a mapped line's price comes from: the work system's amount (as the
// earlier app did), or the lab's own price list.
export const LINE_PRICES = Object.freeze(['work', 'list']);
export const MAPPING_DEFAULTS = Object.freeze({ steps: [...STEPS], zeroLines: 'keep', linePrice: 'work' });

const SCORE_MIN = 16;
const SCORE_GAP = 8;
const MAX_MAPPINGS = 2000;
const invalid = (message) => new FlowError('invalid', message);

// Text in the form every comparison uses: lower case, "&" as "and", every
// other mark a space.
export function lineText(value) {
  return String(value ?? '').trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The label without what varies between orders of the same item: sizes
// ("2 x 3"), arch ("upper", "lower 4") and "per set" or "per unit".
export function lineLookupText(value) {
  return lineText(value)
    .replace(/\b\d+\s*x\s*\d+(?:\s+\d+)?\b/g, ' ')
    .replace(/\b(upper|lower)\s+\d+\b/g, ' ')
    .replace(/\b(upper|lower)\b/g, ' ')
    .replace(/\bper set\b/g, ' ')
    .replace(/\bper unit\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A label that carries its own quantity and unit price: "Teeth (6 x $12.50)".
export function quantityOf(text) {
  const raw = String(text ?? '').trim();
  const found = raw.match(/\((\d+(?:\.\d+)?)\s*x\s*\$?([0-9]+(?:\.\d{1,2})?)\)/i);
  if (!found) return { base: raw, quantity: 1, unitAmountCents: null };
  const quantity = Number(found[1]);
  const base = raw.replace(found[0], ' ').replace(/\s+/g, ' ').trim();
  return {
    base: base || raw,
    quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
    unitAmountCents: Number.isInteger(quantity) && quantity > 0 ? Math.round(Number(found[2]) * 100) : null,
  };
}

const tokens = (text) => [...new Set(text.split(' ').filter((t) => t.length > 1))];

// How close a price item's name is to a label. The weights are the earlier
// lab app's, so its results carry over.
export function nameScore(item, { exact, lookup, original }) {
  const texts = [lineText(item.name), lineText(item.description)];
  const lookups = [lineLookupText(item.name), lineLookupText(item.description)];
  let score = 0;
  if (exact && texts.includes(exact)) score += 120;
  if (lookup && lookups.includes(lookup)) score += 90;
  if (lookup && lookups.some((t) => t && (t.includes(lookup) || lookup.includes(t)))) score += 35;
  const lookupTokens = new Set(lookups.flatMap(tokens));
  for (const token of tokens(lookup)) if (lookupTokens.has(token)) score += 8;
  const exactTokens = new Set(texts.flatMap(tokens));
  for (const token of tokens(exact)) if (exactTokens.has(token)) score += 8;
  if (original && texts.some((t) => t && t.includes(original))) score += 20;
  return score;
}

// The lab's price list and mapping rows, indexed once for a run.
export function mappingContext({ items = [], mappings = [], links = [], config = MAPPING_DEFAULTS } = {}) {
  const live = items.filter((i) => !i.archivedAt);
  // A linked work system code: its price item, by the code in lookup form.
  const byId = new Map(live.map((i) => [i.id, i]));
  const byLinkedCode = new Map();
  for (const link of links) {
    const item = byId.get(link.priceItemId);
    const code = lineText(link.externalCode);
    if (item && code && !byLinkedCode.has(code)) byLinkedCode.set(code, item);
  }
  const byCode = new Map(live.map((i) => [i.code, i]));
  const byCodeText = new Map(live.map((i) => [lineText(i.code), i]));
  const byText = new Map();
  const byPrice = new Map();
  const add = (map, key, item) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(item)) map.get(key).push(item);
  };
  for (const item of live) {
    for (const text of [lineText(item.name), lineText(item.description), lineLookupText(item.name), lineLookupText(item.description)]) add(byText, text, item);
    add(byPrice, item.unitAmountCents, item);
  }
  const rows = mappings.filter((m) => m.enabled !== false);
  const rowsOf = (kind) => rows.filter((m) => m.kind === kind);
  return { byCode, byCodeText, byText, byPrice, byLinkedCode, rowsOf, config: { ...MAPPING_DEFAULTS, ...config } };
}

const rowMatches = (row, lookup) => (row.match === 'starts_with' ? lookup === row.label || lookup.startsWith(`${row.label} `) : lookup === row.label);

// Maps one line. Answers the line as the ledger takes it, with `mappedBy` (the
// step) and `label` (the lookup text), or `skip: true` for a zero line the
// routine drops. A line no step answers comes back with `unmapped` set.
export function mapLine(line, context) {
  const { config } = context;
  const original = String(line.description ?? '').trim();
  const meta = quantityOf(original);
  const exact = lineText(meta.base);
  const lookup = lineLookupText(meta.base);
  const lineCents = line.unitAmountCents ?? null;
  const price = meta.unitAmountCents ?? lineCents;
  const quantity = meta.unitAmountCents !== null ? meta.quantity : (line.quantity ?? 1);
  const base = { ...line, label: lookup || exact || null };
  if (lineCents !== null && lineCents <= 0 && config.zeroLines === 'drop') return { ...base, skip: true, mappedBy: 'zero_line' };

  const toItem = (item, step, taxCode = null) => ({
    ...base,
    itemCode: item.code,
    accountCode: null,
    description: (item.description || item.name || original).trim(),
    quantity,
    unitAmountCents: config.linePrice === 'list' ? item.unitAmountCents : (price ?? item.unitAmountCents),
    taxCode: taxCode ?? line.taxCode ?? item.taxCode,
    mappedBy: step,
  });
  const fromRow = (row, step) => {
    const item = context.byCode.get(row.itemCode);
    return item ? toItem(item, step, row.taxCode) : null;
  };
  const unmapped = (reason) => ({ ...base, itemCode: null, accountCode: null, mappedBy: null, unmapped: reason });

  const linked = line.itemCode ? context.byLinkedCode?.get(lineText(line.itemCode)) : null;
  if (linked) return toItem(linked, 'linked');

  for (const step of config.steps) {
    switch (step) {
      case 'same_code': {
        const item = line.itemCode ? context.byCode.get(line.itemCode.trim()) ?? context.byCodeText.get(lineText(line.itemCode)) : null;
        if (item) return toItem(item, step);
        break;
      }
      case 'account': {
        const row = context.rowsOf('account').find((r) => rowMatches(r, lookup));
        if (row) {
          return {
            ...base, itemCode: null, accountCode: row.accountCode, description: row.description || original, quantity,
            unitAmountCents: price, taxCode: row.taxCode ?? line.taxCode, mappedBy: step,
          };
        }
        break;
      }
      case 'saved':
      case 'price_alias': {
        if (price === null) break;
        const row = context.rowsOf(step).find((r) => r.unitAmountCents === price && rowMatches(r, lookup));
        const mapped = row && fromRow(row, step);
        if (mapped) return mapped;
        break;
      }
      case 'catalog_name': {
        const found = [...new Set([...(context.byText.get(exact) ?? []), ...(context.byText.get(lookup) ?? [])])];
        if (found.length === 1) return toItem(found[0], step);
        break;
      }
      case 'catalog_name_price': {
        if (price === null) break;
        const found = [...new Set([...(context.byText.get(exact) ?? []), ...(context.byText.get(lookup) ?? [])])]
          .filter((i) => i.unitAmountCents === price);
        if (found.length === 1) return toItem(found[0], step);
        if (found.length > 1) return unmapped(`more than one price item is named "${original}" at this price`);
        break;
      }
      case 'catalog_score': {
        if (price === null) break;
        const scored = (context.byPrice.get(price) ?? [])
          .map((item) => ({ item, score: nameScore(item, { exact, lookup, original: lineText(original) }) }))
          .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name) || a.item.code.localeCompare(b.item.code));
        const [top, next] = scored;
        if (top && top.score >= SCORE_MIN && !(next && top.score < next.score + SCORE_GAP)) return toItem(top.item, step);
        break;
      }
      case 'alias': {
        const rows = context.rowsOf('alias');
        const row = rows.find((r) => r.match === 'exact' && rowMatches(r, lookup)) ?? rows.find((r) => r.match === 'starts_with' && rowMatches(r, lookup));
        const mapped = row && fromRow(row, step);
        if (mapped) return mapped;
        break;
      }
      default:
        break;
    }
  }
  return unmapped(original ? `no mapping step found a price item for "${original}"` : 'the line has no text');
}

// Maps every line of a job. Lines the routine drops leave the job.
export function mapLines(lines, context) {
  return lines.map((line) => mapLine(line, context)).filter((l) => !l.skip)
    .map(({ skip: _skip, unmapped: _unmapped, ...line }) => line);
}

function readConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('the routine settings must be an object');
  const out = { ...MAPPING_DEFAULTS };
  if ('steps' in raw) {
    if (!Array.isArray(raw.steps) || raw.steps.some((s) => !STEPS.includes(s)) || new Set(raw.steps).size !== raw.steps.length) {
      throw invalid(`steps must list some of ${STEPS.join(', ')}, each once`);
    }
    out.steps = raw.steps;
  }
  if ('zeroLines' in raw) {
    if (!ZERO_LINES.includes(raw.zeroLines)) throw invalid(`zeroLines must be one of ${ZERO_LINES.join(', ')}`);
    out.zeroLines = raw.zeroLines;
  }
  if ('linePrice' in raw) {
    if (!LINE_PRICES.includes(raw.linePrice)) throw invalid(`linePrice must be one of ${LINE_PRICES.join(', ')}`);
    out.linePrice = raw.linePrice;
  }
  return out;
}
export { readConfig as readMappingConfig };

const shape = (r) => ({
  id: r.id, kind: r.kind, match: r.match, label: r.label, unitAmountCents: r.unitAmountCents, itemCode: r.itemCode,
  accountCode: r.accountCode, taxCode: r.taxCode, description: r.description, enabled: r.enabled, origin: r.origin, updatedAt: r.updatedAt,
});

const shortText = (value, name, max = 200) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw invalid(`${name} must be text of ${max} characters at most`);
  return value.trim() || null;
};

export function readMapping(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('the mapping must be an object');
  const known = ['kind', 'match', 'label', 'unitAmountCents', 'itemCode', 'accountCode', 'taxCode', 'description', 'enabled'];
  const unknown = Object.keys(raw).filter((k) => !known.includes(k));
  if (unknown.length) throw invalid(`unknown field: ${unknown[0]}`);
  if (!LINE_MAPPING_KINDS.includes(raw.kind)) throw invalid(`kind must be one of ${LINE_MAPPING_KINDS.join(', ')}`);
  const match = raw.match ?? 'exact';
  if (!['exact', 'starts_with'].includes(match)) throw invalid('match must be exact or starts_with');
  const label = lineLookupText(raw.label) || lineText(raw.label);
  if (!label || label.length > 200) throw invalid('the label must be text of 200 characters at most');
  const priced = ['price_alias', 'saved'].includes(raw.kind);
  let unitAmountCents = raw.unitAmountCents ?? null;
  if (unitAmountCents !== null && (!Number.isInteger(unitAmountCents) || unitAmountCents < 0 || unitAmountCents > 100_000_000)) {
    throw invalid('unitAmountCents must be whole cents');
  }
  if (priced && unitAmountCents === null) throw invalid('this kind needs a unit price');
  if (!priced) unitAmountCents = null;
  const taxCode = raw.taxCode ?? null;
  if (taxCode !== null && !['GST', 'GST_FREE'].includes(taxCode)) throw invalid('taxCode must be GST or GST_FREE');
  const itemCode = shortText(raw.itemCode, 'itemCode', 100);
  const accountCode = shortText(raw.accountCode, 'accountCode', 20);
  if (raw.kind === 'account' ? !accountCode : !itemCode) throw invalid(raw.kind === 'account' ? 'an account line needs an account code' : 'the mapping needs a price item');
  const enabled = raw.enabled ?? true;
  if (typeof enabled !== 'boolean') throw invalid('enabled must be true or false');
  return {
    kind: raw.kind, match, label, unitAmountCents,
    itemCode: raw.kind === 'account' ? null : itemCode,
    accountCode: raw.kind === 'account' ? accountCode : null,
    taxCode, description: shortText(raw.description, 'description'), enabled,
  };
}

export async function listMappings(db, organisationId) {
  const rows = await db.select().from(lineMappings).where(eq(lineMappings.organisationId, organisationId))
    .orderBy(asc(lineMappings.kind), asc(lineMappings.label), asc(lineMappings.unitAmountCents));
  return rows.map(shape);
}

// A change to the mappings reads every job again on the next pipeline run, so
// jobs already in the ledger take the new mapping. It reads Flow's own copy of
// the work system, not the work system.
export async function remapJobs(db, organisationId) {
  await db.delete(pipelineCursors).where(and(eq(pipelineCursors.organisationId, organisationId), sql`${pipelineCursors.name} like '%.work'`));
}

export async function createMapping(db, organisationId, raw, { personId = null, origin = 'person' } = {}) {
  const mapping = readMapping(raw);
  const [{ count }] = await db.select({ count: sql`count(*)::int` }).from(lineMappings).where(eq(lineMappings.organisationId, organisationId));
  if (count >= MAX_MAPPINGS) throw invalid(`an organisation can have ${MAX_MAPPINGS} line mappings at most`);
  const [row] = await db.insert(lineMappings).values({ organisationId, ...mapping, origin, updatedBy: personId })
    .onConflictDoNothing().returning();
  if (!row) throw new FlowError('conflict', 'a mapping for this label already exists');
  await remapJobs(db, organisationId);
  return shape(row);
}

async function loadMapping(db, organisationId, id) {
  const [row] = await db.select().from(lineMappings).where(and(eq(lineMappings.organisationId, organisationId), eq(lineMappings.id, id)));
  if (!row) throw notFound('mapping');
  return row;
}

export async function updateMapping(db, organisationId, id, changes, { personId = null } = {}) {
  const row = await loadMapping(db, organisationId, id);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('the change must be an object');
  const mapping = readMapping({ ...shape(row), ...changes, id: undefined, origin: undefined, updatedAt: undefined });
  try {
    const [saved] = await db.update(lineMappings).set({ ...mapping, updatedBy: personId, updatedAt: sql`now()` })
      .where(eq(lineMappings.id, row.id)).returning();
    await remapJobs(db, organisationId);
    return shape(saved);
  } catch (error) {
    if (error?.code === '23505' || error?.cause?.code === '23505') throw new FlowError('conflict', 'a mapping for this label already exists');
    throw error;
  }
}

export async function deleteMapping(db, organisationId, id) {
  const row = await loadMapping(db, organisationId, id);
  await db.delete(lineMappings).where(eq(lineMappings.id, row.id));
  await remapJobs(db, organisationId);
}

// The price list, mapping rows and `system`'s product links for a pipeline run.
export async function loadMappingContext(db, organisationId, config, { system = null } = {}) {
  const [items, mappings, links] = await Promise.all([
    db.select().from(priceItems).where(and(eq(priceItems.organisationId, organisationId), isNull(priceItems.archivedAt))),
    db.select().from(lineMappings).where(eq(lineMappings.organisationId, organisationId)),
    system
      ? db.select().from(priceItemLinks).where(and(eq(priceItemLinks.organisationId, organisationId), eq(priceItemLinks.system, system)))
      : [],
  ]);
  return mappingContext({ items, mappings, links, config });
}
