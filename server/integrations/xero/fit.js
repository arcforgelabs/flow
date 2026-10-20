// How sure Flow is that a Xero invoice in the copy is one Flow invoice
// (docs/XERO_IMPORT.md, "Sure match"). The checks are the ones the job
// matcher learned on work-system jobs against Xero (server/core/pipeline.js
// scoreCandidate), plus what the Flow invoice's own jobs know: the matcher's
// tie to this Xero invoice, and the work system's invoice number.
//
// A pair is sure only when one piece of hard evidence ties it, or when the
// score is high and clearly ahead; and in both cases only when it is the one
// fit both ways (`sureFits`).

export const SURE_SCORE = 11; // total, same items, and within 3 days
export const SURE_LEAD = 3;
export const POOL_DAYS = 14;
const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
const daysApart = (a, b) => (a && b ? Math.abs(day(a) - day(b)) / 86_400_000 : null);
const withGst = (cents) => Math.round(cents * 1.1);
const withoutReissue = (ref) => String(ref ?? '').trim().replace(/R$/i, '').toLowerCase();
const words = (text) => String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// xero: { id, number, contactId, totalCents, issuedOn, itemCodes[], reference }
// flow: { id, contactId, totalCents, subtotalCents, date, itemCodes[], reference,
//         jobs: [{ accountingRef, sourceInvoiceRef, practitioner }] }
// Answers { score, signals, hard }; `hard` names the evidence that ties them.
export function scoreFit(xero, flow) {
  const signals = [];
  const add = (signal, weight) => signals.push({ signal, weight });
  const jobs = flow.jobs ?? [];
  let hard = null;
  if (jobs.some((j) => j.accountingRef && j.accountingRef === xero.id)) hard = 'job_tied';
  else if (xero.number && jobs.some((j) => j.sourceInvoiceRef && withoutReissue(j.sourceInvoiceRef) === withoutReissue(xero.number))) hard = 'work_invoice_number';
  if (hard) add(hard, 10);
  if (xero.contactId && xero.contactId === flow.contactId) add('client', 2);
  if (xero.totalCents === flow.totalCents) add('total', 6);
  else if ([flow.subtotalCents, withGst(flow.subtotalCents)].includes(xero.totalCents)) add('total_gst', 5);
  const ours = new Set(flow.itemCodes ?? []);
  const theirs = new Set(xero.itemCodes ?? []);
  if (ours.size && theirs.size) {
    const shared = [...ours].filter((c) => theirs.has(c)).length;
    if (shared === ours.size && shared === theirs.size) add('items_same', 3);
    else if (shared) add('items_overlap', 1);
    else add('items_differ', -3);
  }
  const apart = daysApart(xero.issuedOn, flow.date);
  if (apart !== null && apart <= 3) add('date_close', 2);
  else if (apart !== null && apart <= POOL_DAYS) add('date_near', 1);
  // A Reference is in the copy only with XERO_KEEP_REFERENCE on.
  if (xero.reference && flow.reference) {
    if (words(xero.reference) === words(flow.reference)) add('reference_same', 3);
    else add('reference_differs', -2);
  } else if (xero.reference && jobs.some((j) => j.practitioner && words(xero.reference).includes(words(j.practitioner)))) {
    add('practitioner', 1);
  }
  return { score: signals.reduce((sum, s) => sum + s.weight, 0), signals, hard };
}

// Whether the pair may be offered at all: hard evidence, or the same client
// with an amount that fits and dates within two weeks.
export function canFit(xero, flow, scored) {
  if (scored.hard) return true;
  const amount = scored.signals.some((s) => s.signal === 'total' || s.signal === 'total_gst');
  const near = scored.signals.some((s) => s.signal === 'date_close' || s.signal === 'date_near');
  return Boolean(xero.contactId && xero.contactId === flow.contactId && amount && near);
}

// pairs: [{ xeroId, flowId, score, hard }]. Answers the set of `xeroId` whose
// best fit is sure: hard evidence or SURE_SCORE, at least SURE_LEAD ahead of
// that Xero invoice's next fit, and that Flow invoice's best fit back.
export function sureFits(pairs) {
  const byXero = new Map();
  const byFlow = new Map();
  for (const p of pairs) {
    if (!byXero.has(p.xeroId)) byXero.set(p.xeroId, []);
    if (!byFlow.has(p.flowId)) byFlow.set(p.flowId, []);
    byXero.get(p.xeroId).push(p);
    byFlow.get(p.flowId).push(p);
  }
  const ranked = (list) => [...list].sort((a, b) => b.score - a.score);
  const clear = (list) => {
    const [top, next] = ranked(list);
    if (!top || !(top.hard || top.score >= SURE_SCORE)) return null;
    if (next && (next.hard || top.score - next.score < SURE_LEAD)) return null;
    return top;
  };
  const sure = new Map();
  for (const [xeroId, list] of byXero) {
    const top = clear(list);
    if (top && clear(byFlow.get(top.flowId))?.xeroId === xeroId) sure.set(xeroId, top.flowId);
  }
  return sure;
}
