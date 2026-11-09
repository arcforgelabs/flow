import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { draftProblems, invoiceView } from '../server/core/sending.js';
import { createContact, createOrganisation, createPriceItem } from '../server/core/directory.js';
import { draftInvoiceForObligation, jobChangeFor, observeJob, observeWithdrawn, recordAccountingEvidence, setHold } from '../server/core/ledger.js';
import { freshDatabase, skipWithoutDatabase } from './support/db.js';
import { readRule, rulePending } from '../server/core/invoice-rules.js';

// Exercise the real detail page and confirmation with synthetic HTTP responses.
// No database or accounting system is used; a held response represents latency.
let browser, server, origin;
before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/jobs' || req.url.startsWith('/invoicing-settings/')) {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><div id="app"><main></main><div id="toasts"></div></div>
        <script type="module">
          import * as kit from '/assets/ui/kit.js';
          import { renderInvoice } from '/assets/ui/invoicing.js';
          import { renderInvoicingSettings } from '/assets/ui/invoicing-settings.js';
          import { renderJobs } from '/assets/ui/jobs.js';
          const ui = { ...kit, go: (event) => {
            if (typeof event !== 'string') { event.preventDefault(); location.href = event.currentTarget.href; }
            else window.finished = true;
          }, flow: async (path, options) => {
            const response = await fetch(path, options);
            const body = await response.json();
            if (!response.ok) throw Error(body.error);
            return body;
          }};
          if (location.pathname.startsWith('/invoicing-settings/')) {
            const context = await ui.flow('/api/invoicing/context');
            ui.me = { person: { role: context.canIssue ? 'owner' : 'staff' } };
            renderInvoicingSettings(document.querySelector('main'), ui, 'invoices');
          } else if (location.pathname === '/jobs') await renderJobs(document.querySelector('main'), ui);
          else await renderInvoice(document.querySelector('main'), ui, 'synthetic-invoice');
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
    for (const cancel of ['button', 'Escape']) {
      if (cancel === 'button') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      else await page.keyboard.press('Escape');
      assert.equal(calls, 0);
      await page.waitForFunction(() => [...document.querySelectorAll('button')]
        .some((button) => button.textContent === 'Send to Xero' && !button.disabled));
      assert.equal(await send.evaluate((button) => document.activeElement === button), true, `${cancel} restores Send focus`);
      await page.keyboard.press('Enter');
      await dialog.waitFor();
    }
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

