// Capture rule persistence and the current tabs on the synthetic phone seed.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startFlow } from '../../../../test/mobile/server.js';
import { clerkBrowserStub } from '../../../../test/support/clerk.js';

const root = new URL('../', import.meta.url);
const flow = await startFlow();
const started = performance.now();
const expectedCounts = { pending: 8, ready: 42, draft: 0, approved: 14, sent: 0, non_chargeable: 0, void: 0 };
const tabs = ['Pending', 'Ready', 'Draft', 'Approved', 'Sent', 'Non-chargeable', 'Void'];
const checks = [];
let browser;
try {
  browser = await chromium.launch();
  const [project, token] = Object.entries(flow.tokens)[0];
  const pageFor = async viewport => {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === flow.url) return route.continue();
      if (url.origin === 'https://clerk.example.test') return route.fulfill({
        contentType: 'text/javascript',
        body: url.pathname.endsWith('clerk.browser.js')
          ? clerkBrowserStub({ token, email: `owner-${project}@example.test`, name: 'Synthetic owner' }) : '',
      });
      return route.abort();
    });
    return context.newPage();
  };
  const desktop = await pageFor({ width: 1280, height: 800 });
  const phone = await pageFor({ width: 390, height: 844 });
  const open = async (page, path) => {
    await page.goto(flow.url + path);
    await page.waitForLoadState('networkidle');
  };
  const shot = async (page, path) => {
    await page.waitForTimeout(600); // Wait for the dialog and tab transitions.
    await page.screenshot({ path: fileURLToPath(new URL(path, root)), type: 'jpeg', quality: 78 });
  };

  await open(desktop, '/invoicing-settings/invoices');
  await desktop.getByRole('button', { name: 'Edit Old job', exact: true }).click();
  assert.equal(await desktop.getByLabel('Value', { exact: true }).inputValue(), '90');
  await desktop.getByRole('button', { name: 'Cancel', exact: true }).click();
  await desktop.getByRole('button', { name: 'Edit Old job', exact: true }).click();
  assert.equal(await desktop.getByLabel('Value', { exact: true }).inputValue(), '90');
  await desktop.getByLabel('Value', { exact: true }).fill('60');
  const saved = desktop.waitForResponse(r => r.url().includes('/api/invoicing/rules/') && r.request().method() === 'PUT');
  await desktop.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200);
  const { rule } = await response.json();
  assert.deepEqual(rule.conditions, [{ field: 'job_age_days', test: 'more_than', value: 60 }]);
  assert.equal(rule.action.kind, 'wait');
  assert.equal(rule.enabled, true);

  for (const [page, size] of [[desktop, 'desktop'], [phone, 'phone']]) {
    await open(page, '/invoicing-settings/invoices');
    await page.getByRole('button', { name: 'Edit Old job', exact: true }).click();
    assert.equal(await page.getByLabel('Value', { exact: true }).inputValue(), '60');
    assert.equal(await page.getByLabel('Then', { exact: true }).inputValue(), 'wait');
    await shot(page, `r27/${size}.jpg`);
    checks.push({ size, ruleName: 'Old job', savedDays: 60, action: 'wait', freshLoad: true });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/invoicing/invoices');
    await open(page, '/invoices');
    const initial = await (await loaded).json();
    assert.deepEqual(initial.counts, expectedCounts);
    assert.equal(await page.getByRole('tab').count(), 7);
    for (const [index, label] of tabs.entries()) {
      assert.ok((await page.getByRole('tab').nth(index).innerText()).startsWith(label));
      const tab = page.getByRole('tab', { name: new RegExp('^' + label) });
      await tab.scrollIntoViewIfNeeded();
      if (await tab.getAttribute('aria-selected') !== 'true') {
        const loadedTab = page.waitForResponse(r => new URL(r.url()).pathname === '/api/invoicing/invoices');
        await tab.click();
        const result = await (await loadedTab).json();
        const key = Object.keys(expectedCounts)[index];
        assert.deepEqual(result.counts, expectedCounts);
        assert.equal(result.invoices.length, expectedCounts[key]);
        await page.getByRole('tab', { name: new RegExp('^' + label), selected: true }).waitFor();
        if (expectedCounts[key]) {
          await page.locator('tbody tr').first().waitFor();
          assert.equal(await page.locator('tbody tr').count(), expectedCounts[key]);
        } else {
          await page.getByText(`No ${label.toLowerCase()} invoices.`, { exact: true }).waitFor();
          assert.equal(await page.locator('tbody tr').count(), 0);
        }
      }
    }
    // Phone tabs scroll inside their strip. The page itself must stay within its width.
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const last = page.waitForResponse(r => new URL(r.url()).pathname === '/api/invoicing/invoices');
    await page.getByRole('tab', { name: size === 'phone' ? /^Pending/ : /^Ready/ }).click();
    await last;
    await page.getByText(size === 'phone' ? 'No lines' : 'Ready', { exact: true }).first().waitFor();
    await shot(page, `r39/${size}.jpg`);
    checks.push({ size, tabOrder: tabs, counts: expectedCounts, allTabsChecked: true, pageWithinViewport: true });
  }
  await writeFile(new URL('r27/persistence.json', root), JSON.stringify({
    synthetic: true, sourceCommit: 'df87ccda9c4a8558406547abdc45dde3134de45e',
    command: 'node docs/evidence/report-2026-10/r27/stills.mjs',
    workers: 1, wallSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    ruleSaveStatus: 200, checks,
    integrations: { xero: 'disabled', seazona: 'disabled' },
  }, null, 2) + '\n');
  console.log('PASS: rule save and fresh desktop/phone loads; all seven tabs and counts; four screenshots.');
} finally {
  await browser?.close();
  await flow.close();
}
