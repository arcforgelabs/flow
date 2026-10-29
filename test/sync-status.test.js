import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startFlow } from './mobile/server.js';
import { clerkBrowserStub } from './support/clerk.js';
import { skipWithoutDatabase } from './support/db.js';

// Real app, synthetic status responses: no integration credentials or remote calls.
test('History uses Layers, retains totals on reload and stops polling when inactive', { skip: skipWithoutDatabase, timeout: 60000 }, async () => {
  const app = await startFlow();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(10000);
    page.on('console', msg => { if (msg.type() === 'error') console.error(msg.text()); });
    page.on('requestfailed', req => console.error(req.url(), req.failure()));
    page.on('pageerror', error => console.error(error.message));
    await page.clock.install({ time: new Date('2026-10-29T12:02:00Z') });
    await page.route('https://clerk.example.test/**', route => route.fulfill({ contentType: 'text/javascript', body: clerkBrowserStub({ token: app.tokens['desk-chromium-meridian-light'], email: 'owner@example.test', name: 'Example Owner' }) }));
    await page.route('**/api/integrations', async route => {
      const response = await route.fetch();
      const body = await response.json();
      Object.assign(body.integrations.find(i => i.id === 'seazona'), { state: 'ready', enabled: true });
      await route.fulfill({ json: body });
    });
    let reads = 0;
    let totalCount = 412;
    let run = { phase: 'running', running: true, startedAt: '2026-10-29T12:00:00Z', from: '2026-09-01', through: '2026-09-30', readingDay: '2026-09-14', ordersRead: 12, daysDone: 13 };
    await page.route('**/api/seazona/history', route => { reads++; return route.fulfill({ json: { history: { jobs: totalCount }, backfill: run } }); });
    await page.goto(`${app.url}/integrations/seazona`);
    await page.getByRole('heading', { name: 'History', exact: true }).waitFor();
    assert.match(await page.locator('section').filter({ has: page.getByRole('heading', { name: 'History', exact: true }) }).innerText(), /412 jobs/);
    assert.equal(await page.locator('.fx-history .fx-spinner').count(), 0);
    assert.equal(await page.locator('.fx-sync [role="status"]').getAttribute('aria-live'), 'polite');
    await page.getByRole('button', { name: 'Stop', exact: true }).focus();
    await page.clock.runFor(5100);
    assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).evaluate(el => el === document.activeElement), true);
    // Hide the document without navigating away: no background polling.
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenReads = reads;
    await page.clock.runFor(15000);
    assert.equal(reads, hiddenReads);
    await Promise.all([page.waitForResponse('**/api/seazona/history'), page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); })]);
    if (process.env.SYNC_SCREENSHOTS) {
      mkdirSync(process.env.SYNC_SCREENSHOTS, { recursive: true });
      await page.locator('.fx-sync').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.SYNC_SCREENSHOTS}/history-1280.png` });
    }
    await page.setViewportSize({ width: 375, height: 667 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.runFor(300);
    await page.locator('.fx-sync').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const box = await page.getByRole('button', { name: 'Stop', exact: true }).boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44);
    if (process.env.SYNC_SCREENSHOTS) await page.screenshot({ path: `${process.env.SYNC_SCREENSHOTS}/history-375.png` });
    await page.reload();
    await page.locator('.fx-sync').waitFor();
    assert.match(await page.locator('.fx-sync').innerText(), /412 jobs/);
    assert.match(await page.locator('.fx-sync__clock').innerText(), /2:[12]\d/);
    totalCount = 0;
    await page.clock.runFor(5100);
    await page.waitForFunction(() => document.querySelector('.fx-sync__word')?.textContent === 'Reading');
    assert.equal(await page.locator('.fx-sync__dots i').first().evaluate(el => getComputedStyle(el).animationName), 'none');
    assert.equal(await page.locator('.fx-sync__word').evaluate(el => getComputedStyle(el, '::after').display), 'none');
    totalCount = 412;
    run = { ...run, phase: 'done', running: false, endedAt: '2026-10-29T12:02:00Z' };
    await page.clock.runFor(5100);
    await page.getByRole('button', { name: 'Again', exact: true }).waitFor();
    const endedReads = reads;
    await page.clock.runFor(15000);
    assert.equal(reads, endedReads);
    assert.equal(await page.locator('.fx-sync__clock').innerText(), '2:00');
  } finally { await browser.close(); await app.close(); }
});