// This boundary protects the real invoice page's action wiring, not source
// correctness. The ledger/API suites own persistence and the financial guard.
test('source comparison rechecks honestly and preserves unsaved edits', { timeout: 10000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
  page.setDefaultTimeout(3000);
  let reads = 0;
  const sourceReview = { sourceTotals: { subtotalCents: 10000, taxCents: 0, totalCents: 10000 },
    reconstructed: { subtotalCents: 10000, taxCents: 1000, totalCents: 11000 },
    savedInvoice: { subtotalCents: 10000, taxCents: 1000, totalCents: 11000 }, unknownTaxLines: [] };
  const invoice = { id: 'synthetic-invoice', status: 'draft', view: 'problem', tab: 'pending', reference: 'SYNTHETIC',
    dueDate: '2026-11-30', contact: { id: 'synthetic-client', name: 'Example client' }, lines: [], linksTo: [],
    problems: [{ code: 'job_review', message: 'Source totals differ.', sourceBilling: true, resolution: { kind: 'job_review' } },
      { code: 'job_review', message: 'The job changed after its invoice was made.', short: 'Line 1 item', resolution: { kind: 'job_review' } }],
    jobChange: { jobId: 'synthetic-job', systemName: 'Source', canRecheck: true, canAccept: false, sourceReview } };
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body;
    switch (url.pathname) {
      case '/api/invoicing/context': body = { canIssue: true, organisations: [{ id: 'synthetic-org', invoicePrefix: 'SYN-', nextInvoiceNumber: 1 }] }; break;
      case '/api/invoicing/invoices/synthetic-invoice': body = { invoice }; break;
      case '/api/invoicing/price-items': body = { priceItems: [] }; break;
      case '/api/invoicing/invoices': body = { invoices: [] }; break;
      case '/api/invoicing/jobs/synthetic-job/recheck':
        reads++;
        body = { invoice, outcome: reads === 1 ? 'read' : 'fresh', retryAfterSeconds: 9 };
        break;
      default: return route.fulfill({ status: 404, json: { error: 'Unexpected synthetic request' } });
    }
    return route.fulfill({ json: body });
  });
  try {
    await page.goto(origin);
    const comparison = page.getByRole('alert', { name: 'Source invoice comparison' });
    await comparison.waitFor();
    assert.equal(await comparison.getByText('+$10.00', { exact: true }).count(), 2);
    assert.equal(await page.getByText(/The resolution view is unavailable/).count(), 0);
    await page.getByText('The job also changed after this invoice was made. Resolve the source amount problem first. Select Recheck, then review the remaining job changes.', { exact: true }).waitFor();
    await comparison.getByText('Saved invoice', { exact: true }).click();
    assert.equal(await comparison.locator('dl dt').count(), 3, 'saved amounts are real DOM nodes');
    assert.equal(await comparison.locator('dl dd').last().textContent(), '$110.00');
    assert.equal((await comparison.innerText()).includes('[object HTMLElement]'), false);
    assert.equal(await page.getByRole('button', { name: 'Accept change', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).first().isDisabled(), true);
    await comparison.getByRole('button', { name: 'Recheck', exact: true }).click();
    await page.getByText('Still pending. Check the comparison and the remaining problems.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Recheck', exact: true }).click();
    await page.getByText('No new source read. Try again in 9 seconds.', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Reference', exact: true }).fill('Unsaved reference');
    await page.getByRole('button', { name: 'Recheck', exact: true }).click();
    await page.getByText('Save or discard your changes before Recheck.', { exact: true }).waitFor();
    assert.equal(reads, 2, 'unsaved edits prevent the read and redraw');
    assert.equal(await page.getByRole('textbox', { name: 'Reference', exact: true }).inputValue(), 'Unsaved reference');
  } finally { await page.close(); }
});

// Resolution contract action proof reuses the server and browser above.
const draft = (extra = {}) => ({
  id: 'synthetic-invoice', status: 'draft', view: 'problem', tab: 'pending', issuedVersion: 0,
  contact: { id: 'client', name: 'Example client' }, dueDate: '2026-11-30', linksTo: [],
  lines: [{ position: 1, quantity: 1, description: 'Crown', unitAmountCents: 10000, taxCode: 'GST', priceItemId: 'crown' }],
  problems: [], ...extra,
});
const sourceWarning = { code: 'job_review', message: 'Source amount differs.', sourceBilling: true, resolution: { kind: 'job_review' } };
const sourceChange = () => ({ jobId: 'job', systemName: 'Seazona', canAccept: false, canRecheck: true,
  sourceInvoiceRef: 'SOURCE-1', caseRef: 'CASE-1', sourceReview: {
    sourceTotals: { subtotalCents: 10000, taxCents: 0, totalCents: 10000 },
    reconstructed: { subtotalCents: 10000, taxCents: 1000, totalCents: 11000 },
    savedInvoice: { subtotalCents: 10000, taxCents: 1000, totalCents: 11000 }, unknownTaxLines: [],
  } });
async function open(invoice, { canIssue = true, action = async () => null, width = 1280, rules = [] } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 852 } });
  page.setDefaultTimeout(3000);
  await page.route('**/api/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    let body;
    if (req.method() !== 'GET') body = await action(req, route);
    else if (path === '/api/invoicing/context') body = { canIssue, organisations: [{ id: 'org' }] };
    else if (path === '/api/invoicing/invoices/synthetic-invoice') body = { invoice };
    else if (path === '/api/invoicing/price-items') body = { priceItems: [{ id: 'crown', code: 'CRN', name: 'Crown', unitAmountCents: 10000, taxCode: 'GST' }] };
    else if (path === '/api/invoicing/invoices') body = { invoices: [] };
    else if (path === '/api/invoicing/rules') body = { rules };
    else if (path === '/api/invoicing/rule-fields') body = {
      fields: [{ key: 'reference', label: 'Reference', kind: 'text', tests: ['is_empty', 'is_not_empty'], draftOnly: true }], options: {},
    };
    else body = {};
    if (body !== undefined) await route.fulfill({ json: body });
  });
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Pending invoice', exact: true, level: 1 }).waitFor();
  return page;
}

