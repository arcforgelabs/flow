/**
 * Flow's design systems: the theme families people choose in Appearance, each
 * with a light and a dark palette, plus accent colour overrides.
 *
 * This module is the one source of the --t-* tokens, on the server and in the
 * browser (server/ui/routes.js serves this folder as browser modules). Harbour,
 * Flow's own family, is hand-authored here; the other families are ported from
 * OpenClaw's Control UI by scripts/port-openclaw-themes.mjs into
 * ./openclaw-palettes.js (docs/DESIGN.md). The engine is Arc Forge Labs'
 * Field's, so a family looks the same in both apps.
 */
import { boundaryOn, HEX, inkOn, readableOn } from './color-contrast.js';
import { OPENCLAW_FAMILIES } from './openclaw-palettes.js';

export { boundaryOn, contrast, inkOn, readableOn } from './color-contrast.js';

// Harbour: one deep teal for ink, filled buttons and labels, a mint highlight,
// warm cream pages and cool white cards. Nunito Sans for reading, Playfair
// Display for page titles, tracked uppercase labels and soft corners. Dark
// mode turns the teal into the page and the mint into the accent.
const HARBOUR_SHAPE = {
  '--t-body': "'Nunito Sans Variable', 'Nunito Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  '--t-display': "'Playfair Display Variable', 'Playfair Display', Georgia, 'Times New Roman', serif",
  '--t-data': "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  '--t-radius': '6px',
  '--t-radius-lg': '10px',
  '--t-stroke': '1px',
  '--t-label-size': '12px',
  '--t-label-weight': '600',
  '--t-label-spacing': '.09em',
  '--t-label-case': 'uppercase',
  '--t-display-weight': '700',
};

const HARBOUR = {
  label: 'Harbour',
  description: 'Teal, mint & cream',
  source: 'flow',
  light: {
    '--t-bg': '#fdfaf8', '--t-s1': '#f1f6f6', '--t-s2': '#e4eeee', '--t-paper': '#fefffe',
    '--t-brd': '#dee5e6', '--t-brd-hi': '#8fb7be', '--t-stroke-color': '#ced9d8',
    '--t-text': '#0d4e5f', '--t-strong': '#0a3c49', '--t-dim': '#4e6365', '--t-mute': '#5d7374',
    '--t-accent': '#0d4e5f', '--t-accent-bg': '#e4ffff', '--t-accent-brd': '#4a7c88',
    '--t-brand': '#0d4e5f', '--t-brand-ink': '#fefffe',
    '--t-primary': '#0d4e5f', '--t-on-primary': '#fefffe', '--t-ring': '#4a7c88',
    '--t-warn': '#8a5a00', '--t-warn-bg': 'rgba(138, 90, 0, 0.08)', '--t-warn-brd': 'rgba(138, 90, 0, 0.32)',
    '--t-danger': '#b42318', '--t-danger-bg': 'rgba(180, 35, 24, 0.07)', '--t-danger-brd': 'rgba(180, 35, 24, 0.40)',
    '--t-success': '#22663f', '--t-success-bg': 'rgba(34, 102, 63, 0.08)',
    ...HARBOUR_SHAPE,
    '--t-shadow': '0 1px 2px rgba(13, 78, 95, 0.05), 0 2px 6px rgba(13, 78, 95, 0.06)',
    'color-scheme': 'light',
  },
  dark: {
    '--t-bg': '#071f26', '--t-s1': '#0b2a33', '--t-s2': '#11363f', '--t-paper': '#0c2830',
    '--t-brd': '#1b414b', '--t-brd-hi': '#4a7c88', '--t-stroke-color': '#2a5560',
    '--t-text': '#d9e8ea', '--t-strong': '#fefffe', '--t-dim': '#a5bfc3', '--t-mute': '#8fb0b5',
    '--t-accent': '#c5feff', '--t-accent-bg': 'rgba(197, 254, 255, 0.10)', '--t-accent-brd': 'rgba(197, 254, 255, 0.45)',
    '--t-brand': '#c5feff', '--t-brand-ink': '#0d4e5f',
    '--t-primary': '#c5feff', '--t-on-primary': '#0d4e5f', '--t-ring': '#8fb7be',
    '--t-warn': '#e7b75c', '--t-warn-bg': 'rgba(231, 183, 92, 0.12)', '--t-warn-brd': 'rgba(231, 183, 92, 0.32)',
    '--t-danger': '#f2877b', '--t-danger-bg': 'rgba(242, 135, 123, 0.12)', '--t-danger-brd': 'rgba(242, 135, 123, 0.45)',
    '--t-success': '#86d3a1', '--t-success-bg': 'rgba(134, 211, 161, 0.12)',
    ...HARBOUR_SHAPE,
    '--t-shadow': '0 1px 2px rgba(0, 0, 0, 0.30), 0 4px 12px rgba(0, 0, 0, 0.20)',
    'color-scheme': 'dark',
  },
};

