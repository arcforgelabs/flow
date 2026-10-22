import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Flow has three widths (docs/MOBILE_TESTS.md): phone up to 639px, tablet
// 640–1023px, desk from 1024px. A media query or matchMedia in server/ui
// uses only these edges. The older widths below are left from before; each
// phone issue moves its rules onto the edges and takes its width off this
// list. Never add one.
const EDGES = new Set(['max-width: 639px', 'min-width: 640px', 'max-width: 1023px', 'min-width: 1024px']);
const OLDER = new Map([
  ['max-width: 820px', 'navigation (#288)'],
  ['min-width: 821px', 'navigation (#288)'],
  ['max-width: 900px', 'Integrations page (#287)'],
  ['max-width: 960px', 'list head (#284)'],
  ['max-width: 1320px', 'list head (#284)'],
]);

const dir = new URL('../server/ui/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.css') || f.endsWith('.js'));

test('media queries use only the three widths', () => {
  const found = new Map();
  for (const file of files) {
    for (const [, query] of readFileSync(new URL(file, dir), 'utf8').matchAll(/\(((?:max|min)-width:\s*\d+px)\)/g)) {
      const width = query.replace(/\s+/g, ' ');
      if (!found.has(width)) found.set(width, new Set());
      found.get(width).add(file);
    }
  }
  const stray = [...found].filter(([width]) => !EDGES.has(width) && !OLDER.has(width))
    .map(([width, where]) => `${width} in ${[...where].join(', ')}`);
  assert.deepEqual(stray, [], 'use max-width: 639px, min-width: 640px, max-width: 1023px or min-width: 1024px');
  const gone = [...OLDER.keys()].filter((width) => !found.has(width));
  assert.deepEqual(gone, [], 'a width is no longer used: take it off OLDER in test/breakpoints.test.js');
});
