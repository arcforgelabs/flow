import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDesignSystem, cardNames } from '../scripts/design-system/build.mjs';
import { loadCardRules } from '../scripts/design-system/mobile-rules.mjs';
import { RULES, WIDTHS, assignPhoneSlots, phoneSlot } from '../server/ui/mobile.js';
import { SCREENS } from './mobile/screens.js';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// The modules whose exports are shared components. Each export has a card,
// or is a helper listed here.
const SHARED = ['server/ui/kit.js', 'server/ui/view-bar.js', 'server/ui/bulk-bar.js', 'server/ui/tip.js', 'server/ui/job-change.js', 'server/ui/sidecar.js', 'server/ui/columns.js'];
const HELPERS = new Set(['h', 'ICONS', 'svg', 'today', 'iconOnly', 'tipText', 'startTips', 'FIRST_ROWS', 'changeRows', 'changeSummary', 'linksOpenWith', 'watchPhonePrimary']);

const exportsOf = (source) => [...source.matchAll(/^export (?:async )?(?:function|const|let) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);

test('every shared component has a design system card', () => {
  const covered = new Set(cardNames().flatMap((name) => {
    const code = /^Code: (.+)$/m.exec(read(`design-system/components/${name}/README.md`));
    assert.ok(code, `${name}/README.md has a "Code:" line`);
    return [...code[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  }));
  for (const file of SHARED) {
    for (const name of exportsOf(read(file))) {
      if (HELPERS.has(name)) continue;
      assert.ok(covered.has(name), `${name} (${file}) has a card in design-system/components/, or is listed as a helper in this test`);
    }
  }
});

test('every visible card has phone rules, and the browser reads those rules', () => {
  const screens = new Set(SCREENS.map((screen) => screen.id));
  const rules = loadCardRules();
  assert.deepEqual(RULES, rules, 'server/ui/mobile.js is behind the cards; run node scripts/design-system/mobile-rules.mjs');
  assert.deepEqual(WIDTHS, {
    phone: '(max-width: 639px)',
    tabletMin: '(min-width: 640px)',
    tabletMax: '(max-width: 1023px)',
    desk: '(min-width: 1024px)',
  });
  for (const name of cardNames()) {
    const file = `design-system/components/${name}/mobile.json`;
    assert.ok(existsSync(join(ROOT, file)), `${name} has no mobile.json`);
    const raw = JSON.parse(read(file));
    assert.equal(raw.touch, 44, `${name} touch`);
    assert.equal(raw.pageOverflow, 'none', `${name} page overflow`);
    assert.ok(raw.direction && raw.phone?.layout && raw.tablet?.layout && raw.desk?.layout, `${name} names a direction and a layout at each width`);
    const code = /^Code: (.+)$/m.exec(read(`design-system/components/${name}/README.md`));
    const sources = [...code[1].matchAll(/server\/ui\/[\w.-]+\.js/g)].map((match) => read(match[0])).join('\n');
    for (const component of [raw.component, ...(raw.also ?? []).map((part) => part.component)]) {
      assert.match(code[1], new RegExp(component.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name} Code line names ${component}`);
      const rule = rules[component];
      assert.ok(rule, `${component} is in the phone rules`);
      for (const screen of rule.screens) assert.ok(screens.has(screen), `${component} lists an unknown screen ${screen}`);
      if (rule.mark === false) continue;
      assert.match(sources, new RegExp(`applyPhoneRule\\([\\s\\S]*?['"]${component}['"]\\)`), `${component} reads its phone rules`);
    }
  }
  assert.equal(phoneSlot({ phone: 'title' }), 'title');
  assert.equal(phoneSlot({ phone: 'meta' }), 'meta');
  assert.equal(phoneSlot({ phone: 'end' }), 'end');
  assert.equal(phoneSlot({ phone: 'hide' }), 'hide');
  assert.equal(phoneSlot({ phone: 'wide' }), null);
  assert.equal(phoneSlot({}), null);
  const placed = assignPhoneSlots([
    { id: 'number', kind: 'text' },
    { id: 'client', kind: 'client', phone: 'title' },
    { id: 'reference', kind: 'text' },
    { id: 'date', kind: 'date' },
    { id: 'total', kind: 'total', num: true },
    { id: 'status', kind: 'status' },
    { id: 'linked', kind: 'link' },
    { id: 'extra', kind: 'text', phone: 'title' },
  ]);
  assert.deepEqual(placed.map((column) => column.phone), ['meta', 'title', 'meta', 'hide', 'end', 'meta', 'hide', 'title']);
  assert.deepEqual(assignPhoneSlots([
    { id: 'client', kind: 'client' },
    { id: 'practitioner', kind: 'text' },
    { id: 'stage', kind: 'stage' },
    { id: 'total', kind: 'total', num: true },
  ]).map((column) => column.phone), ['title', 'meta', 'meta', 'end']);
  assert.equal(assignPhoneSlots([{ id: 'only', kind: 'text', phone: 'hide' }])[0].phone, 'hide');
  assert.deepEqual(rules.columnTable.phone.slots, { title: 2, end: 1, meta: 3 });
  assert.equal(rules.columnTable.phone.columnFlag, 'phone');
  assert.equal(rules.columnTable.minRowsAt375, 7);
});

test('each card names its group on line 1 and has a README', () => {
  for (const name of cardNames()) {
    const preview = read(`design-system/components/${name}/preview.html`);
    assert.match(preview.split('\n')[0], /^<!-- @dsCard group="[A-Za-z ]+" height=\d+ -->$/, `${name}/preview.html line 1`);
    assert.match(read(`design-system/components/${name}/README.md`), new RegExp(`^# ${name}\\n\\n\\S`), `${name}/README.md starts with its name and a summary`);
    for (const [, path] of preview.matchAll(/\/assets\/(?:ui|theme)\/([\w./-]+)/g)) assert.fail(`${name} loads /assets/${path}: use window.FlowDesignSystem`);
  }
  assert.ok(existsSync(join(ROOT, 'design-system/components/Cover/preview.html')));
});

test('the build writes tokens the Design System page can read, and a bundle it can inline', async () => {
  const out = mkdtempSync(join(tmpdir(), 'flow-ds-'));
  try {
    const { project, files } = await buildDesignSystem(out);
    const tokens = JSON.parse(readFileSync(join(project, 'tokens.json'), 'utf8'));
    assert.ok(tokens.color.themes.length <= 8);
    assert.equal(tokens.color.themes[0].id, 'harbour-light');
    const names = ['color', 'radius', 'spacing', 'shadow'].flatMap((family) => tokens[family].tokens.map((t) => t.name));
    assert.equal(new Set(names).size, names.length, 'token names are unique across families');
    for (const name of names) assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
    const colour = /^(#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\))$/i;
    for (const token of tokens.color.tokens) {
      assert.ok(token.usage, `${token.name} has a usage note`);
      for (const theme of tokens.color.themes) assert.match(token.value[theme.id], colour, `${token.name} in ${theme.id}`);
    }
    for (const font of tokens.type.fonts) assert.ok(files.includes(font.file), `${font.file} is copied`);
    const bundle = readFileSync(join(project, 'components/bundle.js'), 'utf8');
    assert.match(bundle.split('\n')[0], /^\/\* @ds-bundle: \{"format":4,"namespace":"FlowDesignSystem"/);
    assert.doesNotMatch(bundle, /<\/script|<!--/i);
    const css = readFileSync(join(project, 'components/bundle.css'), 'utf8');
    assert.doesNotMatch(css, /<\/style/i);
    assert.match(css, /\[data-theme="meridian-dark"\]/);
    for (const name of [...cardNames(), 'Cover', 'Themes']) assert.ok(files.includes(`components/${name}/preview.html`), `${name} card is built`);
    for (const name of cardNames()) assert.ok(files.includes(`components/${name}/mobile.json`), `${name} phone rules are built`);
    const columns = readFileSync(join(project, 'components/Columns/preview.html'), 'utf8');
    assert.match(columns, /class="fds-phone"/);
    assert.match(columns, /Phone rules/);
    assert.match(columns, /two-line/);
    assert.match(columns, /56px/);
    assert.ok(!readdirSync(project).includes('design-system.json'), 'the index is written at publish, never by the build');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