// Meridian: a dental laboratory's own look. Deep navy ink and filled buttons,
// a champagne highlight, warm stone pages and white cards. Plus Jakarta Sans
// for reading, Playfair Display at regular weight for page titles, square
// corners and widely tracked uppercase labels. Dark mode turns the navy into
// the page and the champagne into the accent.
const MERIDIAN_SHAPE = {
  '--t-body': "'Plus Jakarta Sans Variable', 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  '--t-display': "'Playfair Display Variable', 'Playfair Display', Georgia, 'Times New Roman', serif",
  '--t-data': "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  '--t-radius': '0px',
  '--t-radius-lg': '2px',
  '--t-stroke': '1px',
  '--t-label-size': '12px',
  '--t-label-weight': '600',
  '--t-label-spacing': '.16em',
  '--t-label-case': 'uppercase',
  '--t-display-weight': '400',
};

const MERIDIAN = {
  label: 'Meridian',
  description: 'Navy, champagne & stone',
  source: 'flow',
  light: {
    '--t-bg': '#f6f3ef', '--t-s1': '#efe9e0', '--t-s2': '#e6ded1', '--t-paper': '#ffffff',
    '--t-brd': '#e0dbd1', '--t-brd-hi': '#b8a685', '--t-stroke-color': '#d5cec2',
    '--t-text': '#1d3444', '--t-strong': '#13242f', '--t-dim': '#4d6575', '--t-mute': '#526a7a',
    '--t-accent': '#1d3444', '--t-accent-bg': '#faefdd', '--t-accent-brd': '#d4b07a',
    '--t-brand': '#1d3444', '--t-brand-ink': '#f8dfb9',
    '--t-primary': '#1d3444', '--t-on-primary': '#f8dfb9', '--t-ring': '#b08850',
    '--t-warn': '#8a5a00', '--t-warn-bg': 'rgba(138, 90, 0, 0.08)', '--t-warn-brd': 'rgba(138, 90, 0, 0.32)',
    '--t-danger': '#b42318', '--t-danger-bg': 'rgba(180, 35, 24, 0.07)', '--t-danger-brd': 'rgba(180, 35, 24, 0.40)',
    '--t-success': '#22663f', '--t-success-bg': 'rgba(34, 102, 63, 0.08)',
    ...MERIDIAN_SHAPE,
    '--t-shadow': '0 1px 2px rgba(29, 52, 68, 0.06)',
    'color-scheme': 'light',
  },
  dark: {
    '--t-bg': '#14252f', '--t-s1': '#1d3444', '--t-s2': '#26404f', '--t-paper': '#192d3a',
    '--t-brd': '#2c4555', '--t-brd-hi': '#56707f', '--t-stroke-color': '#334d5e',
    '--t-text': '#ece5d8', '--t-strong': '#fbf4e8', '--t-dim': '#b9c3c9', '--t-mute': '#a3b2bb',
    '--t-accent': '#f8dfb9', '--t-accent-bg': 'rgba(248, 223, 185, 0.12)', '--t-accent-brd': 'rgba(248, 223, 185, 0.45)',
    '--t-brand': '#f8dfb9', '--t-brand-ink': '#1d3444',
    '--t-primary': '#f8dfb9', '--t-on-primary': '#1d3444', '--t-ring': '#f8dfb9',
    '--t-warn': '#e7b75c', '--t-warn-bg': 'rgba(231, 183, 92, 0.12)', '--t-warn-brd': 'rgba(231, 183, 92, 0.32)',
    '--t-danger': '#f2877b', '--t-danger-bg': 'rgba(242, 135, 123, 0.12)', '--t-danger-brd': 'rgba(242, 135, 123, 0.45)',
    '--t-success': '#86d3a1', '--t-success-bg': 'rgba(134, 211, 161, 0.12)',
    ...MERIDIAN_SHAPE,
    '--t-shadow': '0 1px 2px rgba(0, 0, 0, 0.30)',
    'color-scheme': 'dark',
  },
};

// Picker order: Flow's own (Harbour, Meridian), then the design directions
// Field leads with (Beacon, Tide, Claw, Knot, Dash), then the other OpenClaw
// families.
const { beacon, tide, claw, knot, dash, ...otherOpenclaw } = OPENCLAW_FAMILIES;
const FAMILIES = { harbour: HARBOUR, meridian: MERIDIAN, beacon, tide, claw, knot, dash, ...otherOpenclaw };

// --t-control: the edge of an input or an outlined button on --t-paper, the
// text colour faded toward the paper only as far as it still reads at 3:1.
for (const family of Object.values(FAMILIES)) {
  for (const mode of ['light', 'dark']) {
    const tokens = family[mode];
    tokens['--t-control'] = boundaryOn(tokens['--t-paper'], tokens['--t-text']);
  }
}

