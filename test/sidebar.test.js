import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the sidebar foot holds the account chip and Search; light or dark is on the Appearance page', () => {
  const page = read('../server/ui/app-page.js');
  const foot = page.match(/<div class="fx-side__end">([\s\S]*?)<\/div>\n    <\/aside>/)[1];
  assert.match(foot, /id="user-button"/);
  assert.match(foot, /id="search"[^>]*aria-label="Search"/);
  assert.doesNotMatch(foot, /data-mode-toggle/);
  assert.doesNotMatch(foot, /report-problem/, 'Report a problem is in the account menu');
});

test('search.js is served with the other page scripts', () => {
  assert.match(read('../server/ui/routes.js'), /'search\.js'/);
  assert.match(read('../server/ui/app.js'), /import \{ openSearch \} from '\/assets\/ui\/search\.js';/);
});
