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

test('the menu button folds the sidebar on wide screens and opens it on narrow ones', () => {
  const page = read('../server/ui/app-page.js');
  assert.match(page, /<div class="fx-side__head">[\s\S]*id="menu-toggle"[^>]*aria-controls="nav"/);
  const css = read('../server/ui/flow.css');
  assert.match(css, /@media \(min-width: 821px\) \{\n  \.fx-shell\[data-folded\] \.fx-side \{ width: 64px;/);
  assert.match(css, /\.fx-shell\[data-menu-open\] \.fx-nav \{ display: flex; \}/);
  // Folded, the page names stay for screen readers.
  assert.match(css, /\.fx-shell\[data-folded\] \.fx-nav__label \{ position: absolute; width: 1px;/);
});