/**
 * The design system a browser starts on until someone picks another in
 * Appearance. An installation can choose another with FLOW_THEME
 * (resolveDefaultFamily).
 */
export const DEFAULT_FAMILY = 'harbour';

/** The families in picker order: id, label, description and a preview swatch per mode. */
export const THEME_FAMILIES = Object.entries(FAMILIES).map(([id, family]) => ({
  id,
  label: family.label,
  description: family.description,
  source: family.source,
  swatches: {
    light: swatchesOf(family.light),
    dark: swatchesOf(family.dark),
  },
}));

function swatchesOf(tokens) {
  return { bg: tokens['--t-bg'], surface: tokens['--t-s1'], text: tokens['--t-text'], accent: tokens['--t-brand'], primary: tokens['--t-primary'] };
}

export function isThemeFamily(id) {
  return typeof id === 'string' && Object.hasOwn(FAMILIES, id);
}

export function normalizeFamily(id, fallback = DEFAULT_FAMILY) {
  return isThemeFamily(id) ? id : fallback;
}

/**
 * FLOW_THEME: the family this installation starts every browser on. Unset
 * means Harbour; an unknown name stops the server, so a typo is not silently
 * ignored.
 */
export function resolveDefaultFamily(env = process.env) {
  const raw = String(env.FLOW_THEME ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_FAMILY;
  if (!isThemeFamily(raw)) {
    throw new Error(`FLOW_THEME must be one of ${Object.keys(FAMILIES).join(', ')} (got "${raw}")`);
  }
  return raw;
}

/** The --t-* tokens (and color-scheme) for a family in a resolved mode. */
export function tokensFor(familyId, mode) {
  const family = FAMILIES[normalizeFamily(familyId)];
  return family[mode === 'dark' ? 'dark' : 'light'];
}

function declarations(tokens, indent) {
  return Object.entries(tokens).map(([k, v]) => `${indent}${k}: ${v};`).join('\n');
}

/** Every family and mode as `[data-theme][data-mode]` rules, served as /assets/themes.css. */
export function themeStylesheet() {
  return Object.keys(FAMILIES).flatMap((id) => ['light', 'dark'].map((mode) =>
    `[data-theme="${id}"][data-mode="${mode}"] {\n${declarations(FAMILIES[id][mode], '  ')}\n}`,
  )).join('\n');
}

// ── Accent colours ──────────────────────────────────────────────────────────
// Upstream's accent presets, with Harbour's teal first. "theme" keeps the
// family's accent. A custom colour is any #rrggbb.
export const ACCENT_PRESETS = [
  { id: 'theme', label: 'Theme default', hex: null },
  { id: 'harbour', label: 'Harbour teal', hex: '#0d4e5f' },
  { id: 'claw', label: 'Claw red', hex: '#ff5c5c' },
  { id: 'coral', label: 'Coral', hex: '#ff8066' },
  { id: 'amber', label: 'Amber', hex: '#f5b942' },
  { id: 'mint', label: 'Mint', hex: '#52c99a' },
  { id: 'teal', label: 'Teal', hex: '#35b9b0' },
  { id: 'blue', label: 'Blue', hex: '#5b9cf6' },
  { id: 'violet', label: 'Violet', hex: '#a78bfa' },
  { id: 'pink', label: 'Pink', hex: '#f472b6' },
  { id: 'slate', label: 'Slate', hex: '#8795a8' },
];

export function normalizeAccent(value) {
  if (typeof value !== 'string') return null;
  const preset = ACCENT_PRESETS.find((p) => p.id === value);
  if (preset) return preset.hex;
  return HEX.test(value) ? value.toLowerCase() : null;
}

/**
 * Token overrides that put an accent colour on a family's palette. The colour
 * fills brand surfaces and focus rings as chosen; --t-accent, which is text,
 * is shifted until it reads at 4.5:1 on the background.
 */
export function accentOverrides(familyId, mode, accent) {
  const hex = normalizeAccent(accent);
  if (!hex) return {};
  const base = tokensFor(familyId, mode);
  const tint = (pct) => `color-mix(in srgb, ${hex} ${pct}%, transparent)`;
  const out = {
    '--t-brand': hex,
    '--t-brand-ink': inkOn(hex),
    '--t-ring': hex,
    '--t-accent': readableOn(hex, base['--t-bg']),
    '--t-accent-bg': tint(mode === 'dark' ? 16 : 14),
    '--t-accent-brd': hex,
  };
  if (base['--t-primary'] === base['--t-brand']) {
    out['--t-primary'] = hex;
    out['--t-on-primary'] = inkOn(hex);
  } else if (base['--t-on-primary'] === base['--t-brand']) {
    out['--t-on-primary'] = readableOn(hex, base['--t-primary']);
  }
  return out;
}
