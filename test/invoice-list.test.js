import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// The page scripts import each other by their served path (/assets/ui/...).
const ui = new URL('../server/ui/', import.meta.url);
registerHooks({
  resolve: (specifier, context, next) => next(specifier.startsWith('/assets/ui/') ? new URL(specifier.slice('/assets/ui/'.length), ui).href : specifier, context),
});
const { renderInvoiceList } = await import('../server/ui/invoicing.js');

// A small stand-in for the page: enough elements to draw the list and click
// its tabs, with each answer from the server held until the test lets it go.
class El {
  constructor(tag) { Object.assign(this, { tag, attrs: {}, dataset: {}, children: [], hidden: false, listeners: {} }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...kids) { this.children.push(...kids.flat().filter((k) => k != null)); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  get classList() { return { toggle: (name, on) => { this.attrs[`class:${name}`] = String(on); } }; }
  get firstChild() { return this.children[0] ?? null; }
  set innerHTML(markup) { this.children = [new El('svg')]; }
  get text() { return this.children.map((k) => (k instanceof El ? k.text : String(k))).join(''); }
  all(test) { return this.children.filter((k) => k instanceof El).flatMap((k) => [...(test(k) ? [k] : []), ...k.all(test)]); }
}

function h(tag, props = {}, ...kids) {
  const el = new El(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k.startsWith('on')) el[k] = v;
    else if (k === 'hidden') el.hidden = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

function page() {
  const asked = [];
  const flow = (path) => {
    if (path === '/api/invoicing/context') return Promise.resolve({ canIssue: true });
    if (path.startsWith('/api/alerts')) return Promise.resolve({ alerts: [] });
    let answer;
    const promise = new Promise((resolve) => { answer = resolve; });
    asked.push({ path, answer });
    return promise;
  };
  const main = new El('main');
  const ui = { h, flow, go() {}, toast() {}, notice: (m) => h('p', {}, m), pageHeader: (title) => h('header', {}, title),
    listHead: (title, { start = [], end = [], actions = [] } = {}) => ({ nodes: [h('header', {}, title), h('div', {}, start, end, actions)] }) };
  return { main, ui, asked };
}

const list = (status, numbers) => ({
  invoices: numbers.map((number, i) => ({ id: `${status}-${i}`, number, contactName: `Client ${number}`, status: status === 'issued' ? 'issued' : 'draft', tab: status === 'issued' ? 'approved' : status, totalCents: 100, createdAt: '2026-01-01' })),
  counts: { pending: 0, ready: 1, draft: 0, approved: 1, sent: 0, void: 0 },
  sendsTo: null,
  sendMode: null,
});
const settle = () => new Promise((resolve) => { setImmediate(resolve); });
const tab = (main, name) => main.all((el) => el.getAttribute('role') === 'tab' && el.text.startsWith(name))[0];
const selected = (main) => main.all((el) => el.getAttribute('aria-selected') === 'true')[0].text.replace(/\d+$/, '');
const panel = (main) => main.all((el) => el.getAttribute('class') === 'fx-panel')[0];

test('a tab click selects the tab at once; only the newest answer draws; a tab seen before shows at once', async () => {
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: (tag) => new El(tag) };
  const { main, ui, asked } = page();
  const opened = renderInvoiceList(main, ui);
  await settle();
  asked.shift().answer(list('ready', ['R-1']));
  await opened;
  assert.equal(selected(main), 'Ready');

  // Approved is selected before the server answers; the old list is dimmed.
  tab(main, 'Approved').onclick();
  assert.equal(selected(main), 'Approved');
  assert.equal(panel(main).getAttribute('aria-busy'), 'true');
  assert.ok('stale' in panel(main).dataset);
  const issued = asked.shift();

  // A quick click back to Ready draws its last list at once, and the late
  // Approved answer does not replace it.
  tab(main, 'Ready').onclick();
  assert.equal(selected(main), 'Ready');
  assert.match(panel(main).text, /R-1/);
  assert.ok(!('stale' in panel(main).dataset));
  issued.answer(list('issued', ['I-1']));
  await settle();
  assert.match(panel(main).text, /R-1/);
  assert.doesNotMatch(panel(main).text, /I-1/);
  assert.equal(panel(main).getAttribute('aria-busy'), 'true');

  asked.shift().answer(list('ready', ['R-2']));
  await settle();
  assert.match(panel(main).text, /R-2/);
  assert.equal(panel(main).getAttribute('aria-busy'), null);
});

test('only Draft, Approved, Sent and Void show a Number column; the other tabs open on Client', async () => {
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: (tag) => new El(tag) };
  const { main, ui, asked } = page();
  const opened = renderInvoiceList(main, ui);
  await settle();
  asked.shift().answer(list('ready', [null]));
  await opened;
  const heads = () => panel(main).all((el) => el.tag === 'th').map((el) => el.text);
  assert.ok(!heads().includes('Number'));
  assert.equal(heads()[1], 'Client');

  tab(main, 'Approved').onclick();
  asked.shift().answer(list('issued', ['INV-1']));
  await settle();
  assert.ok(heads().includes('Number'));
  assert.match(panel(main).text, /INV-1/);
});

test('with integrations on, a Linked column shows one icon per system; one not in Xero stands out', async () => {
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: (tag) => new El(tag) };
  const { main, ui, asked } = page();
  const flow = ui.flow;
  ui.flow = (path, options) => (path === '/api/invoicing/context'
    ? Promise.resolve({ canIssue: true, sendsTo: 'Xero', organisations: [{ id: 'org-1' }] })
    : flow(path, options));
  const linksTo = [{ id: 'seazona', name: 'Seazona', kind: 'work' }, { id: 'xero', name: 'Xero', kind: 'accounting' }];
  const opened = renderInvoiceList(main, ui);
  await settle();
  asked.shift().answer({ ...list('ready', [null]), sendsTo: 'Xero', linksTo });
  await opened;
  const heads = () => panel(main).all((el) => el.tag === 'th').map((el) => el.text);
  const icons = () => panel(main).all((el) => /^fx-link( |$)/.test(el.getAttribute('class') ?? ''));
  // A draft shows its work system link only.
  assert.equal(heads().at(-1), 'Linked');
  assert.equal(icons().length, 1);
  assert.equal(icons()[0].getAttribute('class'), 'fx-link fx-link--none');

  tab(main, 'Approved').onclick();
  const approved = list('issued', ['FL-1', 'FL-2']);
  approved.invoices[0].job = { sourceSystem: 'seazona', sourceJobRef: '48213', caseRef: '48213', link: { url: 'https://lab.seazona.net/' } };
  asked.shift().answer({ ...approved, sendsTo: 'Xero', linksTo });
  await settle();
  assert.deepEqual(heads().slice(-2), ['Status', 'Linked']);
  const status = asked.shift();
  assert.equal(status.path, '/api/xero/invoices/status');
  status.answer({ invoices: [
    { invoiceId: 'issued-0', state: 'draft', label: 'Draft in Xero', finding: null, xero: { number: 'INV-0451', url: 'https://go.xero.com/x' } },
    { invoiceId: 'issued-1', state: 'not_sent', label: 'Not in Xero', finding: null, xero: null },
  ] });
  await settle();
  const shown = icons();
  assert.equal(shown.length, 4);
  const [sea, xero, noSea, noXero] = shown;
  assert.equal(sea.tag, 'a');
  assert.equal(sea.getAttribute('href'), 'https://lab.seazona.net/');
  assert.equal(xero.tag, 'a');
  assert.equal(xero.getAttribute('href'), 'https://go.xero.com/x');
  assert.match(xero.getAttribute('title'), /Xero INV-0451: Draft in Xero/);
  assert.equal(noSea.getAttribute('class'), 'fx-link fx-link--none');
  assert.equal(noXero.tag, 'span');
  assert.equal(noXero.all((el) => el.getAttribute('data-tone') === 'warn').length, 1);
});

