import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

// Settings, Rules, "Price codes" in a real browser (server/ui/line-mappings.js),
// with the API stubbed in the page. Synthetic data only (CONTRIBUTING.md).

const root = fileURLToPath(new URL('../server/ui/', import.meta.url));
const PAGE = `<!doctype html>
<meta charset="utf-8">
<div id="app"></div><div id="toasts"></div>
<script type="module">
  import { copyButton, h, notice, settingRow, toast } from '/assets/ui/kit.js';
  import { lineMappingSection } from '/assets/ui/line-mappings.js';
  const items = [{ id: 'item-crn', code: 'CRN', name: 'Example crown', unitAmountCents: 17000, taxCode: 'GST' }];
  const product = { system: 'worksystem', externalId: '11111111-2222-4333-8444-555555555555', unitAmountCents: 17000 };
  window.state = { calls: [], copied: [], waiting: [
    { label: 'example crown', sample: 'Example Crown', unitAmountCents: 18500, code: '2131', lines: 4, jobs: 3, jobsToInvoice: 1, product },
    { label: 'example discount', sample: 'Example Discount', unitAmountCents: -17500, code: null, lines: 1, jobs: 1, jobsToInvoice: 1, product: null },
    { label: 'opening line', sample: 'Opening Line', unitAmountCents: 0, code: '2155', lines: 2, jobs: 2, jobsToInvoice: 0, product: null },
  ] };
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.state.copied.push(text); } } });
  async function flow(path, options = {}) {
    if (path === '/api/invoicing/line-labels') return { ok: true, labels: [], waiting: window.state.waiting };
    if (path === '/api/invoicing/price-items') return { ok: true, priceItems: items };
    if (path === '/api/invoicing/automations') return { ok: true, automations: [{ key: 'map_lines', config: { placeholders: [{ label: 'older', unitAmountCents: 0 }] } }] };
    window.state.calls.push({ path, body: JSON.parse(options.body) });
    if (path === '/api/invoicing/automations/map_lines') { window.state.waiting = window.state.waiting.filter((row) => row.label !== 'opening line'); return { ok: true }; }
    if (path === '/api/invoicing/line-mappings') throw Object.assign(new Error('the mapping needs a price item'), { status: 400, code: 'invalid' });
    window.state.waiting = window.state.waiting.filter((row) => row.code !== '2131');
    return { ok: true };
  }
  const ui = { h, flow, toast, notice, settingRow, copyButton, me: { person: { role: 'owner' } }, go: () => {} };
  document.getElementById('app').append(lineMappingSection(ui));
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

test('a product row links the product and clears; a failed save stays in red with Copy prompt', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(origin);
    await page.waitForFunction(() => window.ready);
    await page.getByText('Example Crown', { exact: true }).waitFor();
    const text = await page.locator('#app').innerText();
    assert.ok(text.includes('Code 2131 · $185.00 on the job, list $170.00 · 4 lines on 3 jobs, 1 to invoice'), text);
    assert.ok(text.includes('-$175.00 · 1 line on 1 job, 1 to invoice'), text);

    // Each row has its own Copy prompt: codes and amounts, never the line text.
    await page.getByRole('button', { name: 'Copy prompt' }).first().click();
    await page.waitForFunction(() => window.state.copied.length === 1);
    const prompt = await page.evaluate(() => window.state.copied[0]);
    assert.ok(prompt.includes('code: 2131') && prompt.includes('$185.00') && !prompt.includes('Example Crown'), prompt);

    // A free-text row saves the label at its own price; the error stays on the page.
    await page.getByLabel('Price item for Example Discount').selectOption('item-crn');
    await page.getByRole('alert').waitFor();
    assert.ok((await page.getByRole('alert').innerText()).includes('the mapping needs a price item'));
    assert.equal(await page.getByRole('button', { name: 'Copy prompt' }).count(), 4, 'the error has its own Copy prompt');
    await page.getByRole('button', { name: 'Copy prompt' }).nth(2).click();
    await page.waitForFunction(() => window.state.copied.length === 2);
    assert.ok((await page.evaluate(() => window.state.copied[1])).includes('Error: Save the price code: HTTP 400, code invalid'));

    // Only a $0.00 row offers the placeholder choice; it joins the lab's list.
    assert.equal(await page.getByLabel('Price item for Example Discount').locator('option', { hasText: 'Placeholder' }).count(), 0);
    await page.getByLabel('Price item for Opening Line').selectOption('__placeholder');
    await page.getByText('Opening Line', { exact: true }).waitFor({ state: 'detached' });

    // A product row links the product, and the row leaves after the reload.
    await page.getByLabel('Price item for Example Crown').selectOption('item-crn');
    await page.getByText('Example Crown', { exact: true }).waitFor({ state: 'detached' });
    assert.ok((await page.locator('#toasts').innerText()).includes('Linked to CRN'));
    assert.deepEqual(await page.evaluate(() => window.state.calls), [
      { path: '/api/invoicing/line-mappings', body: { kind: 'saved', label: 'example discount', unitAmountCents: -17500, itemCode: 'CRN' } },
      { path: '/api/invoicing/automations/map_lines', body: { config: { placeholders: [{ label: 'older', unitAmountCents: 0 }, { label: 'opening line', unitAmountCents: 0 }] } } },
      { path: '/api/invoicing/price-links', body: { links: [{ priceItemId: 'item-crn', system: 'worksystem', externalId: '11111111-2222-4333-8444-555555555555' }] } },
    ]);
  } finally {
    await page.close();
  }
});