test('owned invoice warnings resolve through editing and Save, not a label', async () => {
  const invoice = draft();
  invoice.lines[0].priceItemId = null;
  invoice.problems = draftProblems({ totalCents: 11000 }, invoice.lines);
  let submitted;
  const page = await open(invoice, { action: async (req) => {
    assert.equal(req.method(), 'PATCH');
    submitted = req.postDataJSON();
    assert.equal(submitted.lines[0].priceItemId, 'crown');
    return { invoice: draft({ view: 'ready', problems: draftProblems({ totalCents: 11000 }, submitted.lines) }) };
  } });
  try {
    await page.getByLabel('Item, line 1', { exact: true }).fill('CRN');
    await page.getByLabel('Item, line 1', { exact: true }).blur();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved. It is Ready.', { exact: true }).waitFor();
    assert.ok(submitted, 'Save crossed the actual write boundary');
  } finally { await page.close(); }
});

test('no access, unavailable comparison, unknown resolver and read failure never offer issuance', async () => {
  for (const scenario of ['access', 'missing', 'unknown', 'offline', 'read_failure']) {
    const change = sourceChange();
    if (scenario === 'offline') change.canRecheck = false;
    const invoice = draft({ view: 'ready', problems: [{ ...sourceWarning,
      resolution: { kind: scenario === 'unknown' ? 'new_unimplemented_resolver' : 'job_review' } }],
      jobChange: ['missing', 'unknown'].includes(scenario) ? null : change });
    let calls = 0;
    const page = await open(invoice, { canIssue: scenario !== 'access', action: async (_req, route) => {
      calls++;
      await route.fulfill({ status: 503, json: { error: 'Source unavailable. Try again later.' } });
    } });
    try {
      const approve = page.getByRole('button', { name: 'Approve', exact: true });
      if (scenario === 'access') assert.equal(await approve.count(), 0);
      else assert.equal(await approve.isDisabled(), true);
      if (['missing', 'unknown'].includes(scenario)) await page.getByText(/The resolution view is unavailable/).waitFor();
      if (scenario === 'offline') {
        assert.equal(await page.getByRole('button', { name: 'Recheck', exact: true }).count(), 0);
        assert.equal(await page.getByRole('link', { name: 'Price list', exact: true }).getAttribute('href'), '/price-list');
        await page.getByText(/Ask an administrator to restore the source connection/).waitFor();
      }
      if (scenario === 'read_failure') {
        await page.getByRole('button', { name: 'Recheck', exact: true }).click();
        await page.getByText('Source unavailable. Try again later.', { exact: true }).waitFor();
        assert.equal(calls, 1);
        assert.equal(await approve.isDisabled(), true);
      } else assert.equal(calls, 0);
    } finally { await page.close(); }
  }
});

