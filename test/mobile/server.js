import { createApp } from '../../server/app.js';
import { invitePerson, seedFirstOwner, setPersonAppearance } from '../../server/auth/people.js';
import { createPersonAuth } from '../../server/auth/session.js';
import { createField } from '../../server/core/custom-fields.js';
import { createContact, createOrganisation, createPriceItem } from '../../server/core/directory.js';
import { createDraftInvoice, issueInvoice } from '../../server/core/invoices.js';
import { adapters as shippedAdapters } from '../../server/integrations/adapters.js';
import { createRegistry } from '../../server/integrations/port.js';
import { fakeClerk, TEST_PUBLISHABLE_KEY } from '../support/clerk.js';
import { freshDatabase } from '../support/db.js';
import { ENGINES, SIZES, THEMES } from './themes.js';

// The phone suite's Flow (docs/MOBILE_TESTS.md): the real app on a fresh
// database with synthetic data only, and one signed-in owner per theme so
// projects that run at once never change each other's state. Playwright
// runs this before the tests (globalSetup); the tests read MOBILE_* from the
// environment. Every name here is made up.

const quiet = { info() {}, warn() {}, error() {} };
const CLINICS = ['Northside Dental', 'Harbour Smiles', 'Bayview Clinic', 'Coast Dental Co', 'Ridge Family Dental'];
const PRACTITIONERS = ['Dr A. Example', 'Dr B. Sample', 'Dr C. Demo', 'Dr D. Test'];
const PRODUCTS = [['CR-ZR', 'Zirconia crown', 16000], ['SH-MT', 'Shade match', 2500], ['BR-3U', 'Bridge, 3 units', 54000], ['VN-EM', 'Veneer', 31000], ['SP-NG', 'Night guard', 12000], ['IM-PL', 'Implant crown', 48000], ['RP-DN', 'Denture repair', 9000]];
const STAGES = ['Received', 'Design', 'Milling', 'Finishing', 'Quality check', 'Shipped'];
const day = (n) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10);

// A work system with jobs on every stage, so the board has full lanes.
function workSystem() {
  const items = Array.from({ length: 42 }, (_, i) => ({
    sourceSystem: 'worksystem',
    sourceJobRef: `CASE-${48200 + i}`,
    caseRef: String(48200 + i),
    status: STAGES[i % STAGES.length],
    clientName: CLINICS[i % CLINICS.length],
    practitioner: PRACTITIONERS[i % PRACTITIONERS.length],
    patient: `Patient ${String.fromCharCode(65 + (i % 26))}`,
    orderedOn: day(i % 20),
    dueOn: day(10 + (i % 20)),
    totalCents: PRODUCTS[i % PRODUCTS.length][2],
    lines: [{ code: PRODUCTS[i % PRODUCTS.length][0], description: PRODUCTS[i % PRODUCTS.length][1], amountCents: PRODUCTS[i % PRODUCTS.length][2] }],
  }));
  return {
    id: 'worksystem', name: 'Work system',
    capabilities: {
      health: async () => ({ ok: true }),
      listWork: async () => ({ items, statuses: STAGES.map((label, i) => ({ label, final: i === STAGES.length - 1, firstSeenAt: '2026-09-01T00:00:00.000Z' })) }),
    },
  };
}

