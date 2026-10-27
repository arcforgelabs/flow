import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { measure } from './checks.js';
import { RULES, rulesFor } from '../../server/ui/mobile.js';
import { SCREENS } from './screens.js';

// The phone suite (docs/MOBILE_TESTS.md). Each screen, in each project (size,
// engine, theme), is checked for page overflow, small touch targets, cut text
// and accessibility against the budget in budget.json, and compared with its
// saved screenshot. A screen may not get worse than its budget; each phone
// issue (#281–#288) brings its budget down to zero.

const here = dirname(fileURLToPath(import.meta.url));
const BUDGET = JSON.parse(readFileSync(join(here, 'budget.json'), 'utf8'));
const MEASURED = join(here, 'results', 'measure');
const TOUCH = 44;
// The day every screen shows, so dates and "Yesterday" never change a
// screenshot.
const TODAY = new Date('2026-10-21T09:30:00Z');

// What may scroll sideways on a phone: each card's `scrollX` (Tabs, the
// toolbar row, the list and board window). Anything else is a cut table.
const SCROLL_X = Object.values(RULES).map((rule) => rule.scrollX).filter(Boolean).join(', ');

async function open(page, project, screen) {
  const { theme } = project.metadata;
  const tokens = JSON.parse(process.env.MOBILE_TOKENS);
  await page.clock.setFixedTime(TODAY);
  await page.route('https://clerk.example.test/**', (route) => {
    const body = route.request().url().endsWith('clerk.browser.js') ? clerkStub(tokens[project.name], project.name, theme) : '';
    return route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
  const path = typeof screen.path === 'function' ? screen.path() : screen.path;
  await page.goto(`${process.env.MOBILE_URL}${path}`);
  await page.locator(screen.ready).first().waitFor();
  await page.waitForLoadState('networkidle');
  if (screen.prepare) await screen.prepare(page);
  // A click can scroll the page, and a sticky head marks itself stuck a
  // frame later (an IntersectionObserver): start each check from the top,
  // settled.
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await document.fonts.ready;
    for (let i = 0; i < 3; i += 1) await new Promise((done) => requestAnimationFrame(done));
  });
}

// A stand-in for Clerk's browser script: signed in, with a session token the
// fake Clerk on the server knows (test/support/clerk.js).
function clerkStub(token, name, theme) {
  const email = `owner-${name}@example.test`;
  return `window.Clerk = {
    user: { id: 'u', fullName: 'Owner ${theme.label}', primaryEmailAddress: { emailAddress: '${email}' } },
    session: { getToken: async () => '${token}' },
    load: async () => {}, addListener: () => () => {}, signOut: async () => {},
    mountUserButton: () => {}, unmountUserButton: () => {},
    mountUserProfile: () => {}, unmountUserProfile: () => {},
    mountSignIn: () => {}, unmountSignIn: () => {}, mountSignUp: () => {}, unmountSignUp: () => {},
  };`;
}

// The layout a card's mobile.json names at this width.
function layoutOf(rule, width) {
  if (width <= 639) return rule.phone.layout;
  if (width <= 1023) return rule.tablet.layout;
  return rule.desk?.layout ?? rule.tablet.layout;
}

// Each card's phone rules, on the screens the card lists. A component marks
// itself from those rules (server/ui/mobile.js); a screen the card lists
// shows that mark.
async function ruleProblems(page, screen, width) {
  const found = await page.evaluate(() => [...document.querySelectorAll('[data-phone-rule]')].map((el) => {
    const box = el.getBoundingClientRect();
    const hidden = el.hidden || Boolean(el.closest('[hidden]'));
    return {
      component: el.dataset.phoneRule,
      layout: el.dataset.phoneLayout,
      touch: el.dataset.phoneTouch,
      rowHeight: el.dataset.phoneRowHeight || '',
      visible: !hidden && box.width > 0 && box.height > 0,
    };
  }));
  const problems = [];
  for (const hit of found.filter((item) => item.visible)) {
    const rule = RULES[hit.component];
    if (!rule) { problems.push(`${hit.component} has no phone rules`); continue; }
    const layout = layoutOf(rule, width);
    if (hit.layout !== layout) problems.push(`${hit.component} shows ${hit.layout}; its card says ${layout}`);
    if (hit.touch !== String(rule.touch)) problems.push(`${hit.component} touch is ${hit.touch}; its card says ${rule.touch}`);
    if (width <= 639 && rule.phone.rowHeight && hit.rowHeight !== String(rule.phone.rowHeight)) {
      problems.push(`${hit.component} row height is ${hit.rowHeight || 'unset'}; its card says ${rule.phone.rowHeight}`);
    }
  }
  for (const rule of rulesFor(screen.id)) {
    if (rule.pageOverflow !== 'none') problems.push(`${rule.component} lets the page overflow`);
    if (rule.selector) {
      if (await page.locator(rule.selector).count() === 0) problems.push(`${rule.component} (${rule.selector}) is not on this screen`);
      continue;
    }
    if (rule.mark === false) continue;
    if (!found.some((hit) => hit.component === rule.component && hit.visible)) problems.push(`${rule.component} is not on this screen`);
  }
  return problems;
}

