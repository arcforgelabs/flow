// Reads each card's phone rules (design-system/components/<Card>/mobile.json)
// and writes the module the browser loads (server/ui/mobile.js), so a shared
// component and the phone suite read the same rules as the card.
//
//   node scripts/design-system/mobile-rules.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CARDS = join(ROOT, 'design-system/components');
const OUT = join(ROOT, 'server/ui/mobile.js');

// One entry per component. A card may name further components in `also`
// (Tiles is tileCard and tileSection); each keeps the card's layout and its
// own screens.
export function loadCardRules() {
  const rules = {};
  for (const card of readdirSync(CARDS).filter((name) => statSync(join(CARDS, name)).isDirectory() && name !== 'Cover').sort()) {
    const file = join(CARDS, card, 'mobile.json');
    const rule = JSON.parse(readFileSync(file, 'utf8'));
    const { also = [], ...rest } = rule;
    rules[rest.component] = { ...rest, card };
    for (const part of also) {
      rules[part.component] = { ...rest, ...part, card };
      delete rules[part.component].also;
    }
  }
  return rules;
}

export function renderMobileModule(rules = loadCardRules()) {
  return `// Phone rules for every shared component. The source is each card's
// mobile.json (design-system/components/<Card>/mobile.json). This module is
// what the browser reads, so a component and its card cannot drift.
// Regenerate with: node scripts/design-system/mobile-rules.mjs
// docs/DESIGN_SYSTEM.md, docs/MOBILE_TESTS.md.

// The three widths (docs/MOBILE_TESTS.md): phone up to 639px, tablet
// 640–1023px, desk from 1024px.
export const WIDTHS = Object.freeze({
  phone: '(max-width: 639px)',
  tabletMin: '(min-width: 640px)',
  tabletMax: '(max-width: 1023px)',
  desk: '(min-width: 1024px)',
});

export const RULES = ${JSON.stringify(rules, null, 2)};

// The card's rules for one component (columnTable, listHead, sidecar, …).
export function rule(component) {
  const found = RULES[component];
  if (!found) throw new Error(\`No phone rules for \${component}\`);
  return found;
}

export function isPhone() {
  return typeof matchMedia === 'function' && matchMedia(WIDTHS.phone).matches;
}

export function isTablet() {
  return typeof matchMedia === 'function' && matchMedia(WIDTHS.tabletMin).matches && matchMedia(WIDTHS.tabletMax).matches;
}

// The layout the card names for the width the page is at now.
export function layoutFor(component) {
  const found = rule(component);
  if (isPhone()) return found.phone.layout;
  if (isTablet()) return found.tablet.layout;
  return found.desk?.layout ?? found.tablet.layout;
}

// The rules that list this phone-suite screen.
export function rulesFor(screenId) {
  return Object.values(RULES).filter((found) => found.screens?.includes(screenId));
}

// Mark an element with the layout, touch size and row height from its card,
// and keep the mark current when the window crosses a width. The phone suite
// reads these marks.
export function applyPhoneRule(el, component) {
  const found = rule(component);
  if (!el?.dataset) return el;
  const paint = () => {
    el.dataset.phoneRule = component;
    el.dataset.phoneLayout = layoutFor(component);
    el.dataset.phoneTouch = String(found.touch);
    if (isPhone() && found.phone.rowHeight) el.dataset.phoneRowHeight = String(found.phone.rowHeight);
    else delete el.dataset.phoneRowHeight;
  };
  paint();
  if (typeof matchMedia === 'function' && !el.dataset.phoneWatch) {
    el.dataset.phoneWatch = '1';
    for (const query of [WIDTHS.phone, WIDTHS.tabletMin, WIDTHS.desk]) matchMedia(query).addEventListener?.('change', paint);
  }
  return el;
}

// A list column's phone slot, from the flag the Columns card names
// (phone: 'title' | 'meta' | 'end' | 'hide'). Anything else is unset.
export function phoneSlot(column) {
  const found = rule('columnTable');
  const value = column?.[found.phone.columnFlag];
  return found.phone.flags?.includes(value) ? value : null;
}
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(OUT, renderMobileModule());
  console.log(`wrote ${OUT}`);
}
