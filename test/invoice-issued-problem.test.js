import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// The issued invoice page (server/ui/invoicing.js). A refusal that names a
// Xero invoice shows that reason and a link to it.
const uiRoot = new URL('../server/ui/', import.meta.url);
registerHooks({
  resolve: (specifier, context, next) => next(specifier.startsWith('/assets/ui/') ? new URL(specifier.slice('/assets/ui/'.length), uiRoot).href : specifier, context),
});

class Node {}
class El extends Node {
  constructor(tag) {
    super();
    Object.assign(this, {
      tag, attrs: {}, dataset: {}, children: [], parentElement: null, hidden: false, listeners: {},
      style: { setProperty() {}, getPropertyValue() { return ''; } },
    });
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  append(...kids) {
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      if (kid instanceof El) { kid.remove(); kid.parentElement = this; }
      this.children.push(kid);
    }
  }
  replaceChildren(...kids) {
    for (const child of this.children) if (child instanceof El) child.parentElement = null;
    this.children = [];
    this.append(...kids);
  }
  insertBefore(node, before) {
    if (node instanceof El) { node.remove(); node.parentElement = this; }
    const at = this.children.indexOf(before);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
  }
  after(node) {
    if (!this.parentElement) return;
    if (node instanceof El) { node.remove(); node.parentElement = this.parentElement; }
    const at = this.parentElement.children.indexOf(this);
    this.parentElement.children.splice(at + 1, 0, node);
  }
  querySelectorAll(sel) {
    const token = sel.startsWith('.') ? sel.slice(1) : null;
    const walk = (node) => (node.children ?? []).filter((kid) => kid instanceof El).flatMap((kid) => {
      const hit = token ? (kid.getAttribute('class') ?? '').split(/\s+/).includes(token) : kid.tag === sel;
      return [...(hit ? [kid] : []), ...walk(kid)];
    });
    return walk(this);
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  get textContent() { return this.children.map((kid) => (kid instanceof El ? kid.textContent : String(kid))).join(''); }
  set textContent(value) { this.replaceChildren(String(value)); }
  set innerHTML(value) { this.children = [String(value)]; }
  get classList() {
    const names = () => (this.getAttribute('class') ?? '').split(/\s+/);
    return { contains: (name) => names().includes(name), add() {}, remove() {}, toggle() {} };
  }
  click() { this.listeners.click?.(); }
  getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
  closest() { return null; }
  hidePopover() {}
}

globalThis.Node = Node;
globalThis.document = {
  createElement: (tag) => new El(tag),
  createTextNode: (text) => String(text),
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.window = { matchMedia: globalThis.matchMedia, innerHeight: 800 };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { renderInvoice } = await import('../server/ui/invoicing.js');
const { h, notice } = await import('../server/ui/kit.js');

const XERO_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('an issued invoice that Xero refused shows the reason and Open in Xero', async () => {
  const invoice = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'issued',
    number: 'INV-2456',
    tab: 'pending',
    sendState: 'failed',
    reference: 'CASE-1',
    issueDate: '2026-10-30',
    dueDate: '2026-11-13',
    subtotalCents: 22000,
    taxCents: 0,
    totalCents: 22000,
    contact: { id: '22222222-2222-4222-8222-222222222222', name: 'Example Practice', email: null },
    lines: [{ description: 'Crown', quantity: 1, unitAmountCents: 22000, taxCode: 'GST', lineAmountCents: 22000 }],
    versions: [{ version: 1, issuedAt: '2026-10-30T00:00:00.000Z' }],
    problems: [{
      code: 'xero_same_reference_different_amount',
      message: 'Xero INV-2449 has the same client and reference at 235.00. Nothing was sent.',
      short: 'Duplicate?',
      xero: { invoiceId: XERO_ID, number: 'INV-2449', status: 'AUTHORISED' },
    }],
    job: null,
    linksTo: [],
  };
  const flow = (path) => {
    if (path === '/api/invoicing/context') return Promise.resolve({ canIssue: true, organisations: [{ id: 'lab' }] });
    if (path === `/api/invoicing/invoices/${invoice.id}`) return Promise.resolve({ invoice });
    if (String(path).startsWith('/api/xero/status')) return Promise.resolve({ connected: false });
    return Promise.resolve({});
  };
  const main = document.createElement('main');
  await renderInvoice(main, { h, notice, flow, toast() {}, go() {}, dialog: async () => false }, invoice.id);
  const link = main.querySelectorAll('a').find((el) => el.textContent === 'Open in Xero');
  assert.ok(link, main.textContent);
  assert.equal(link.getAttribute('href'), `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${XERO_ID}`);
  assert.match(main.textContent, /Xero INV-2449 has the same client and reference at 235\.00/);
});

test('an issued lab-rule hold names the rule and links the source job', async () => {
  const invoice = {
    id: '11111111-1111-4111-8111-111111111111', status: 'issued', number: 'TEST-1', tab: 'pending',
    sendState: 'failed', totalCents: 10000, lines: [], versions: [], linksTo: [],
    contact: { name: 'Synthetic Practice' },
    job: { id: '22222222-2222-4222-8222-222222222222', link: 'https://example.test/jobs/CASE-1', systemName: 'Work system' },
    problems: [{ code: 'rule', rule: '33333333-3333-4333-8333-333333333333', short: 'Bare name', message: 'Use the practitioner full name in the work system.' }],
  };
  const flow = async (path) => path === '/api/invoicing/context'
    ? { canIssue: false, organisations: [{ id: 'lab' }] }
    : { invoice };
  const main = document.createElement('main');
  await renderInvoice(main, { h, notice, flow, toast() {}, go() {}, dialog: async () => false }, invoice.id);
  assert.match(main.textContent, /Rule: Bare name/);
  assert.ok(main.querySelectorAll('a').some((a) => a.getAttribute('href') === invoice.job.link && /Fix job/.test(a.textContent)));
});

// Public problem-code contract from draft checks and Xero send refusals. Each
// fixture includes independent explanatory text: losing a reason must fail.
test('every invoice hold keeps its full page reason, compact accessible text and safe links', async () => {
  const { invoiceProblems } = await import('../server/ui/invoice-problems.js');
  const codes = [
    'no_lines', 'no_amount', 'line_no_item', 'rule', 'non_chargeable', 'job_review', 'send_failed',
    'xero_contact_missing', 'xero_contact_ambiguous', 'xero_item_missing', 'xero_not_synced', 'xero_sync_stale',
    'invoice_void', 'invoice_not_issued', 'xero_contact_no_email', 'xero_preview_failed',
    'xero_same_reference_different_amount', 'xero_earlier_version_in_xero', 'xero_earlier_version_unresolved',
    'xero_tracking_missing', 'xero_validation_failed', 'xero_reconnect_needed', 'xero_token_failed',
    'xero_unreachable', 'xero_writes_off', 'xero_push_in_progress', 'xero_outcome_unknown', 'xero_push_failed',
  ];
  for (const code of codes) {
    const rule = ['rule', 'non_chargeable'].includes(code);
    const matched = ['xero_same_reference_different_amount', 'xero_earlier_version_in_xero'].includes(code);
    const invoice = { job: { id: 'job', link: { url: 'https://example.test/jobs/1' } }, problems: [{
      code, message: 'Synthetic reason. Fix the source before trying again.', short: 'Hold',
      ...(rule ? { rule: 'rule-id', ruleName: 'Synthetic rule' } : {}),
      ...(matched ? { xero: { invoiceId: XERO_ID } } : {}),
    }] };
    const summary = invoiceProblems({ h, notice }, invoice, { compact: true });
    assert.match(summary.getAttribute('title'), /Synthetic reason\. Fix the source before trying again\./, code);
    assert.match(summary.getAttribute('aria-label'), /Fix the source before trying again/, code);
    // Lists open the invoice; its full presenter owns every matched/remediation link.
    const shown = invoiceProblems({ h, notice }, invoice);
    assert.match(shown.textContent, /Synthetic reason\. Fix the source before trying again\./, code);
    if (rule) assert.match(shown.textContent, /Rule: Synthetic rule/, code);
    if (code === 'xero_tracking_missing') assert.ok(shown.querySelectorAll('a').some((a) => a.getAttribute('href') === '/integrations/xero#tracking'), code);
    if (matched) assert.ok(shown.querySelectorAll('a').some((a) => a.getAttribute('href').endsWith(XERO_ID)), code);
    if (rule || code === 'job_review') assert.ok(shown.querySelectorAll('a').some((a) => a.textContent === 'Fix job'), code);
  }
});

test('unknown holds retain their reason and unsafe source links never become navigation', async () => {
  const { invoiceProblems } = await import('../server/ui/invoice-problems.js');
  const shown = invoiceProblems({ h, notice }, {
    job: { id: 'synthetic-job', link: { url: 'javascript:alert(1)' } },
    problems: [{ code: 'job_review', message: 'Synthetic change needs review.' }, { code: 'future_provider_hold', message: 'Synthetic provider reason.' }],
  });
  assert.match(shown.textContent, /Synthetic provider reason/);
  assert.match(shown.textContent, /Check the reason, then retry/);
  assert.ok(shown.querySelectorAll('a').every((a) => !a.getAttribute('href').startsWith('javascript:')));
  assert.ok(shown.querySelectorAll('a').some((a) => a.getAttribute('href') === '/jobs/synthetic-job'));
});
