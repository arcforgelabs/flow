// Synthetic screenshots and account persistence proof. Run from the repo root.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startFlow } from '../../../../test/mobile/server.js';
import { clerkBrowserStub } from '../../../../test/support/clerk.js';
import seedGap from '../../../../scripts/demo/seeds/reconcile-gap.mjs';

const root = new URL('../', import.meta.url);
const flow = await startFlow();
let browser;
try {
  browser = await chromium.launch();
  const owners = Object.entries(flow.tokens);
  const context = async (owner, viewport) => {
    const [project, token] = owner;
    const ctx = await browser.newContext({ viewport });
    await ctx.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === flow.url) return route.continue();
      if (url.origin === 'https://clerk.example.test') return route.fulfill({
        contentType: 'text/javascript',
        body: url.pathname.endsWith('clerk.browser.js')
          ? clerkBrowserStub({ token, email: `owner-${project}@example.test`, name: 'Synthetic owner' }) : '',
      });
      return route.abort();
    });
    return ctx;
  };
  const desk = await context(owners[0], { width: 1280, height: 800 });
  const phone = await context(owners[0], { width: 390, height: 844 });
  const page = await desk.newPage();
  const mobile = await phone.newPage();
  const open = async (p, path) => {
    await p.goto(flow.url + path);
    await p.waitForLoadState('networkidle');
  };
  const shot = async (p, id, size) => p.screenshot({
    path: fileURLToPath(new URL(`${id}/${size}.jpg`, root)), type: 'jpeg', quality: 78,
  });
  await open(page, '/jobs');
  await page.locator('.fx-board').waitFor();
  assert.equal(await page.locator('.fx-board__col').count(), 6);
  assert.equal(await page.locator('.fx-job').count(), 42);
  await shot(page, 'r28', 'desktop');
  await open(mobile, '/jobs');
  await mobile.locator('.fx-board-tabs:visible').waitFor();
  await shot(mobile, 'r28', 'phone');

  await page.getByRole('button', { name: 'Group: Status', exact: true }).click();
  await page.getByLabel('Group by', { exact: true }).selectOption('client');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sort', exact: true }).click();
  await page.getByRole('button', { name: 'Add sort', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  await page.getByRole('button', { name: 'Select option', exact: true }).click();
  const saved = page.waitForResponse(r => r.url().endsWith('/api/me/views/jobs') && r.request().method() === 'PUT');
  await page.getByRole('menuitemcheckbox', { name: 'Shipped', exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByText('7 jobs', { exact: true }).waitFor();
  // A fresh page reads the account's stored choice, with no shared page state.
  await page.close();
  const restored = await desk.newPage();
  await open(restored, '/jobs');
  await restored.getByText('7 jobs', { exact: true }).waitFor();
  await restored.getByRole('button', { name: 'Group: Client', exact: true }).waitFor();
  await restored.getByRole('button', { name: /Sort: Due/ }).waitFor();
  await restored.getByRole('button', { name: '1 Filter', exact: true }).waitFor();
  await shot(restored, 'r35', 'desktop');
  await open(mobile, '/jobs');
  await mobile.getByText('7 jobs', { exact: true }).waitFor();
  await shot(mobile, 'r35', 'phone');
  const other = await context(owners[1], { width: 1280, height: 800 });
  const independent = await other.newPage();
  await open(independent, '/jobs');
  await independent.getByText('42 jobs', { exact: true }).waitFor();
  await independent.getByRole('button', { name: 'Group: Status', exact: true }).waitFor();
  await independent.getByRole('button', { name: 'Sort', exact: true }).waitFor();
  await independent.getByRole('button', { name: 'Filter', exact: true }).waitFor();
  await other.close();
  await writeFile(new URL('r35/persistence.json', root), JSON.stringify({
    synthetic: true, savedResponseStatus: 200, freshPage: { group: 'Client', sort: 'Due ascending', filter: 'Status is Shipped', jobs: 7 },
    sameAccountOnPhone: { jobs: 7 }, otherAccount: { group: 'Status', sort: null, filter: null, jobs: 42 },
  }, null, 2) + '\n');

  await seedGap(flow);
  for (const [p, size] of [[restored, 'desktop'], [mobile, 'phone']]) {
    await open(p, '/reconcile');
    await p.locator('tbody tr:first-child').click();
    await p.getByRole('button', { name: 'Link this invoice', exact: true }).first().waitFor();
    await shot(p, 'r38', size);
  }
  console.log('Saved six synthetic screenshots. Account persistence and isolation passed.');
} finally {
  await browser?.close();
  await flow.close();
}
