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
import { renderContacts } from '/assets/ui/contacts.js';
import { automationSection, renderAutomations } from '/assets/ui/automations.js';
import { renderInvoicingSettings, sendModeSection } from '/assets/ui/invoicing-settings.js';
import { renderPriceList } from '/assets/ui/price-list.js';
import { renderPriceReconcile } from '/assets/ui/price-reconcile.js';
import { renderCustomFields } from '/assets/ui/custom-fields.js';
import { renderPortalSettings } from '/assets/ui/portal-settings.js';
import { renderJobs } from '/assets/ui/jobs.js';
import { renderReconcile } from '/assets/ui/reconcile.js';
import { renderXeroImport } from '/assets/ui/xero-import.js';
import { xeroUsage } from '/assets/ui/xero-usage.js';
import { startMonitoring } from '/assets/ui/monitoring.js';
import { isSearchKey, openSearch } from '/assets/ui/search.js';
import { alertStrip } from '/assets/ui/alerts.js';
import { initialsOf, personLabel } from '/assets/ui/person.js';
import { startTips } from '/assets/ui/tip.js';
import { crumbs, dialog, edgeFade, fieldError, h, holdButton, linksOpenWith, listFrame, listHead, notice, pageHeader, pickOne, rowMenu, sectionTitle, settingRow, tileCard, tileSection, toast } from '/assets/ui/kit.js';
import { NAV_DEFAULT, NAV_LOCKED } from '/assets/ui/nav-pins.js';

const $ = (id) => document.getElementById(id);

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
  else if (kind === 'signUp') Clerk.mountSignUp(element, props);
  else if (kind === 'userButton') Clerk.mountUserButton(element, props);
  else if (kind === 'profile') Clerk.mountUserProfile(element, props);
  mounted.set(element, { kind, options });
}

function unmountClerk(element) {
  const entry = mounted.get(element);
  if (!entry) return;
  const Clerk = window.Clerk;
  if (entry.kind === 'signIn') Clerk.unmountSignIn(element);
  else if (entry.kind === 'signUp') Clerk.unmountSignUp(element);
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
  // A button that calls Xero or Seazona waits between presses (the action
  // guard): a press too soon says how long (retryAfterMs), and a good run
  // says its own wait (Flow-Cooldown-Ms). holdButton shows the wait.
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, code: body.code, details: body.details, retryAfterMs: body.retryAfterMs });
  const cooldownMs = Number(res.headers.get('Flow-Cooldown-Ms'));
  if (cooldownMs > 0 && body && typeof body === 'object') body.cooldownMs = cooldownMs;
  return body;
}

// ── Shared pieces ──────────────────────────────────────────────────────────

function statusPill(person) {
  if (person.status === 'pending') return h('span', { class: 'fx-status', 'data-tone': 'warn' }, 'Waiting for approval');
  if (person.status === 'disabled') return h('span', { class: 'fx-status', 'data-tone': 'mute' }, 'Turned off');
  if (person.invited) return h('span', { class: 'fx-status', 'data-tone': 'info' }, 'Invited');
  // Active is the usual state, so it shows nothing.
  return null;
}

function roleSelect(value, attrs = {}) {
  return h('select', { class: 'fx-select', ...attrs },
    ['owner', 'admin', 'staff'].map((role) => h('option', { value: role, selected: role === value, title: ROLE_HINT[role] }, ROLE_LABEL[role])));
}

// ── Views ──────────────────────────────────────────────────────────────────

let me = null;

// Where each view sits, in sidebar order, daily work first. No `place`: a
// sidebar page, pinned until the person unpins it. `place: 'more'`: a sidebar
// page that starts in More until they pin it. `place: 'account'`: the account
// menu. `sidebar: false`: opened by a link or Search only. Jobs and Invoices
// cannot be unpinned (nav-pins.js).
const VIEWS = {
  jobs: { label: 'Jobs', icon: 'jobs', render: (main) => renderJobs(main, ui()) },
  invoices: { label: 'Invoices', icon: 'invoices', render: (main, id) => (id ? renderInvoice(main, ui(), id) : renderInvoiceList(main, ui())) },
  contacts: { label: 'Contacts', icon: 'contacts', render: (main, id) => renderContacts(main, ui(), id) },
  reconcile: { label: 'Reconcile', icon: 'reconcile', render: (main, id) => renderReconcile(main, ui(), id) },
  'price-list': { label: 'Price list', icon: 'tag', render: (main, id) => (id === 'reconcile' ? renderPriceReconcile(main, ui()) : renderPriceList(main, ui())) },
  'invoicing-settings': { label: 'Rules', icon: 'rules', render: (main, id) => renderInvoicingSettings(main, ui(), id) },
  automations: { label: 'Automations', icon: 'bolt', place: 'more', render: (main) => renderAutomations(main, ui()) },
  'custom-fields': { label: 'Custom fields', icon: 'fields', place: 'more', render: (main) => renderCustomFields(main, ui()) },
  'portal-settings': { label: 'Portal', icon: 'portal', place: 'more', managerOnly: true, render: (main) => renderPortalSettings(main, ui()) },
  integrations: { label: 'Integrations', icon: 'plug', place: 'more', ownerOnly: true, render: (main, id) => (id ? renderIntegration(main, id) : renderIntegrations(main)) },
  people: { label: 'People', icon: 'people', place: 'account', ownerOnly: true, render: renderPeople },
  // Not in the sidebar: "Manage account" in the account menu opens the same
  // Clerk profile. The page stays for links and Search.
  // Opened from the Xero integration page: Xero invoices against Flow's own.
  'xero-import': { label: 'Xero import', icon: 'plug', sidebar: false, render: (main) => renderXeroImport(main, ui()) },
  account: { label: 'Account', icon: 'person', sidebar: false, render: renderAccount },
  appearance: { label: 'Appearance', icon: 'palette', place: 'account', render: renderAppearance },
};

