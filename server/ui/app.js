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
// remounts each one (after the tokens have changed on <html>).
onAppearanceChange(() => {
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
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, code: body.code });
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

const VIEWS = {
  people: { label: 'People', ownerOnly: true, render: renderPeople },
  integrations: { label: 'Integrations', ownerOnly: true, render: renderIntegrations },
  account: { label: 'Account', render: renderAccount },
  appearance: { label: 'Appearance', render: renderAppearance },
};

function currentView() {
  const name = location.pathname.replace(/^\/+|\/+$/g, '');
  if (VIEWS[name] && (!VIEWS[name].ownerOnly || me?.person.role === 'owner')) return name;
  return me?.person.role === 'owner' ? 'people' : 'account';
}

async function route() {
  const main = $('main');
  unmountAllIn(main);
  const view = currentView();
  if (location.pathname !== `/${view}`) history.replaceState(null, '', `/${view}`);
  for (const link of document.querySelectorAll('[data-nav]')) {
    link.setAttribute('aria-current', link.dataset.nav === view ? 'page' : 'false');
  }
  main.replaceChildren();
  document.title = `${VIEWS[view].label} · Flow`;
  await VIEWS[view].render(main);
  main.focus({ preventScroll: true });
}

// A view's link opens it in place; the address changes, the page stays.
function navigate(event) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  const href = event.currentTarget.getAttribute('href');
  if (href !== location.pathname) history.pushState(null, '', href);
  route();
}

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
  nav.replaceChildren(...Object.entries(VIEWS)
    .filter(([, view]) => !view.ownerOnly || me?.person.role === 'owner')
    .map(([name, view]) => h('a', { href: `/${name}`, 'data-nav': name, onclick: navigate }, view.label)));
  mountClerk('userButton', $('user-button'), { afterSignOutUrl: '/sign-in', showName: false });
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

// Integrations: an owner turns Xero and Seazona on and enters their settings
// here. Credentials are write-only: the server says whether each is set,
// never its value (server/integrations/setup.js).
const STATE_LABEL = { ready: 'On', disabled: 'Off', failed: 'Needs attention', restart_needed: 'Restart needed', not_started: 'Starting' };
const STATE_TONE = { ready: 'success', disabled: 'info', failed: 'danger', restart_needed: 'warn', not_started: 'info' };

async function renderIntegrations(main) {
  const host = h('div', { class: 'fx-fields' }, h('div', { class: 'fx-skeleton' }));
  main.append(
    pageHeader('Integrations', { subtitle: 'Connect Flow to your accounting and lab systems. Each one uses an app you create in that system.' }),
    host);
  let body;
  try {
    body = await flow('/api/integrations');
  } catch (error) {
    host.replaceChildren(notice(error.message, 'danger'));
    return;
  }
  const canChange = Boolean(me.ownerActions?.allowed);
  host.replaceChildren(...[
    canChange ? null : notice('Changing integrations needs a verified owner sign-in: Google Workspace on the owner domain with no password, or a second factor.', 'warn', 'Read only.'),
    body.secretsKey ? null : notice('Flow has no secrets key, so it cannot store a client secret. Ask whoever hosts Flow to set FLOW_SECRETS_KEY (64 hex characters), then restart Flow.', 'warn', 'No secrets key.'),
    ...body.integrations.map((integration) => integrationCard(integration, { canChange, organisations: body.organisations })),
  ].filter(Boolean));
}

