import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { invitePerson } from '../server/auth/people.js';
import { readTracking } from '../server/integrations/xero/tracking.js';
import { clerkBrowserStub, request } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { bootFlow, connectDirectly, seedLab, scriptedXero, xeroAnswer } from './support/xero.js';

// The real browser boundary catches unserved modules and native select
// handling that the send-boundary regression cannot see. Synthetic only.
test('owners and admins choose tracking in Flow, reload it, and save Off', { skip: skipWithoutDatabase, timeout: 60_000 }, async () => {
  const handle = await freshDatabase();
  const xero = scriptedXero();
  const { app, clerk, integrations } = await bootFlow(handle, { runtime: xero.runtime, log: xero.log });
  const lab = await seedLab(handle, clerk);
  await connectDirectly(handle, xero.runtime, lab.organisation.id);
  await invitePerson(handle.db, { email: 'admin@example.test', role: 'admin', invitedBy: lab.owner.id });
  const adminToken = clerk.signIn(clerk.addUser({ email: 'admin@example.test' }));
  assert.equal((await request(app, '/api/integrations', { token: adminToken })).status, 403);
  xero.script([xeroAnswer('TrackingCategories', { TrackingCategories: [
    { Name: 'Department', Status: 'ACTIVE', Options: [{ Name: 'Laboratory', Status: 'ACTIVE' }, { Name: 'Retired', Status: 'ARCHIVED' }] },
    { Name: 'Old category', Status: 'ARCHIVED', Options: [] },
  ] }, { repeat: true })]);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [email, token] of [['owner@example.test', lab.ownerToken], ['admin@example.test', adminToken]]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      try {
        await page.route('https://clerk.example.test/**', (route) => route.fulfill({
          status: 200, contentType: 'text/javascript',
          body: route.request().url().endsWith('clerk.browser.js') ? clerkBrowserStub({ token, email, name: 'Example Person' }) : '',
        }));
        const url = 'http://127.0.0.1:' + server.address().port + '/integrations/xero';
        if (email === 'admin@example.test') {
          await page.goto(url.replace('/xero', ''));
          await page.locator('a[href="/integrations/xero"]').click();
        } else await page.goto(url + '#tracking');
        const category = page.getByLabel('Tracking category');
        const option = page.getByLabel('Tracking option');
        await category.waitFor();
        if (email === 'owner@example.test') assert.ok(await category.evaluate((el) => el.getBoundingClientRect().top < innerHeight));
        await category.selectOption('Department');
        assert.deepEqual(await category.locator('option').allTextContents(), ['Off', 'Department']);
        assert.deepEqual(await option.locator('option').allTextContents(), ['Choose an option', 'Laboratory']);
        await option.selectOption('Laboratory');
        await page.locator('#tracking').getByRole('button', { name: 'Save', exact: true }).click();
        await page.getByText('Tracking saved.', { exact: true }).waitFor();
        assert.deepEqual(await readTracking(handle.db, lab.organisation.id), { category: 'Department', option: 'Laboratory' });
        await page.reload();
        await category.waitFor();
        assert.equal(await category.inputValue(), 'Department');
        assert.equal(await option.inputValue(), 'Laboratory');
        await category.selectOption('');
        assert.equal(await option.isDisabled(), true);
        await page.locator('#tracking').getByRole('button', { name: 'Save', exact: true }).click();
        await page.getByText('Tracking saved.', { exact: true }).waitFor();
        assert.equal(await readTracking(handle.db, lab.organisation.id), null);
      } finally { await page.close(); }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await integrations.stop();
    await handle.close();
  }
});
