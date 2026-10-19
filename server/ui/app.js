// Flow's signed-in app and its sign-in screen, at /sign-in and each view's
// own address (/people, /account, /appearance). Clerk's own
// components sign people in (SignIn), hold the account menu (UserButton) and
// the account page (UserProfile); Flow decides what each person may do
// (GET /api/me) and an owner manages people here. Every Clerk component takes
// Flow's design system (clerk-appearance.js) and follows it when the
// appearance changes. Every Flow request carries the session token in the
// Authorization header. Text from the server is only ever set as text.
import { getAppearance, onAppearanceChange, setAppearance, loadFonts } from '/assets/ui/appearance.js';
import { flowClerkAppearance } from '/assets/ui/clerk-appearance.js';
import { ACCENT_PRESETS, normalizeAccent, THEME_FAMILIES, tokensFor } from '/assets/theme/themes.js';
import { renderInvoice, renderInvoiceList } from '/assets/ui/invoicing.js';
import { renderJobs } from '/assets/ui/jobs.js';
import { startMonitoring } from '/assets/ui/monitoring.js';

const $ = (id) => document.getElementById(id);

// h('p', { class: 'x', onclick }, 'text', child) — children are text or nodes.
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', staff: 'Staff' };
const ROLE_HINT = {
  owner: 'Manages people, connections and every record.',
  admin: 'Runs invoicing and connections day to day.',
  staff: 'Works on jobs and invoices.',
};

// ── Clerk ──────────────────────────────────────────────────────────────────

let config = null;
const mounted = new Map(); // element -> { kind, options }

function clerkAppearance(kind) {
  return flowClerkAppearance({ embedded: kind === 'profile', publicSignUp: config?.publicSignUp });
}

function mountClerk(kind, element, options = {}) {
  const Clerk = window.Clerk;
  const props = { ...options, appearance: clerkAppearance(kind) };
  // The "Manage account" modal does not inherit the button's appearance.
  if (kind === 'userButton') props.userProfileProps = { ...options.userProfileProps, appearance: clerkAppearance('modal') };
  if (kind === 'signIn') Clerk.mountSignIn(element, props);
  else if (kind === 'userButton') Clerk.mountUserButton(element, props);
  else if (kind === 'profile') Clerk.mountUserProfile(element, props);
  mounted.set(element, { kind, options });
}

function unmountClerk(element) {
  const entry = mounted.get(element);
  if (!entry) return;
  const Clerk = window.Clerk;
  if (entry.kind === 'signIn') Clerk.unmountSignIn(element);
  else if (entry.kind === 'userButton') Clerk.unmountUserButton(element);
  else if (entry.kind === 'profile') Clerk.unmountUserProfile(element);
  mounted.delete(element);
}

function unmountAllIn(container) {
  for (const element of [...mounted.keys()]) {
    if (container.contains(element)) unmountClerk(element);
  }
}

// Clerk reads its appearance when a component mounts, so a new appearance
// remounts each one (after the tokens have changed on <html>). Modals Clerk
// opens itself use the appearance from Clerk.load(), so update that too.
onAppearanceChange(() => {
  window.Clerk?.__internal_updateProps?.({ appearance: clerkAppearance('modal') });
  for (const [element, { kind, options }] of [...mounted]) {
    unmountClerk(element);
    mountClerk(kind, element, options);
  }
});

// clerk-js, then its prebuilt components (@clerk/ui), which set
// window.__internal_ClerkUICtor for Clerk.load().
function loadClerk({ publishableKey, proxyUrl, scriptUrl, uiScriptUrl }) {
  return Promise.all([
    loadScript(scriptUrl, (script) => {
      script.dataset.clerkPublishableKey = publishableKey;
      if (proxyUrl) script.dataset.clerkProxyUrl = proxyUrl;
    }),
    loadScript(uiScriptUrl),
  ]);
}

function loadScript(src, prepare = () => {}) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.crossOrigin = 'anonymous';
    prepare(script);
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

async function flow(path, options = {}) {
  const token = await window.Clerk.session?.getToken();
  const res = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, code: body.code, details: body.details });
  return body;
}

// ── Shared pieces ──────────────────────────────────────────────────────────

function pageHeader(title, { subtitle, actions = [] } = {}) {
  return h('header', { class: 'fx-ph' },
    h('div', { class: 'fx-ph__text' },
      h('h1', { class: 'fx-title' }, title),
      subtitle ? h('p', { class: 'fx-ph__sub' }, subtitle) : null),
    actions.length ? h('div', { class: 'fx-ph__actions' }, actions) : null);
}

function notice(text, tone = 'info', title = null) {
  return h('div', { class: 'fx-notice', 'data-tone': tone, role: tone === 'danger' ? 'alert' : 'status' },
    title ? h('strong', {}, title) : null,
    h('span', {}, text));
}

function toast(text, tone = 'info') {
  const region = $('toasts');
  const item = h('div', { class: 'fx-toast', 'data-tone': tone, role: 'status' }, text);
  region.append(item);
  setTimeout(() => item.remove(), 4200);
}

// A modal built on <dialog>: resolves with the button's value, or null.
function dialog({ title, body, confirm, tone = 'primary' }) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog', class: 'fx-dialog__form' },
      h('h2', { class: 'fx-dialog__title' }, title),
      body,
      h('div', { class: 'fx-dialog__actions' },
        h('button', { class: 'fx-btn fx-btn--ghost', value: 'cancel', type: 'submit', formnovalidate: true }, 'Cancel'),
        h('button', { class: `fx-btn fx-btn--${tone}`, value: 'ok', type: 'submit' }, confirm)));
    const element = h('dialog', { class: 'fx-dialog' }, form);
    element.addEventListener('close', () => {
      const ok = element.returnValue === 'ok';
      const data = ok ? new FormData(form) : null;
      element.remove();
      resolve(ok ? data : null);
    });
    document.body.append(element);
    element.showModal();
    element.querySelector('input, select, button[value="ok"]')?.focus();
  });
}

