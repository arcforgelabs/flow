// Which sidebar pages a person has pinned. Stored with the account in
// people.views.nav (PUT /api/me/views/nav). No table of its own.
// Jobs and Invoices stay pinned: a request that leaves them out is saved
// with them put back. A page Flow does not know is dropped.

export const NAV_PAGES = Object.freeze([
  'jobs',
  'invoices',
  'contacts',
  'reconcile',
  'price-list',
  'invoicing-settings',
  'automations',
  'custom-fields',
  'integrations',
]);

export const NAV_LOCKED = Object.freeze(['jobs', 'invoices']);

// Today's sidebar, before a person has chosen: daily work (Jobs, Invoices,
// Contacts, Reconcile), Price list and Rules. Automations, Custom fields
// and Integrations start in More.
export const NAV_DEFAULT = Object.freeze([
  'jobs',
  'invoices',
  'contacts',
  'reconcile',
  'price-list',
  'invoicing-settings',
]);

export function normaliseNavPins(input) {
  const source = Array.isArray(input?.pinned) ? input.pinned : [];
  const chosen = new Set(NAV_LOCKED);
  for (const name of source) if (NAV_PAGES.includes(name)) chosen.add(name);
  return { pinned: NAV_PAGES.filter((name) => chosen.has(name)) };
}

// No saved choice yet: the default sidebar. A saved choice is checked.
export function navPinsFromViews(input) {
  const value = input && typeof input === 'object' ? input : {};
  if (!value.nav) return { pinned: [...NAV_DEFAULT] };
  return normaliseNavPins(value.nav);
}