// `env` turns on shipped adapters for a demo (scripts/demo/xero-demo.mjs):
// with XERO_MODE set, Xero starts with those settings.
export async function startFlow({ port = 0, env = {} } = {}) {
  const handle = await freshDatabase();
  const db = handle.db;
  const lab = await createOrganisation(db, { name: 'Example Lab', invoicePrefix: 'FL-' });
  const contacts = [];
  for (const name of CLINICS) contacts.push(await createContact(db, lab.id, { kind: 'customer', name }));
  const items = [];
  for (const [code, name, unitAmountCents] of PRODUCTS) items.push(await createPriceItem(db, lab.id, { code, name, unitAmountCents }));
  for (const name of ['Shade', 'Rush', 'Scan received']) {
    await createField(db, lab.id, name === 'Shade'
      ? { name, type: 'dropdown', options: [{ name: 'A1', color: 'blue' }, { name: 'A2', color: 'green' }, { name: 'B1', color: 'purple' }] }
      : { name, type: 'checkbox' });
  }

  // One owner per project (size, engine, theme): a page keeps state with
  // the account (the Jobs layout, column widths), so projects never share
  // one.
  const clerk = fakeClerk();
  const tokens = {};
  let firstOwner = null;
  for (const size of SIZES) {
    for (const engine of ENGINES) {
      for (const theme of THEMES) {
        const project = `${size.id}-${engine}-${theme.id}`;
        const email = `owner-${project}@example.test`;
        const person = firstOwner
          ? await invitePerson(db, { email, name: `Owner ${theme.label}`, role: 'owner', invitedBy: firstOwner.id })
          : await seedFirstOwner(db, email);
        firstOwner ??= person;
        await setPersonAppearance(db, { id: person.id, appearance: { colorMode: theme.mode, themeFamily: theme.family } });
        // Long enough for a whole run.
        tokens[project] = clerk.signIn(clerk.addUser({ email, google: true, password: false }), { expiresIn: 6 * 3600 });
      }
    }
  }

  // Invoices on several tabs: drafts with lines, drafts with none (Pending),
  // and issued ones (Approved).
  const invoiceIds = [];
  let issuedId = null;
  for (let i = 0; i < 64; i += 1) {
    const contact = contacts[i % contacts.length];
    const lines = i % 9 === 0 ? [] : [{ priceItemId: items[i % items.length].id }, ...(i % 3 ? [] : [{ priceItemId: items[1].id }])];
    const invoice = await createDraftInvoice(db, lab.id, {
      contactId: contact.id,
      reference: `${PRACTITIONERS[i % PRACTITIONERS.length]} - Case ${48200 + i}`,
      dueDate: day(30 + (i % 25)),
      lines,
    });
    if (lines.length && i % 4 === 0) {
      await issueInvoice(db, lab.id, invoice.id, { issuedBy: firstOwner.id, issueDate: day(i % 20) });
      issuedId ??= invoice.id;
    }
    invoiceIds.push(invoice.id);
  }

  // Every row as made on one fixed day, so a "made on" date never changes a
  // screenshot. Append-only records refuse the change and keep their own.
  await handle.pool.query(`DO $$ DECLARE c record; BEGIN
    FOR c IN SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND data_type LIKE 'timestamp%' AND column_name IN ('created_at', 'updated_at', 'issued_at')
    LOOP
      BEGIN EXECUTE format('UPDATE %I SET %I = %L', c.table_name, c.column_name, '2026-10-20T09:00:00Z');
      EXCEPTION WHEN others THEN NULL; END;
    END LOOP;
  END $$;`);
  // Lists show the newest first, so give each invoice its own minute, in
  // the order of its case, or rows that tie would swap between runs.
  await handle.pool.query(`UPDATE invoices SET created_at = timestamptz '2026-10-20T09:00:00Z' - o.n * interval '1 minute'
    FROM (SELECT id, row_number() OVER (ORDER BY reference) AS n FROM invoices) o WHERE invoices.id = o.id`);

  const integrations = createRegistry({ log: quiet, env });
  integrations.register(workSystem());
  integrations.enable('worksystem');
  // The shipped adapters, each off, so Integrations shows its cards.
  for (const adapter of shippedAdapters) integrations.register(adapter);
  if (env.XERO_MODE) integrations.enable('xero');
  await integrations.start(db);
  const settings = { mode: 'clerk', keys: { publishableKey: TEST_PUBLISHABLE_KEY, proxyUrl: null } };
  const personAuth = createPersonAuth({ db, clerk, ownerGoogleDomains: ['example.test'], log: quiet });
  const app = createApp({ database: handle, auth: { settings, clerk, personAuth }, integrations, log: quiet,
    // Every project loads every page from one address at once.
    rateLimitPerMinute: 100_000, signInRateLimitPerMinute: 100_000, assetRateLimitPerMinute: 100_000,
  });
  const server = await new Promise((resolve) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    tokens,
    organisationId: lab.id,
    invoiceId: invoiceIds[1],
    issuedId,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await integrations.stop?.();
      await handle.close();
    },
  };
}

// Playwright's globalSetup: start Flow and hand its address to the workers.
export default async function globalSetup() {
  const flow = await startFlow();
  process.env.MOBILE_URL = flow.url;
  process.env.MOBILE_TOKENS = JSON.stringify(flow.tokens);
  process.env.MOBILE_INVOICE = flow.invoiceId;
  process.env.MOBILE_ISSUED = flow.issuedId;
  return () => flow.close();
}