function initials(person) {
  const source = (person.name || person.email || '?').replace(/@.*/, '');
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function statusPill(person) {
  if (person.status === 'pending') return h('span', { class: 'fx-status', 'data-tone': 'warn' }, 'Waiting for approval');
  if (person.status === 'disabled') return h('span', { class: 'fx-status', 'data-tone': 'mute' }, 'Turned off');
  if (person.invited) return h('span', { class: 'fx-status', 'data-tone': 'info' }, 'Invited');
  return h('span', { class: 'fx-status', 'data-tone': 'success' }, 'Active');
}

function roleSelect(value, attrs = {}) {
  return h('select', { class: 'fx-select', ...attrs },
    ['owner', 'admin', 'staff'].map((role) => h('option', { value: role, selected: role === value }, ROLE_LABEL[role])));
}

// ── Views ──────────────────────────────────────────────────────────────────

let me = null;

// The sidebar lists the views in this order, under their group's heading.
const VIEWS = {
  jobs: { label: 'Jobs', icon: 'jobs', group: 'Work', render: (main) => renderJobs(main, ui()) },
  invoices: { label: 'Invoices', icon: 'invoices', group: 'Work', render: (main, id) => (id ? renderInvoice(main, ui(), id) : renderInvoiceList(main, ui())) },
  people: { label: 'People', icon: 'people', group: 'Settings', ownerOnly: true, render: renderPeople },
  integrations: { label: 'Integrations', icon: 'plug', group: 'Settings', ownerOnly: true, render: (main, id) => (id ? renderIntegration(main, id) : renderIntegrations(main)) },
  account: { label: 'Account', icon: 'person', group: 'Settings', render: renderAccount },
  appearance: { label: 'Appearance', icon: 'palette', group: 'Settings', render: renderAppearance },
};

// Line icons for the sidebar, drawn on a 24-unit grid in the text colour.
const ICON_PATHS = {
  jobs: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="14" rx="1"/>',
  invoices: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 5a3 3 0 010 6M21 20c0-3-1.6-5-4-5.7"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  palette: '<path d="M12 3a9 9 0 100 18c1.1 0 1.5-.8 1.5-1.6 0-1-.8-1.4-.8-2.4 0-.9.7-1.5 1.6-1.5H17a4 4 0 004-4c0-4.7-4-8.5-9-8.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
};

function icon(name) {
  const node = h('span', { class: 'fx-ico', 'aria-hidden': 'true' });
  node.innerHTML = `<svg viewBox="0 0 24 24">${ICON_PATHS[name] ?? ''}</svg>`;
  return node;
}

// The view and, for one record, its id: /invoices/<id> is ['invoices', '<id>'].
function currentView() {
  const [name, id = null] = location.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (VIEWS[name] && (!VIEWS[name].ownerOnly || me?.person.role === 'owner')) return [name, id];
  return ['jobs', null];
}

async function route() {
  const main = $('main');
  unmountAllIn(main);
  const [view, id] = currentView();
  const path = id ? `/${view}/${id}` : `/${view}`;
  if (location.pathname !== path) history.replaceState(null, '', path);
  for (const link of document.querySelectorAll('[data-nav]')) {
    link.setAttribute('aria-current', link.dataset.nav === view ? 'page' : 'false');
  }
  main.replaceChildren();
  main.className = 'fx-main';
  document.title = `${VIEWS[view].label} · Flow`;
  await VIEWS[view].render(main, id);
  main.focus({ preventScroll: true });
}

// Opens a path in place; the address changes, the page stays.
function go(path, { replace = false } = {}) {
  if (path !== location.pathname) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  route();
}

// A link's click opens it in place (a new tab still works).
function navigate(event) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  go(event.currentTarget.getAttribute('href'));
}

// The shared pieces a view module (invoicing.js) builds with. Its `go`
// takes a path, or a link's click event.
const ui = () => ({
  h, flow, toast, notice, pageHeader, dialog, me,
  go: (target, options) => (typeof target === 'string' ? go(target, options) : navigate(target)),
});

function renderSignedOut() {
  document.body.dataset.state = 'signed-out';
  document.title = 'Sign in · Flow';
  const panel = $('sign-in');
  $('sign-in-note').textContent = config.publicSignUp
    ? 'Sign in, or ask for access with your work email.'
    : 'Sign in with the account you were invited with.';
  // With public sign-up off the widget never creates a Clerk account: no
  // sign-up link, and an OAuth sign-in for an unknown email is not turned
  // into a sign-up (transferable: false).
  mountClerk('signIn', panel, {
    forceRedirectUrl: '/sign-in',
    withSignUp: config.publicSignUp,
    transferable: config.publicSignUp,
  });
}

function renderShell() {
  document.body.dataset.state = 'signed-in';
  const nav = $('nav');
  const items = [];
  let group = null;
  for (const [name, view] of Object.entries(VIEWS)) {
    if (view.ownerOnly && me?.person.role !== 'owner') continue;
    if (view.group && view.group !== group) items.push(h('span', { class: 'fx-nav__group' }, view.group));
    group = view.group;
    items.push(h('a', { href: `/${name}`, 'data-nav': name, onclick: navigate }, icon(view.icon), h('span', {}, view.label)));
  }
  nav.replaceChildren(...items);
  mountClerk('userButton', $('user-button'), { afterSignOutUrl: '/sign-in', showName: false });
  // Errors and problem reports go to the installation's own Sentry, when the
  // Sentry integration is on (monitoring.js). Flow works the same without it.
  $('report-problem').replaceChildren(icon('flag'));
  startMonitoring({ flow, person: me.person, button: $('report-problem') })
    .catch((error) => console.warn(`[monitoring] ${error.message}`));
  window.addEventListener('popstate', route);
  return route();
}

