// Likely Flow codes for a connected system's record (Price list › Reconcile).
// Pure: the page passes the record and Flow's codes. A code's score comes
// from its name (and code) against the record's name, then its price and tax.
// "Sure" means name, price and tax all agree and no other code comes close,
// so a person can link every sure one in one step.

const IGNORED = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'with', 'per', 'than', 'more', 'unit', 'each']);

export function nameWords(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w && !IGNORED.has(w));
}

// Two words agree when they are the same, or one starts the other and the
// shorter has 4 letters or more ("frame" and "framework").
const wordsAgree = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

// 0 to 1: how much of both names the shared words cover (Dice).
export function nameScore(a, b) {
  const left = nameWords(a);
  const right = nameWords(b);
  if (!left.length || !right.length) return 0;
  const free = [...right];
  let shared = 0;
  for (const word of left) {
    const at = free.findIndex((other) => wordsAgree(word, other));
    if (at >= 0) { shared += 1; free.splice(at, 1); }
  }
  return (2 * shared) / (left.length + right.length);
}

export const SAME_NAME = 0.8;
const LIKELY_NAME = 0.5;

const fact = (left, right, same) => (left == null || right == null || left === '' || right === '' ? null : same ? 'same' : 'differs');

// The codes that may be this record, best first: { item, score, name, price,
// tax, sure }. name, price and tax are 'same', 'differs' or null (one side
// has no value). `limit` keeps the first few.
export function rankCodes(record, items, { limit = 3 } = {}) {
  const ranked = [];
  for (const item of items) {
    if (item.archivedAt) continue;
    const sameCode = Boolean(record.code) && String(record.code).trim().toLowerCase() === String(item.code).trim().toLowerCase();
    const score = sameCode ? 1 : Math.max(nameScore(record.name, item.name), nameScore(record.name ?? record.code, item.code) * 0.9);
    const price = fact(record.unitAmountCents, item.unitAmountCents, record.unitAmountCents === item.unitAmountCents);
    const tax = fact(record.taxCode, item.taxCode, record.taxCode === item.taxCode);
    if (score < LIKELY_NAME && !(price === 'same' && score >= 0.3)) continue;
    ranked.push({ item, score, name: score >= SAME_NAME ? 'same' : 'differs', price, tax, rank: score * 2 + (price === 'same' ? 0.6 : 0) + (tax === 'same' ? 0.2 : 0) });
  }
  ranked.sort((a, b) => b.rank - a.rank || a.item.code.localeCompare(b.item.code));
  const [best, next] = ranked;
  if (best) best.sure = best.name === 'same' && best.price === 'same' && best.tax !== 'differs' && !(next && next.rank >= best.rank - 0.3);
  return ranked.slice(0, limit).map(({ rank: _rank, ...rest }) => ({ sure: false, ...rest }));
}

// The search under "Other code": codes whose code or name holds every word.
export function findCodes(query, items, { limit = 8 } = {}) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return items.filter((i) => !i.archivedAt && words.every((w) => `${i.code} ${i.name}`.toLowerCase().includes(w))).slice(0, limit);
}

// What a person still has to do on the price list, from GET /price-list:
// each system record that links to no code ('link'), then each code that
// differs from a linked record ('differs'). Records come sure first, then
// likely, then with no likely code. Every row has a stable key.
export function reconcileRows(data) {
  const systems = new Map(data.systems.map((s) => [s.id, s]));
  const rows = [];
  for (const { system, records } of data.unlinked) {
    const owner = systems.get(system);
    if (!owner) continue;
    for (const record of records) {
      const candidates = rankCodes(record, data.items);
      rows.push({ key: `link:${system}:${record.id}`, kind: 'link', system: owner, record, candidates, sure: Boolean(candidates[0]?.sure) });
    }
  }
  // Sure ones first, then likely ones, then records no code fits.
  const order = (row) => (row.sure ? 0 : row.candidates[0] ? 1 : 2);
  rows.sort((a, b) => order(a) - order(b));
  for (const item of data.items) {
    if (item.archivedAt || !item.findings?.length) continue;
    for (const system of new Set(item.findings.map((f) => f.system))) {
      const owner = systems.get(system);
      if (!owner) continue;
      const findings = item.findings.filter((f) => f.system === system);
      const link = item.links.find((l) => l.system === system && findings.some((f) => f.externalId === String(l.externalId))) ?? null;
      rows.push({ key: `differs:${system}:${item.id}`, kind: 'differs', system: owner, item, findings, link, record: link?.record ?? null, sure: false });
    }
  }
  return rows;
}
