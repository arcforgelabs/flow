import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDesignSystem, cardNames } from '../scripts/design-system/build.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// The modules whose exports are shared components. Each export has a card,
// or is a helper listed here.
const SHARED = ['server/ui/kit.js', 'server/ui/view-bar.js', 'server/ui/bulk-bar.js', 'server/ui/tip.js', 'server/ui/job-change.js', 'server/ui/sidecar.js'];
const HELPERS = new Set(['h', 'ICONS', 'svg', 'today', 'iconOnly', 'tipText', 'startTips', 'FIRST_ROWS', 'changeRows', 'changeSummary', 'linksOpenWith']);

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
    assert.ok(!readdirSync(project).includes('design-system.json'), 'the index is written at publish, never by the build');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