function renderNoAccess(error) {
  document.body.dataset.state = 'no-access';
  const email = window.Clerk.user?.primaryEmailAddress?.emailAddress ?? '';
  const card = $('no-access');
  card.replaceChildren(...[
    h('h1', { class: 'fx-title' }, error.status === 403 ? 'Waiting for an owner' : 'Flow could not open'),
    h('p', {}, error.message),
    email ? h('p', { class: 'fx-dim' }, `Signed in as ${email}.`) : null,
    h('div', { class: 'fx-row' },
      h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', onclick: () => window.Clerk.signOut({ redirectUrl: '/sign-in' }) }, 'Sign out'),
      h('button', { class: 'fx-btn', type: 'button', onclick: () => location.reload() }, 'Try again')),
  ].filter(Boolean));
}

// People: an owner invites, approves, changes roles, turns access off and
// removes. Managing people needs a verified owner sign-in (/api/me says).
async function renderPeople(main) {
  const canManage = Boolean(me.ownerActions?.allowed);
  const invite = h('button', { class: 'fx-btn fx-btn--primary', type: 'button', disabled: !canManage, onclick: () => invitePerson() }, 'Invite someone');
  const tableHost = h('div', { class: 'fx-panel' }, h('div', { class: 'fx-skeleton' }));
  main.append(...[
    pageHeader('People', { subtitle: 'Who can sign in to Flow, and what each person can do.', actions: [invite] }),
    canManage ? null : notice('Managing people needs a verified owner sign-in: Google Workspace on the owner domain with no password, or a second factor.', 'warn', 'Read only.'),
    tableHost,
    h('dl', { class: 'fx-roles' }, ['owner', 'admin', 'staff'].flatMap((role) => [h('dt', {}, ROLE_LABEL[role]), h('dd', {}, ROLE_HINT[role])])),
  ].filter(Boolean));
  if (!canManage) {
    tableHost.replaceChildren(h('p', { class: 'fx-empty' }, 'The people list opens after a verified owner sign-in.'));
    return;
  }
  await refreshPeople(tableHost);
}

async function refreshPeople(host) {
  let people;
  try {
    ({ people } = await flow('/api/people'));
  } catch (error) {
    host.replaceChildren(notice(error.message, 'danger'));
    return;
  }
  const waiting = people.filter((p) => p.status === 'pending').length;
  const rows = people.map((person) => personRow(person, host));
  host.replaceChildren(...[
    waiting ? notice(`${waiting} ${waiting === 1 ? 'person is' : 'people are'} waiting for approval.`, 'info') : null,
    h('table', { class: 'fx-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Role'), h('th', {}, 'Access'), h('th', { class: 'fx-table__actions' }, h('span', { class: 'fx-sr' }, 'Actions')))),
      h('tbody', {}, rows)),
  ].filter(Boolean));
}

function personRow(person, host) {
  const self = person.id === me.person.id;
  const act = async (fn, done) => {
    try {
      await fn();
      if (done) toast(done, 'success');
    } catch (error) {
      toast(error.message, 'danger');
    }
    await refreshPeople(host);
  };
  const patch = (body) => flow(`/api/people/${person.id}`, { method: 'PATCH', body: JSON.stringify(body) });
  const who = h('div', { class: 'fx-person' },
    h('span', { class: 'fx-avatar', 'aria-hidden': 'true' }, initials(person)),
    h('span', { class: 'fx-person__text' },
      h('span', { class: 'fx-person__name' }, person.name || person.email, self ? h('span', { class: 'fx-tag' }, 'You') : null),
      person.name ? h('span', { class: 'fx-person__email' }, person.email) : null));
  const role = self
    ? h('span', {}, ROLE_LABEL[person.role])
    : roleSelect(person.role, {
      'aria-label': `Role for ${person.email}`,
      onchange: (event) => act(() => patch({ role: event.target.value }), `${person.email} is now ${ROLE_LABEL[event.target.value].toLowerCase()}.`),
    });
  const actions = [];
  if (!self) {
    if (person.status === 'pending') {
      actions.push(h('button', { class: 'fx-btn fx-btn--primary fx-btn--sm', type: 'button', onclick: () => act(() => patch({ status: 'active' }), `${person.email} can sign in.`) }, 'Approve'));
    } else if (person.status === 'active') {
      actions.push(h('button', { class: 'fx-btn fx-btn--sm', type: 'button', onclick: () => act(() => patch({ status: 'disabled' }), `${person.email} is turned off.`) }, 'Turn off'));
    } else {
      actions.push(h('button', { class: 'fx-btn fx-btn--sm', type: 'button', onclick: () => act(() => patch({ status: 'active' }), `${person.email} is turned on.`) }, 'Turn on'));
    }
    actions.push(h('button', {
      class: 'fx-btn fx-btn--ghost fx-btn--danger fx-btn--sm',
      type: 'button',
      onclick: async () => {
        const ok = await dialog({
          title: `Remove ${person.email}?`,
          body: h('p', {}, 'They can no longer sign in to Flow. Records they made stay.'),
          confirm: 'Remove',
          tone: 'danger',
        });
        if (ok) await act(() => flow(`/api/people/${person.id}`, { method: 'DELETE' }), `${person.email} is removed.`);
      },
    }, 'Remove'));
  }
  return h('tr', {},
    h('td', {}, who),
    h('td', {}, role),
    h('td', {}, statusPill(person)),
    h('td', { class: 'fx-table__actions' }, h('div', { class: 'fx-row fx-row--end' }, actions)));
}