function integrationCard(integration, { canChange, organisations }) {
  const card = h('section', { class: 'fx-panel', 'aria-label': integration.name });
  const draw = (current) => {
    const inputs = new Map();
    const fields = current.fields.map((field) => {
      const fromHost = field.source === 'host';
      const disabled = !canChange || fromHost;
      let input;
      if (field.kind === 'choice' || field.kind === 'onoff') {
        const choices = field.kind === 'onoff' ? [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] : field.choices;
        input = h('select', { class: 'fx-select', disabled },
          field.kind === 'choice' ? h('option', { value: '' }, 'Choose…') : null,
          choices.map((c) => h('option', { value: c.value, selected: (field.value ?? (field.kind === 'onoff' ? 'off' : '')) === c.value }, c.label)));
      } else if (field.secret) {
        input = h('input', { class: 'fx-input', type: 'password', autocomplete: 'off', disabled, placeholder: field.set ? 'Set. Type a new one to replace it.' : 'Paste it here' });
      } else {
        input = h('input', { class: 'fx-input', type: field.kind === 'url' ? 'url' : 'text', autocomplete: 'off', disabled, value: field.value ?? '' });
      }
      inputs.set(field.name, { field, input });
      const suggestion = field.suggest === 'callback' ? `${location.origin}/api/${current.id}/oauth/callback` : null;
      return h('label', { class: 'fx-field' },
        h('span', { class: 'fx-label' }, field.label),
        input,
        fromHost ? h('span', { class: 'fx-dim' }, 'Set by the host. Change it there.') : null,
        field.unreadable ? h('span', { class: 'fx-dim' }, 'Stored with another key. Enter it again.') : null,
        field.help ? h('span', { class: 'fx-dim' }, field.help) : null,
        suggestion && !disabled ? h('div', { class: 'fx-row' },
          h('code', {}, suggestion),
          h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', onclick: () => { navigator.clipboard?.writeText(suggestion); toast('Copied.', 'success'); } }, 'Copy'),
          h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', onclick: () => { input.value = suggestion; } }, 'Use this')) : null);
    });

    const values = () => {
      const out = {};
      for (const [name, { field, input }] of inputs) {
        if (field.source === 'host') continue;
        const value = input.value.trim();
        if (field.secret) { if (value) out[name] = value; continue; }
        if (value !== (field.value ?? (field.kind === 'onoff' ? 'off' : ''))) out[name] = value || null;
      }
      return out;
    };
    const save = async (enabled) => {
      try {
        const res = await flow(`/api/integrations/${current.id}`, { method: 'PUT', body: JSON.stringify({ values: values(), ...(enabled === undefined ? {} : { enabled }) }) });
        const next = res.integration;
        toast(next.state === 'ready' ? `${next.name} is on.` : next.state === 'disabled' ? `${next.name} settings saved. It is off.` : `${next.name} needs attention.`, next.state === 'failed' ? 'danger' : 'success');
        draw(next);
      } catch (error) {
        toast(error.message, 'danger');
      }
    };

    const on = current.enabled;
    const guide = current.guide;
    card.replaceChildren(...[
      h('div', { class: 'fx-row' },
        h('h2', { class: 'fx-title' }, current.name),
        h('span', { class: 'fx-tag', 'data-tone': STATE_TONE[current.state] ?? 'info' }, STATE_LABEL[current.state] ?? current.state),
        current.enabledBy === 'host' ? h('span', { class: 'fx-dim' }, 'Turned on by the host.') : null),
      current.state === 'failed' && current.error ? notice(current.error, 'danger', 'It could not start.') : null,
      guide ? h('details', { open: !on },
        h('summary', {}, guide.title),
        h('ol', {}, guide.steps.map((step) => h('li', {}, step))),
        guide.link ? h('p', {}, h('a', { href: guide.link, target: '_blank', rel: 'noopener' }, guide.link)) : null) : null,
      h('div', { class: 'fx-fields' }, fields),
      canChange ? h('div', { class: 'fx-row fx-row--end' },
        h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', onclick: () => save(undefined) }, 'Save'),
        current.enabledBy === 'host' ? null : on
          ? h('button', { class: 'fx-btn fx-btn--danger', type: 'button', onclick: () => save(false) }, `Turn ${current.name} off`)
          : h('button', { class: 'fx-btn fx-btn--primary', type: 'button', onclick: () => save(true) }, `Save and turn ${current.name} on`)) : null,
      current.id === 'xero' && current.state === 'ready' ? xeroConnection(organisations, canChange) : null,
    ].filter(Boolean));
  };
  draw(integration);
  return card;
}

// Once Xero is on: each organisation's connection, the history copy, and
// Connect, which goes to Xero and comes back.
function xeroConnection(organisations, canChange) {
  const host = h('div', { class: 'fx-fields' });
  for (const organisation of organisations) {
    const row = h('div', { class: 'fx-row' }, h('span', {}, organisation.name), h('span', { class: 'fx-dim' }, 'Checking…'));
    host.append(row);
    (async () => {
      try {
        const status = await flow(`/api/xero/status?organisationId=${organisation.id}`);
        const parts = [h('span', {}, organisation.name)];
        if (status.connected) {
          parts.push(h('span', { class: 'fx-tag', 'data-tone': 'success' }, `Connected to ${status.connection?.tenantName ?? 'Xero'}`));
          const mirror = await flow(`/api/xero/mirror?organisationId=${organisation.id}`).catch(() => null);
          if (mirror) parts.push(h('span', { class: 'fx-dim' }, `History copied: ${mirror.counts.invoices} invoices, ${mirror.counts.credit_notes} credit notes, ${mirror.counts.payments} payments.`));
        } else {
          parts.push(h('span', { class: 'fx-dim' }, 'Not connected.'));
        }
        if (canChange) {
          parts.push(h('button', { class: 'fx-btn fx-btn--primary fx-btn--sm', type: 'button', onclick: async () => {
            try {
              const { authorizeUrl } = await flow('/api/xero/connect', { method: 'POST', body: JSON.stringify({ organisationId: organisation.id }) });
              location.assign(authorizeUrl);
            } catch (error) {
              toast(error.message, 'danger');
            }
          } }, status.connected ? 'Connect again' : 'Connect to Xero'));
        }
        row.replaceChildren(...parts);
      } catch (error) {
        row.replaceChildren(h('span', {}, organisation.name), notice(error.message, 'danger'));
      }
    })();
  }
  return h('div', {}, h('h3', { class: 'fx-label' }, 'Connection'), host);
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

// Appearance: light or dark, the design system and an accent colour, for
// this browser.
function renderAppearance(main) {
  main.append(
    pageHeader('Appearance', { subtitle: 'For this browser. Clerk\'s sign-in and account screens follow it too.' }),
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
    (m) => setAppearance({ colorMode: m.value }),
    (m) => h('button', { type: 'button', class: 'fx-seg__item' }, m.label));
  modeGroup.classList.add('fx-seg');

  const familyIndex = THEME_FAMILIES.findIndex((f) => f.id === family);
  const families = radioGroup('Design system', THEME_FAMILIES, familyIndex,
    (f) => setAppearance({ family: f.id }),
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
    (p) => setAppearance({ accent: p.hex ? p.id : null }),
    (p) => p.hex
      ? h('button', { type: 'button', class: 'fx-swatch', title: p.label, 'aria-label': p.label, style: { background: p.hex } })
      : h('button', { type: 'button', class: 'fx-swatch fx-swatch--default', title: `${active.label}'s own`, 'aria-label': `${active.label}'s own accent` },
        h('span', { 'aria-hidden': 'true', style: { background: `linear-gradient(135deg, ${active.swatches[mode].primary} 50%, ${active.swatches[mode].accent} 50%)` } })));
  accents.classList.add('fx-swatches');
  const custom = h('label', { class: 'fx-swatch-custom' },
    h('input', { type: 'color', 'aria-label': 'Custom accent colour', value: customHex ?? '#0d4e5f', onchange: (event) => setAppearance({ accent: event.target.value }) }),
    'Custom');
  const accentLabel = customHex ? `Custom ${customHex}` : presetIndex > 0 ? ACCENT_PRESETS[presetIndex].label : `${active.label}'s own`;

  host.replaceChildren(
    h('section', { class: 'fx-group' },
      h('h2', { class: 'fx-label' }, 'Mode'),
      modeGroup,
      h('p', { class: 'fx-dim' }, 'Auto follows this device\'s light or dark setting.')),
    h('section', { class: 'fx-group' },
      h('h2', { class: 'fx-label' }, 'Design system'),
      families,
      h('p', { class: 'fx-dim' }, 'Each design system brings its own colours, type and corners, in light and dark. Harbour is Flow\'s own; the rest are OpenClaw\'s themes.')),
    h('section', { class: 'fx-group' },
      h('h2', { class: 'fx-label' }, 'Accent colour'),
      h('div', { class: 'fx-row' }, accents, custom),
      h('p', { class: 'fx-dim', 'aria-live': 'polite' }, `Using ${accentLabel}. Buttons, highlights and focus rings take the accent; text in the accent is adjusted until it reads clearly.`)));
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
  button.addEventListener('click', () => setAppearance({ colorMode: getAppearance().mode === 'dark' ? 'light' : 'dark' }));
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
  } catch (error) {
    renderNoAccess(error);
    return;
  }
  await renderShell();
}

start();
