import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import express from 'express';
import { createApp } from '../server/app.js';
import { FAMILY_FONTS, fontStylesheets } from '../server/theme/font-families.js';
import {
  accentOverrides,
  contrast,
  DEFAULT_FAMILY,
  normalizeFamily,
  resolveDefaultFamily,
  THEME_FAMILIES,
  themeStylesheet,
  tokensFor,
} from '../server/theme/themes.js';
import { messagePage, renderPage } from '../server/ui/page.js';
import { request } from './support/clerk.js';

// The design systems (server/theme/themes.js) and the files every page loads
// (server/ui/routes.js). docs/DESIGN.md is the contract.

describe('design systems', () => {
  test('Harbour leads the picker and is the default, Meridian follows', () => {
    assert.equal(DEFAULT_FAMILY, 'harbour');
    assert.equal(THEME_FAMILIES[0].id, 'harbour');
    assert.equal(THEME_FAMILIES[1].id, 'meridian');
    assert.deepEqual(THEME_FAMILIES.slice(2, 7).map((f) => f.id), ['beacon', 'tide', 'claw', 'knot', 'dash']);
    assert.equal(normalizeFamily('nope'), 'harbour');
    assert.equal(normalizeFamily('nope', 'tide'), 'tide');
  });

  test('every family defines the same tokens in both modes, with readable text', () => {
    const keys = Object.keys(tokensFor('harbour', 'light')).sort();
    for (const { id } of THEME_FAMILIES) {
      for (const mode of ['light', 'dark']) {
        const t = tokensFor(id, mode);
        assert.deepEqual(Object.keys(t).sort(), keys, `${id} ${mode} token set`);
        assert.ok(contrast(t['--t-text'], t['--t-bg']) >= 4.5, `${id} ${mode} text`);
        assert.ok(contrast(t['--t-dim'], t['--t-paper']) >= 4.5, `${id} ${mode} dim text`);
        assert.ok(contrast(t['--t-accent'], t['--t-bg']) >= 4.5, `${id} ${mode} accent`);
        assert.ok(contrast(t['--t-control'], t['--t-paper']) >= 3, `${id} ${mode} control edge`);
      }
    }
  });

  test('every family names fonts Flow serves', () => {
    for (const { id } of THEME_FAMILIES) assert.ok(Object.hasOwn(FAMILY_FONTS, id), `${id} has a font list`);
    assert.deepEqual(fontStylesheets('harbour'), ['/assets/fonts/jetbrains-mono/index.css', '/assets/fonts/nunito-sans/index.css', '/assets/fonts/playfair-display/index.css']);
  });

  test('an accent keeps accent text readable on the background', () => {
    for (const { id } of THEME_FAMILIES) {
      for (const mode of ['light', 'dark']) {
        const out = accentOverrides(id, mode, 'amber');
        assert.equal(out['--t-brand'], '#f5b942');
        assert.ok(contrast(out['--t-accent'], tokensFor(id, mode)['--t-bg']) >= 4.5, `${id} ${mode} amber accent`);
      }
    }
    assert.deepEqual(accentOverrides('harbour', 'light', 'not-a-colour'), {});
  });

  test('FLOW_THEME picks the installation default, and a typo stops the server', () => {
    assert.equal(resolveDefaultFamily({}), 'harbour');
    assert.equal(resolveDefaultFamily({ FLOW_THEME: ' Tide ' }), 'tide');
    assert.throws(() => resolveDefaultFamily({ FLOW_THEME: 'tidee' }), /FLOW_THEME must be one of harbour, meridian, beacon/);
  });

  test('the stylesheet has a rule for every family and mode', () => {
    const css = themeStylesheet();
    for (const { id } of THEME_FAMILIES) {
      assert.match(css, new RegExp(`\\[data-theme="${id}"\\]\\[data-mode="light"\\]`));
      assert.match(css, new RegExp(`\\[data-theme="${id}"\\]\\[data-mode="dark"\\]`));
    }
    assert.match(css, /--t-bg: #fdfaf8;/);
  });
});

describe('pages and assets', () => {
  test('a page starts on the installation default and escapes what it is given', () => {
    const html = renderPage({ title: 'A <b> title', body: '<p>x</p>', defaultFamily: 'tide' });
    assert.match(html, /<html lang="en" data-theme="tide" data-mode="light" data-default-theme="tide">/);
    assert.match(html, /<title>A &lt;b&gt; title<\/title>/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/themes.css">/);
    const message = messagePage({ title: 'Done', text: 'Connected to <Acme>.', defaultFamily: 'harbour', tone: 'success' });
    assert.match(message, /Connected to &lt;Acme&gt;\./);
    assert.match(message, /data-tone="success"/);
  });

  test('the sign-in page follows FLOW_THEME', async () => {
    const page = await request(createApp({ defaultFamily: 'beacon' }), '/sign-in');
    assert.equal(page.status, 200);
    assert.match(page.text, /data-default-theme="beacon"/);
  });

  test('the theme engine, components and fonts are served, and nothing else', async () => {
    const app = createApp();
    const css = await request(app, '/assets/themes.css');
    assert.equal(css.status, 200);
    assert.match(css.text, /\[data-theme="harbour"\]\[data-mode="dark"\]/);
    for (const path of ['/assets/theme/themes.js', '/assets/theme/openclaw-palettes.js', '/assets/theme/color-contrast.js', '/assets/theme/font-families.js', '/assets/ui/flow.css', '/assets/ui/appearance.js', '/assets/ui/clerk-appearance.js', '/assets/ui/app.js', '/assets/ui/invoicing.js', '/assets/ui/invoicing-settings.js', '/assets/ui/automations.js', '/assets/ui/jobs.js', '/assets/ui/logos/xero.svg', '/assets/ui/logos/seazona.svg']) {
      assert.equal((await request(app, path)).status, 200, path);
    }
    const font = await request(app, '/assets/fonts/nunito-sans/index.css');
    assert.equal(font.status, 200);
    const file = font.text.match(/url\(\.\/files\/([^)]+\.woff2)\)/)[1];
    assert.equal((await request(app, `/assets/fonts/nunito-sans/files/${file}`)).status, 200);
    for (const path of ['/assets/theme/../app.js', '/assets/ui/page.js', '/assets/ui/routes.js', '/assets/fonts/nunito-sans/package.json', '/assets/fonts/left-pad/index.css', '/assets/ui/logos/other.svg']) {
      assert.equal((await request(app, path)).status, 404, path);
    }
  });

  test('the components are served when Flow is installed under a dot directory', async () => {
    // A Replit deployment installs Flow under /home/runner/workspace/.flow-deploy/.
    // send's dotfile rule must not turn every component into a 404 there.
    const base = mkdtempSync(join(tmpdir(), 'flow-'));
    const install = join(base, '.flow-deploy');
    try {
      cpSync(new URL('../server', import.meta.url), join(install, 'server'), { recursive: true });
      symlinkSync(new URL('../node_modules', import.meta.url), join(install, 'node_modules'), 'dir');
      const { createUiAssetsRouter } = await import(join(install, 'server', 'ui', 'routes.js'));
      const app = express().use(createUiAssetsRouter());
      for (const path of ['/assets/ui/flow.css', '/assets/ui/app.js', '/assets/ui/flow-mark.svg', '/assets/theme/themes.js']) {
        assert.equal((await request(app, path)).status, 200, path);
      }
      assert.equal((await request(app, '/assets/ui/page.js')).status, 404);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