// Integrations: a classic catalogue. Each system is a card with its logo;
// the card opens a side panel where an owner turns it on and enters its
// settings. Credentials are write-only: the server says whether each is set,
// never its value (server/integrations/setup.js).
const STATE_LABEL = { ready: 'Connected', disabled: 'Not set up', failed: 'Needs attention', restart_needed: 'Restart needed', not_started: 'Starting' };
const STATE_TONE = { ready: 'success', disabled: 'mute', failed: 'danger', restart_needed: 'warn', not_started: 'info' };

// What the catalogue shows for each adapter: its group, one line on what it
// does, and its logo (server/ui/logos/, each maker's own mark).
const CATALOGUE = {
  xero: { maker: 'Xero', category: 'accounting', blurb: 'Send invoices to Xero as drafts and bring payments back.', logo: 'xero.svg' },
  seazona: { maker: 'Seazona', category: 'lab', blurb: 'Bring lab cases and orders into Flow as jobs.', logo: 'seazona.svg' },
  sentry: { maker: 'Sentry', category: 'monitoring', blurb: 'Send errors and problem reports to your own Sentry project.', logo: 'sentry.svg' },
};
const CATEGORIES = [['all', 'All'], ['accounting', 'Accounting'], ['lab', 'Lab software'], ['monitoring', 'Monitoring']];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);

function integrationLogo(integration, size = '') {
  const file = CATALOGUE[integration.id]?.logo;
  return h('span', { class: `fx-logo${size ? ` fx-logo--${size}` : ''}`, 'aria-hidden': 'true' },
    file ? h('img', { src: `/assets/ui/logos/${file}`, alt: '' }) : icon('plug'));
}

async function renderIntegrations(main) {
  const state = { tab: 'all', category: 'all', q: '' };
  const tabs = h('div', { class: 'fx-seg', role: 'tablist' });
  const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Search integrations', 'aria-label': 'Search integrations' });
  const category = h('select', { class: 'fx-select', 'aria-label': 'Category' },
    CATEGORIES.map(([id, label]) => h('option', { value: id }, id === 'all' ? 'All categories' : label)));
  const notices = h('div', { class: 'fx-fields' });
  const content = h('div', { class: 'fx-int-sections' }, h('div', { class: 'fx-skeleton' }));
  main.append(
    h('header', { class: 'fx-ph' }, h('div', { class: 'fx-ph__text' }, h('h1', { class: 'fx-title' }, 'Integrations'))),
    h('div', { class: 'fx-int-bar' }, tabs, search),
    notices, content);
  let body;
  try {
    body = await flow('/api/integrations');
  } catch (error) {
    content.replaceChildren(notice(error.message, 'danger'));
    return;
  }
  const canChange = Boolean(me.ownerActions?.allowed);
  notices.replaceChildren(...[
    canChange ? null : notice('Changing integrations needs a verified owner sign-in: Google Workspace on the owner domain with no password, or a second factor.', 'warn', 'Read only.'),
    body.secretsKey ? null : notice('Flow has no secrets key, so it cannot store a client secret. Ask whoever hosts Flow to set FLOW_SECRETS_KEY (64 hex characters), then restart Flow.', 'warn', 'No secrets key.'),
  ].filter(Boolean));
  const list = [...body.integrations].sort((a, b) => a.name.localeCompare(b.name));
  const connected = (i) => i.enabled;

  const draw = () => {
    tabs.replaceChildren(...[['all', 'All integrations'], ['yours', 'Your integrations']].map(([id, label]) => h('button', {
      type: 'button', role: 'tab', class: 'fx-seg__item', 'aria-selected': String(state.tab === id), 'aria-checked': String(state.tab === id),
      onclick: () => { state.tab = id; draw(); },
    }, label)));
    const q = state.q.toLowerCase();
    const matches = (i) => !q || `${i.name} ${CATALOGUE[i.id]?.blurb ?? ''}`.toLowerCase().includes(q);
    const sections = [];
    if (state.tab === 'yours') {
      const yours = list.filter(connected).filter(matches);
      sections.push(h('section', { class: 'fx-int-section-list' },
        yours.length ? h('div', { class: 'fx-int-grid' }, yours.map(integrationTile))
          : h('p', { class: 'fx-empty' }, q ? 'No integration matches.' : 'Nothing is connected yet. Pick one under All integrations.')));
    } else {
      // Recommended: what is not connected yet, once the catalogue is long
      // enough that a short row helps (with a few, it would repeat the grid).
      const recommended = q || list.length < 4 ? [] : list.filter((i) => !connected(i)).slice(0, 3);
      if (recommended.length) {
        sections.push(h('section', { class: 'fx-int-section-list' },
          h('h2', { class: 'fx-int-heading' }, 'Recommended for you'),
          h('div', { class: 'fx-int-grid' }, recommended.map(integrationTile))));
      }
      const all = list.filter(matches).filter((i) => state.category === 'all' || CATALOGUE[i.id]?.category === state.category);
      sections.push(h('section', { class: 'fx-int-section-list' },
        h('div', { class: 'fx-int-heading-row' }, h('h2', { class: 'fx-int-heading' }, 'All integrations'), category),
        all.length ? h('div', { class: 'fx-int-grid' }, all.map(integrationTile)) : h('p', { class: 'fx-empty' }, 'No integration matches.')));
    }
    content.replaceChildren(...sections);
  };
  search.addEventListener('input', () => { state.q = search.value.trim(); draw(); });
  category.addEventListener('change', () => { state.category = category.value; draw(); });
  draw();
}

