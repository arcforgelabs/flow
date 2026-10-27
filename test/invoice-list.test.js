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
  constructor(tag) { Object.assign(this, { tag, attrs: {}, dataset: {}, style: {}, children: [], hidden: false, listeners: {} }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...kids) { this.children.push(...kids.flat().filter((k) => k != null)); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  scrollIntoView() {}
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

function page({ fields = [], people = [], values = [] } = {}) {
  const asked = [];
  const flow = (path) => {
    if (path === '/api/invoicing/context') return Promise.resolve({ canIssue: true });
    if (path === '/api/custom-fields') return Promise.resolve({ fields, people });
    if (path === '/api/custom-fields/values') return Promise.resolve({ values });
    if (path.startsWith('/api/alerts')) return Promise.resolve({ alerts: [] });
    let answer;
    const promise = new Promise((resolve) => { answer = resolve; });
    asked.push({ path, answer });
    return promise;
  };
  const main = new El('main');
  const ui = { h, flow, go() {}, toast() {}, notice: (m) => h('p', {}, m), pageHeader: (title) => h('header', {}, title),
    listHead: (title, { start = [], end = [], actions = [] } = {}) => ({ nodes: [h('header', {}, title), h('div', {}, start, end, actions)] }),
    listFrame: (_main, content) => {
      const tools = h('div', {});
      return { element: h('section', {}, content, h('footer', {}, tools)), body: { scrollTop: 0 }, tools, count() {} };
    } };
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

test('a person adds the job\'s Shipped date, Case, Practitioner, the Due date and custom fields as columns', async () => {
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: (tag) => new El(tag) };
  const shade = { id: '0b6a3a4e-6f3d-4b52-9d8e-2f1c7a9e5d10', name: 'Shade', type: 'dropdown', options: [{ id: 'a2', name: 'A2' }] };
  const owner = { id: '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f', name: 'Checked by', type: 'person' };
  const { main, ui, asked } = page({
    fields: [shade, owner], people: [{ id: 'p-1', name: 'Jo Lee' }],
    values: [{ sourceSystem: 'seazona', sourceJobRef: '48213', fieldId: shade.id, value: 'a2' }, { sourceSystem: 'seazona', sourceJobRef: '48213', fieldId: owner.id, value: 'p-1' }],
  });
  const heads = () => panel(main).all((el) => el.tag === 'th').map((el) => el.text).filter((t) => t && t !== '+');
  const cells = (label) => panel(main).all((el) => el.tag === 'td' && el.getAttribute('data-label') === label);
  const sample = () => {
    const answer = list('issued', ['FL-1', 'FL-2']);
    Object.assign(answer.invoices[0], { dueDate: '2025-11-20', job: { sourceSystem: 'seazona', sourceJobRef: '48213', caseRef: '48213', practitioner: 'Dr Example', shippedOn: '2025-10-05' } });
    return answer;
  };

  // Before a person chooses, the list keeps its usual columns.
  let opened = renderInvoiceList(main, ui);
  await settle();
  asked.shift().answer(sample());
  await opened;
  for (const name of ['Shipped', 'Case', 'Practitioner', 'Due', 'Shade']) assert.ok(!heads().includes(name), name);

  // Chosen (saved with the account), each shows the invoice's job's value.
  ui.me = { views: { invoices: { columns: ['client', 'shipped', 'case', 'practitioner', 'due', `field:${shade.id}`, `field:${owner.id}`] } } };
  main.replaceChildren();
  opened = renderInvoiceList(main, ui);
  await settle();
  asked.shift().answer(sample());
  await opened;
  assert.deepEqual(heads(), ['Client', 'Shipped', 'Case', 'Practitioner', 'Due', 'Shade', 'Checked by']);
  assert.match(cells('Shipped')[0].text, /05\/10\/25/);
  assert.equal(cells('Shipped')[0].children[0].getAttribute('datetime'), '2025-10-05');
  assert.equal(cells('Case')[0].text, '48213');
  assert.equal(cells('Practitioner')[0].text, 'Dr Example');
  assert.match(cells('Due')[0].text, /20\/11\/25/);
  assert.equal(cells('Shade')[0].text, 'A2');
  assert.equal(cells('Checked by')[0].children[0].getAttribute('aria-label'), 'Jo Lee');
  // An invoice with no job shows a dash.
  for (const label of ['Shipped', 'Case', 'Practitioner', 'Shade']) assert.equal(cells(label)[1].text, '—', label);
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
  // The last head is + (show a hidden column).
  const heads = () => panel(main).all((el) => el.tag === 'th').map((el) => el.text).filter((t) => t !== '+');
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

test('the list asks the server for one page; a page button asks for the next rows', async () => {
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: (tag) => new El(tag) };
  const { main, ui, asked } = page();
  const opened = renderInvoiceList(main, ui);
  await settle();
  const first = asked.shift();
  const query = (path) => new URL(path, 'http://flow.test').searchParams;
  assert.equal(query(first.path).get('offset'), '0');
  assert.equal(query(first.path).get('limit'), '100');
  assert.equal(query(first.path).get('filter'), null, 'no filter, none sent');
  first.answer({ ...list('ready', ['R-1']), offset: 0, limit: 100, total: 250 });
  await opened;
  const pages = main.all((el) => el.getAttribute('class') === 'fx-pages')[0];
  assert.match(pages.text, /1–100 of 250/);
  const nums = pages.all((el) => el.getAttribute('class') === 'fx-pages__num');
  assert.deepEqual(nums.map((n) => n.text), ['1', '2', '3']);

  nums[2].onclick();
  const third = asked.shift();
  assert.equal(query(third.path).get('offset'), '200');
  third.answer({ ...list('ready', ['R-201']), offset: 200, limit: 100, total: 250 });
  await settle();
  assert.match(panel(main).text, /R-201/);
  assert.match(pages.text, /201–250 of 250/);

  // A new tab starts at its first page.
  tab(main, 'Approved').onclick();
  assert.equal(query(asked.shift().path).get('offset'), '0');
});
