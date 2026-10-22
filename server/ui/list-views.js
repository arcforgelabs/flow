// A person's saved views of a list page (Jobs, Invoices, Reconcile), as
// ClickUp's view tabs: each has a name and the page's view (Group, Sort,
// Filter, Columns), and one can be the person's default, which opens when
// they go to the page. No DOM: the server checks a saved list with the same
// rules the page uses (server/auth/people.js).
import { caseNumber } from './job-board.js';
import { cleanFilterView, fieldIdOf, filterJobs, KIND_OF_TYPE, normaliseJobsView } from './job-view.js';

// The Invoices filter's fields (invoicing.js): the list's own columns, then
// the job columns the Columns menu offers (Case, Practitioner, Shipped).
// Custom fields ('field:<id>') are fields too; their kind comes from their
// type. The page shows the chip (view-bar.js); the server keeps the rows
// (GET /api/invoicing/invoices), so a filter reaches every invoice of a tab.
export const INVOICE_FILTER_FIELDS = {
  client: { label: 'Client', kind: 'choice', icon: 'building-2' },
  number: { label: 'Number', kind: 'text', icon: 'hash' },
  reference: { label: 'Reference', kind: 'text', icon: 'text' },
  date: { label: 'Date', kind: 'date', icon: 'calendar' },
  due: { label: 'Due', kind: 'date', icon: 'calendar' },
  total: { label: 'Total', kind: 'number', icon: 'dollar-sign' },
  status: { label: 'Status', kind: 'choice', icon: 'circle-dot' },
  linked: { label: 'Linked', kind: 'choice', icon: 'link' },
  problem: { label: 'Problem', kind: 'check', icon: 'triangle-alert' },
  case: { label: 'Case', kind: 'text', icon: 'briefcase' },
  practitioner: { label: 'Practitioner', kind: 'choice', icon: 'stethoscope' },
  shipped: { label: 'Shipped', kind: 'date', icon: 'calendar' },
};

// What the Status column shows. `sending` replaces the tab while an invoice
// is on its way to the accounting system.
export const INVOICE_FILTER_STATUSES = Object.freeze([
  { value: 'pending', label: 'Pending' },
  { value: 'ready', label: 'Ready' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'sent', label: 'Sent' },
  { value: 'void', label: 'Void' },
  { value: 'sending', label: 'Sending' },
]);

export const invoiceFilterKind = (field) => INVOICE_FILTER_FIELDS[field]?.kind ?? null;

// A field's kind for this lab: a built-in field, or a custom field's type.
// `fields` is the lab's custom fields ({ id, type }).
export function invoiceKindOf(fields) {
  const type = new Map((fields ?? []).map((f) => [f.id, f.type]));
  return (field) => INVOICE_FILTER_FIELDS[field]?.kind ?? KIND_OF_TYPE[type.get(fieldIdOf(field) ?? '')] ?? null;
}

// An invoice's value for a filter field or a sort, as they compare it. A
// draft has no issue date: it uses the day it was made. A job column reads
// the invoice's job; a custom field reads that job's value (`fields`).
export function invoiceValue(invoice, field) {
  const job = invoice.job ?? null;
  switch (field) {
    case 'client': return invoice.contactName ?? null;
    case 'number': return invoice.number ?? null;
    case 'reference': return invoice.reference ?? null;
    case 'date': return invoice.issueDate ?? (invoice.createdAt ? new Date(invoice.createdAt).toISOString().slice(0, 10) : null);
    case 'due': return invoice.dueDate ?? null;
    case 'total': return invoice.totalCents == null ? null : invoice.totalCents / 100;
    case 'status': return invoice.sending ? 'sending' : invoice.tab ?? null;
    case 'linked': return job?.sourceSystem ?? null;
    case 'problem': return (invoice.problems?.length ?? 0) > 0;
    case 'case': return job ? caseNumber(job) : null;
    case 'practitioner': return job?.practitioner ?? null;
    case 'shipped': return job?.shippedOn ?? null;
    default: {
      const id = fieldIdOf(field);
      if (!id) return null;
      const value = invoice.fields?.[id];
      return value === undefined ? null : value;
    }
  }
}

// What the Invoices list sorts by (a column head). No sort is newest first.
export const INVOICE_SORTS = Object.freeze(['number', 'client', 'reference', 'date', 'total']);

// One page of an invoice list: the Filter view keeps rows, the sort orders
// them (an empty value last, either way), then `offset` and `limit` cut the
// page. `total` and `totalCents` are of every kept row. The rows come in
// newest first; that order breaks ties.
export function invoicePage(invoices, { view, sort = null, dir = 'asc', offset = 0, limit = 100, today, kindOf = invoiceFilterKind, me = null }) {
  const kept = filterJobs(invoices, view, { valueOf: invoiceValue, kindOf, late: null, me, today });
  const sign = dir === 'desc' ? -1 : 1;
  const ordered = INVOICE_SORTS.includes(sort)
    ? kept.map((invoice, i) => [invoice, invoiceValue(invoice, sort), i]).sort(([, x, i], [, y, j]) => {
      if (x == null || y == null) return x == null && y == null ? i - j : (x == null) - (y == null);
      const order = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true });
      return order ? order * sign : i - j;
    }).map(([invoice]) => invoice)
    : kept;
  return {
    rows: ordered.slice(offset, offset + limit),
    total: kept.length,
    totalCents: kept.reduce((sum, i) => sum + (i.totalCents ?? 0), 0),
  };
}

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
export const normaliseInvoicesView = (value) => cleanFilterView(value, kindIn(INVOICE_FILTER_FIELDS, true));
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