function integrationTile(integration) {
  const href = `/integrations/${integration.id}`;
  const entry = CATALOGUE[integration.id];
  const on = integration.enabled;
  const attention = ['failed', 'restart_needed'].includes(integration.state);
  return h('a', { class: 'fx-int-card', href, onclick: navigate },
    h('header', { class: 'fx-int-card__head' },
      integrationLogo(integration),
      h('h3', {}, integration.name),
      on ? h('span', { class: 'fx-status', 'data-tone': STATE_TONE[integration.state] ?? 'mute' }, STATE_LABEL[integration.state] ?? integration.state) : null),
    h('p', { class: 'fx-int-card__blurb' }, entry?.blurb ?? ''),
    h('span', { class: 'fx-int-card__btn' }, attention ? 'Fix' : on ? 'Manage' : '+ Connect'));
}

// One integration's page (/integrations/<id>): its logo and maker, Connect
// with each step shown as it happens, the setup steps, its settings, and the
// facts beside them.
async function renderIntegration(main, id) {
  const host = h('div', { class: 'fx-int-page' }, h('div', { class: 'fx-skeleton' }));
  main.append(host);
  let body;
  try {
    body = await flow('/api/integrations');
  } catch (error) {
    host.replaceChildren(notice(error.message, 'danger'));
    return;
  }
  const found = body.integrations.find((i) => i.id === id);
  if (!found) {
    host.replaceChildren(notice('No integration by that name.', 'danger'));
    return;
  }
  const canChange = Boolean(me.ownerActions?.allowed);

  const draw = (current, progress = null) => {
    const inputs = new Map();
    const rows = [];
    for (const field of current.fields) {
      if (field.source === 'host') {
        // The host sets it: a value to read, not a box to type in.
        rows.push(settingRow({
          label: field.label,
          hint: 'Set by whoever hosts Flow.',
          control: field.secret ? h('span', { class: 'fx-dim' }, 'Set') : h('code', { class: 'fx-setting__value' }, field.value),
        }));
        continue;
      }
      const disabled = !canChange;
      let input;
      if (field.kind === 'choice' || field.kind === 'onoff') {
        const choices = field.kind === 'onoff' ? [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] : field.choices;
        input = h('select', { class: 'fx-select', disabled },
          field.kind === 'choice' ? h('option', { value: '' }, 'Choose…') : null,
          choices.map((c) => h('option', { value: c.value, selected: (field.value ?? (field.kind === 'onoff' ? 'off' : '')) === c.value }, c.label)));
      } else if (field.secret) {
        input = h('input', { class: 'fx-input', type: 'password', autocomplete: 'off', disabled, placeholder: field.set ? 'Saved' : 'Paste it here' });
      } else {
        input = h('input', { class: 'fx-input', type: field.kind === 'url' ? 'url' : 'text', autocomplete: 'off', disabled, value: field.value ?? '' });
      }
      inputs.set(field.name, { field, input });
      const suggestion = field.suggest === 'callback' ? `${location.origin}/api/${current.id}/oauth/callback` : null;
      rows.push(settingRow({
        label: field.label,
        hint: field.unreadable ? 'Stored with another key. Enter it again.' : field.help,
        control: suggestion && !disabled
          ? h('div', { class: 'fx-setting__stack' }, input,
            h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', title: suggestion, onclick: () => { input.value = suggestion; navigator.clipboard?.writeText(suggestion); toast('Address filled in and copied.', 'success'); } }, 'Use this installation\'s address'))
          : input,
      }));
    }

    const values = () => {
      const out = {};
      for (const [name, { field, input }] of inputs) {
        const value = input.value.trim();
        if (field.secret) { if (value) out[name] = value; continue; }
        if (value !== (field.value ?? (field.kind === 'onoff' ? 'off' : ''))) out[name] = value || null;
      }
      return out;
    };
    const put = (enabled) => flow(`/api/integrations/${current.id}`, { method: 'PUT', body: JSON.stringify({ values: values(), ...(enabled === undefined ? {} : { enabled }) }) });

    // Connect: each step is shown as it runs, then ticked or crossed.
    const connect = async () => {
      const steps = [
        { label: 'Saving settings', state: 'running' },
        { label: `Starting ${current.name}`, state: 'waiting' },
      ];
      const started = Date.now();
      const show = () => draw(current, { steps, started });
      show();
      let next;
      try {
        next = (await put(true)).integration;
      } catch (error) {
        steps[0] = { label: error.message, state: 'failed' };
        show();
        return;
      }
      steps[0].state = 'done';
      steps[1].state = next.state === 'ready' ? 'done' : 'failed';
      if (next.state !== 'ready') steps[1].label = next.error ? `${current.name} could not start: ${next.error}` : `${current.name}: ${STATE_LABEL[next.state] ?? next.state}`;
      if (next.state === 'ready') steps.push({ label: `${current.name} is connected`, state: 'done' });
      current = next;
      show();
      setTimeout(() => { if (steps.every((step) => step.state === 'done')) draw(current); }, 2400);
    };
    const save = async (enabled) => {
      try {
        const next = (await put(enabled)).integration;
        toast(enabled === false ? `${next.name} is disconnected.` : `${next.name} settings saved.`, 'success');
        current = next;
        draw(current);
      } catch (error) {
        toast(error.message, 'danger');
      }
    };

    const on = current.enabled;
    const guide = current.guide;
    const hostOwned = current.enabledBy === 'host';
    const entry = CATALOGUE[current.id];
    const mode = current.fields.find((f) => /_MODE$/.test(f.name));
    const modeLabel = mode?.choices?.find((c) => c.value === mode.value)?.label ?? mode?.value;
    const busy = progress && progress.steps.some((step) => step.state === 'running');

    const primary = !canChange || hostOwned ? null : on
      ? h('button', { class: 'fx-btn', type: 'button', onclick: () => save(false) }, 'Disconnect')
      : h('button', { class: 'fx-btn fx-btn--primary', type: 'button', disabled: busy, onclick: connect },
        busy ? h('span', { class: 'fx-spinner fx-spinner--sm', 'aria-hidden': 'true' }) : null, busy ? 'Connecting' : 'Connect');

    host.replaceChildren(
      h('nav', { class: 'fx-crumbs', 'aria-label': 'Breadcrumb' },
        h('a', { href: '/integrations', onclick: navigate }, 'Integrations'), h('span', { 'aria-hidden': 'true' }, '›'), h('span', {}, current.name)),
      h('header', { class: 'fx-int-hero' },
        integrationLogo(current, 'xl'),
        h('div', { class: 'fx-int-hero__text' },
          h('h1', { class: 'fx-title' }, current.name),
          h('p', { class: 'fx-int-hero__maker' }, entry?.maker ?? current.name, h('span', { class: 'fx-dim' }, CATEGORY_LABEL[entry?.category] ?? 'Integration')),
          h('p', { class: 'fx-int-hero__blurb' }, entry?.blurb ?? ''),
          h('div', { class: 'fx-int-hero__actions' },
            primary,
            on ? h('span', { class: 'fx-status', 'data-tone': STATE_TONE[current.state] ?? 'mute' }, STATE_LABEL[current.state] ?? current.state) : null,
            progress ? connectProgress(progress) : null))),
      h('div', { class: 'fx-int-page__grid' },
        h('div', { class: 'fx-int-page__main' }, ...[
          !canChange ? notice('Changing integrations needs a verified owner sign-in: Google Workspace on the owner domain with no password, or a second factor.', 'warn', 'Read only.') : null,
          !body.secretsKey ? notice('Flow has no secrets key, so it cannot store a client secret. Ask whoever hosts Flow to set FLOW_SECRETS_KEY (64 hex characters), then restart Flow.', 'warn', 'No secrets key.') : null,
          current.state === 'failed' && current.error ? notice(current.error, 'danger', 'It could not start.') : null,
          current.id === 'xero' && current.state === 'ready' ? h('section', { class: 'fx-int-section' }, xeroConnection(body.organisations, canChange)) : null,
          guide ? h('section', { class: 'fx-int-section' },
            h('h2', { class: 'fx-int-section__title' }, 'Set up'),
            h('ol', { class: 'fx-steps' }, guide.steps.map((step) => h('li', {}, step))),
            guide.link ? h('a', { class: 'fx-btn fx-btn--sm', href: guide.link, target: '_blank', rel: 'noopener' }, `Open ${current.name} developer site ↗`) : null) : null,
          rows.length ? h('section', { class: 'fx-int-section' },
            h('h2', { class: 'fx-int-section__title' }, 'Settings'),
            h('div', { class: 'fx-settings' }, rows),
            canChange && on && inputs.size ? h('div', { class: 'fx-row fx-row--end' }, h('button', { class: 'fx-btn', type: 'button', onclick: () => save(undefined) }, 'Save changes')) : null) : null,
        ].filter(Boolean)),
        h('aside', { class: 'fx-int-page__meta' },
          h('dl', { class: 'fx-meta' }, ...[
            ['Status', h('span', { class: 'fx-status', 'data-tone': STATE_TONE[current.state] ?? 'mute' }, STATE_LABEL[current.state] ?? current.state)],
            ['Category', h('span', { class: 'fx-chip fx-chip--static' }, CATEGORY_LABEL[entry?.category] ?? 'Integration')],
            modeLabel ? ['Mode', modeLabel] : null,
            ['Turned on by', current.enabledBy === 'host' ? 'The host' : current.enabledBy === 'flow' ? 'An owner, here' : '—'],
            current.updatedAt ? ['Last changed', new Date(current.updatedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })] : null,
            guide?.link ? ['Documentation', h('a', { href: guide.link, target: '_blank', rel: 'noopener' }, 'Developer site ↗')] : null,
          ].filter(Boolean).map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value)))))));
  };
  document.title = `${found.name} · Flow`;
  draw(found);
}