// Line icons for the sidebar, drawn on a 24-unit grid in the text colour.
const ICON_PATHS = {
  jobs: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="14" rx="1"/>',
  invoices: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  contacts: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M6 16c.4-1.6 1.5-2.4 3-2.4s2.6.8 3 2.4M14 9h5M14 13h4"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  rules: '<path d="M3 6l2 2 4-4M3 16l2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
  reconcile: '<path d="M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 5a3 3 0 010 6M21 20c0-3-1.6-5-4-5.7"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  fields: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="13" width="18" height="5" rx="1.5"/><path d="M7 6.5h4M7 15.5h7"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  palette: '<path d="M12 3a9 9 0 100 18c1.1 0 1.5-.8 1.5-1.6 0-1-.8-1.4-.8-2.4 0-.9.7-1.5 1.6-1.5H17a4 4 0 004-4c0-4.7-4-8.5-9-8.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
  portal: '<path d="M4 21V5a2 2 0 012-2h8a2 2 0 012 2v16"/><path d="M8 21v-5h4v5"/><circle cx="14" cy="11" r="1"/>',
};

function icon(name) {
  const node = h('span', { class: 'fx-ico', 'aria-hidden': 'true' });
  node.innerHTML = `<svg viewBox="0 0 24 24">${ICON_PATHS[name] ?? ''}</svg>`;
  return node;
}

// The sidebar button at the top of the sidebar (a panel icon, not a
// hamburger; folded or narrow, the logo stands in for it). On a wide screen it folds the sidebar to its icons and back,
// and the choice stays in this browser. On a narrow screen the sidebar is a
// bar across the top, and the button slides the menu in from the left as a
// drawer over a dimmed page; choosing a page, Escape or a click on the page
// closes it.
const NARROW = window.matchMedia('(max-width: 820px)');
const FOLDED_KEY = 'flow_sidebar_folded';

function readFolded() {
  try { return localStorage.getItem(FOLDED_KEY) === '1'; } catch { return false; }
}

function drawMenu() {
  const shell = $('shell');
  const folded = readFolded();
  shell.toggleAttribute('data-folded', folded);
  const open = NARROW.matches ? shell.hasAttribute('data-menu-open') : !folded;
  const toggle = $('menu-toggle');
  const label = NARROW.matches ? (open ? 'Close the menu' : 'Open the menu') : (folded ? 'Show the sidebar' : 'Hide the sidebar');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', label);
  toggle.dataset.tip = label;
  // Folded, a page's name shows when the pointer rests on its icon.
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (folded && !NARROW.matches) Object.assign(link.dataset, { tip: link.dataset.label, tipSide: 'right' });
    else { delete link.dataset.tip; delete link.dataset.tipSide; }
  }
}

function closeMenu() {
  if (!$('shell').hasAttribute('data-menu-open')) return;
  $('shell').removeAttribute('data-menu-open');
  drawMenu();
}

function toggleMenu() {
  if (NARROW.matches) {
    $('shell').toggleAttribute('data-menu-open');
  } else {
    try { localStorage.setItem(FOLDED_KEY, readFolded() ? '0' : '1'); } catch { /* the choice is only a convenience */ }
  }
  drawMenu();
}

NARROW.addEventListener('change', () => { $('shell').removeAttribute('data-menu-open'); drawMenu(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('shell')?.hasAttribute('data-menu-open')) {
    closeMenu();
    $('menu-toggle').focus();
  }
});
document.addEventListener('click', (event) => {
  if (!event.target.closest?.('.fx-side') || event.target.closest?.('[data-nav]:not([data-nav="more"])')) closeMenu();
});
// Folded, a click on the sidebar's empty space opens it out again, as in
// Claude. A click on a page, the account photo or Search still does its job.
document.addEventListener('click', (event) => {
  if (NARROW.matches || !readFolded() || !event.target.closest?.('.fx-side')) return;
  if (event.target.closest('a, button, input, select, textarea, [role="button"], [role="menuitem"], #user-button')) return;
  toggleMenu();
});

// Search, from the sidebar foot or Ctrl+K (⌘K): the pages this person may
// open, invoices and jobs (search.js).
function mayOpen(view) {
  if (view.ownerOnly && me?.person.role !== 'owner') return false;
  if (view.managerOnly && !['owner', 'admin'].includes(me?.person?.role)) return false;
  return true;
}

function search() {
  const views = Object.entries(VIEWS)
    .filter(([, view]) => mayOpen(view))
    .map(([name, view]) => ({ name, label: view.label, icon: view.icon }));
  openSearch({ h, flow, go, icon, views });
}

document.addEventListener('keydown', (event) => {
  if (!isSearchKey(event)) return;
  if (document.body.dataset.state !== 'signed-in') return;
  event.preventDefault();
  search();
});

// "Report a problem" in Clerk's account menu, between "Manage account" and
// "Sign out". Clerk mounts and unmounts the icon itself.
function accountMenuItem(label, iconName, onClick) {
  return {
    label,
    onClick,
    mountIcon: (element) => element.replaceChildren(icon(iconName)),
    unmountIcon: (element) => element.replaceChildren(),
  };
}

