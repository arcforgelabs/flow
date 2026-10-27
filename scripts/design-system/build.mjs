#!/usr/bin/env node
// Builds the files of the Flow Design System artifact (a claude.ai Design
// System) from this repository, so the artifact is never written by hand and
// never drifts from the app:
//
//   tokens.json        every --t-* colour of Harbour and Meridian, light and
//                      dark, from server/theme/themes.js
//   fonts/             their faces, copied from the fontsource packages
//   components/        bundle.js: the real server/ui modules (kit.js,
//                      view-bar.js, bulk-bar.js, tip.js …) as one script;
//                      bundle.css: flow.css, every family's --t-* tokens and
//                      the Lucide icons the app names; and each card in
//                      design-system/components/, plus a generated card of
//                      every theme family
//   README.md, *.md    design-system/*.md
//   assets/            design-system/assets/ (the text files; the logo is an
//                      upload, docs/DESIGN_SYSTEM.md)
//
// node scripts/design-system/build.mjs [out-dir]   (default .artifacts/design-system)
// The files land in <out-dir>/project/, the paths the artifact keeps them at.
// docs/DESIGN_SYSTEM.md says how they are published.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_FAMILIES, tokensFor } from '../../server/theme/themes.js';
import { FAMILY_FONTS, MONO_FONT } from '../../server/theme/font-families.js';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = join(ROOT, 'design-system');
export const NAMESPACE = 'FlowDesignSystem';

// The two families Flow ships as its own; the OpenClaw ports show on the
// Themes card. The artifact holds at most 8 colour themes.
const OWN = ['harbour', 'meridian'];
const MODES = ['light', 'dark'];

// What each colour token is for, in one line (DESIGN.md has the rules).
export const USAGE = {
  '--t-bg': 'The page behind everything.',
  '--t-s1': 'A raised surface: the sidebar, a toolbar, a hovered row.',
  '--t-s2': 'A surface on a surface: a selected row, a pressed chip.',
  '--t-paper': 'Cards, dialogs, menus and inputs.',
  '--t-brd': 'The edge of a card or a table.',
  '--t-brd-hi': 'An edge that needs to show: a hovered or open control.',
  '--t-stroke-color': 'Hairlines inside a card.',
  '--t-text': 'Body text. 4.5:1 or better on every surface.',
  '--t-strong': 'Titles and numbers that lead.',
  '--t-dim': 'Secondary text: hints, column heads. 4.5:1 on its surfaces.',
  '--t-mute': 'Tertiary text: placeholders and counts.',
  '--t-accent': 'Accent as text, links. 4.5:1 on --t-bg.',
  '--t-accent-bg': 'A light accent wash behind a selected item.',
  '--t-accent-brd': 'The edge of an accented item.',
  '--t-brand': 'The colour as chosen: fills, highlights, the focus ring.',
  '--t-brand-ink': 'Text and icons on --t-brand.',
  '--t-primary': 'The one primary button on a page.',
  '--t-on-primary': 'Text on --t-primary.',
  '--t-ring': 'The keyboard focus ring.',
  '--t-warn': 'A warning, as text.',
  '--t-warn-bg': 'Behind a warning note.',
  '--t-warn-brd': 'The edge of a warning note.',
  '--t-danger': 'An error or a destructive action, as text.',
  '--t-danger-bg': 'Behind an error note.',
  '--t-danger-brd': 'The edge of an error note.',
  '--t-success': 'Done, sent, connected, as text.',
  '--t-success-bg': 'Behind a success note.',
};