// One setting, laid out the same on every settings screen: a short name, one
// line of smaller text under it, and the control on the right. Longer help
// lives behind a link, not here. A wide control (a grid of choices) sits on
// its own line under the name.
function settingRow({ label, hint, control, wide = false }) {
  const target = control?.matches?.('input, select, textarea') ? control : control?.querySelector?.('input:not([type=color]), select, textarea');
  const id = target ? (target.id ||= `fx-set-${++settingRow.next}`) : null;
  return h('div', { class: `fx-setting${wide ? ' fx-setting--wide' : ''}` },
    h('div', { class: 'fx-setting__text' },
      id ? h('label', { class: 'fx-setting__name', for: id }, label) : h('span', { class: 'fx-setting__name' }, label),
      hint ? h('p', { class: 'fx-setting__hint' }, hint) : null),
    h('div', { class: 'fx-setting__control' }, control));
}
settingRow.next = 0;

// The steps of a Connect, each ticked, running or crossed, with the time taken.
function connectProgress({ steps, started }) {
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  return h('div', { class: 'fx-progress', role: 'status' },
    h('div', { class: 'fx-progress__head' }, h('span', { class: 'fx-strong' }, 'Connecting'), h('span', { class: 'fx-dim' }, `${seconds}s`)),
    h('ol', {}, steps.map((step) => h('li', { 'data-state': step.state },
      h('span', { class: 'fx-progress__mark', 'aria-hidden': 'true' }, step.state === 'done' ? '✓' : step.state === 'failed' ? '!' : ''),
      step.label))));
}

