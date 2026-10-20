import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// The page scripts import each other by their served path (/assets/ui/...).
const ui = new URL('../server/ui/', import.meta.url);
registerHooks({
  resolve: (specifier, context, next) => next(specifier.startsWith('/assets/ui/') ? new URL(specifier.slice('/assets/ui/'.length), ui).href : specifier, context),
});
const { openNext } = await import('../server/ui/invoicing.js');

const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const nav = () => JSON.parse(store.get('flow_invoice_nav'));

test('after a send, the next invoice opens and the count holds', () => {
  store.clear();
  store.set('flow_invoice_nav', JSON.stringify({ tab: 'ready', ids: ['a', 'b', 'c'] }));
  const went = [];
  openNext({ go: (href) => went.push(href) }, 'a');
  assert.deepEqual(went, ['/invoices/b']);
  assert.deepEqual(nav().ids, ['a', 'b', 'c'], 'the sent invoice stays, so the bar still says 2 of 3');
});

test('after the last invoice is sent, the list opens', () => {
  store.clear();
  store.set('flow_invoice_nav', JSON.stringify({ tab: 'ready', ids: ['a', 'b'] }));
  const went = [];
  openNext({ go: (href) => went.push(href) }, 'b');
  assert.deepEqual(went, ['/invoices']);
  assert.equal(store.get('flow_invoice_back'), '1');
});
