import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import qrcode from 'qrcode-generator';
import { startFlow } from './mobile/server.js';
import { clerkBrowserStub } from './support/clerk.js';
import { skipWithoutDatabase } from './support/db.js';

test('Capture desktop review, key-free phone handoff, settings and phone sheet', { skip: skipWithoutDatabase }, async () => {
  const flow = await startFlow();
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(10000);
    const project = 'desk-chromium-meridian-light';
    await page.route('https://clerk.example.test/**', (route) => route.fulfill({ contentType: 'text/javascript', body: clerkBrowserStub({ token: flow.tokens[project], email: 'owner@example.test' }) }));
    await page.goto(`${flow.url}/captures?key=synthetic-must-not-be-shared`);
    await page.locator('.fx-captures__row').first().click();
    await page.locator('.fx-sidecar .fx-capture').waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    const list = await page.locator('.fx-captures').boundingBox();
    const sheet = await page.locator('.fx-sidecar').boundingBox();
    assert.ok(sheet.x >= list.x + list.width - 1);
    const initial = await page.locator('.fx-captures__row[aria-current="true"]').textContent();
    await page.keyboard.press('j');
    await page.waitForFunction((title) => document.querySelector('.fx-captures__row[aria-current="true"]')?.textContent !== title, initial);
    await page.getByRole('button', { name: 'Use phone', exact: true }).click();
    const qr = page.locator('.fx-captures__qr');
    await qr.waitFor();
    const code = qrcode(0, 'M');
    code.addData(`${flow.url}/captures`);
    code.make();
    assert.equal(await qr.getAttribute('src'), code.createDataURL(6, 24));
    assert.equal(await page.locator('dialog a').getAttribute('href'), `${flow.url}/captures`);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const proof = process.env.CAPTURE_PROOF_DIR;
    if (proof) { await mkdir(proof, { recursive: true }); await page.screenshot({ path: `${proof}/capture-desktop-1280x800.png` }); }
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Reader', exact: true });
    await toggle.waitFor();
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false');
    await page.reload();
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.match(await page.locator('.fx-settings').textContent(), /US\$/);
    if (proof) await page.screenshot({ path: `${proof}/capture-settings-1280x800.png` });
    await page.goto(`${flow.url}/integrations/seazona`);
    const sync = page.getByRole('switch', { name: 'Two-way sync' });
    await sync.waitFor();
    assert.equal(await sync.isDisabled(), true);
    assert.equal(await sync.getAttribute('aria-checked'), 'false');
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto(`${flow.url}/captures`);
    assert.equal(await page.getByRole('button', { name: 'Use phone' }).isVisible(), false);
    await page.locator('.fx-captures__row').first().click();
    await page.locator('dialog.fx-capture[open]').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (proof) await page.screenshot({ path: `${proof}/capture-phone-393x852.png` });
  } finally {
    await browser?.close();
    await flow.close();
  }
});
