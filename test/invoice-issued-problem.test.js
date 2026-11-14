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

test('an imported invoice offers no change, and shows each job tied to it', async () => {
  const base = {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'issued',
    number: 'INV-1042',
    tab: 'paid',
    sendState: 'none',
    sendsTo: 'Xero',
    reference: null,
    issueDate: '2024-05-10',
    dueDate: '2024-05-24',
    subtotalCents: 25000,
    taxCents: 2500,
    totalCents: 27500,
    contact: { id: '22222222-2222-4222-8222-222222222222', name: 'Example Practice', email: null },
    // A line as Xero gave it: no quantity and no unit price.
    lines: [{ description: 'Crown', quantity: null, unitAmountCents: null, taxCode: 'GST', lineAmountCents: 25000 }],
    versions: [{ version: 1, issuedAt: '2026-11-14T00:00:00.000Z' }],
    problems: [],
    job: null,
    linksTo: [{ id: 'worksystem', name: 'Work system', kind: 'work' }],
  };
  const draw = async (invoice) => {
    const flow = (path) => {
      if (path === '/api/invoicing/context') return Promise.resolve({ canIssue: true, sendsTo: 'Xero', organisations: [{ id: 'lab' }] });
      if (path === `/api/invoicing/invoices/${invoice.id}`) return Promise.resolve({ invoice });
      return Promise.resolve({});
    };
    const main = document.createElement('main');
    await renderInvoice(main, { h, notice, flow, toast() {}, go() {}, dialog: async () => false }, invoice.id);
    return main;
  };
  const buttons = (main) => main.querySelectorAll('button').map((el) => el.textContent);

  const own = await draw(base);
  assert.ok(buttons(own).includes('Revise'), 'an invoice Flow made can be revised');
  assert.ok(!own.querySelectorAll('.fx-status').some((el) => el.textContent === 'Imported'));

  const job = (ref) => ({ id: ref, sourceSystem: 'worksystem', sourceJobRef: ref, caseRef: ref, systemName: 'Work system', link: null });
  const imported = await draw({ ...base, imported: true, job: job('CASE-1'), tiedJobs: [job('CASE-1'), job('CASE-2')] });
  const chip = imported.querySelectorAll('.fx-status').find((el) => el.textContent === 'Imported');
  assert.ok(chip, imported.textContent);
  assert.match(chip.getAttribute('title'), /Xero owns this invoice/);
  for (const label of ['Revise', 'Void', 'Delete']) assert.ok(!buttons(imported).includes(label), `no ${label}`);
  assert.ok(!buttons(imported).some((label) => /Send|Xero/.test(label)), buttons(imported).join(', '));
  assert.deepEqual(imported.querySelectorAll('.fx-linked__ref').map((el) => el.textContent), ['CASE-1', 'CASE-2']);
  assert.match(imported.querySelector('.fx-lines__table').textContent, /Crown——GST/);
});
