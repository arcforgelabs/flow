import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

// Exercise the real detail page and confirmation with synthetic HTTP responses.
// No database or accounting system is used; a held response represents latency.
let browser, server, origin;
before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><div id="app"><main></main><div id="toasts"></div></div>
        <script type="module">
          import * as kit from '/assets/ui/kit.js';
          import { renderInvoice } from '/assets/ui/invoicing.js';
          const ui = { ...kit, go: () => { window.finished = true; }, flow: async (path, options) => {
            const response = await fetch(path, options);
            const body = await response.json();
            if (!response.ok) throw Error(body.error);
            return body;
          }};
          await renderInvoice(document.querySelector('main'), ui, 'synthetic-invoice');
        </script>`);
      return;
    }
    if (!req.url.startsWith('/assets/ui/') || req.url.includes('..')) return res.writeHead(404).end();
    try {
      const body = await readFile(new URL('../server/ui/' + req.url.slice(11), import.meta.url));
      res.setHeader('content-type', req.url.endsWith('.json') ? 'application/json' : 'text/javascript');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

for (const width of [1280, 393]) test(`detail Send stays busy, rejects repeat activation and permits retry at ${width}px`, { timeout: 5000 }, async () => {
  const page = await browser.newPage({ viewport: { width, height: 852 } });
  page.setDefaultTimeout(3000);
  let calls = 0, release, issued = false;
  let submitted = Promise.withResolvers();
  const invoice = () => ({
    id: 'synthetic-invoice', status: 'draft', view: 'ready', tab: 'ready',
    number: issued ? 'SYN-0001' : null, reference: 'SYNTHETIC', dueDate: '2026-11-30',
    contact: { id: 'synthetic-client', name: 'Example client' }, lines: [], problems: [], linksTo: [],
    sendsTo: 'Xero', sendMode: { connected: true, writesAllowed: true, mode: 'accounting_draft' },
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body;
    switch (url.pathname) {
      case '/api/invoicing/context': body = { canIssue: true, organisations: [{ id: 'synthetic-org', invoicePrefix: 'SYN-', nextInvoiceNumber: 1 }] }; break;
      case '/api/invoicing/invoices/synthetic-invoice': body = { invoice: invoice() }; break;
      case '/api/invoicing/price-items': body = { priceItems: [] }; break;
      case '/api/invoicing/invoices': body = { invoices: [] }; break;
      case '/api/invoicing/invoices/send-ready': {
        calls++;
        assert.equal(route.request().method(), 'POST');
        assert.deepEqual(route.request().postDataJSON().invoiceIds, ['synthetic-invoice']);
        const success = await new Promise((resolve) => { release = resolve; submitted.resolve(); });
        issued = success;
        return route.fulfill({ status: success ? 200 : 409, json: success ? { issued: 1 } : { error: 'Synthetic refusal. Check sync and retry.' } });
      }
      default: return route.fulfill({ status: 404, json: { error: 'Unexpected synthetic request' } });
    }
    return route.fulfill({ json: body });
  });
  try {
    await page.goto(origin);
    const send = page.getByRole('button', { name: 'Send to Xero', exact: true });
    const dialog = page.getByRole('dialog');
    await send.click();
    await dialog.waitFor();
    assert.equal(await send.isDisabled(), true, 'confirmation also owns the action');
    await send.dispatchEvent('click');
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(calls, 0);
    await send.focus();
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Send', exact: true }).focus();
    await page.keyboard.press('Enter');
    await submitted.promise;
    await page.waitForFunction(() => document.querySelector('button[aria-busy="true"]'));
    const working = page.getByRole('button', { name: 'Sending…', exact: true });
    assert.equal(await working.isDisabled(), true);
    // A queued activation must not reopen confirmation even if delivered directly.
    await working.dispatchEvent('click');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.waitForFunction(() => document.querySelector('button[aria-busy="true"]'));
    assert.equal(calls, 1);
    release(false);
    await send.waitFor();
    assert.equal(await send.isEnabled(), true);
    assert.equal(await send.getAttribute('aria-busy'), null);
    await page.getByText('Synthetic refusal. Check sync and retry.', { exact: true }).waitFor();
    submitted = Promise.withResolvers();
    await send.click();
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await submitted.promise;
    await working.waitFor();
    assert.equal(calls, 2, 'a failed send can be retried');
    release(true);
    await page.getByText('SYN-0001 is on the way to Xero.', { exact: true }).waitFor();
    await page.waitForFunction(() => window.finished);
  } finally {
    release?.(false);
    await page.close();
  }
});
