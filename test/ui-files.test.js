import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { UI_FILES } from '../server/ui/routes.js';

// Every page module the browser imports (/assets/ui/<file>, static or
// dynamic) must be served, or the page that imports it fails to load.
test('every /assets/ui import is a served file', () => {
  const dir = new URL('../server/ui/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    for (const [, name] of readFileSync(new URL(file, dir), 'utf8').matchAll(/['"]\/assets\/ui\/([\w.-]+\.js)['"]/g)) {
      assert.ok(UI_FILES.has(name), `${file} imports /assets/ui/${name}; add it to UI_FILES in server/ui/routes.js`);
    }
  }
});
