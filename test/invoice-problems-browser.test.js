import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { tokensFor } from '../server/theme/themes.js';

// Real list-column geometry and invoice page, with synthetic API answers.
// The mobile suite retains the whole-app screenshot and accessibility gate.
const root = new URL('../server/ui/', import.meta.url);
const reason = 'A synthetic invoice already bills this job. Compare the complete invoice and its extra delivery charge before creating another invoice.';
const xeroId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const invoice = {
  id: '11111111-1111-4111-8111-111111111111', number: 'SYN-2', status: 'issued', tab: 'pending', sendState: 'failed',
  contact: { name: 'Synthetic Practice' }, job: { id: 'job', systemName: 'Work system', link: 'https://example.test/job' },
  totalCents: 22000, subtotalCents: 20000, taxCents: 2000, versions: [], linksTo: [],
  lines: [{ position: 1, description: 'Synthetic crown', quantity: 1, unitAmountCents: 20000, lineAmountCents: 20000, taxCode: 'GST' }],
  problems: [
    { code: 'xero_same_reference_different_amount', short: 'Possible historical invoice', message: reason, xero: { invoiceId: xeroId } },
    { code: 'rule', rule: 'rule', short: 'Practitioner required', message: 'Add the full practitioner name to the source job.' },
    { code: 'xero_tracking_missing', short: 'Tracking missing', message: 'Select tracking before sending.' },
  ],
};
const theme = Object.entries(tokensFor('meridian', 'light')).map(([k, v]) => k + ':' + v).join(';');
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test('long compact holds fit their cells; opening the invoice retains full reasons and usable links', async () => {
  const page = await browser.newPage();
  await page.route('http://flow.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/assets/ui/')) {
      const name = path.slice('/assets/ui/'.length);
      return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(name, root)) });
    }
    const script = path.startsWith('/invoices/') ? '<script type="module">'
      + 'import * as kit from "/assets/ui/kit.js"; import { renderInvoice } from "/assets/ui/invoicing.js";'
      + 'const invoice = ' + JSON.stringify(invoice) + ';'
      + 'const flow = async (path) => path === "/api/invoicing/context" ? { canIssue: false, organisations: [{id:"lab"}] } : path.startsWith("/api/xero/status") ? {connected:false} : {invoice};'
      + 'await renderInvoice(document.querySelector("main"), {...kit, flow, go() {}, toast() {}}, invoice.id);</script>' : '';
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>:root{' + theme + '}</style><link rel="stylesheet" href="/assets/ui/flow.css"><main class="fx-main"></main>' + script });
  });
  try {
    await page.goto('http://flow.test/');
    await page.evaluate(async (invoice) => {
      const { h, notice } = await import('/assets/ui/kit.js');
      const { columnTable, rowCells } = await import('/assets/ui/columns.js');
      const { invoiceProblems } = await import('/assets/ui/invoice-problems.js');
      const columns = [
        { id: 'client', label: 'Client', kind: 'text', phone: 'title', cell: () => h('a', { href: '/invoices/' + invoice.id }, invoice.contact.name) },
        { id: 'problem', label: 'Problem', kind: 'text', phone: 'meta', cell: () => invoiceProblems({ h, notice }, invoice, { compact: true }) },
        { id: 'date', label: 'Created', kind: 'date', phone: 'meta', cell: () => 'Yesterday' },
        { id: 'total', label: 'Total', kind: 'total', num: true, phone: 'end', cell: () => '$220.00' },
      ];
      const heads = columnTable(h, { order: () => columns.map((c) => c.id), widths: () => ({}), change() {} });
      document.querySelector('main').append(heads.table({ columns, rows: h('tbody', {}, h('tr', {}, ...rowCells(h, columns, invoice))) }));
    }, invoice);
    for (const width of [375, 393, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(() => {
        const cell = document.querySelector('td[data-label="Problem"]');
        const range = document.createRange();
        range.selectNodeContents(cell.firstElementChild);
        const text = range.getBoundingClientRect();
        const summary = cell.firstElementChild.getBoundingClientRect();
        const clips = getComputedStyle(cell.firstElementChild).overflowX === 'hidden';
        const bounds = cell.getBoundingClientRect();
        const date = document.querySelector('td[data-label="Created"]').getBoundingClientRect();
        return { left: clips ? Math.max(text.left, summary.left) : text.left, right: clips ? Math.min(text.right, summary.right) : text.right,
          cellLeft: bounds.left, cellRight: bounds.right, dateLeft: date.left, pageWidth: document.documentElement.scrollWidth };
      });
      assert.ok(geometry.left >= geometry.cellLeft - 1 && geometry.right <= geometry.cellRight + 1, JSON.stringify({ width, ...geometry }));
      assert.ok(geometry.right <= geometry.dateLeft, 'the explanation never overwrites the adjacent date');
      assert.ok(geometry.pageWidth <= width, 'the compact reason never widens the page');
    }
    const summary = page.getByRole('note', { name: new RegExp('A synthetic invoice already bills') });
    assert.ok((await summary.getAttribute('title')).includes(reason));
    assert.ok((await summary.getAttribute('aria-label')).includes(reason));
    await page.getByRole('link', { name: 'Synthetic Practice', exact: true }).click();
    const detail = page.locator('.fx-problems');
    await detail.waitFor();
    assert.ok((await detail.textContent()).includes(reason));
    const links = [
      ['Open in Xero', 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' + xeroId],
      ['Fix job', 'https://example.test/job'], ['Check rule', '/invoicing-settings/invoices'], ['Tracking settings', '/integrations/xero#tracking'],
    ];
    for (const [name, href] of links) assert.equal(await detail.getByRole('link', { name, exact: true }).getAttribute('href'), href);
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const message = detail.locator('.fx-notice').first();
      assert.ok(await message.isVisible());
      assert.ok((await message.innerText()).includes(reason), 'the real invoice page keeps the complete visible reason at both widths');
      for (const [name] of links) {
        const target = await detail.getByRole('link', { name, exact: true }).boundingBox();
        assert.ok(target.x >= 0 && target.x + target.width <= width, 'remediation links remain inside the viewport');
        if (width === 375) assert.ok(target.width >= 44 && target.height >= 44, 'phone remediation links keep their touch targets');
      }
    }
  } finally {
    await page.close();
  }
});
