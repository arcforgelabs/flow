import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSearchKey } from '../server/ui/search.js';

test('Ctrl+K and ⌘K open search', () => {
  assert.equal(isSearchKey({ key: 'k', ctrlKey: true }), true);
  assert.equal(isSearchKey({ key: 'K', metaKey: true }), true);
});

test('other keys and modifiers do not open search', () => {
  assert.equal(isSearchKey({ key: 'k' }), false);
  assert.equal(isSearchKey({ key: 'j', ctrlKey: true }), false);
  assert.equal(isSearchKey({ key: 'k', ctrlKey: true, shiftKey: true }), false);
  assert.equal(isSearchKey({ key: 'k', metaKey: true, altKey: true }), false);
});

// Chrome sends keydown events with no key when it fills a form from saved
// details; the shortcut check must not throw on them.
test('a keydown with no key is not the shortcut and does not throw', () => {
  assert.equal(isSearchKey({}), false);
  assert.equal(isSearchKey({ key: undefined, ctrlKey: true }), false);
});