// Once Xero is on: each organisation's connection, the history copy, and
// Connect, which goes to Xero and comes back.
function xeroConnection(organisations, canChange) {
  const host = h('div', { class: 'fx-settings' });
  for (const organisation of organisations) {
    const row = settingRow({ label: organisation.name, hint: 'Checking…' });
    host.append(row);
    (async () => {
      let hint;
      let control = null;
      try {
        const status = await flow(`/api/xero/status?organisationId=${organisation.id}`);
        if (status.connected) {
          const mirror = await flow(`/api/xero/mirror?organisationId=${organisation.id}`).catch(() => null);
          hint = `Connected to ${status.connection?.tenantName ?? 'Xero'}.${mirror ? ` ${mirror.counts.invoices} invoices copied.` : ''}`;
        } else {
          hint = 'Not connected.';
        }
        if (canChange) {
          control = h('button', { class: `fx-btn fx-btn--sm${status.connected ? '' : ' fx-btn--primary'}`, type: 'button', onclick: async () => {
            try {
              const { authorizeUrl } = await flow('/api/xero/connect', { method: 'POST', body: JSON.stringify({ organisationId: organisation.id }) });
              location.assign(authorizeUrl);
            } catch (error) {
              toast(error.message, 'danger');
            }
          } }, status.connected ? 'Connect again' : 'Connect to Xero');
        }
      } catch (error) {
        hint = error.message;
      }
      row.replaceWith(settingRow({ label: organisation.name, hint, control }));
    })();
  }
  return h('div', {}, h('h2', { class: 'fx-int-section__title' }, 'Xero organisation'), host);
}

async function invitePerson() {
  const data = await dialog({
    title: 'Invite someone',
    body: h('div', { class: 'fx-fields' },
      h('label', { class: 'fx-field' },
        h('span', { class: 'fx-label' }, 'Email'),
        h('input', { class: 'fx-input', name: 'email', type: 'email', required: true, autocomplete: 'off', placeholder: 'name@example.com' })),
      h('label', { class: 'fx-field' },
        h('span', { class: 'fx-label' }, 'Role'),
        roleSelect('staff', { name: 'role' })),
      h('p', { class: 'fx-dim' }, 'They sign in with this email. Flow prepares their sign-in account.')),
    confirm: 'Send invitation',
  });
  if (!data) return;
  try {
    await flow('/api/people', { method: 'POST', body: JSON.stringify({ email: data.get('email'), role: data.get('role') }) });
    toast(`${data.get('email')} is invited.`, 'success');
  } catch (error) {
    toast(error.message, 'danger');
  }
  await route();
}

// Account: Clerk's own profile (name, email addresses, connected accounts,
// security), with the person's Flow role above it.
function renderAccount(main) {
  const host = h('div', { class: 'fx-clerk-profile' });
  main.append(
    pageHeader('Account', { subtitle: `${me.person.email} · ${ROLE_LABEL[me.person.role]}. ${ROLE_HINT[me.person.role]}` }),
    host);
  // Clerk keeps its own pages (profile, security) in memory, so the URL
  // stays Flow's.
  mountClerk('profile', host, { routing: 'virtual' });
}

// Appearance: light or dark, the design system and an accent colour. Each
// person's choice is saved with their account (PUT /api/me/appearance) and
// applied when they sign in; the browser keeps a copy so the next page paints
// in it at once.
function renderAppearance(main) {
  main.append(
    pageHeader('Appearance', { subtitle: 'Saved with your account, on every device.' }),
    h('div', { class: 'fx-appearance', id: 'appearance' }));
  drawAppearance();
}

function radioGroup(label, items, selectedIndex, onSelect, render) {
  const group = h('div', { role: 'radiogroup', 'aria-label': label });
  const buttons = items.map((item, index) => {
    const button = render(item, index);
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(index === selectedIndex));
    button.tabIndex = index === selectedIndex || (selectedIndex < 0 && index === 0) ? 0 : -1;
    button.addEventListener('click', () => onSelect(item));
    button.addEventListener('keydown', (event) => {
      const last = items.length - 1;
      const next = { ArrowRight: index === last ? 0 : index + 1, ArrowDown: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, ArrowUp: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      onSelect(items[next]);
      document.querySelector(`[aria-label="${label}"] > [role="radio"]:nth-child(${next + 1})`)?.focus();
    });
    return button;
  });
  group.append(...buttons);
  return group;
}

