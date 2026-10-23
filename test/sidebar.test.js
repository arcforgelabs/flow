import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NAV_DEFAULT, NAV_LOCKED, NAV_PAGES } from '../server/ui/nav-pins.js';

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
  assert.match(read('../server/ui/app.js'), /import \{ isSearchKey, openSearch \} from '\/assets\/ui\/search\.js';/);
});

test('the sidebar button folds the sidebar on wide screens and opens it as a drawer on narrow ones', () => {
  const page = read('../server/ui/app-page.js');
  assert.match(page, /<div class="fx-side__head">[\s\S]*id="menu-toggle"[^>]*aria-controls="nav"/);
  const css = read('../server/ui/flow.css');
  assert.match(css, /@media \(min-width: 821px\) \{\n  \.fx-shell\[data-folded\] \.fx-side \{ width: 64px;/);
  // Narrow: a drawer from the left over a dimmed page, not a panel dropping
  // down; the button shows a sidebar icon, never a hamburger.
  assert.match(css, /\.fx-shell\[data-menu-open\] \.fx-nav \{ transform: none; visibility: visible; \}/);
  assert.match(css, /\.fx-shell\[data-menu-open\]::after \{/);
  const app = read('../server/ui/app.js');
  assert.match(app, /const sidebar = icon\('sidebar'\);/);
  assert.doesNotMatch(app, /M4 6h16M4 12h16M4 18h16/, 'no hamburger icon');
  // Folded or narrow, the logo is the button: brand hidden, mark at rest,
  // sidebar icon on hover or focus, never both side by side.
  assert.match(app, /\$\('menu-toggle'\)\.replaceChildren\(mark, sidebar\)/);
  assert.match(css, /\.fx-shell\[data-folded\] \.fx-side__head \.fx-brand \{ display: none; \}/);
  assert.match(css, /\.fx-shell\[data-folded\] #menu-toggle:is\(:hover, :focus-visible\) \.fx-toggle__icon \{ display: inline-flex; \}/);
  assert.match(css, /#menu-toggle:is\(:hover, :focus-visible, \[aria-expanded="true"\]\) \.fx-toggle__icon \{ display: inline-flex; \}/);
  // Folded, the page names stay for screen readers.
  assert.match(css, /\.fx-shell\[data-folded\] \.fx-nav__label \{ position: absolute; width: 1px;/);
});

test('Account is not in the sidebar; its page stays, with one visible heading', () => {
  const app = read('../server/ui/app.js');
  assert.match(app, /account: \{ label: 'Account', icon: 'person', sidebar: false, render: renderAccount \}/);
  assert.match(app, /view\.sidebar !== false && view\.place !== 'account'/);
  assert.match(app, /main\.append\(h\('h1', \{ class: 'fx-sr' \}, 'Account'\), host\);/);
});

test('a person lands on Invoices, Ready tab, after sign-in and at / or an unknown path', () => {
  const app = read('../server/ui/app.js');
  assert.match(app, /const START_VIEW = 'invoices';/);
  assert.match(app, /return \[START_VIEW, null\];/);
  assert.doesNotMatch(app, /return \['jobs', null\];/);
  // A new browser tab has no saved tab, so the list opens on Ready.
  assert.match(read('../server/ui/invoicing.js'), /\? saved : 'ready'/);
});

test('folded, a click on the sidebar empty space opens it; a click on a page, the account photo or Search does not', () => {
  const app = read('../server/ui/app.js');
  assert.match(app, /if \(NARROW\.matches \|\| !readFolded\(\) \|\| !event\.target\.closest\?\.\('\.fx-side'\)\) return;/);
  assert.match(app, /event\.target\.closest\('a, button, input, select, textarea, \[role="button"\], \[role="menuitem"\], #user-button'\)\) return;\n  toggleMenu\(\);/);
  const css = read('../server/ui/flow.css');
  assert.match(css, /\.fx-shell\[data-folded\] \.fx-side \{ width: 64px; padding-inline: 10px; cursor: e-resize; \}/);
});

test('the sidebar shows pinned pages, then More; People and Appearance are in the account menu', () => {
  const app = read('../server/ui/app.js');
  const views = app.match(/const VIEWS = \{([\s\S]*?)\n\};/)[1];
  // The sidebar order: daily work first, then Price list and Rules.
  const order = [...views.matchAll(/^  '?([a-z-]+)'?: \{/gm)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 6), ['jobs', 'invoices', 'contacts', 'reconcile', 'price-list', 'invoicing-settings']);
  for (const name of ['automations', 'custom-fields', 'integrations']) assert.match(views, new RegExp(`'?${name}'?: \\{[^\\n]*place: 'more'`));
  for (const name of ['people', 'appearance']) assert.match(views, new RegExp(`${name}: \\{[^\\n]*place: 'account'`));
  const lineOf = (name) => views.match(new RegExp(`'?${name}'?: \\{[^\\n]*`))[0];
  const sidebar = order.filter((name) => !lineOf(name).includes("place: 'account'") && !lineOf(name).includes('sidebar: false'));
  assert.deepEqual(sidebar, [...NAV_PAGES], 'a new sidebar page is added to the pin allow-list');
  const defaults = sidebar.filter((name) => !lineOf(name).includes("place: 'more'"));
  assert.deepEqual(defaults, [...NAV_DEFAULT]);
  assert.deepEqual([...NAV_LOCKED], ['jobs', 'invoices']);
  // No group headings in the sidebar.
  assert.doesNotMatch(app, /fx-nav__group/);
  // More is the shared row menu, floating to the right of the row, listing
  // every sidebar page. It shows as current while an unpinned page is open.
  assert.match(app, /rowMenu\('More', moreItems, \{ trigger: \[icon\('more'\), h\('span', \{ class: 'fx-nav__label' \}, 'More'\)\], className: 'fx-nav__more', align: 'start', place: 'side' \}\)/);
  assert.match(app, /inSidebar && !shown \? 'page' : 'false'/);
  assert.match(app, /NAV_LOCKED\.includes\(name\)/);
  assert.match(app, /\/api\/me\/views\/nav/);
  // The account menu: People (owners), Appearance, then Report a problem.
  assert.match(app, /customMenuItems: accountItems \}/);
  assert.match(app, /customMenuItems: \[\.\.\.accountItems, reportMenuItem\(openReport\)\]/);
  const kit = read('../server/ui/kit.js');
  assert.match(kit, /export function rowMenu\(label, items, \{ trigger = null, className = 'fx-cfm__more', align = 'end', place = 'below' \} = \{\}\)/);
  assert.match(kit, /place === 'side'/);
  assert.match(kit, /entry\.trailing/);
  const css = read('../server/ui/flow.css');
  assert.match(css, /\.fx-nav :is\(a, \.fx-nav__more\)\[aria-current="page"\] \{/);
  assert.match(css, /\.fx-pop__pin\[aria-pressed="false"\] \{ opacity: 0; \}/);
  assert.match(css, /\.fx-pop--side \.fx-pop__item \{ min-height: 44px; \}/);
});