for (const role of ['owner', 'staff', 'missing']) test('custom Pending rule opens its actual targeted resolution view: ' + role, async () => {
  const made = { ...readRule({ name: 'Missing reference', conditions: [{ field: 'reference', test: 'is_empty' }],
    action: { kind: 'pending', note: 'Check the Reference before sending.' } }), id: 'custom-rule', trigger: 'job_ready' };
  const other = { ...made, id: 'other-rule', name: 'Another rule' };
  const invoice = draft({ problems: rulePending([made], { reference: '' }) });
  let writes = 0;
  const page = await open(invoice, { canIssue: role !== 'staff',
    rules: role === 'missing' ? [] : [other, made], action: async (req) => {
      assert.equal(new URL(req.url()).pathname, '/api/invoicing/rules/custom-rule');
      assert.equal(req.method(), 'PUT');
      const saved = readRule(req.postDataJSON());
      assert.deepEqual(saved.conditions, [{ field: 'reference', test: 'is_not_empty' }]);
      Object.assign(made, saved);
      invoice.problems = rulePending([made], { reference: '' });
      invoice.view = invoice.problems.length ? 'problem' : 'ready';
      invoice.tab = invoice.problems.length ? 'pending' : 'ready';
      writes++;
      return { rule: made };
    } });
  try {
    await page.getByRole('link', { name: 'Review Missing reference', exact: true }).click();
    await page.waitForURL('**/invoicing-settings/invoices?rule=custom-rule');
    if (role === 'missing') {
      await page.getByText('This rule is no longer available. Reopen the invoice to check its remaining problems.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('region').count(), 0);
    } else {
      const target = page.getByRole('region', { name: 'Rule Missing reference', exact: true });
      await target.waitFor();
      assert.ok((await target.innerText()).includes('Reference is empty'));
      assert.equal(await page.getByRole('region', { name: 'Rule Another rule', exact: true }).count(), 0, 'link opens the responsible rule, not a general settings list');
      if (role === 'owner') {
        await target.getByRole('button', { name: 'Edit Missing reference', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('combobox', { name: 'Test', exact: true }).selectOption('is_not_empty');
        await dialog.getByRole('combobox', { name: 'Then', exact: true }).selectOption('wait');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        assert.equal(writes, 0, 'unsupported draft-only condition never crosses the write boundary');
        assert.equal(await dialog.isVisible(), true, 'invalid save retains the dialog and edits');
        assert.equal(await dialog.getByRole('combobox', { name: 'Test', exact: true }).inputValue(), 'is_not_empty');
        assert.match(await dialog.getByRole('combobox', { name: 'Then', exact: true }).evaluate((el) => el.validationMessage), /Pending/);
        await dialog.getByRole('combobox', { name: 'Then', exact: true }).selectOption('pending');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await target.getByText('Reference is not empty · Pending: Check the Reference before sending.', { exact: true }).waitFor();
        await page.goBack();
        await page.getByRole('heading', { name: 'Ready invoice', exact: true, level: 1 }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).isEnabled(), true, 'the changed rule no longer matches on recheck');
      } else {
        assert.equal(await target.getByRole('button', { name: 'Edit Missing reference', exact: true }).count(), 0);
        assert.equal(await target.getByRole('switch', { name: 'Missing reference', exact: true }).isDisabled(), true);
      }
    }
    assert.equal(writes, role === 'owner' ? 1 : 0);
  } finally { await page.close(); }
});

// The real drawer must distinguish work awaiting its first draft from an
// existing draft. Rule persistence is covered by the core/API suites.
test('a job without an invoice is Not drafted after its Wait or Skip rule clears', { timeout: 10000 }, async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  const jobs = ['wait', 'skip'].map((kind) => ({
    sourceSystem: 'synthetic', sourceJobRef: kind, caseRef: kind, status: 'Shipped',
    clientName: `Example ${kind} clinic`, totalCents: 11000, lines: [],
    obligation: { id: kind, view: 'ready', invoiceId: null, waitingFor: [], waitingRules: [], reasons: [], invoiceProblems: [] },
  }));
  const writes = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (route.request().method() !== 'GET') writes.push(url.pathname);
    let body;
    if (url.pathname === '/api/invoicing/board') body = { jobs, statuses: [{ label: 'Shipped' }] };
    else if (url.pathname === '/api/invoicing/context') body = { canIssue: true };
    else if (url.pathname.endsWith('/activity')) body = { events: [] };
    else if (url.pathname === '/api/custom-fields') body = { fields: [] };
    else if (url.pathname === '/api/custom-fields/values') body = { values: [] };
    else return route.fulfill({ status: 404, json: { error: 'Unexpected synthetic request' } });
    return route.fulfill({ json: body });
  });
  try {
    await page.goto(origin + '/jobs');
    for (const job of jobs) {
      await page.getByRole('button', { name: `${job.clientName}, open the job`, exact: true }).click();
      const drawer = page.getByRole('dialog', { name: job.clientName, exact: true });
      const invoice = drawer.locator('dt').filter({ hasText: /^Invoice$/ }).locator('..').locator('dd');
      assert.equal(await invoice.textContent(), 'Not drafted');
      assert.equal(await drawer.getByRole('button', { name: 'Draft invoice', exact: true }).isVisible(), true);
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden' });
    }
    assert.deepEqual(writes, [], 'viewing the job never drafts an invoice');
  } finally {
    await page.close();
  }
});