function drawAppearance() {
  const host = $('appearance');
  if (!host) return;
  const { colorMode, family, accent, mode } = getAppearance();
  // Each card is set in its own family's faces.
  THEME_FAMILIES.forEach((f) => loadFonts(f.id));

  const modes = [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'Auto' }];
  const modeGroup = radioGroup('Mode', modes, modes.findIndex((m) => m.value === colorMode),
    (m) => chooseAppearance({ colorMode: m.value }),
    (m) => h('button', { type: 'button', class: 'fx-seg__item' }, m.label));
  modeGroup.classList.add('fx-seg');

  const familyIndex = THEME_FAMILIES.findIndex((f) => f.id === family);
  const families = radioGroup('Design system', THEME_FAMILIES, familyIndex,
    (f) => chooseAppearance({ family: f.id }),
    (f) => {
      // The card shows the family as it is, not the active theme.
      const t = tokensFor(f.id, mode);
      const s = f.swatches[mode];
      return h('button', { type: 'button', class: 'fx-theme-card', 'data-theme-card': f.id },
        h('span', { class: 'fx-theme-card__preview', 'aria-hidden': 'true', style: { background: s.bg, color: s.text, borderRadius: t['--t-radius-lg'], fontFamily: t['--t-body'], borderColor: t['--t-brd'] } },
          h('span', { class: 'fx-theme-card__bar', style: { background: s.surface } }),
          h('span', { class: 'fx-theme-card__type', style: { fontFamily: t['--t-display'], fontWeight: t['--t-display-weight'] } }, 'Aa'),
          h('span', { class: 'fx-theme-card__chips' },
            h('span', { style: { background: s.primary, borderRadius: t['--t-radius'] } }),
            h('span', { style: { background: s.accent, borderRadius: t['--t-radius'] } }))),
        h('span', { class: 'fx-theme-card__name' }, f.label),
        h('span', { class: 'fx-theme-card__desc' }, f.description));
    });
  families.classList.add('fx-theme-grid');

  const active = THEME_FAMILIES[Math.max(familyIndex, 0)];
  const presetIndex = accent ? ACCENT_PRESETS.findIndex((p) => p.id === accent) : 0;
  const customHex = accent && presetIndex < 0 ? normalizeAccent(accent) : null;
  const accents = radioGroup('Accent colour', ACCENT_PRESETS, presetIndex,
    (p) => chooseAppearance({ accent: p.hex ? p.id : null }),
    (p) => p.hex
      ? h('button', { type: 'button', class: 'fx-swatch', title: p.label, 'aria-label': p.label, style: { background: p.hex } })
      : h('button', { type: 'button', class: 'fx-swatch fx-swatch--default', title: `${active.label}'s own`, 'aria-label': `${active.label}'s own accent` },
        h('span', { 'aria-hidden': 'true', style: { background: `linear-gradient(135deg, ${active.swatches[mode].primary} 50%, ${active.swatches[mode].accent} 50%)` } })));
  accents.classList.add('fx-swatches');
  const custom = h('label', { class: 'fx-swatch-custom' },
    h('input', { type: 'color', 'aria-label': 'Custom accent colour', value: customHex ?? '#0d4e5f', onchange: (event) => chooseAppearance({ accent: event.target.value }) }),
    'Custom');
  const accentLabel = customHex ? `Custom ${customHex}` : presetIndex > 0 ? ACCENT_PRESETS[presetIndex].label : `${active.label}'s own`;

  host.replaceChildren(h('div', { class: 'fx-settings' },
    settingRow({ label: 'Mode', hint: 'Auto follows this device.', control: modeGroup }),
    settingRow({ label: 'Accent colour', hint: `Using ${accentLabel}.`, control: h('div', { class: 'fx-row' }, accents, custom) }),
    settingRow({ label: 'Design system', hint: 'Colours, type and corners.', control: families, wide: true })));
}

// A person's own change: show it, then save it to their account once they
// are signed in. Signed out (the sign-in screen's switch) it stays in this
// browser.
let savingAppearance = null;
function chooseAppearance(update) {
  setAppearance(update);
  saveAccountAppearance();
}

function accountAppearance() {
  const { colorMode, family, accent } = getAppearance();
  return { colorMode, themeFamily: family, ...(accent ? { accent } : {}) };
}

function saveAccountAppearance() {
  if (!me) return;
  clearTimeout(savingAppearance);
  savingAppearance = setTimeout(() => {
    flow('/api/me/appearance', { method: 'PUT', body: JSON.stringify(accountAppearance()) })
      .catch(() => toast('Flow could not save your appearance to your account. It stays in this browser for now.', 'danger'));
  }, 300);
}

// On sign-in: the account's appearance wins. An account with none yet takes
// this browser's current choice.
function adoptAccountAppearance(saved) {
  if (!saved) return saveAccountAppearance();
  setAppearance({ colorMode: saved.colorMode, family: saved.themeFamily, accent: saved.accent ?? null });
}

onAppearanceChange(() => {
  const focused = document.activeElement?.closest?.('[role="radiogroup"]')?.getAttribute('aria-label');
  drawAppearance();
  if (focused) document.querySelector(`[aria-label="${focused}"] [aria-checked="true"]`)?.focus();
});

// The quick light or dark switch on the sign-in screen and in the top bar.
const SUN = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

function drawModeToggles() {
  const dark = getAppearance().mode === 'dark';
  for (const button of document.querySelectorAll('[data-mode-toggle]')) {
    const label = dark ? 'Use light mode' : 'Use dark mode';
    button.innerHTML = dark ? SUN : MOON;
    if (!button.classList.contains('fx-btn--icon')) button.append(` ${dark ? 'Light' : 'Dark'}`);
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

for (const button of document.querySelectorAll('[data-mode-toggle]')) {
  button.addEventListener('click', () => chooseAppearance({ colorMode: getAppearance().mode === 'dark' ? 'light' : 'dark' }));
}
onAppearanceChange(drawModeToggles);
drawModeToggles();

// ── Start ──────────────────────────────────────────────────────────────────

// Clerk's words where they name the app: the installation is Flow, whatever
// the Clerk instance is called.
const LOCALIZATION = {
  signIn: {
    start: { title: 'Sign in to Flow', subtitle: 'Welcome back. Choose how to sign in.' },
    password: { subtitle: 'Enter the password for your account.' },
  },
  signUp: { start: { title: 'Ask for access to Flow', subtitle: 'Use your work email. An owner approves new people.' } },
};

async function start() {
  config = await fetch('/api/auth/config').then((res) => res.json()).catch(() => null);
  if (!config || config.mode !== 'clerk') {
    document.body.dataset.state = 'off';
    return;
  }
  try {
    await loadClerk(config.clerk);
    await window.Clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      appearance: flowClerkAppearance({ publicSignUp: config.publicSignUp }),
      localization: LOCALIZATION,
    });
  } catch {
    document.body.dataset.state = 'error';
    return;
  }
  const Clerk = window.Clerk;
  // Signing in on this page reloads it into the app. Clerk calls a new
  // listener at once with the current user, so compare with the state the
  // page opened in.
  const openedSignedIn = Boolean(Clerk.user);
  Clerk.addListener(({ user }) => {
    if (user && !openedSignedIn) location.reload();
  });
  if (!openedSignedIn) {
    renderSignedOut();
    return;
  }
  try {
    me = await flow('/api/me');
    adoptAccountAppearance(me.appearance);
  } catch (error) {
    renderNoAccess(error);
    return;
  }
  await renderShell();
}

start();