const COLOUR = /^(#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%deg]+\))$/i;
const name = (token) => token.replace(/^--/, '');

export function buildTokens() {
  const themes = OWN.flatMap((id) => MODES.map((mode) => ({
    id: `${id}-${mode}`,
    name: `${THEME_FAMILIES.find((f) => f.id === id).label} ${mode === 'dark' ? 'Dark' : 'Light'}`,
  })));
  const first = tokensFor(OWN[0], 'light');
  const colours = Object.keys(first).filter((key) => key.startsWith('--t-') && COLOUR.test(first[key]));
  const color = colours.map((key) => ({
    name: name(key),
    value: Object.fromEntries(OWN.flatMap((id) => MODES.map((mode) => [`${id}-${mode}`, tokensFor(id, mode)[key]]))),
    usage: USAGE[key] ?? `The ${name(key)} colour.`,
  }));
  const shape = (key) => OWN.map((id) => ({ id, value: tokensFor(id, 'light')[key] }));
  const families = {};
  for (const id of OWN) {
    families[`${id}-body`] = tokensFor(id, 'light')['--t-body'].replaceAll("'", '"');
  }
  families.display = tokensFor('harbour', 'light')['--t-display'].replaceAll("'", '"');
  families.data = tokensFor('harbour', 'light')['--t-data'].replaceAll("'", '"');
  return {
    name: 'Flow',
    version: 1,
    color: { themes, tokens: color },
    type: {
      fonts: fontFiles().map((font) => ({ family: font.family, file: `fonts/${font.file}`, weight: font.weight, style: 'normal' })),
      families,
      groups: [
        { name: 'Titles', family: 'display', styles: [
          { name: 'page-title', fontSize: '26px', lineHeight: '32px', fontWeight: 700, usage: 'The page name in pageHeader (.fx-title). Meridian sets it at 400.', sample: 'Invoices' },
          { name: 'dialog-title', fontSize: '20px', lineHeight: '26px', fontWeight: 700, usage: 'A dialog title (.fx-dialog__title).', sample: 'Send 3 invoices?' },
        ] },
        { name: 'Text', family: 'harbour-body', styles: [
          { name: 'body', fontSize: '14px', lineHeight: '20px', fontWeight: 400, usage: 'Rows, settings and notes.', sample: 'Draft when ready' },
          { name: 'hint', fontSize: '13px', lineHeight: '18px', fontWeight: 400, usage: 'The one line under a setting (.fx-setting__hint), in --t-dim.', sample: 'Off: they stay in the Xero history.' },
          { name: 'label', fontSize: tokensFor('harbour', 'light')['--t-label-size'], lineHeight: '16px', fontWeight: Number(tokensFor('harbour', 'light')['--t-label-weight']), letterSpacing: '0.09em', usage: 'Column heads and section labels, uppercase.', sample: 'DUE' },
        ] },
        { name: 'Data', family: 'data', styles: [
          { name: 'code', fontSize: '13px', lineHeight: '18px', fontWeight: 500, usage: 'Case numbers, references and amounts in tables (.fx-mono, .fx-num).', sample: 'INV-0042 · $1,280.00' },
        ] },
      ],
    },
    radius: { tokens: shape('--t-radius').map(({ id, value }) => ({ name: `radius-${id}`, value, usage: `${id === 'harbour' ? 'Harbour' : 'Meridian'}: buttons, inputs, chips (--t-radius).` }))
      .concat(shape('--t-radius-lg').map(({ id, value }) => ({ name: `radius-lg-${id}`, value, usage: `${id === 'harbour' ? 'Harbour' : 'Meridian'}: cards and dialogs (--t-radius-lg).` }))) },
    spacing: { tokens: [
      { name: 'space-1', value: '4px', usage: 'Inside a chip, between an icon and its word.' },
      { name: 'space-2', value: '8px', usage: 'Between controls in a toolbar.' },
      { name: 'space-3', value: '12px', usage: 'Row padding in a list.' },
      { name: 'space-4', value: '16px', usage: 'Card padding; the side gutter on a phone.' },
      { name: 'space-6', value: '24px', usage: 'Between sections of a page.' },
    ] },
    shadow: { tokens: [{ name: 'shadow-card', value: Object.fromEntries(OWN.flatMap((id) => MODES.map((mode) => [`${id}-${mode}`, tokensFor(id, mode)['--t-shadow']]))), usage: 'A raised card or a menu (--t-shadow).' }] },
    meta: { source: 'github', repo: 'arcforgelabs/flow', paths: { tokens: ['server/theme/themes.js'], styles: ['server/ui/flow.css'], components: ['server/ui/kit.js', 'server/ui/view-bar.js', 'server/ui/bulk-bar.js', 'server/ui/tip.js', 'server/ui/custom-fields.js', 'server/ui/job-change.js'] } },
  };
}

// The faces of Harbour and Meridian (and the mono), latin, variable weight.
export function fontFiles() {
  const packages = [...new Set([...OWN.flatMap((id) => FAMILY_FONTS[id]), MONO_FONT])];
  return packages.map((pkg) => {
    const dir = join(dirname(require.resolve(`@fontsource-variable/${pkg}/package.json`)), 'files');
    const file = `${pkg}-latin-wght-normal.woff2`;
    const css = readFileSync(join(dir, '..', 'index.css'), 'utf8');
    const family = /font-family:\s*'([^']+)'/.exec(css)[1];
    const weight = /font-weight:\s*([0-9]+ [0-9]+)/.exec(css)?.[1] ?? '400';
    return { pkg, family, file, weight, path: join(dir, file) };
  });
}

