// A person's saved views of a list page (Jobs, Invoices, Reconcile), as
// ClickUp's view tabs: each has a name and the page's view (Group, Sort,
// Filter, Columns), and one can be the person's default, which opens when
// they go to the page. No DOM: the server checks a saved list with the same
// rules the page uses (server/auth/people.js).
import { cleanFilterView, normaliseJobsView } from './job-view.js';

// The Invoices filter's fields (invoicing.js). The tabs are the status, so
// Status is not here.
export const INVOICE_FILTER_FIELDS = {
  client: { label: 'Client', kind: 'choice', icon: 'building-2' },
  number: { label: 'Number', kind: 'text', icon: 'hash' },
  reference: { label: 'Reference', kind: 'text', icon: 'text' },
  date: { label: 'Date', kind: 'date', icon: 'calendar' },
  total: { label: 'Total', kind: 'number', icon: 'dollar-sign' },
  problem: { label: 'Problem', kind: 'check', icon: 'triangle-alert' },
};

// The Reconcile filter's fields (reconcile.js). Reconcile lists jobs and
// invoices, so it has both lists' fields; a job's own field (Practitioner,
// a custom field) skips invoice rows, so it never hides them.
export const RECONCILE_FILTER_FIELDS = {
  type: { label: 'Type', kind: 'choice', icon: 'layers' },
  status: { label: 'Status', kind: 'choice', icon: 'circle-dot' },
  client: { label: 'Client', kind: 'choice', icon: 'building-2' },
  practitioner: { label: 'Practitioner', kind: 'choice', icon: 'stethoscope', job: true },
  date: { label: 'Date', kind: 'date', icon: 'calendar' },
  total: { label: 'Total', kind: 'number', icon: 'dollar-sign' },
  match: { label: 'Match', kind: 'check', icon: 'link' },
};

const CUSTOM_FIELD = /^field:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kindIn = (fields, custom) => (field) => (Object.hasOwn(fields, field) ? fields[field].kind : custom && CUSTOM_FIELD.test(field) ? '*' : null);

// The Invoices and Reconcile views: their filter.
export const normaliseInvoicesView = (value) => cleanFilterView(value, kindIn(INVOICE_FILTER_FIELDS, false));
export const normaliseReconcileView = (value) => cleanFilterView(value, kindIn(RECONCILE_FILTER_FIELDS, true));

// The pages with saved views. Each is named in a switch, never looked up
// by the name a request sends, so a name such as "constructor" is refused.
export const SAVED_VIEW_PAGES = Object.freeze(['jobs', 'invoices', 'reconcile']);
export function pageViewCheck(page) {
  switch (page) {
    case 'jobs': return normaliseJobsView;
    case 'invoices': return normaliseInvoicesView;
    case 'reconcile': return normaliseReconcileView;
    default: return null;
  }
}

export const MAX_SAVED_VIEWS = 20;
const MAX_NAME = 60;
const VIEW_ID = /^[a-z0-9-]{1,40}$/i;

// A page's saved views as Flow keeps them: { list: [{ id, name, view }],
// default }. Bad entries are dropped; a default that names no view is none.
export function normaliseSavedViews(page, input) {
  const check = pageViewCheck(page);
  const value = input && typeof input === 'object' ? input : {};
  const seen = new Set();
  const list = check && Array.isArray(value.list) ? value.list : [];
  const kept = list.filter((v) => v && typeof v === 'object' && typeof v.id === 'string' && VIEW_ID.test(v.id) && !seen.has(v.id) && seen.add(v.id))
    .map((v) => ({ id: v.id, name: String(v.name ?? '').trim().slice(0, MAX_NAME), view: check(v.view) }))
    .filter((v) => v.name.length > 0)
    .slice(0, MAX_SAVED_VIEWS);
  return { list: kept, default: kept.some((v) => v.id === value.default) ? value.default : null };
}

// Do two views of a page show the same thing?
export function sameView(page, a, b) {
  const check = pageViewCheck(page);
  return Boolean(check) && JSON.stringify(check(a)) === JSON.stringify(check(b));
}
