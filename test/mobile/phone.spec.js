import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { measure } from './checks.js';
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

async function open(page, project, screen) {
  const { theme } = project.metadata;
  const tokens = JSON.parse(process.env.MOBILE_TOKENS);
  await page.clock.setFixedTime(TODAY);
  await page.route('https://clerk.example.test/**', (route) => {
    const body = route.request().url().endsWith('clerk.browser.js') ? clerkStub(tokens[theme.id], theme) : '';
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
function clerkStub(token, theme) {
  const email = `owner-${theme.id}@example.test`;
  return `window.Clerk = {
    user: { id: 'u', fullName: 'Owner ${theme.label}', primaryEmailAddress: { emailAddress: '${email}' } },
    session: { getToken: async () => '${token}' },
    load: async () => {}, addListener: () => () => {}, signOut: async () => {},
    mountUserButton: () => {}, unmountUserButton: () => {},
    mountUserProfile: () => {}, unmountUserProfile: () => {},
    mountSignIn: () => {}, unmountSignIn: () => {}, mountSignUp: () => {}, unmountSignUp: () => {},
  };`;
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

    const found = await page.evaluate(measure, TOUCH);
    const phone = size.width < 640;
    const result = {
      overflow: found.overflow,
      // Touch targets are a phone and tablet rule; a mouse needs less.
      small: size.mobile ? found.small.length : 0,
      cut: found.cut.length,
      rows: found.rows,
      toolbar: found.toolbar,
    };
    if (project.metadata.size.id === 'phone') {
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      result.axe = Object.fromEntries(axe.violations.map((v) => [v.id, v.nodes.length]).sort());
    }
    record(project.name, screen.id, result);

    const budget = BUDGET[`${project.name}/${screen.id}`] ?? {};
    const over = [];
    if (result.overflow > (budget.overflow ?? 0)) over.push(`the page is ${result.overflow}px wider than the screen`);
    if (result.small > (budget.small ?? 0)) over.push(`${result.small} controls are under ${TOUCH}px: ${found.small.join(', ')}`);
    if (result.cut > (budget.cut ?? 0)) over.push(`${result.cut} cut texts have no full text: ${found.cut.join(', ')}`);
    for (const [rule, nodes] of Object.entries(result.axe ?? {})) {
      if (nodes > (budget.axe?.[rule] ?? 0)) over.push(`axe ${rule}: ${nodes}`);
    }
    if (phone && screen.list && size.id === 'phone-s' && result.rows < 7) {
      info.annotations.push({ type: 'rows', description: `${result.rows} rows on the first screen; the goal is 7 (#281)` });
    }
    // MOBILE_RECORD=1 measures without failing, to write a new budget.
    if (!process.env.MOBILE_RECORD) expect(over, `${project.name} ${screen.id} is over its budget (test/mobile/budget.json)`).toEqual([]);

    if (project.metadata.shots) await expect(page).toHaveScreenshot(`${screen.id}.png`);
  });
}

// The list toolbar sits in the same place on every list page.
test('toolbar stays in place', async ({ page }, info) => {
  const boxes = {};
  for (const screen of SCREENS.filter((s) => s.list)) {
    await open(page, info.project, screen);
    boxes[screen.id] = (await page.evaluate(measure, TOUCH)).toolbar;
  }
  const first = boxes['invoices-ready'];
  const moved = Object.entries(boxes)
    .filter(([, box]) => !box || box.top !== first?.top || box.left !== first?.left)
    .map(([id]) => id).sort();
  record(info.project.name, 'toolbar', { moved });
  const allowed = BUDGET[`${info.project.name}/toolbar`]?.moved ?? [];
  if (!process.env.MOBILE_RECORD) expect(moved.filter((id) => !allowed.includes(id)), `the toolbar moves on these lists: ${JSON.stringify(boxes)}`).toEqual([]);
});