// Every family's --t-* tokens, so a card can show any of them
// (data-theme="<family>-<mode>"); Harbour Light is the default.
export function themeCss() {
  const rules = THEME_FAMILIES.flatMap(({ id }) => MODES.map((mode) => {
    const decls = Object.entries(tokensFor(id, mode)).map(([k, v]) => `  ${k}: ${v};`).join('\n');
    const sel = id === 'harbour' && mode === 'light' ? ':root, [data-theme="harbour-light"]' : `[data-theme="${id}-${mode}"]`;
    return `${sel} {\n${decls}\n}`;
  }));
  return rules.join('\n');
}

// The Lucide icons the app names, inlined: in the app an icon is
// url(/assets/icons/<name>.svg), which the artifact cannot serve.
export function iconCss() {
  const iconDir = join(dirname(require.resolve('lucide-static/package.json')), 'icons');
  const uiDir = join(ROOT, 'server/ui');
  const names = new Set();
  for (const file of readdirSync(uiDir).filter((f) => f.endsWith('.js'))) {
    for (const [, word] of readFileSync(join(uiDir, file), 'utf8').matchAll(/['"`/]([a-z](?:[a-z0-9-]*[a-z0-9])?)(?:\.svg)?['"`)]/g)) names.add(word);
  }
  for (const file of readdirSync(join(SOURCE, 'components'), { recursive: true }).filter((f) => String(f).endsWith('.html'))) {
    for (const [, word] of readFileSync(join(SOURCE, 'components', String(file)), 'utf8').matchAll(/['"]([a-z](?:[a-z0-9-]*[a-z0-9])?)['"]/g)) names.add(word);
  }
  const found = [...names].filter((n) => existsSync(join(iconDir, `${n}.svg`))).sort();
  return found.map((n) => {
    const svg = readFileSync(join(iconDir, `${n}.svg`), 'utf8').replace(/\s+/g, ' ').trim();
    const uri = `data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}`;
    return `.fx-lucide[style*="/icons/${n}.svg"] { --icon: url("${uri}") !important; }`;
  }).join('\n');
}

// The cards: design-system/components/<Comp>/, plus the generated Themes card.
function themesCard() {
  const tile = (f, mode) => {
    const s = f.swatches[mode];
    return `<div class="fds-fam" data-theme="${f.id}-${mode}"><div class="fds-fam__face">Aa</div><div class="fds-fam__dots"><i style="background:${s.primary}"></i><i style="background:${s.accent}"></i><i style="background:${s.text}"></i></div><b>${f.label}</b><span>${mode}</span></div>`;
  };
  return `<!-- @dsCard group="Foundations" height=420 subtitle="Every family, light and dark: generated from server/theme/themes.js" -->
<style>
.fds-fams { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; padding: 8px 0; }
.fds-fam { display: grid; gap: 4px; padding: 10px; border: 1px solid var(--t-brd); border-radius: var(--t-radius-lg); background: var(--t-bg); color: var(--t-text); font-family: var(--t-body); }
.fds-fam__face { font-family: var(--t-display); font-size: 24px; color: var(--t-strong); }
.fds-fam__dots { display: flex; gap: 4px; } .fds-fam__dots i { width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--t-brd); }
.fds-fam span { font-size: 11px; color: var(--t-dim); }
</style>
<div class="fds-fams">
${THEME_FAMILIES.flatMap((f) => MODES.map((m) => tile(f, m))).join('\n')}
</div>
`;
}

const aliasPlugin = {
  name: 'flow-assets',
  setup(b) {
    b.onResolve({ filter: /^\/assets\/(ui|theme)\// }, (args) => {
      const [, dir, rest] = /^\/assets\/(ui|theme)\/(.+)$/.exec(args.path);
      return { path: join(ROOT, dir === 'ui' ? 'server/ui' : 'server/theme', rest) };
    });
  },
};

export async function buildBundle() {
  const result = await build({
    entryPoints: [join(ROOT, 'scripts/design-system/entry.js')],
    bundle: true, write: false, format: 'iife', globalName: NAMESPACE, minify: true, target: 'es2022',
    plugins: [aliasPlugin], logLevel: 'silent',
    define: { __FLOW_OPTION_COLORS__: JSON.stringify(optionColors()) },
  });
  const text = result.outputFiles[0].text.replace(new RegExp(`^var ${NAMESPACE}\\s*=`), `window.${NAMESPACE}=`).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '\\x3C!--');
  return `/* @ds-bundle: ${JSON.stringify({ format: 4, namespace: NAMESPACE, components: cardNames().map((n) => ({ name: n })) })} */\n${text}`;
}

// The colours a custom field's option can take (server/core/custom-fields.js).
function optionColors() {
  const source = readFileSync(join(ROOT, 'server/core/custom-fields.js'), 'utf8');
  return JSON.parse(/OPTION_COLORS = (\[[^\]]*\])/.exec(source)[1].replaceAll("'", '"'));
}

export function cardNames() {
  return readdirSync(join(SOURCE, 'components')).filter((n) => n !== 'Cover' && statSync(join(SOURCE, 'components', n)).isDirectory()).sort();
}

const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function ruleRows(rule) {
  const slots = rule.phone.slots ? Object.entries(rule.phone.slots).map(([name, count]) => `${name} ${count}`).join(', ') : '';
  const phone = [rule.phone.layout, rule.phone.rowHeight ? `${rule.phone.rowHeight}px` : '', slots].filter(Boolean).join(' · ');
  const tablet = [rule.tablet.layout, rule.tablet.sticky ? `sticky ${rule.tablet.sticky}` : ''].filter(Boolean).join(' · ');
  const rows = [
    ['Direction', rule.direction],
    ['Phone', phone],
    ['Tablet', tablet],
    ['Desk', rule.desk?.layout ?? rule.tablet.layout],
    ['Touch', `${rule.touch}px`],
    ['Overflow', rule.pageOverflow],
    ['Sideways', rule.scrollX ?? 'never on a phone'],
    ...(rule.minRowsAt375 ? [['Rows at 375', String(rule.minRowsAt375)]] : []),
    ['Screens', rule.screens.length ? rule.screens.join(', ') : '—'],
  ];
  return rows.map(([name, value]) => `<tr><th scope="row">${esc(name)}</th><td>${esc(value)}</td></tr>`).join('\n');
}

// A phone-width frame of the card, plus the rules from its mobile.json.
// The frame is a copy of the card at 375px, so the phone CSS applies.
function phoneBlock(rule) {
  return `<section class="fds-phone-block" aria-label="Phone">
  <figure class="fds-phone">
    <div class="fds-phone__bezel">
      <iframe class="fds-phone__screen" title="Phone preview"></iframe>
    </div>
    <figcaption>${esc(rule.direction)}</figcaption>
  </figure>
  <table class="fds-rules">
    <caption>Phone rules</caption>
    <tbody>
${ruleRows(rule)}
    </tbody>
  </table>
</section>
<script>
(() => {
  const block = document.currentScript.previousElementSibling;
  const frame = block.querySelector('iframe');
  const paint = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.documentElement.replaceChildren();
    const head = doc.createElement('head');
    const body = doc.createElement('body');
    doc.documentElement.append(head, body);
    const style = doc.createElement('style');
    const css = [];
    for (const sheet of document.styleSheets) {
      try { css.push([...sheet.cssRules].map((r) => r.cssText).join('\\n')); } catch { /* a sheet from another origin */ }
    }
    style.textContent = css.join('\\n');
    head.append(style);
    for (const child of document.body.children) {
      if (child === block || child.tagName === 'SCRIPT') continue;
      body.append(child.cloneNode(true));
    }
  };
  frame.addEventListener('load', paint);
  frame.src = 'about:blank';
})();
</script>`;
}

function withPhonePreview(html, rule) {
  const taller = html.replace(/^(<!-- @dsCard\b[^>]*?)height=(\d+)/, (_, start, height) => `${start}height=${Number(height) + 360}`);
  return `${taller.replace(/\s*$/, '')}\n${phoneBlock(rule)}\n`;
}

function copyTree(from, to) {
  for (const entry of readdirSync(from, { recursive: true })) {
    const src = join(from, String(entry));
    if (statSync(src).isDirectory()) continue;
    mkdirSync(dirname(join(to, String(entry))), { recursive: true });
    copyFileSync(src, join(to, String(entry)));
  }
}

export async function buildDesignSystem(outDir = join(ROOT, '.artifacts/design-system')) {
  const project = join(outDir, 'project');
  rmSync(project, { recursive: true, force: true });
  mkdirSync(join(project, 'fonts'), { recursive: true });
  for (const file of readdirSync(SOURCE).filter((f) => f.endsWith('.md'))) copyFileSync(join(SOURCE, file), join(project, file));
  copyTree(join(SOURCE, 'components'), join(project, 'components'));
  for (const card of readdirSync(join(SOURCE, 'components')).filter((name) => existsSync(join(SOURCE, 'components', name, 'mobile.json')))) {
    const rule = JSON.parse(readFileSync(join(SOURCE, 'components', card, 'mobile.json'), 'utf8'));
    const screens = [...new Set([...(rule.screens ?? []), ...(rule.also ?? []).flatMap((part) => part.screens ?? [])])];
    const preview = join(project, 'components', card, 'preview.html');
    writeFileSync(preview, withPhonePreview(readFileSync(preview, 'utf8'), { ...rule, screens }));
  }
  copyTree(join(SOURCE, 'assets'), join(project, 'assets'));
  mkdirSync(join(project, 'components/Themes'), { recursive: true });
  writeFileSync(join(project, 'components/Themes/preview.html'), themesCard());
  writeFileSync(join(project, 'components/Themes/README.md'), '# Themes\n\nEvery design system a person can pick on the Appearance page, in light and dark. Generated from `server/theme/themes.js` (`THEME_FAMILIES`); a card shows any of them with `data-theme="<family>-<mode>"`.\n');
  for (const font of fontFiles()) copyFileSync(font.path, join(project, 'fonts', font.file));
  writeFileSync(join(project, 'tokens.json'), `${JSON.stringify(buildTokens(), null, 2)}\n`);
  const css = [
    '/* Flow Design System: generated by scripts/design-system/build.mjs. Edit server/ui/flow.css or server/theme/themes.js, not this file. */',
    themeCss(),
    readFileSync(join(ROOT, 'server/ui/flow.css'), 'utf8'),
    '/* Cards: a plain frame with Flow\'s own page under it. */',
    'body { margin: 0; padding: 12px; background: var(--t-bg); color: var(--t-text); font-family: var(--t-body); }',
    '.fds { display: grid; gap: 16px; } .fds-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; } .fds-cap { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--t-dim); }',
    '.fds-phone-block { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; align-items: start; margin-top: 20px; }',
    '.fds-phone { margin: 0; } .fds-phone figcaption { margin-top: 8px; color: var(--t-dim); font-size: 12px; }',
    '.fds-phone__bezel { height: 320px; padding: 12px 10px; border: 1px solid var(--t-brd); border-radius: 28px; background: var(--t-s1); }',
    '.fds-phone__screen { width: 100%; height: 100%; border: 0; border-radius: 16px; background: var(--t-bg); }',
    '.fds-rules { width: 100%; border-collapse: collapse; color: var(--t-text); font: 13px/1.4 var(--t-body); }',
    '.fds-rules caption { caption-side: top; padding: 0 0 8px; color: var(--t-strong); font-weight: 650; text-align: left; }',
    '.fds-rules th, .fds-rules td { padding: 6px 8px; border-bottom: 1px solid var(--t-brd); text-align: left; vertical-align: top; }',
    '.fds-rules th { width: 7.5rem; color: var(--t-dim); font-weight: 600; }',
    '@media (max-width: 639px) { .fds-phone-block { grid-template-columns: 1fr; } }',
    iconCss(),
  ].join('\n');
  writeFileSync(join(project, 'components/bundle.css'), css.replace(/<\/style/gi, '<\\/style'));
  writeFileSync(join(project, 'components/bundle.js'), await buildBundle());
  return { project, files: readdirSync(project, { recursive: true }).filter((f) => !statSync(join(project, String(f))).isDirectory()).map(String).sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const { project, files } = await buildDesignSystem(out);
  console.log(`${files.length} files in ${relative(process.cwd(), project) || '.'}`);
}
