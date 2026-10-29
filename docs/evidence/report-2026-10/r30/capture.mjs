// Capture the real Flow screens with a disposable database and fake Clerk only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { startFlow } from '../../../../test/mobile/server.js';
import { clerkBrowserStub } from '../../../../test/support/clerk.js';
import { openDatabase } from '../../../../server/db/index.js';
import { observeJob } from '../../../../server/core/ledger.js';
import { runAutomations } from '../../../../server/core/automations.js';

const root = new URL('../', import.meta.url);
const work = process.argv[2];
if (!work) throw new Error('Use: node docs/evidence/report-2026-10/r30/capture.mjs <new take directory>');
await mkdir(work); // Refuse an existing take.
const flow = await startFlow();
const db = openDatabase({ url: process.env.FLOW_TEST_DATABASE_URL });
let browser;
const proof = { synthetic: true, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), checks: [] };
try {
  const contact = (await db.pool.query("select id from contacts where name='Bayview Clinic'")).rows[0];
  const job = await observeJob(db.db, flow.organisationId, {
    sourceSystem: 'synthetic', sourceJobRef: 'SYNTHETIC-READY', caseRef: 'SYNTHETIC-READY',
    sourceStatus: 'Shipped', shippedOn: '2026-10-29', jobDate: '2026-10-29',
    practitioner: 'Dr Synthetic Ready', contactId: contact.id, lines: [{ itemCode: 'CR-ZR' }],
    actor: 'synthetic-recorder',
  });
  assert.equal(job.invoiceId, null);
  browser = await chromium.launch();
  const [project, token] = Object.entries(flow.tokens)[0];
  const pageFor = async (viewport, id) => {
    const context = await browser.newContext({ viewport, ...(id ? { recordVideo: { dir: `${work}/${id}`, size: viewport } } : {}) });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === flow.url) return route.continue();
      if (url.origin === 'https://clerk.example.test') return route.fulfill({ contentType: 'text/javascript',
        body: url.pathname.endsWith('clerk.browser.js') ? clerkBrowserStub({ token, email: `owner-${project}@example.test`, name: 'Synthetic owner' }) : '' });
      return route.abort();
    });
    // A visible pointer follows real mouse events in the recorded viewport.
    await context.addInitScript(() => addEventListener('DOMContentLoaded', () => {
      const pointer = document.createElement('div');
      pointer.textContent = '➤';
      pointer.style.cssText = 'position:fixed;left:60px;top:60px;z-index:2147483647;pointer-events:none;font:28px sans-serif;color:white;text-shadow:1px 1px 2px black;transform:rotate(-120deg)';
      document.documentElement.append(pointer);
      addEventListener('mousemove', e => { pointer.style.left = `${e.clientX}px`; pointer.style.top = `${e.clientY}px`; });
    }));
    return context.newPage();
  };
  const open = async (page, path) => { await page.goto(flow.url + path); await page.waitForLoadState('networkidle'); };
  const aim = async target => { await target.scrollIntoViewIfNeeded(); await target.hover(); };
  const shot = async (page, id, size) => {
    await page.waitForTimeout(600);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: fileURLToPath(new URL(`${id}/${size}.jpg`, root)), type: 'jpeg', quality: 78 });
  };
  for (const id of ['r30', 'r37']) {
    const page = await pageFor({ width: 1280, height: 800 }, id);
    const timings = [];
    const started = performance.now();
    const step = async (label, action) => {
      const start = (performance.now() - started) / 1000;
      await action();
      await page.waitForTimeout(2200);
      timings.push({ label, start, end: (performance.now() - started) / 1000 });
      await page.screenshot({ path: `${work}/${id}/step-${timings.length}.png` });
    };
    if (id === 'r30') {
      await step('Open Automations: Draft when ready and Ready when drafted are on.', async () => {
        await open(page, '/automations');
        for (const name of ['Draft when ready', 'Ready when drafted'])
          assert.equal(await page.getByRole('switch', { name, exact: true }).getAttribute('aria-checked'), 'true');
      });
      await step('Inspect Ready when drafted. The capture command now runs the real automations once.', async () => {
        await aim(page.getByRole('switch', { name: 'Ready when drafted', exact: true }));
        proof.automations = await runAutomations(db.db, flow.organisationId);
        assert.equal(proof.automations.mark_ready_from_work_status.marked, 1);
        assert.equal(proof.automations.draft_when_ready.drafted, 1);
        assert.equal(proof.automations.ready_when_drafted.marked, 1);
      });
      await step('Open Invoices. The new draft appears on Ready.', async () => {
        await page.locator('a[href="/invoices"]').first().click();
        await page.getByText('Dr Synthetic Ready', { exact: true }).waitFor();
      });
      await step('Open the automatic draft: Ready invoice.', async () => {
        await page.getByText('Dr Synthetic Ready', { exact: true }).click();
        await page.getByRole('heading', { name: 'Ready invoice', exact: true }).waitFor();
        assert.equal(await page.getByLabel('Reference', { exact: true }).inputValue(), 'Dr Synthetic Ready');
      });
      await step('Inspect the filled client and price line.', async () => {
        assert.equal(await page.getByLabel('Client', { exact: true }).inputValue(), 'Bayview Clinic');
        await aim(page.getByLabel('Reference', { exact: true }));
        await shot(page, id, 'desktop');
      });
      const invoiceId = page.url().split('/').pop();
      const saved = (await db.pool.query('select status, ready_at, ready_by, issued_version from invoices where id=$1', [invoiceId])).rows[0];
      assert.equal(saved.status, 'draft'); assert.ok(saved.ready_at); assert.equal(saved.ready_by, null); assert.equal(saved.issued_version, 0);
      const events = (await db.pool.query('select kind, actor from obligation_events where obligation_id=$1 order by created_at', [job.id])).rows;
      assert.ok(events.some(e => e.kind === 'drafted' && e.actor === 'automation:draft_when_ready'));
      proof.checks.push({ id, invoice: saved, events, result: 'automatic draft is Ready; no person marked it Ready' });
      const phone = await pageFor({ width: 390, height: 844 });
      await open(phone, `/invoices/${invoiceId}`);
      await phone.getByRole('heading', { name: 'Ready invoice', exact: true }).waitFor();
      await shot(phone, id, 'phone'); await phone.context().close();
    } else {
      await step('Open People, then Invite.', async () => {
        await open(page, '/people'); await page.getByRole('button', { name: 'Invite', exact: true }).click();
      });
      await step('Enter a synthetic email address. The default role is Staff.', async () => {
        const email = page.getByRole('textbox', { name: 'Email', exact: true });
        await aim(email); await email.pressSequentially('demo-invite@example.test', { delay: 50 });
        assert.equal(await page.getByRole('combobox', { name: 'Role', exact: true }).inputValue(), 'staff');
      });
      await step('Submit to fake Clerk. No email leaves this harness.', async () => {
        const response = page.waitForResponse(r => r.url().endsWith('/api/people') && r.request().method() === 'POST');
        const send = page.getByRole('button', { name: 'Send invite', exact: true }); await aim(send); await send.click();
        const res = await response; assert.equal(res.status(), 201);
        const body = await res.json(); assert.equal(body.invite.emailed, true); assert.equal(body.person.invited, true);
        proof.checks.push({ id, status: res.status(), email: body.person.email, role: body.person.role, invited: body.person.invited,
          simulatedProviderResult: body.invite, result: 'Flow accepted the invitation through fake Clerk; delivery was not tested' });
        await page.getByText('Invite emailed to demo-invite@example.test.', { exact: true }).waitFor();
      });
      await step('The People row shows Invited.', async () => {
        const row = page.getByRole('row').filter({ hasText: 'demo-invite@example.test' });
        await row.getByText('Invited', { exact: true }).waitFor(); await aim(row.getByText('demo-invite@example.test', { exact: true }));
        await shot(page, id, 'desktop');
      });
      await step('Open the row menu. Email invite again is available.', async () => {
        const more = page.getByRole('button', { name: 'More for demo-invite@example.test', exact: true }); await aim(more); await more.click();
        await page.getByText('Email invite again', { exact: true }).waitFor();
      });
      const phone = await pageFor({ width: 390, height: 844 });
      await open(phone, '/people');
      await phone.getByRole('row').filter({ hasText: 'demo-invite@example.test' }).getByText('Invited', { exact: true }).waitFor();
      await shot(phone, id, 'phone'); await phone.context().close();
    }
    const video = page.video();
    await page.context().close();
    const raw = await video.path();
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '35', fileURLToPath(new URL(`${id}/clip.webm`, root))]);
    await writeFile(new URL(`${id}/timing.json`, root), JSON.stringify({ synthetic: true, viewport: { width: 1280, height: 800 }, steps: timings }, null, 2) + '\n');
  }
  await writeFile(new URL('r30/persistence.json', root), JSON.stringify(proof, null, 2) + '\n');
  console.log('PASS: real automation draft, Ready invoice and simulated invitation; desktop and phone captures.');
} finally { await browser?.close(); await db.close(); await flow.close(); }
