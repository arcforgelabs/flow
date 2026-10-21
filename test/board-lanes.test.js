import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../server/ui/flow.css', import.meta.url), 'utf8');

test('board lanes keep one fixed phone width and never stretch to fill a wide screen', () => {
  const board = css.match(/^\.fx-board \{([^}]*)\}/m)[1];
  assert.match(board, /--fx-lane: min\(85vw, 272px\);/);
  assert.match(board, /grid-auto-columns: var\(--fx-lane\);/);
  assert.match(board, /justify-content: start;/);
  assert.doesNotMatch(board, /1fr/, 'a lane must not take a share of spare width');
});
