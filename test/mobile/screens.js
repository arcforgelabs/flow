// The screens the phone suite opens (docs/MOBILE_TESTS.md). `list`: a list
// page under listHead, so the toolbar and rows-per-screen checks run on it.
// `prepare` takes the page from the opened path to the state to check.
const tab = (name) => async (page) => {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
  await page.waitForLoadState('networkidle');
};

// The Jobs page opens on the layout the account used last, so wait for
// either.
const JOBS = '.fx-board, .fx-table';

export const SCREENS = [
  { id: 'jobs-board', path: '/jobs', ready: JOBS, prepare: layout('board') },
  { id: 'jobs-list', path: '/jobs', ready: JOBS, prepare: layout('list'), list: true },
  { id: 'job-panel', path: '/jobs', ready: JOBS, prepare: async (page) => {
    await layout('board')(page);
    await page.locator('.fx-job').first().click();
    await page.waitForLoadState('networkidle');
  } },
  { id: 'captures', path: '/captures', ready: '.fx-captures__row', list: true },
  { id: 'capture-sheet', path: '/captures', ready: '.fx-captures__row', prepare: async (page) => {
    await page.locator('.fx-captures__row').first().click();
    await page.locator('.fx-capture').waitFor();
    await page.waitForLoadState('networkidle');
  } },
  { id: 'invoices-ready', path: '/invoices', ready: '.fx-tabs', list: true },
  { id: 'invoices-pending', path: '/invoices', ready: '.fx-tabs', prepare: tab('Pending'), list: true },
  // Back on the list (a reload): the page opens on the tab used last.
  { id: 'invoices-approved', path: '/invoices', ready: '.fx-tabs', prepare: async (page) => {
    await tab('Approved')(page);
    await page.reload();
    await page.waitForLoadState('networkidle');
  }, list: true },
  { id: 'invoices-ticked', path: '/invoices', ready: '.fx-tabs', prepare: async (page) => {
    await tab('Pending')(page);
    const ticks = page.locator('tbody .fx-tick');
    await ticks.nth(0).check();
    await ticks.nth(1).check();
  } },
  { id: 'invoices-filter', path: '/invoices', ready: '.fx-tabs', prepare: async (page) => {
    await page.getByRole('button', { name: /^Filter/ }).first().click();
  } },
  // One filter row, so the panel's field, operator, value and delete are on screen.
  { id: 'invoices-filter-row', path: '/invoices', ready: '.fx-tabs', prepare: async (page) => {
    await page.getByRole('button', { name: /^Filter/ }).first().click();
    await page.getByRole('button', { name: 'Add filter' }).click();
    await page.locator('.fx-rows__row').first().waitFor();
  } },
  { id: 'invoice', path: () => `/invoices/${process.env.MOBILE_INVOICE}`, ready: '.fx-main h1, .fx-main .fx-title' },
  { id: 'invoice-issued', path: () => `/invoices/${process.env.MOBILE_ISSUED}`, ready: '.fx-lines__table' },
  // A Pending invoice whose client is not in Xero: the problem note with
  // Link and Create. The suite has no Xero, so the page reads the problem
  // from a stand-in answer.
  { id: 'invoice-offer', path: () => `/invoices/${process.env.MOBILE_INVOICE}`, ready: '.fx-lines__table', prepare: async (page) => {
    await page.route(`**/api/invoicing/invoices/${process.env.MOBILE_INVOICE}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      body.invoice.problems = [{
        code: 'xero_contact_missing', short: 'Client not in Xero', offerLink: true, offerCreate: true,
        message: `No Xero contact is named "${body.invoice.contact?.name}". Link it to its Xero client, or create it in Xero.`,
      }];
      return route.fulfill({ response, json: body });
    });
    await page.reload();
    await page.locator('.fx-offer').waitFor();
    await page.waitForLoadState('networkidle');
  } },
  { id: 'reconcile', path: '/reconcile', ready: '.fx-main > *', list: true },
  { id: 'price-list', path: '/price-list', ready: '.fx-frame tbody tr', list: true },
  { id: 'rules', path: '/invoicing-settings', ready: '.fx-main > *' },
  { id: 'automations', path: '/automations', ready: '.fx-main > *' },
  { id: 'integrations', path: '/integrations', ready: '.fx-main > *' },
  // Settings rows with a menu and a box (Sending).
  { id: 'integration-xero', path: '/integrations/xero', ready: '.fx-main > *' },
  // A setting's ? pressed: its help shows under the name.
  { id: 'integration-seazona', path: '/integrations/seazona', ready: '.fx-setting__head .fx-help', prepare: async (page) => {
    await page.locator('.fx-setting__head .fx-help').first().click();
  } },
  { id: 'integration-sentry', path: '/integrations/sentry', ready: '.fx-main > *' },
  { id: 'custom-fields', path: '/custom-fields', ready: '.fx-main > *' },
  { id: 'appearance', path: '/appearance', ready: '.fx-main > *' },
  { id: 'portal-jobs', path: '/portal/jobs', ready: '.fx-table' },
  { id: 'portal-job', path: () => `/portal/jobs/${process.env.MOBILE_PORTAL_JOB}`, ready: '.fx-track' },
  { id: 'portal-team', path: '/portal/team', ready: '.fx-cfm__more' },
  { id: 'portal-join', path: '/portal/join', ready: '.fx-portal-join' },
];

function layout(name) {
  return async (page) => {
    const choice = page.getByRole('radio', { name: name === 'board' ? 'Board' : 'List' });
    if ((await choice.getAttribute('aria-checked')) !== 'true') await choice.click();
    await page.waitForLoadState('networkidle');
  };
}