function reportMenuItem(openReport) {
  return accountMenuItem('Report a problem', 'flag', () => { openReport().catch((error) => toast(error.message, 'danger')); });
}

// The page a person lands on after sign-in, and for / or an unknown path.
// Invoices opens on its Ready tab. A home page can take this over later.
const START_VIEW = 'invoices';

// The view and, for one record, its id: /invoices/<id> is ['invoices', '<id>'].
function currentView() {
  const [name, id = null] = location.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (VIEWS[name] && mayOpen(VIEWS[name])) return [name, id];
  return [START_VIEW, null];
}

async function route() {
  const main = $('main');
  unmountAllIn(main);
  const [view, id] = currentView();
  const path = id ? `/${view}/${id}` : `/${view}`;
  if (location.pathname !== path) history.replaceState(null, '', path);
  markNavCurrent(view);
  main.replaceChildren();
  main.className = 'fx-main';
  document.title = `${VIEWS[view].label} · Flow`;
  await VIEWS[view].render(main, id);
  main.focus({ preventScroll: true });
}

// Opens a path in place; the address changes, the page stays.
linksOpenWith((path) => go(path));

function go(path, { replace = false } = {}) {
  if (path !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', path);
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
  h, flow, toast, notice, fieldError, pageHeader, listHead, listFrame, edgeFade, sectionTitle, settingRow, dialog, pickOne, me, holdButton, tileCard, tileSection, crumbs,
  go: (target, options) => (typeof target === 'string' ? go(target, options) : navigate(target)),
});

