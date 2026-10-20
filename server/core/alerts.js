import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { alertDismissals, invoices } from '../db/schema.js';
import { FlowError } from './errors.js';
import { listReview } from './review.js';
import { invoiceViews } from './sending.js';

// Quiet alerts (issue 117, docs/ALERTS.md). An alert says that something on
// one page needs a person. Nothing shows when nothing does: there is no feed,
// no "done" message, no email and no sound. An alert is worked out each time
// a page asks, from Flow's own records (the review queue, the Invoices views,
// each integration's call guard), so it goes away for everyone as soon as its
// cause is fixed. Only a person's dismissal is stored: it hides the alert for
// that person until something new joins it.
//
// An alert is { key, page, tone, title, action, moneyAtRiskCents, roles,
// members }. `key` starts with its page. `members` are the things it is
// about (an invoice id, a review item and its evidence, a stop and its time);
// they never leave the server. `roles` are who may see it. `action`, when
// there is one, is { label, href } or { label, tab } for a tab on the page.

export const ALERT_PAGES = Object.freeze(['invoices', 'price-list', 'integrations']);
const ALL_ROLES = Object.freeze(['owner', 'admin', 'staff']);
const MANAGERS = Object.freeze(['owner', 'admin']);
const TONES = new Set(['warn', 'danger']);
// A dismissal keeps at most this many members. An alert about more things
// than that comes back after a dismiss: it is too large to set aside.
const MAX_MEMBERS = 500;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const digest = (value) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);

function checkAlert(alert) {
  if (!ALERT_PAGES.includes(alert.page) || !alert.key?.startsWith(`${alert.page}:`)) {
    throw new TypeError(`alert ${alert.key} must start with its page`);
  }
  if (!TONES.has(alert.tone)) throw new TypeError(`alert ${alert.key} tone must be warn or danger`);
  if (!Array.isArray(alert.members) || !alert.members.length) throw new TypeError(`alert ${alert.key} needs members`);
  return { moneyAtRiskCents: 0, roles: ALL_ROLES, action: null, ...alert, members: alert.members.map(String) };
}

// ── Sources ────────────────────────────────────────────────────────────────

// Invoices: drafts a check stopped and issued invoices the accounting system
// refused (server/core/sending.js). One alert for all of them.
export function invoiceProblemsSource(db, { accounting = () => null } = {}) {
  return async (organisationId) => {
    const { problems } = await invoiceViews(db, organisationId, { accounting: accounting() });
    const ids = [...problems.keys()];
    if (!ids.length) return [];
    const [{ total }] = await db.select({ total: sql`coalesce(sum(${invoices.totalCents}), 0)` }).from(invoices)
      .where(and(eq(invoices.organisationId, organisationId), inArray(invoices.id, ids)));
    return [{
      key: 'invoices:problems',
      page: 'invoices',
      tone: 'warn',
      title: `${plural(ids.length, 'invoice has', 'invoices have')} a problem.`,
      action: { label: 'Open Problem', tab: 'problem' },
      moneyAtRiskCents: Number(total),
      members: ids,
    }];
  };
}

// Price list: codes whose price, tax or name differs in a connected system
// (server/core/price-list.js). A difference is an alert only: the person
// fixes it at the source, or marks it resolved on the code.
export function priceDifferencesSource(db) {
  return async (organisationId) => {
    const open = await listReview(db, organisationId, { kind: 'price_check', limit: MAX_MEMBERS });
    if (!open.length) return [];
    return [{
      key: 'price-list:differences',
      page: 'price-list',
      tone: 'warn',
      title: `${plural(open.length, 'code differs', 'codes differ')} from a connected system. Fix it at the source, or open the code and mark it resolved.`,
      moneyAtRiskCents: open.reduce((sum, item) => sum + Number(item.moneyAtRiskCents ?? 0), 0),
      members: open.map((item) => `${item.id}:${digest(item.evidence)}`),
    }];
  };
}

// Integrations: each enabled integration that offers `alerts` says what only
// a person can clear (a refused sign-in, a stopped call). Owners and admins
// see these; staff cannot change integrations.
export function integrationAlertsSource(adapters = () => []) {
  return async (organisationId) => {
    const found = await Promise.all(adapters().map(async (adapter) => {
      const items = await adapter.capabilities.alerts({ organisationId });
      return (items ?? []).map((item) => ({
        key: `integrations:${adapter.id}:${item.id}`,
        page: 'integrations',
        tone: item.tone ?? 'danger',
        title: item.title,
        action: { label: `Open ${adapter.name}`, href: `/integrations/${adapter.id}` },
        roles: MANAGERS,
        members: item.members,
      }));
    }));
    return found.flat();
  };
}

// ── Reading and dismissing ─────────────────────────────────────────────────

async function collect(sources, page, organisationId) {
  const list = await Promise.all((sources[page] ?? []).map((source) => source(organisationId)));
  return list.flat().map(checkAlert);
}

// The alerts one person should see on one page, worst first: danger before
// warn, then most money at risk. A dismissed alert stays hidden while every
// member it has now was a member when it was dismissed.
export async function alertsFor(db, organisationId, person, { page, sources }) {
  if (!ALERT_PAGES.includes(page)) throw new FlowError('invalid', `page must be one of ${ALERT_PAGES.join(', ')}`);
  const alerts = (await collect(sources, page, organisationId)).filter((a) => a.roles.includes(person.role));
  if (!alerts.length) return [];
  const rows = await db.select().from(alertDismissals).where(and(
    eq(alertDismissals.organisationId, organisationId),
    eq(alertDismissals.personId, person.id),
    inArray(alertDismissals.alertKey, alerts.map((a) => a.key)),
  ));
  const dismissed = new Map(rows.map((r) => [r.alertKey, new Set(r.members)]));
  return alerts
    .filter((a) => !dismissed.has(a.key) || a.members.some((m) => !dismissed.get(a.key).has(m)))
    .sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1) || b.moneyAtRiskCents - a.moneyAtRiskCents);
}

// What the browser gets: no members, only how many there are.
export const alertForBrowser = ({ key, tone, title, action, moneyAtRiskCents, members }) => ({
  key, tone, title, action, moneyAtRiskCents, count: members.length,
});

// Hides one alert for one person. The server works the alert out again, so
// the stored members are what the person saw, not what a browser sent.
// Dismissing an alert that is gone is not an error.
export async function dismissAlert(db, organisationId, person, { key, sources }) {
  const page = ALERT_PAGES.find((p) => String(key ?? '').startsWith(`${p}:`));
  if (!page) throw new FlowError('invalid', 'key must name an alert');
  const alert = (await collect(sources, page, organisationId)).find((a) => a.key === key && a.roles.includes(person.role));
  if (!alert) return { dismissed: false };
  const members = alert.members.slice(0, MAX_MEMBERS);
  await db.insert(alertDismissals)
    .values({ organisationId, personId: person.id, alertKey: key, members })
    .onConflictDoUpdate({
      target: [alertDismissals.organisationId, alertDismissals.personId, alertDismissals.alertKey],
      set: { members, dismissedAt: sql`now()` },
    });
  return { dismissed: true };
}
