import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { startFlow } from './mobile/server.js';
import { clerkBrowserStub } from './support/clerk.js';
import { skipWithoutDatabase } from './support/db.js';

// Real page, sign-in, settings routes and database. Only the work status
// list is synthetic; no integration credentials or remote calls are used.
test('an Owner can save ready statuses at desk and phone widths', { skip: skipWithoutDatabase, timeout: 60000 }, async () => {
  const app = await startFlow();
  let browser;
  try {
    browser = await chromium.launch();
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 852 }, hasTouch: width === 390 });
      page.setDefaultTimeout(10000);
      await page.route('https://clerk.example.test/**', route => route.fulfill({
        contentType: 'text/javascript',
        body: clerkBrowserStub({ token: app.tokens['desk-chromium-meridian-light'], email: 'owner@example.test', name: 'Example Owner' }),
      }));
      await page.route('**/api/invoicing/work-statuses', route => route.fulfill({ json: { ok: true, statuses: [
        { value: 'shipped', label: 'Shipped', jobs: 2 },
        { value: 'delivered', label: 'Delivered', jobs: 1 },
        { value: 'received', label: 'Received', jobs: 3 },
      ] } }));
      await page.goto(`${app.url}/integrations/seazona`);
      const picker = page.locator('.fx-multi');
      await picker.locator('summary').click();
      const anchor = await picker.locator('summary').boundingBox();
      const menu = await picker.getByRole('group', { name: 'Ready statuses' }).boundingBox();
      assert.ok(menu.y >= anchor.y + anchor.height && menu.y <= anchor.y + anchor.height + 8,
        `the menu must open below its control: control ends at ${anchor.y + anchor.height}, menu starts at ${menu.y}`);
      assert.ok(menu.x >= 0 && menu.x + menu.width <= width, 'the menu stays inside the viewport');
      const shipped = picker.getByRole('checkbox', { name: /^Shipped/ });
      const received = picker.getByRole('checkbox', { name: /^Received/ });
      assert.equal(await received.isDisabled(), false, 'the Owner can edit');

      const save = async (control, checked, statuses) => {
        const response = page.waitForResponse(r => r.url().endsWith('/api/invoicing/automations/mark_ready_from_work_status') && r.request().method() === 'PUT');
        await control.setChecked(checked);
        const saved = await response;
        assert.equal(saved.status(), 200);
        assert.deepEqual((await saved.json()).automation.config.statuses, statuses);
        // The picker replaces its checkboxes after the save.
        await expect(control).toBeEnabled();
        await expect(control).toBeChecked({ checked });
      };
      await save(received, true, ['shipped', 'delivered', 'received']);
      await save(shipped, false, ['delivered', 'received']);
      await page.reload();
      await picker.locator('summary').click();
      assert.equal(await shipped.isChecked(), false, 'the removed status stays removed after reload');
      assert.equal(await received.isChecked(), true, 'the added status stays selected after reload');
      if (process.env.READY_STATUS_SCREENSHOTS) {
        mkdirSync(process.env.READY_STATUS_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.READY_STATUS_SCREENSHOTS}/ready-statuses-${width}.png`, fullPage: true });
      }
      await save(shipped, true, ['shipped', 'delivered', 'received']);
      await save(received, false, ['shipped', 'delivered']);
      await page.close();
    }
  } finally {
    await browser?.close();
    await app.close();
  }
});
