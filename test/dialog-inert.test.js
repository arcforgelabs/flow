import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { skipWithoutDatabase } from './support/db.js';
import { startFlow } from './mobile/server.js';

// Delete confirms with dialog() (server/ui/kit.js). The confirm button submits
// a form with method="dialog", and Escape closes the same way: the browser
// never calls close(). The inert shield put up for the open dialog has to
// drop on the close event, or the page takes no clicks until a reload.

const root = fileURLToPath(new URL('../server/ui/', import.meta.url));
const PAGE = `<!doctype html>
<meta charset="utf-8">
<div id="app"><button id="page" type="button">Page</button></div>
<script type="module">
  import { dialog } from '/assets/ui/kit.js';
  window.dialog = dialog;
  document.getElementById('page').addEventListener('click', () => { window.clicks = (window.clicks || 0) + 1; });
  window.ready = true;
</script>`;

function serveUi() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(PAGE);
      return;
    }
    const prefix = '/assets/ui/';
    if (!url.pathname.startsWith(prefix) || url.pathname.includes('..')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(join(root, url.pathname.slice(prefix.length)));
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let browser;
let server;
let origin;

before(async () => {
  server = await serveUi();
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(origin);
  await page.waitForFunction(() => window.ready);
  return page;
}

function ask(page, confirm = 'Delete') {
  return page.evaluate((label) => {
    window.settled = null;
    const body = document.createElement('p');
    body.textContent = 'It was never issued, so it is removed.';
    window.dialog({ title: 'Delete this invoice?', body, confirm: label, tone: 'danger' })
      .then((value) => { window.settled = value ? 'ok' : 'cancel'; });
  }, confirm);
}

const inert = (page) => page.evaluate(() => document.getElementById('app').hasAttribute('inert'));

test('confirming, cancelling or escaping a dialog gives the page its clicks back', async () => {
  const page = await openPage();
  try {
    await ask(page);
    await page.getByRole('heading', { name: 'Delete this invoice?' }).waitFor();
    assert.equal(await inert(page), true, 'the open dialog shields the page');
    assert.equal(await page.locator('dialog[open]').count(), 1);

    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => window.settled === 'ok');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await inert(page), false, 'a form method=dialog close drops the shield');
    await page.locator('#page').click();
    assert.equal(await page.evaluate(() => window.clicks), 1);

    await ask(page);
    await page.getByRole('heading', { name: 'Delete this invoice?' }).waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(() => window.settled === 'cancel');
    assert.equal(await inert(page), false, 'Cancel drops the shield');

    await ask(page);
    await page.getByRole('heading', { name: 'Delete this invoice?' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.settled === 'cancel');
    assert.equal(await inert(page), false, 'Escape drops the shield');
    await page.locator('#page').click();
    assert.equal(await page.evaluate(() => window.clicks), 2);
  } finally {
    await page.close();
  }
});

test('close() on a dialog that is not the shared form drops the shield too', async () => {
  const page = await openPage();
  try {
    await page.evaluate(() => {
      const element = document.createElement('dialog');
      element.id = 'plain';
      element.textContent = 'Search';
      document.body.append(element);
      element.showModal();
    });
    assert.equal(await inert(page), true);
    await page.evaluate(() => document.getElementById('plain').close());
    await page.waitForFunction(() => !document.getElementById('plain')?.open);
    assert.equal(await inert(page), false);
    await page.locator('#page').click();
    assert.equal(await page.evaluate(() => window.clicks), 1);
  } finally {
    await page.close();
  }
});

function clerkStub(token, project) {
  const email = `owner-${project}@example.test`;
  return `window.Clerk = {
    user: { id: 'u', fullName: 'Owner Meridian light', primaryEmailAddress: { emailAddress: '${email}' } },
    session: { getToken: async () => '${token}' },
    load: async () => {}, addListener: () => () => {}, signOut: async () => {},
    mountUserButton: () => {}, unmountUserButton: () => {},
    mountUserProfile: () => {}, unmountUserProfile: () => {},
    mountSignIn: () => {}, unmountSignIn: () => {}, mountSignUp: () => {}, unmountSignUp: () => {},
  };`;
}

test('deleting an invoice on the Invoices page leaves the list clickable', { skip: skipWithoutDatabase, timeout: 60_000 }, async () => {
  const flow = await startFlow();
  const project = 'desk-chromium-meridian-light';
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-AU', timezoneId: 'UTC' });
    await page.route('https://clerk.example.test/**', (route) => {
      const body = route.request().url().endsWith('clerk.browser.js') ? clerkStub(flow.tokens[project], project) : '';
      return route.fulfill({ status: 200, contentType: 'text/javascript', body });
    });
    const appInert = () => page.evaluate(() => document.querySelector('.fx-app').hasAttribute('inert'));
    await page.goto(`${flow.url}/invoices/${flow.invoiceId}`);
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('heading', { name: 'Delete this invoice?' }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.waitForURL('**/invoices');
    const deleted = page.getByRole('status').filter({ hasText: 'Invoice deleted.' });
    await deleted.waitFor();
    await deleted.getByRole('button', { name: 'Close' }).waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await appInert(), false);

    await page.getByRole('tab', { name: /^Pending/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent.startsWith('Pending') && tab.getAttribute('aria-selected') === 'true'));

    await page.getByRole('tab', { name: /^Ready/ }).click();
    await page.locator('tbody tr').first().waitFor();
    const ticks = page.locator('tbody .fx-tick');
    await ticks.nth(0).check();
    await ticks.nth(1).check();
    await page.locator('.fx-bulk').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('heading', { name: 'Delete 2 invoices?' }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete 2' }).click();
    const bulkDeleted = page.getByRole('status').filter({ hasText: '2 invoices deleted.' });
    await bulkDeleted.waitFor();
    await bulkDeleted.getByRole('button', { name: 'Close' }).waitFor();
    assert.equal(await appInert(), false);
    await page.getByRole('tab', { name: /^Approved/ }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent.startsWith('Approved') && tab.getAttribute('aria-selected') === 'true'));

    await page.getByRole('tab', { name: /^Ready/ }).click();
    await page.locator('tbody tr').first().click();
    await page.getByRole('button', { name: 'Delete' }).waitFor();
    await page.route('**/api/invoicing/invoices/**', (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, code: 'accounting_unavailable', error: 'No accounting system is connected. An issued invoice stays as it is.' }),
      });
    });
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alert').filter({ hasText: 'No accounting system is connected' }).waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await appInert(), false);
    assert.match(page.url(), /\/invoices\/[0-9a-f-]+$/);
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]') && !document.querySelector('.fx-app').hasAttribute('inert'));
    assert.equal(await appInert(), false);
  } finally {
    await page?.close();
    await flow.close();
  }
});