function record(project, screen, data) {
  mkdirSync(MEASURED, { recursive: true });
  writeFileSync(join(MEASURED, `${project}__${screen}.json`), JSON.stringify(data));
}

for (const screen of SCREENS) {
  test(screen.id, async ({ page }, info) => {
    const project = info.project;
    const { size } = project.metadata;
    await open(page, project, screen);

    const found = await page.evaluate(measure, { min: TOUCH, scrollX: SCROLL_X });
    const phone = size.width < 640;
    const result = {
      overflow: found.overflow,
      // Touch targets are a phone and tablet rule; a mouse needs less.
      small: size.mobile ? found.small.length : 0,
      cut: found.cut.length,
      spill: found.spill.length,
      gutter: found.gutter.length,
      rows: found.rows,
      toolbar: found.toolbar,
    };
    if (project.metadata.size.id === 'phone') {
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      result.axe = Object.fromEntries(axe.violations.map((v) => [v.id, v.nodes.length]).sort());
    }
    record(project.name, screen.id, result);

    const budget = BUDGET[`${project.name}/${screen.id}`] ?? {};
    const ruleOver = await ruleProblems(page, screen, size.width);
    const over = [];
    if (result.overflow > (budget.overflow ?? 0)) over.push(`the page is ${result.overflow}px wider than the screen`);
    if (result.small > (budget.small ?? 0)) over.push(`${result.small} controls are under ${TOUCH}px: ${found.small.join(', ')}`);
    if (result.spill > (budget.spill ?? 0)) over.push(`${result.spill} list rows cut off a line: ${found.spill.join(', ')}`);
    if (result.gutter > (budget.gutter ?? 0)) over.push(`content runs into the page's right gutter: ${found.gutter.join(', ')}`);
    if (result.cut > (budget.cut ?? 0)) over.push(`${result.cut} cut texts have no full text: ${found.cut.join(', ')}`);
    // No budget: a table cut at the right or a split notice never ships.
    if (phone && found.sideways.length) over.push(`these scroll sideways on a phone, and no card lets them (mobile.json scrollX): ${found.sideways.join(', ')}`);
    if (found.split.length) over.push(`a notice title sits on its own line: ${found.split.join(', ')}`);
    for (const [rule, nodes] of Object.entries(result.axe ?? {})) {
      if (nodes > (budget.axe?.[rule] ?? 0)) over.push(`axe ${rule}: ${nodes}`);
    }
    const rowsRule = rulesFor(screen.id).find((rule) => rule.minRowsAt375);
    if (phone && screen.list && size.id === 'phone-s' && rowsRule && result.rows < rowsRule.minRowsAt375) {
      over.push(`${result.rows} rows on the first screen; ${rowsRule.component} asks for ${rowsRule.minRowsAt375}`);
    }
    // MOBILE_RECORD=1 measures without failing, to write a new budget.
    if (!process.env.MOBILE_RECORD) expect([...over, ...ruleOver], `${project.name} ${screen.id} is over its budget or its phone rules (test/mobile/budget.json, design-system/components/*/mobile.json)`).toEqual([]);

    if (project.metadata.shots) await expect(page).toHaveScreenshot(`${screen.id}.png`);
  });
}

// The list toolbar sits in the same place on every list page.
test('toolbar stays in place', async ({ page }, info) => {
  const boxes = {};
  for (const screen of SCREENS.filter((s) => s.list)) {
    await open(page, info.project, screen);
    boxes[screen.id] = (await page.evaluate(measure, { min: TOUCH, scrollX: SCROLL_X })).toolbar;
  }
  const first = boxes['invoices-ready'];
  const moved = Object.entries(boxes)
    .filter(([, box]) => !box || box.top !== first?.top || box.left !== first?.left)
    .map(([id]) => id).sort();
  record(info.project.name, 'toolbar', { moved });
  const allowed = BUDGET[`${info.project.name}/toolbar`]?.moved ?? [];
  if (!process.env.MOBILE_RECORD) expect(moved.filter((id) => !allowed.includes(id)), `the toolbar moves on these lists: ${JSON.stringify(boxes)}`).toEqual([]);
});