function renderSignedOut() {
  document.body.dataset.state = 'signed-out';
  document.title = 'Sign in · Flow';
  const panel = $('sign-in');
  // The link in an invitation email (POST /api/people) carries a Clerk
  // ticket: the invitee makes their account here, on that address only.
  if (new URLSearchParams(location.search).has('__clerk_ticket')) {
    $('sign-in-note').textContent = 'Finish your invitation to Flow.';
    mountClerk('signUp', panel, { forceRedirectUrl: '/sign-in', signInUrl: '/sign-in' });
    return;
  }
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

// Sidebar pages this person may open. Account pages stay in the account menu.
function sidebarViews() {
  return Object.entries(VIEWS).filter(([, view]) => view.sidebar !== false && view.place !== 'account' && mayOpen(view));
}

// Null until the shell reads the account. Jobs and Invoices are always in it.
let pinned = null;
let pinEpoch = 0;
let pinWrite = Promise.resolve();
let morePanel = null;

function pinSet() {
  if (!pinned) {
    pinned = new Set(me?.views?.nav?.pinned ?? NAV_DEFAULT);
    for (const name of NAV_LOCKED) pinned.add(name);
  }
  return pinned;
}

function navLink(name, view) {
  return h('a', { href: `/${name}`, 'data-nav': name, 'data-label': view.label, onclick: navigate }, icon(view.icon), h('span', { class: 'fx-nav__label' }, view.label));
}

// More is the current page while the open page is a sidebar page that is
// not pinned, so it has no row of its own.
function markNavCurrent(view = currentView()[0]) {
  for (const link of document.querySelectorAll('a[data-nav]')) {
    link.setAttribute('aria-current', link.dataset.nav === view ? 'page' : 'false');
  }
  const shown = [...document.querySelectorAll('a[data-nav]')].some((link) => link.dataset.nav === view);
  const inSidebar = sidebarViews().some(([name]) => name === view);
  document.querySelector('[data-nav="more"]')?.setAttribute('aria-current', inSidebar && !shown ? 'page' : 'false');
}

function syncSidebar() {
  const nav = $('nav');
  const moreButton = nav?.querySelector('[data-nav="more"]');
  if (!moreButton) return;
  for (const link of [...nav.querySelectorAll('a[data-nav]')]) link.remove();
  const links = sidebarViews().filter(([name]) => pinSet().has(name)).map(([name, view]) => navLink(name, view));
  if (links.length) moreButton.before(...links);
  morePanel?.refresh?.();
  drawMenu();
  markNavCurrent();
}

function moreItems() {
  const pins = pinSet();
  return sidebarViews().map(([name, view]) => {
    const on = pins.has(name);
    const locked = NAV_LOCKED.includes(name);
    return {
      icon: icon(view.icon),
      text: view.label,
      run: () => { closeMenu(); go(`/${name}`); },
      trailing: locked
        ? { icon: 'pin', label: 'Pinned', pressed: true, locked: true }
        : { icon: 'pin', label: on ? 'Unpin' : 'Pin', pressed: on, run: () => togglePin(name) },
    };
  });
}

function togglePin(name) {
  if (NAV_LOCKED.includes(name)) return;
  const next = new Set(pinSet());
  if (next.has(name)) next.delete(name);
  else next.add(name);
  for (const locked of NAV_LOCKED) next.add(locked);
  const epoch = ++pinEpoch;
  pinned = next;
  syncSidebar();
  const body = { pinned: [...next] };
  pinWrite = pinWrite.then(() => savePins(body, epoch), () => savePins(body, epoch));
}

async function savePins(body, epoch) {
  try {
    const saved = await flow('/api/me/views/nav', { method: 'PUT', body: JSON.stringify(body) });
    if (epoch !== pinEpoch) return;
    pinned = new Set(saved.view.pinned);
    me.views = { ...(me.views ?? {}), nav: saved.view };
    syncSidebar();
  } catch (error) {
    if (epoch !== pinEpoch) return;
    pinned = new Set(me?.views?.nav?.pinned ?? NAV_DEFAULT);
    for (const locked of NAV_LOCKED) pinned.add(locked);
    syncSidebar();
    toast(error.message, 'danger');
  }
}

function renderShell() {
  document.body.dataset.state = 'signed-in';
  const nav = $('nav');
  const [moreButton, panel] = rowMenu('More', moreItems, { trigger: [icon('more'), h('span', { class: 'fx-nav__label' }, 'More')], className: 'fx-nav__more', align: 'start', place: 'side' });
  morePanel = panel;
  Object.assign(moreButton.dataset, { nav: 'more', label: 'More' });
  // "Report a problem" sits at the foot of the menu, above the account chip,
  // while Sentry and its report form are on (monitoring.js).
  const report = h('button', { type: 'button', class: 'fx-nav__report', 'data-nav': 'report', 'data-label': 'Report a problem', hidden: true },
    icon('flag'), h('span', { class: 'fx-nav__label' }, 'Report a problem'));
  nav.replaceChildren(moreButton, panel, report);
  // Folded or narrow, the logo is the sidebar button: it shows the mark and
  // turns into the sidebar icon under the pointer or keyboard focus.
  const mark = h('span', { class: 'fx-toggle__mark', 'aria-hidden': 'true' });
  mark.innerHTML = document.querySelector('.fx-side__head .fx-brand svg')?.outerHTML ?? '';
  const sidebar = icon('sidebar');
  sidebar.classList.add('fx-toggle__icon');
  $('menu-toggle').replaceChildren(mark, sidebar);
  $('menu-toggle').onclick = toggleMenu;
  syncSidebar();
  // The sidebar foot shows who is signed in: photo or initial, then the name
  // (the email when the account has no name). It opens the account menu.
  // People (owners) and Appearance live in the account menu.
  const accountItems = Object.entries(VIEWS)
    .filter(([, view]) => view.place === 'account' && mayOpen(view))
    .map(([name, view]) => accountMenuItem(view.label, view.icon, () => go(`/${name}`)));
  const userButton = { afterSignOutUrl: '/sign-in', showName: true, customMenuItems: accountItems };
  $('search').replaceChildren(icon('search'));
  $('search').onclick = search;
  mountClerk('userButton', $('user-button'), userButton);
  // Errors and problem reports go to the installation's own Sentry, when the
  // Sentry integration is on (monitoring.js). Then "Report a problem" shows
  // in the menu and in the account menu. Flow works the same without it.
  startMonitoring({ flow, person: me.person })
    .then((openReport) => {
      if (!openReport) return;
      report.hidden = false;
      report.onclick = () => { openReport().catch((error) => toast(error.message, 'danger')); };
      unmountClerk($('user-button'));
      mountClerk('userButton', $('user-button'), { ...userButton, customMenuItems: [...accountItems, reportMenuItem(openReport)] });
    })
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
  const invite = h('button', { class: 'fx-btn fx-btn--primary', type: 'button', disabled: !canManage, onclick: () => invitePerson() }, 'Invite');
  const tableHost = h('div', { class: 'fx-panel' }, h('div', { class: 'fx-skeleton' }));
  main.append(...[
    pageHeader('People', { actions: [invite] }),
    canManage ? null : notice('Managing people needs a verified owner sign-in: Google Workspace on the owner domain with no password, or a second factor.', 'warn', 'Read only.'),
    tableHost,
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
    h('table', { class: 'fx-table fx-people' },
      h('thead', { class: 'fx-sr' }, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Role'), h('th', {}, 'Access'), h('th', {}, 'Actions'))),
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
    h('span', { class: 'fx-avatar', 'aria-hidden': 'true' }, initialsOf(person)),
    h('span', { class: 'fx-person__text' },
      h('span', { class: 'fx-person__name' }, personLabel(person), self ? h('span', { class: 'fx-tag' }, 'You') : null),
      person.name ? h('span', { class: 'fx-person__email' }, person.email) : null));
  const role = self
    ? h('span', { title: ROLE_HINT[person.role] }, ROLE_LABEL[person.role])
    : roleSelect(person.role, {
      'aria-label': `Role for ${person.email}`,
      title: ROLE_HINT[person.role],
      onchange: (event) => act(() => patch({ role: event.target.value }), `${person.email} is now ${ROLE_LABEL[event.target.value].toLowerCase()}.`),
    });
  const actions = [];
  if (!self) {
    if (person.status === 'pending') {
      actions.push(h('button', { class: 'fx-btn fx-btn--primary fx-btn--sm', type: 'button', onclick: () => act(() => patch({ status: 'active' }), `${person.email} can sign in.`) }, 'Approve'));
    }
    const items = [];
    if (person.invited && person.status === 'active') {
      items.push({ icon: 'mail', text: 'Email invite again', run: () => act(() => flow(`/api/people/${person.id}/invite`, { method: 'POST' }), `Invite emailed to ${person.email}.`) });
    }
    if (person.status === 'active') items.push({ icon: 'circle-off', text: 'Turn off', run: () => act(() => patch({ status: 'disabled' }), `${person.email} is turned off.`) });
    if (person.status === 'disabled') items.push({ icon: 'circle-check', text: 'Turn on', run: () => act(() => patch({ status: 'active' }), `${person.email} is turned on.`) });
    items.push('-', {
      icon: 'trash-2',
      text: 'Remove',
      tone: 'danger',
      run: async () => {
        const ok = await dialog({
          title: `Remove ${person.email}?`,
          body: h('p', {}, 'They can no longer sign in to Flow. Records they made stay.'),
          confirm: 'Remove',
          tone: 'danger',
        });
        if (ok) await act(() => flow(`/api/people/${person.id}`, { method: 'DELETE' }), `${person.email} is removed.`);
      },
    });
    actions.push(...rowMenu(`More for ${person.email}`, items));
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
  sentry: { maker: 'Sentry', category: 'monitoring', blurb: 'Send errors, problem reports and speed traces to your own Sentry project.', logo: 'sentry.svg' },
};
const CATEGORIES = [['all', 'All'], ['accounting', 'Accounting'], ['lab', 'Lab software'], ['monitoring', 'Monitoring']];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);

// The two notices every integration page can show, each one short line. The
// detail is on the ? (docs/INTEGRATIONS.md has the rest).
const readOnlyNotice = () => notice('Verified owner sign-in needed.', 'warn', 'Read only.');
const secretsKeyNotice = () => notice('Set FLOW_SECRETS_KEY, then restart Flow.', 'warn', 'No secrets key.');

function integrationLogo(integration, size = '') {
  const file = CATALOGUE[integration.id]?.logo;
  return h('span', { class: `fx-logo${size ? ` fx-logo--${size}` : ''}`, 'aria-hidden': 'true' },
    file ? h('img', { src: `/assets/ui/logos/${file}`, alt: '' }) : icon('plug'));
}

async function renderIntegrations(main) {
  const state = { tab: 'all', category: 'all', q: '' };
  const tabs = h('div', { class: 'fx-seg', role: 'tablist' });
  const search = h('input', { class: 'fx-input fx-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search integrations' });
  const category = h('select', { class: 'fx-select', 'aria-label': 'Category' },
    CATEGORIES.map(([id, label]) => h('option', { value: id }, id === 'all' ? 'All categories' : label)));
  const notices = h('div', { class: 'fx-fields' });
  const content = h('div', { class: 'fx-int-sections' }, h('div', { class: 'fx-skeleton' }));
  main.append(
    pageHeader('Integrations'),
    alertStrip(ui(), 'integrations').element,
    h('div', { class: 'fx-int-bar' }, tabs, h('div', { class: 'fx-row' }, category, search)),
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
    canChange ? null : readOnlyNotice(),
    body.secretsKey ? null : secretsKeyNotice(),
  ].filter(Boolean));
  const list = [...body.integrations].sort((a, b) => a.name.localeCompare(b.name));
  const connected = (i) => i.enabled;

  const draw = () => {
    category.hidden = state.tab !== 'all';
    tabs.replaceChildren(...[['all', 'All'], ['yours', 'Connected']].map(([id, label]) => h('button', {
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
          : h('p', { class: 'fx-empty' }, q ? 'No integration matches.' : 'Nothing is connected yet. Pick one under All.')));
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
        recommended.length ? h('h2', { class: 'fx-int-heading' }, 'All') : null,
        all.length ? h('div', { class: 'fx-int-grid' }, all.map(integrationTile)) : h('p', { class: 'fx-empty' }, 'No integration matches.')));
    }
    content.replaceChildren(...sections);
  };
  search.addEventListener('input', () => { state.q = search.value.trim(); draw(); });
  category.addEventListener('change', () => { state.category = category.value; draw(); });
  draw();
}

function integrationTile(integration) {
  const entry = CATALOGUE[integration.id];
  const on = integration.enabled;
  const attention = ['failed', 'restart_needed'].includes(integration.state);
  return tileCard({
    href: `/integrations/${integration.id}`,
    mark: integrationLogo(integration),
    title: integration.name,
    status: on ? { label: STATE_LABEL[integration.state] ?? integration.state, tone: STATE_TONE[integration.state] } : null,
    blurb: entry?.blurb,
    action: attention ? 'Fix' : on ? 'Manage' : '+ Connect',
  });
}


// One integration's page (/integrations/<id>): its logo, name and Connect
// (each step shown as it runs), the setup steps (closed), its settings, and the
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
  // The quiet alert line for this integration only (server/ui/alerts.js).
  // While a danger alert is open, even one this person hid, the status says
  // calls are stopped instead of the integration's state.
  let stopped = false;
  const statusPill = (current) => (stopped && current.state === 'ready'
    ? h('span', { class: 'fx-status', 'data-tone': 'danger', 'data-int-status': '' }, 'Calls stopped')
    : h('span', { class: 'fx-status', 'data-tone': STATE_TONE[current.state] ?? 'mute', 'data-int-status': '' }, STATE_LABEL[current.state] ?? current.state));
  let shown = found;
  // Settings: closed on a phone, open on a wider screen, then as the person
  // leaves it while the page redraws (Connect).
  let settingsOpen = !window.matchMedia?.('(max-width: 639px)').matches;
  const alerts = alertStrip(ui(), 'integrations', {
    scope: id,
    onLoad: ({ danger }) => {
      stopped = danger;
      for (const pill of host.querySelectorAll('[data-int-status]')) pill.replaceWith(statusPill(shown));
    },
  });

  const draw = (current, progress = null) => {
    shown = current;
    const inputs = new Map();
    const rows = [];
    for (const field of current.fields) {
      if (field.source === 'host') {
        // The host sets it: a value to read, not a box to type in.
        rows.push(settingRow({
          label: field.label,
          help: 'Set by whoever hosts Flow.',
          control: field.secret ? h('span', { class: 'fx-dim' }, 'Set') : h('code', { class: 'fx-setting__value' }, field.value),
        }));
        continue;
      }
      const disabled = !canChange;
      let input;
      if (field.kind === 'choice' || field.kind === 'onoff') {
        const choices = field.kind === 'onoff' ? [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] : field.choices;
        const fallback = field.kind === 'onoff' ? (field.default === 'on' || field.default === 'off' ? field.default : 'off') : '';
        input = h('select', { class: 'fx-select', disabled, 'data-fallback': fallback },
          field.kind === 'choice' ? h('option', { value: '' }, 'Choose…') : null,
          choices.map((c) => h('option', { value: c.value, selected: (field.value ?? fallback) === c.value }, c.label)));
      } else if (field.secret) {
        input = h('input', { class: 'fx-input', type: 'password', autocomplete: 'off', disabled, placeholder: field.set ? 'Saved' : 'Paste it here' });
      } else {
        input = h('input', { class: 'fx-input', type: field.kind === 'url' ? 'url' : 'text', autocomplete: 'off', disabled, value: field.value ?? '' });
      }
      inputs.set(field.name, { field, input });
      const suggestion = field.suggest === 'callback' ? `${location.origin}/api/${current.id}/oauth/callback` : null;
      rows.push(settingRow({
        label: field.label,
        hint: field.unreadable ? 'Stored with another key. Enter it again.' : null,
        help: field.help,
        control: suggestion && !disabled
          ? h('div', { class: 'fx-setting__stack' }, input,
            h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', title: suggestion, onclick: () => { input.value = suggestion; navigator.clipboard?.writeText(suggestion); toast('Address filled in and copied.', 'success'); } }, 'Use this address'))
          : input,
      }));
    }

    const values = () => {
      const out = {};
      for (const [name, { field, input }] of inputs) {
        const value = input.value.trim();
        if (field.secret) { if (value) out[name] = value; continue; }
        const fallback = input.dataset.fallback ?? (field.kind === 'onoff' ? 'off' : '');
        if (value !== (field.value ?? fallback)) out[name] = value || null;
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
    const mode = current.fields.find((f) => /_MODE$/.test(f.name));
    const modeLabel = mode?.choices?.find((c) => c.value === mode.value)?.label ?? mode?.value;
    const busy = progress && progress.steps.some((step) => step.state === 'running');

    const primary = !canChange || hostOwned ? null : on
      ? h('button', { class: 'fx-btn', type: 'button', onclick: () => save(false) }, 'Disconnect')
      : h('button', { class: 'fx-btn fx-btn--primary', type: 'button', disabled: busy, onclick: connect },
        busy ? h('span', { class: 'fx-spinner fx-spinner--sm', 'aria-hidden': 'true' }) : null, busy ? 'Connecting' : 'Connect');

    host.replaceChildren(
      crumbs(['/integrations', 'Integrations'], current.name),
      h('div', { class: 'fx-int-page__grid' },
        h('div', { class: 'fx-int-page__main' }, ...[
          h('header', { class: 'fx-int-hero' },
            integrationLogo(current, 'lg'),
            h('h1', { class: 'fx-title' }, current.name),
            h('div', { class: 'fx-int-hero__actions' },
              on ? statusPill(current) : null,
              primary,
              progress ? connectProgress(progress) : null)),
          alerts.element,
          !canChange ? readOnlyNotice() : null,
          !body.secretsKey ? secretsKeyNotice() : null,
          current.state === 'failed' && current.error ? notice(current.error, 'danger', 'It could not start.') : null,
          current.id === 'xero' && current.state === 'ready' ? h('section', { class: 'fx-int-section' }, xeroConnection(body.organisations, canChange)) : null,
          current.id === 'seazona' ? h('section', { class: 'fx-int-section fx-card', style: { padding: '8px 20px 16px' } }, automationSection(ui(), 'seazona', 'Ready to invoice')) : null,
          on && current.state === 'ready' ? personSettingsSection(current) : null,
          current.id === 'xero' && current.state === 'ready' ? xeroImportSection(body.organisations) : null,
          current.id === 'xero' ? h('section', { class: 'fx-int-section fx-card', style: { padding: '8px 20px 16px' } }, automationSection(ui(), 'xero', 'Contacts')) : null,
          current.id === 'xero' ? h('section', { class: 'fx-int-section fx-card', style: { padding: '8px 20px 16px' } }, sendModeSection(ui())) : null,
          guide ? h('details', { class: 'fx-int-section fx-int-fold' },
            h('summary', { class: 'fx-int-section__title' }, 'Set up'),
            h('ol', { class: 'fx-steps' }, guide.steps.map((step) => h('li', {}, step))),
            guide.link ? h('a', { class: 'fx-btn fx-btn--sm', href: guide.link, target: '_blank', rel: 'noopener' }, `${current.name} site ↗`) : null) : null,
          rows.length ? h('details', { class: 'fx-int-section fx-int-fold', open: settingsOpen, ontoggle: (event) => { settingsOpen = event.currentTarget.open; } },
            h('summary', { class: 'fx-int-section__title' }, 'Settings'),
            h('div', { class: 'fx-settings' }, rows),
            canChange && on && inputs.size ? h('div', { class: 'fx-row fx-row--end' }, h('button', { class: 'fx-btn', type: 'button', onclick: () => save(undefined) }, 'Save changes')) : null) : null,
        ].filter(Boolean)),
        h('aside', { class: 'fx-int-page__meta' },
          h('dl', { class: 'fx-meta' }, ...[
            ['Status', statusPill(current)],
            modeLabel ? ['Mode', modeLabel] : null,
            current.enabledBy === 'host' ? ['On by', 'Host'] : current.enabledBy === 'flow' ? ['On by', 'Owner'] : null,
            current.updatedAt ? ['Changed', new Date(current.updatedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })] : null,
            guide?.link ? ['Docs', h('a', { href: guide.link, target: '_blank', rel: 'noopener' }, `${current.name} ↗`)] : null,
          ].filter(Boolean).map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value)))))));
  };
  document.title = `${found.name} · Flow`;
  draw(found);
}

