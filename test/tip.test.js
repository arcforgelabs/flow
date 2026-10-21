import assert from 'node:assert/strict';
import { test } from 'node:test';
import { iconOnly, tipText } from '../server/ui/tip.js';

// The tips on icon-only controls (server/ui/tip.js). Stand-in elements only.

const el = (text, attrs = {}, inClerk = false) => ({
  textContent: text,
  getAttribute: (name) => attrs[name] ?? null,
  closest: () => (inClerk ? {} : null),
});

test('a control with no word of its own is icon-only', () => {
  assert.equal(iconOnly(''), true);
  assert.equal(iconOnly('  ✕ '), true);
  assert.equal(iconOnly('⋯'), true);
  assert.equal(iconOnly('Board'), false);
  assert.equal(iconOnly('1/3'), false);
});

test('an icon-only control shows its name; a control with words shows none', () => {
  assert.equal(tipText(el('', { 'aria-label': 'Close' })), 'Close');
  assert.equal(tipText(el('✕', { title: 'Remove line', 'aria-label': 'Remove line 2' })), 'Remove line', 'the title is the short tip');
  assert.equal(tipText(el('', { 'aria-label': 'Clear the ticks', 'data-tip': 'Clear' })), 'Clear');
  assert.equal(tipText(el('Save', { 'aria-label': 'Save the invoice' })), null);
  assert.equal(tipText(el('Jobs', { 'data-tip': 'Jobs' })), 'Jobs', 'a folded sidebar link asks for its tip');
  assert.equal(tipText(el('')), null, 'no name, no tip');
  assert.equal(tipText(el('', { 'aria-label': 'Account' }, true)), null, "Clerk's components keep their own tips");
});
