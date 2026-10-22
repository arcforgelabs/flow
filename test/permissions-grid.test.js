import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const ui = new URL('../server/ui/', import.meta.url);
registerHooks({
  resolve: (specifier, context, next) => next(specifier.startsWith('/assets/ui/') ? new URL(specifier.slice('/assets/ui/'.length), ui).href : specifier, context),
});
const { permissionGrid } = await import('../server/ui/permissions-grid.js');

class El {
  constructor(tag) { Object.assign(this, { tag, attrs: {}, children: [], listeners: {} }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(...kids) { this.children.push(...kids.flat().filter((k) => k != null && k !== false)); }
  all(test) { return this.children.filter((k) => k instanceof El).flatMap((k) => [...(test(k) ? [k] : []), ...k.all(test)]); }
}
globalThis.Node = El;
globalThis.document = {
  createElement: (tag) => new El(tag),
  createTextNode: (text) => String(text),
};

function h(tag, props = {}, ...kids) {
  const el = new El(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (typeof v === 'function') el[k] = v;
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

const groups = [{ label: 'Invoices', permissions: [{ key: 'invoices.send', label: 'Send' }, { key: 'invoices.void', label: 'Void' }] }];

function switches(root, label) {
  return root.all((el) => el.getAttribute('aria-label') === label);
}

test('All turns every permission for a role on, then off; the owner All stays on', () => {
  const grants = {
    owner: { 'invoices.send': true, 'invoices.void': true },
    admin: { 'invoices.send': true, 'invoices.void': false },
    staff: { 'invoices.send': false, 'invoices.void': false },
  };
  const seen = [];
  let root;
  const draw = () => {
    root = permissionGrid(h, {
      groups, grants,
      onChange(role, key, allowed) {
        grants[role][key] = allowed;
        seen.push([role, key, allowed]);
        draw();
      },
    });
  };
  draw();
  const owner = switches(root, 'All for Owner')[0];
  assert.equal(owner.getAttribute('aria-checked'), 'true');
  assert.equal(owner.getAttribute('disabled'), 'true');
  assert.equal(owner.onclick, undefined);

  assert.equal(switches(root, 'All for Staff')[0].getAttribute('aria-checked'), 'false');
  switches(root, 'All for Staff')[0].onclick();
  assert.deepEqual(seen, [['staff', 'invoices.send', true], ['staff', 'invoices.void', true]]);
  assert.equal(switches(root, 'All for Staff')[0].getAttribute('aria-checked'), 'true');
  assert.equal(switches(root, 'Send for Staff')[0].getAttribute('aria-checked'), 'true');

  switches(root, 'All for Admin')[0].onclick();
  assert.deepEqual(seen.at(-1), ['admin', 'invoices.void', true]);
  assert.equal(grants.admin['invoices.send'], true);

  switches(root, 'All for Staff')[0].onclick();
  assert.equal(grants.staff['invoices.send'], false);
  assert.equal(grants.staff['invoices.void'], false);
  assert.equal(switches(root, 'All for Staff')[0].getAttribute('aria-checked'), 'false');
});

test('onChangeAll hears the All switch once', () => {
  const grants = {
    owner: { 'invoices.send': true, 'invoices.void': true },
    admin: { 'invoices.send': false, 'invoices.void': false },
    staff: { 'invoices.send': false, 'invoices.void': false },
  };
  let batch = null;
  const root = permissionGrid(h, {
    groups, grants,
    onChange() { throw new Error('one permission'); },
    onChangeAll(role, allowed) { batch = [role, allowed]; },
  });
  switches(root, 'All for Admin')[0].onclick();
  assert.deepEqual(batch, ['admin', true]);
});