// "Your settings": this person's own choices in one integration
// (GET /api/work/my-settings), such as Seazona's "Ask before stage moves".
// Each person sees and changes only their own.
function personSettingsSection(integration) {
  const section = h('section', { class: 'fx-int-section' },
    h('h2', { class: 'fx-int-section__title' }, 'Your settings'), h('div', { class: 'fx-skeleton' }));
  flow(`/api/work/my-settings?integration=${encodeURIComponent(integration.id)}`).then(({ integrations }) => {
    const settings = integrations[0]?.settings ?? [];
    if (!settings.length) { section.remove(); return; }
    const rows = settings.map((setting) => {
      const input = h('select', { class: 'fx-select' },
        [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }].map((c) => h('option', { value: c.value, selected: (setting.value ? 'on' : 'off') === c.value }, c.label)));
      input.addEventListener('change', async () => {
        input.disabled = true;
        try {
          await flow('/api/work/my-settings', { method: 'PUT', body: JSON.stringify({ integration: integration.id, key: setting.key, value: input.value === 'on' }) });
          toast('Saved for you.', 'success');
        } catch (error) {
          input.value = setting.value ? 'on' : 'off';
          toast(error.message, 'danger');
        }
        input.disabled = false;
      });
      return settingRow({ label: setting.label, help: setting.hint, control: input });
    });
    section.replaceChildren(section.firstChild, h('div', { class: 'fx-settings' }, rows));
  }).catch(() => section.remove());
  return section;
}

