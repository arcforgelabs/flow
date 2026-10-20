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
  const ui = { h, flow, go() {}, toast() {}, notice: (m) => h('p', {}, m), pageHeader: (title) => h('header', {}, title) };
  return { main, ui, asked };
}

const list = (status, numbers) => ({
  invoices: numbers.map((number, i) => ({ id: `${status}-${i}`, number, status: status === 'issued' ? 'issued' : 'draft', totalCents: 100, createdAt: '2026-01-01' })),
  counts: { ready: 1, to_check: 0, problem: 0, issued: 1, void: 0 },
  sendsTo: null,
  sendMode: null,
});
const settle = () => new Promise((resolve) => { setImmediate(resolve); });
const tab = (main, name) => main.all((el) => el.getAttribute('role') === 'tab' && el.text.startsWith(name))[0];
const selected = (main) => main.all((el) => el.getAttribute('aria-selected') === 'true')[0].text.replace(/\d+$/, '');
const panel = (main) => main.all((el) => el.getAttribute('class') === 'fx-panel')[0];

test('a tab click selects the tab at once; only the newest answer draws; a tab seen before shows at once', async () => {
  globalThis.sessionStorage = { getItem: () => null, setItem() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const { main, ui, asked } = page();
  const opened = renderInvoiceList(main, ui);
  await settle();
  asked.shift().answer(list('ready', ['R-1']));
  await opened;
  assert.equal(selected(main), 'Ready');

  // Issued is selected before the server answers; the old list is dimmed.
  tab(main, 'Issued').onclick();
  assert.equal(selected(main), 'Issued');
  assert.equal(panel(main).getAttribute('aria-busy'), 'true');
  assert.ok('stale' in panel(main).dataset);
  const issued = asked.shift();

  // A quick click back to Ready draws its last list at once, and the late
  // Issued answer does not replace it.
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