test('ticked rows bring up the bulk bar: N selected, the tab\'s actions, and × clears', async () => {
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: (tag) => new El(tag) };
  const { main, ui, asked } = page();
  const opened = renderInvoiceList(main, ui);
  await settle();
  asked.shift().answer(list('ready', ['R-1', 'R-2', 'R-3']));
  await opened;
  const bulk = () => main.all((el) => el.getAttribute('class') === 'fx-bulk')[0];
  const acts = () => bulk().all((el) => /fx-bulk__act( |$)/.test(el.getAttribute('class') ?? ''));
  const words = () => acts().map((el) => el.getAttribute('data-tip') ?? el.text);
  assert.equal(bulk().hidden, true);

  // Tick two rows: the bar shows the count, Approve first.
  const boxes = panel(main).all((el) => el.tag === 'input' && /^Tick /.test(el.getAttribute('aria-label') ?? '') && el.getAttribute('aria-label') !== 'Tick every invoice shown');
  for (const box of boxes.slice(0, 2)) { box.checked = true; box.onchange(); }
  assert.equal(bulk().hidden, false);
  assert.match(bulk().text, /^2 selected/);
  assert.deepEqual(words(), ['Approve', 'Copy references', 'Export CSV', 'More']);
  assert.match(acts()[0].getAttribute('class'), /--primary/);
  // Ready has no Move to Drafts: a clean draft is ready by itself.
  assert.doesNotMatch(main.text, /Drafts/);

  // × clears the ticks and hides the bar.
  bulk().all((el) => el.getAttribute('aria-label') === 'Clear the ticks')[0].onclick();
  assert.equal(bulk().hidden, true);
  const again = panel(main).all((el) => el.tag === 'input' && el.getAttribute('aria-label')?.startsWith('Tick R-'));
  again[0].checked = true; again[0].onchange();
  assert.match(bulk().text, /^1 selected/);
  bulk().all((el) => el.getAttribute('aria-label') === 'Clear the ticks')[0].onclick();
  assert.equal(bulk().hidden, true);

  // Approved rows can be ticked too; there the bar has Void, not Approve.
  tab(main, 'Approved').onclick();
  asked.shift().answer(list('issued', ['FL-1']));
  await settle();
  const fl = panel(main).all((el) => el.tag === 'input' && el.getAttribute('aria-label')?.startsWith('Tick FL-1'))[0];
  fl.checked = true; fl.onchange();
  assert.deepEqual(words(), ['Copy numbers', 'Export CSV', 'Download PDFs', 'Void', 'More']);
});
