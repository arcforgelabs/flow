#!/usr/bin/env node
// The Xero demo (docs/XERO.md, "Demo"): the real Flow on localhost, on a
// throwaway database with synthetic data only, connected to a Xero Demo
// Company through a Custom Connection. It creates one new customer in Xero
// from a Flow contact, reads it back from Xero, and saves screenshots of
// Flow. Nothing here can reach a real ledger: sandbox mode refuses an
// organisation that is not a Demo Company.
//
//   FLOW_TEST_DATABASE_URL=postgres://… \
//   XERO_DEMO_CLIENT_ID=… XERO_DEMO_CLIENT_SECRET=… \
//   node scripts/demo/xero-demo.mjs [--out <folder>]
//
// FLOW_TEST_DATABASE_URL is wiped first, as in the tests.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { clerkBrowserStub } from '../../test/support/clerk.js';
import { startFlow } from '../../test/mobile/server.js';

const { values } = parseArgs({ options: { out: { type: 'string', default: 'xero-demo' } } });
const missing = ['FLOW_TEST_DATABASE_URL', 'XERO_DEMO_CLIENT_ID', 'XERO_DEMO_CLIENT_SECRET'].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Set ${missing.join(', ')} (scripts/demo/xero-demo.mjs). The Xero values come from the Custom Connection in Xero My Apps.`);
  process.exit(1);
}

const env = {
  XERO_MODE: 'sandbox',
  XERO_CONNECTION: 'custom',
  XERO_CLIENT_ID: process.env.XERO_DEMO_CLIENT_ID,
  XERO_CLIENT_SECRET: process.env.XERO_DEMO_CLIENT_SECRET,
  // A new key each run: the throwaway database is new each run too.
  XERO_TOKEN_KEY: randomBytes(32).toString('hex'),
};
const flow = await startFlow({ env });
const [project, token] = Object.entries(flow.tokens)[0];
const organisationId = flow.organisationId;

async function api(path, body) {
  const response = await fetch(`${flow.url}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify({ organisationId, ...body }) : undefined,
  });
  const answer = await response.json();
  if (!answer.ok) throw new Error(`${path}: ${answer.code ?? response.status}: ${answer.error ?? ''}`);
  return answer;
}

// A new name each run, so Xero gets a new contact and not a link.
const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, '');
const name = `Demo Clinic ${stamp}`;
const { contact } = await api('/api/invoicing/contacts', {
  kind: 'customer', name, email: 'accounts@demo-clinic.example', phone: '02 9000 0000',
  address: { line1: '1 Example Street', city: 'Sydney', region: 'NSW', postalCode: '2000', country: 'Australia' },
});

const connected = await api('/api/xero/connect', {});
console.log(`connected: ${connected.connection.tenantName} (${connected.mode})`);
const created = await api('/api/xero/contacts', { contactId: contact.id });
console.log(`${created.outcome}: Xero contact ${created.contact.xeroContactId} for "${name}"`);
// Proof from Xero itself: a sync reads every Xero contact again.
await api('/api/xero/sync', {});
const copy = await api(`/api/xero/contacts?organisationId=${organisationId}&q=${encodeURIComponent(name)}`);
const found = copy.contacts.find((c) => c.xeroContactId === created.contact.xeroContactId);
if (!found) throw new Error('The new contact was not in Xero when Flow read the contacts again.');
console.log(`read back from Xero: ${found.name}`);

mkdirSync(values.out, { recursive: true });
const browser = await chromium.launch();
for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  await page.route('https://clerk.example.test/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: route.request().url().endsWith('clerk.browser.js') ? clerkBrowserStub({ token, email: `owner-${project}@example.test`, name: 'Demo owner' }) : '',
  }));
  await page.goto(`${flow.url}/contacts/${contact.id}`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: join(values.out, `flow-contact-${label}.png`), fullPage: true });
  await page.close();
}
await browser.close();

const evidence = {
  at: new Date().toISOString(),
  xeroOrganisation: connected.connection.tenantName,
  mode: connected.mode,
  flowContact: name,
  outcome: created.outcome,
  xeroContactId: created.contact.xeroContactId,
  xeroLink: `https://go.xero.com/Contacts/View/${created.contact.xeroContactId}`,
  readBack: Boolean(found),
};
writeFileSync(join(values.out, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`saved ${values.out}/ (open ${evidence.xeroLink} in Xero to see the contact)`);
await flow.close();
