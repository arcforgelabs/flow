// Appearance in the browser: which design system (theme family), light or
// dark, and an optional accent colour. The families and their tokens live in
// server/theme/themes.js. The choice belongs to the person's account
// (server/ui/app.js saves it); localStorage keeps this browser's copy so a
// page paints in it before sign-in is known. server/ui/page.js runs the same family and mode
// resolution inline before first paint so there is no flash; keep the two in
// step. Ported from Arc Forge Labs' Field (client/src/lib/color-mode.ts).
import { accentOverrides, normalizeAccent, normalizeFamily, tokensFor } from '/assets/theme/themes.js';
import { fontStylesheets } from '/assets/theme/font-families.js';

const KEY = 'flow_appearance';
const root = document.documentElement;

/** The installation's default family (FLOW_THEME), as the page was served. */
export const defaultFamily = normalizeFamily(root.getAttribute('data-default-theme'));

function readSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem(KEY) || '{}');
    return settings && typeof settings === 'object' ? settings : {};
  } catch {
    return {};
  }
}

function writeSettings(update) {
  try {
    const settings = readSettings();
    update(settings);
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch { /* storage blocked: the choice lasts for this page only */ }
}

function systemPrefersDark() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function readState() {
  const settings = readSettings();
  const colorMode = ['light', 'dark', 'system'].includes(settings.colorMode) ? settings.colorMode : 'system';
  const accent = typeof settings.accent === 'string' && normalizeAccent(settings.accent) ? settings.accent : null;
  return { colorMode, family: normalizeFamily(settings.themeFamily, defaultFamily), accent };
}

let state = readState();
const listeners = new Set();

export function resolveMode(colorMode = state.colorMode) {
  if (colorMode === 'light' || colorMode === 'dark') return colorMode;
  return systemPrefersDark() ? 'dark' : 'light';
}

/** { colorMode, family, accent, mode } — mode is what is showing. */
export function getAppearance() {
  return { ...state, mode: resolveMode() };
}

const loadedFonts = new Set([...document.querySelectorAll('link[data-font]')].map((link) => link.getAttribute('href')));

/** Load a family's faces once. A failed font leaves the stack's system fallback painting the text. */
export function loadFonts(family) {
  for (const href of fontStylesheets(family)) {
    if (loadedFonts.has(href)) continue;
    loadedFonts.add(href);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-font', '');
    document.head.append(link);
  }
}

let appliedAccentKeys = [];

function apply() {
  const { family, accent } = state;
  const mode = resolveMode();
  loadFonts(family);
  root.setAttribute('data-theme', family);
  root.setAttribute('data-mode', mode);
  for (const key of appliedAccentKeys) root.style.removeProperty(key);
  const overrides = accentOverrides(family, mode, accent);
  for (const [key, value] of Object.entries(overrides)) root.style.setProperty(key, value);
  appliedAccentKeys = Object.keys(overrides);
  if (appliedAccentKeys.length) root.setAttribute('data-accent', String(accent));
  else root.removeAttribute('data-accent');
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = tokensFor(family, mode)['--t-bg'];
  for (const listener of listeners) listener(getAppearance());
}

/** Change any of colorMode, family and accent (null keeps the family's own). */
export function setAppearance(update) {
  state = { ...state, ...update };
  state.family = normalizeFamily(state.family, defaultFamily);
  state.accent = state.accent && normalizeAccent(state.accent) ? state.accent : null;
  writeSettings((settings) => {
    settings.colorMode = state.colorMode;
    if (state.family === defaultFamily) delete settings.themeFamily;
    else settings.themeFamily = state.family;
    if (state.accent) settings.accent = state.accent;
    else delete settings.accent;
  });
  apply();
}

/** Called after every change of appearance, with getAppearance(). Returns an unsubscribe. */
export function onAppearanceChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window.matchMedia === 'function') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (state.colorMode === 'system') apply();
  });
}
// Another tab changed the appearance.
window.addEventListener('storage', (event) => {
  if (event.key !== KEY) return;
  state = readState();
  apply();
});

apply();