// The existing browser boundary consumes real ledger/send-check output here:
// no fabricated warning intent can hide a mismatch between the two owners.
test('non-change job holds show their existing review steps without inventing a missing comparison', { skip: skipWithoutDatabase }, async () => {
  const handle = await freshDatabase();
  const actor = 'user:synthetic-review';
  const captures = await mkdtemp(path.join(tmpdir(), 'flow-job-hold-'));
  try {
    const lab = await createOrganisation(handle.db, { name: 'Example Lab' });
    const contact = await createContact(handle.db, lab.id, { kind: 'customer', name: 'Example Clinic' });
    await createPriceItem(handle.db, lab.id, { code: 'CRN', name: 'Crown', unitAmountCents: 10000 });
    for (const kind of ['deleted', 'status', 'manual']) {
      const report = { sourceSystem: 'worksystem', sourceJobRef: kind, contactId: contact.id,
        sourceStatus: 'Shipped', lines: [{ itemCode: 'CRN' }] };
      const obligation = await observeJob(handle.db, lab.id, report);
      await recordAccountingEvidence(handle.db, lab.id, obligation.id, { state: 'not_found', actor });
      const { invoice: saved } = await draftInvoiceForObligation(handle.db, lab.id, obligation.id,
        { actor, liveCheck: async () => ({ state: 'not_found' }) });
      if (kind === 'manual') await setHold(handle.db, lab.id, obligation.id,
        { actor, holdState: 'review', reason: 'Confirm the cancelled case with the work team' });
      else await observeWithdrawn(handle.db, lab.id,
        { sourceSystem: report.sourceSystem, sourceJobRef: kind, deleted: kind === 'deleted', sourceStatus: 'Design', actor });
      const viewed = await invoiceView(handle.db, lab.id, saved);
      const jobChange = await jobChangeFor(handle.db, lab.id, saved.id);
      assert.equal(jobChange, null, 'a real non-change hold has no comparison');
      assert.equal(viewed.view, 'problem', 'the financial hold is still authoritative');
      for (const canIssue of [true, false]) {
        const withSource = kind !== 'manual';
        const invoice = draft({ ...saved, id: 'synthetic-invoice', ...viewed, tab: 'pending', jobChange,
          contact, job: { id: obligation.id, systemName: 'Work system', sourceJobRef: kind,
            link: withSource ? { url: 'https://work.example.test/job/' + kind, exact: true } : null } });
        let writes = 0;
        const page = await open(invoice, { canIssue, width: canIssue ? 1280 : 393, action: async () => { writes++; } });
        try {
          await page.screenshot({ path: path.join(captures, kind + '-' + (canIssue ? 'owner' : 'staff') + '.png'), fullPage: true });
          assert.equal(await page.getByText(/The resolution view is unavailable/).count(), 0,
            'a supported non-change hold is not a missing comparison view');
          await page.getByText(withSource ? /Check the job in the work system/ : /Check the job and its invoice/).waitFor();
          if (withSource) assert.equal(await page.getByRole('link', { name: 'Open in Work system', exact: true }).getAttribute('href'), invoice.job.link.url);
          else await page.getByText(/source link is unavailable/).waitFor();
          const approve = page.getByRole('button', { name: 'Approve', exact: true });
          assert.equal(canIssue ? await approve.isDisabled() : await approve.count() === 0, true);
          assert.equal(await page.getByRole('button', { name: 'Accept change', exact: true }).count(), 0);
          assert.equal(writes, 0, 'reading the review never releases a hold or writes to a source');
        } finally { await page.close(); }
      }
      assert.equal((await invoiceView(handle.db, lab.id, saved)).view, 'problem');
    }
  } finally { console.log('Non-change hold screenshots:', captures); await handle.close(); }
});
