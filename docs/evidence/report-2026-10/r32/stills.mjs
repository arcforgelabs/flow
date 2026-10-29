// Capture the two local-only report rows on the phone suite's synthetic seed.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startFlow } from '../../../../test/mobile/server.js';
import { clerkBrowserStub } from '../../../../test/support/clerk.js';

const root = new URL('../', import.meta.url);
const flow = await startFlow();
let browser;
try {
  browser = await chromium.launch();
  const [project, token] = Object.entries(flow.tokens)[0];
  const context = async viewport => {
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
  const desk = await context({ width: 1280, height: 800 });
  const phone = await context({ width: 390, height: 844 });
  const page = await desk.newPage();
  const mobile = await phone.newPage();
  const open = async (p, path) => {
    await p.goto(flow.url + path);
    await p.waitForLoadState('networkidle');
  };
  const shot = async (p, id, size) => {
    await p.waitForTimeout(600); // Let the dialog finish its opening transition.
    await p.screenshot({ path: fileURLToPath(new URL(`${id}/${size}.jpg`, root)), type: 'jpeg', quality: 78 });
  };
  await open(page, '/price-list');
  await page.getByText('CR-ZR', { exact: true }).click();
  await page.getByLabel('Price', { exact: true }).fill('175.00');
  const priceSaved = page.waitForResponse(r => r.url().includes('/api/invoicing/price-items/') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await priceSaved).status(), 200);
  // Fresh pages read the saved record on both screen sizes.
  await open(page, '/price-list');
  await page.locator('tr:has(td:text-is("CR-ZR")):has-text("$175.00")').waitFor();
  await shot(page, 'r32', 'desktop');
  await open(mobile, '/price-list');
  await mobile.getByText('CR-ZR', { exact: true }).click();
  assert.equal(await mobile.getByLabel('Price', { exact: true }).inputValue(), '175.00');
  await mobile.getByRole('button', { name: 'Cancel', exact: true }).click();
  await shot(mobile, 'r32', 'phone');

  await open(page, '/jobs');
  await page.locator('.fx-job').first().click();
  const saveField = async action => {
    const saved = page.waitForResponse(r => r.url().endsWith('/api/custom-fields/values') && r.request().method() === 'PUT');
    await action();
    assert.equal((await saved).status(), 200);
  };
  await saveField(() => page.getByLabel('Shade', { exact: true }).selectOption({ label: 'B1' }));
  await saveField(() => page.getByLabel('Rush', { exact: true }).check());
  await saveField(() => page.getByLabel('Scan received', { exact: true }).check());
  for (const [p, size] of [[page, 'desktop'], [mobile, 'phone']]) {
    await open(p, '/jobs');
    await p.locator('.fx-job').first().click();
    assert.equal(await p.getByLabel('Shade', { exact: true }).locator('option:checked').innerText(), 'B1');
    assert.ok(await p.getByLabel('Rush', { exact: true }).isChecked());
    assert.ok(await p.getByLabel('Scan received', { exact: true }).isChecked());
    if (size === 'phone') {
      await p.locator('section[aria-label="Custom fields"]').scrollIntoViewIfNeeded();
    }
    await shot(p, 'r34', size);
  }
  await writeFile(new URL('r32/persistence.json', root), JSON.stringify({
    synthetic: true, priceSaveStatus: 200, customFieldSaveStatuses: [200, 200, 200],
    freshDesktopAndPhone: { priceCode: 'CR-ZR', priceBeforeTax: '175.00', caseNumber: '48200', shade: 'B1', rush: true, scanReceived: true },
    integrations: { xero: 'disabled', seazona: 'disabled' },
  }, null, 2) + '\n');
  console.log('PASS: four synthetic screenshots; saved price and three job values survive fresh desktop and phone loads.');
} finally {
  await browser?.close();
  await flow.close();
}