function connectProgress({ steps, started }) {
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  return h('div', { class: 'fx-progress', role: 'status' },
    h('div', { class: 'fx-progress__head' }, h('span', { class: 'fx-strong' }, 'Connecting'), h('span', { class: 'fx-dim' }, `${seconds}s`)),
    h('ol', {}, steps.map((step) => h('li', { 'data-state': step.state },
      h('span', { class: 'fx-progress__mark', 'aria-hidden': 'true' }, step.state === 'done' ? '✓' : step.state === 'failed' ? '!' : ''),
      step.label))));
}

// Xero › Import, in settings rows: how many Xero invoices to check (Review
// opens them one at a time), the two import settings, and the history. The
// counts come from Flow's copy of Xero; the pages are server/ui/xero-import.js.
function xeroImportSection(organisations) {
  const organisationId = organisations?.[0]?.id;
  const canAct = ['owner', 'admin'].includes(me?.person?.role);
  const count = h('span', { class: 'fx-num fx-xi-count' }, '…');
  const copied = h('span', {}, '');
  const switchFor = (name, label) => {
    const button = h('button', { class: 'fx-switch', type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': 'false', disabled: true });
    button.addEventListener('click', async () => {
      const on = button.getAttribute('aria-checked') !== 'true';
      button.disabled = true;
      try {
        const { settings } = await flow('/api/xero/import/settings', { method: 'PUT', body: JSON.stringify({ organisationId, [name]: on }) });
        button.setAttribute('aria-checked', String(settings[name]));
        toast('Saved.', 'success');
      } catch (error) {
        toast(error.message, 'danger');
      }
      button.disabled = !canAct;
    });
    return button;
  };
  const autoLink = switchFor('autoLink', 'Link sure matches');
  const makeUnmatched = switchFor('makeUnmatched', 'Make Flow invoices for the rest');
  const section = h('section', { class: 'fx-set fx-int-section fx-card', style: { padding: '8px 20px 16px' } },
    h('h2', { class: 'fx-set__title' }, 'Import'),
    settingRow({ label: 'To check', help: 'Xero invoices that fit a Flow invoice or a Flow job.',
      control: h('span', { class: 'fx-row' }, count, h('a', { class: 'fx-btn fx-btn--sm fx-btn--primary', href: '/xero-import', onclick: navigate }, 'Review')) }),
    settingRow({ label: 'Link sure matches', help: 'Same client, total and week, and only one fit. Flow links them.', control: autoLink }),
    settingRow({ label: 'Make Flow invoices for the rest', help: 'Off: they stay in the Xero history.', control: makeUnmatched }),
    settingRow({ label: 'Xero history', hint: copied, help: 'Every Xero invoice Flow copied. A search makes no Xero call.', control: h('a', { class: 'fx-btn fx-btn--sm', href: '/xero-import?show=all', onclick: navigate }, 'Search') }));
  if (organisationId) {
    flow(`/api/xero/import?organisationId=${organisationId}&show=check&limit=1`)
      .then(({ counts: c, settings }) => {
        count.replaceChildren(String(c.job_fits + c.invoice_fits));
        copied.replaceChildren(`${Object.values(c).reduce((a, b) => a + b, 0)} copied, ${c.linked} in Flow`);
        autoLink.setAttribute('aria-checked', String(settings.autoLink));
        makeUnmatched.setAttribute('aria-checked', String(settings.makeUnmatched));
        autoLink.disabled = makeUnmatched.disabled = !canAct;
      })
      .catch(() => count.replaceChildren('—'));
  }
  return section;
}

// Once Xero is on: each organisation's connection, the history copy, and
// Connect, which goes to Xero and comes back.
function xeroConnection(organisations, canChange) {
  const host = h('div', { class: 'fx-xero-orgs' });
  for (const organisation of organisations) {
    const usage = h('div');
    const row = settingRow({ label: organisation.name, hint: 'Checking…' });
    host.append(h('div', { class: 'fx-xero-org' }, usage, row));
    (async () => {
      let hint;
      let control = null;
      let stopped = false;
      let refused = false;
      try {
        const status = await flow(`/api/xero/status?organisationId=${organisation.id}`);
        usage.replaceChildren(xeroUsage(status) ?? '');
        if (status.connected && status.calls?.stopped) {
          // A refused connection stopped calls (the call guard): say so, and
          // make Connect again the main button, which starts them again.
          const at = status.calls.since ? ` at ${new Date(status.calls.since).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}` : '';
          // One refused resource stops only that resource, and Flow tries it
          // again by itself: a calm note, not a stop.
          hint = status.calls.all
            ? `Xero refused Flow${at}. Flow stopped all calls.`
            : `Connected. Xero refused Flow for ${status.calls.resources.join(', ')}${at}. Other calls still work. Flow tries again by itself.`;
          stopped = status.calls.all;
          refused = !status.calls.all;
        } else if (status.connected) {
          const mirror = await flow(`/api/xero/mirror?organisationId=${organisation.id}`).catch(() => null);
          hint = `Connected to ${status.connection?.tenantName ?? 'Xero'}.${mirror ? ` ${mirror.counts.invoices} invoices copied.` : ''}`;
        } else {
          hint = 'Not connected.';
        }
        if (canChange) {
          control = h('button', { class: `fx-btn fx-btn--sm${status.connected && !stopped && !refused ? '' : ' fx-btn--primary'}`, type: 'button', onclick: async () => {
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
      row.replaceWith(settingRow({ label: organisation.name, hint, control, tone: stopped ? 'danger' : null }));
    })();
  }
  return h('div', {}, h('h2', { class: 'fx-int-section__title' }, 'Xero organisation'), host);
}

// When Clerk cannot email an invitation, the owner sends the invitee this
// message instead. It names the sign-in address and the email to use.
function inviteMessage(person) {
  return [
    'You have access to Flow.',
    `Sign in at ${location.origin}/sign-in with ${person.email}.`,
    'Use Continue with Google if that address is a Google account.',
  ].join('\n');
}

async function copyInvite(person) {
  try {
    await navigator.clipboard.writeText(inviteMessage(person));
    return true;
  } catch {
    return false;
  }
}

async function invitePerson() {
  const hint = h('p', { class: 'fx-dim' }, ROLE_HINT.staff);
  const data = await dialog({
    title: 'Invite someone',
    body: h('div', { class: 'fx-fields' },
      h('label', { class: 'fx-field' },
        h('span', { class: 'fx-label' }, 'Email'),
        h('input', { class: 'fx-input', name: 'email', type: 'email', required: true, autocomplete: 'off', placeholder: 'name@example.com' })),
      h('label', { class: 'fx-field' },
        h('span', { class: 'fx-label' }, 'Role'),
        roleSelect('staff', { name: 'role', onchange: (event) => { hint.textContent = ROLE_HINT[event.target.value]; } })),
      hint),
    confirm: 'Send invite',
  });
  if (!data) return;
  try {
    const { person, invite } = await flow('/api/people', { method: 'POST', body: JSON.stringify({ email: data.get('email'), role: data.get('role') }) });
    if (invite?.emailed) toast(`Invite emailed to ${person.email}.`, 'success');
    else if (await copyInvite(person)) toast(`${person.email} is invited, but the email could not be sent. A sign-in message is copied: paste it into an email to them.`, 'info');
    else toast(`${person.email} is invited, but the email could not be sent. Send them: ${inviteMessage(person)}`, 'info');
  } catch (error) {
    toast(error.message, 'danger');
  }
  await route();
}

// Account: Clerk's own profile (name, email addresses, connected accounts,
// security), with the person's Flow role above it.
function renderAccount(main) {
  const host = h('div', { class: 'fx-clerk-profile' });
  // Clerk's card has its own "Account" heading; Flow's page heading is for
  // screen readers only, so the title shows once.
  main.append(h('h1', { class: 'fx-sr' }, 'Account'), host);
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
    pageHeader('Appearance'),
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
      // The design system's own accent, named "Default" on the swatch: a
      // click puts it back.
      : h('button', { type: 'button', class: 'fx-swatch fx-swatch--default', 'aria-label': `Default: ${active.label}'s own accent` },
        h('span', { class: 'fx-swatch__dot', 'aria-hidden': 'true', style: { background: `linear-gradient(135deg, ${active.swatches[mode].primary} 50%, ${active.swatches[mode].accent} 50%)` } }),
        'Default'));
  accents.classList.add('fx-swatches');
  const custom = h('label', { class: 'fx-swatch-custom' },
    h('input', { type: 'color', 'aria-label': 'Custom accent colour', value: customHex ?? '#0d4e5f', onchange: (event) => chooseAppearance({ accent: event.target.value }) }),
    'Custom');
  const accentLabel = customHex ? `Custom ${customHex}` : presetIndex > 0 ? ACCENT_PRESETS[presetIndex].label : `the default, ${active.label}'s own`;

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
    button.dataset.tip = label;
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
    start: { title: 'Sign in to Flow', subtitle: 'Choose how to sign in.' },
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

startTips();
start();
