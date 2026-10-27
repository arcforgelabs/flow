// Practice portal (/portal). Jobs, one job, and the practice team.
// Lab staff use the other app. Requests, Messages and Alerts stay out
// until their steps (docs/PORTAL.md).
import { flowClerkAppearance } from '/assets/ui/clerk-appearance.js';
import { filterJobs } from '/assets/ui/job-view.js';
import { cardRows, crumbs, dialog, h, listFrame, listHead, pageHeader, rowMenu, toast } from '/assets/ui/kit.js';
import { findBox, viewBar } from '/assets/ui/view-bar.js';

const $ = (id) => document.getElementById(id);
const STAGES = ['Ordered', 'Received', 'In work', 'Quality check', 'Sent'];

function setState(state) {
  document.body.dataset.state = state;
}

function practiceQuery() {
  const practice = new URLSearchParams(location.search).get('practice');
  return practice ? `?practice=${encodeURIComponent(practice)}` : '';
}

function withPractice(path) {
  const extra = practiceQuery();
  if (!extra) return path;
  return path.includes('?') ? `${path}&${extra.slice(1)}` : `${path}${extra}`;
}

async function api(path, options = {}) {
  const token = await window.Clerk?.session?.getToken?.();
  const res = await fetch(withPractice(path), {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, code: body.code });
  return body;
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

function loadClerk({ publishableKey, proxyUrl, scriptUrl, uiScriptUrl }) {
  return Promise.all([
    loadScript(scriptUrl, (script) => {
      script.dataset.clerkPublishableKey = publishableKey;
      if (proxyUrl) script.dataset.clerkProxyUrl = proxyUrl;
    }),
    loadScript(uiScriptUrl),
  ]);
}

function appearance() {
  return flowClerkAppearance();
}

function go(path) {
  const next = `${path}${practiceQuery()}`;
  if (next !== location.pathname + location.search) history.pushState(null, '', next);
  route();
}

let me = null;

function drawNav() {
  const page = location.pathname.split('/')[2] || 'jobs';
  const items = [
    ['jobs', 'Jobs'],
    ...(me.member.role === 'owner' || me.member.role === 'admin' ? [['team', 'Team']] : []),
  ];
  $('nav').replaceChildren(...items.map(([id, label]) => h('a', {
    href: `/portal/${id}${practiceQuery()}`,
    'aria-current': page === id ? 'page' : null,
    onclick: (event) => { event.preventDefault(); go(`/portal/${id}`); },
  }, label)));
  const select = $('practice');
  const wrap = $('practice-switch');
  if (me.practices.length < 2) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  select.replaceChildren(...me.practices.map((practice) => h('option', {
    value: practice.contactId,
    selected: practice.contactId === me.practiceId,
  }, practice.name)));
  select.onchange = () => { location.assign(`/portal/jobs?practice=${encodeURIComponent(select.value)}`); };
}

function showJoin() {
  setState('signed-out');
  $('auth-title').textContent = 'Join';
  $('sign-in').hidden = true;
  $('join-link').hidden = true;
  const host = $('join');
  host.hidden = false;
  const name = h('input', { class: 'fx-input', name: 'name', required: true, autocomplete: 'name' });
  const email = h('input', { class: 'fx-input', type: 'email', name: 'email', required: true, autocomplete: 'email' });
  const practiceName = h('input', { class: 'fx-input', name: 'practiceName', required: true });
  const phone = h('input', { class: 'fx-input', name: 'phone', autocomplete: 'tel' });
  const button = h('button', { class: 'fx-btn fx-btn--primary', type: 'submit' }, 'Join');
  host.replaceChildren(h('form', {
    class: 'fx-fields',
    onsubmit: async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        await api('/portal/api/join', {
          method: 'POST',
          body: JSON.stringify({
            name: name.value, email: email.value, practiceName: practiceName.value, phone: phone.value,
          }),
        });
        location.assign('/portal/waiting');
      } catch (error) {
        toast(error.message, 'danger');
        button.disabled = false;
      }
    },
  },
  field('Name', name), field('Email', email), field('Practice', practiceName), field('Phone', phone), button,
  h('a', { href: '/portal/sign-in' }, 'Sign in')));
}

function field(label, control) {
  return h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, label), control);
}

function showWaiting() {
  setState('no-access');
  $('no-access').replaceChildren(h('h1', { class: 'fx-title' }, 'Waiting for the lab'));
}

function showSignIn() {
  setState('signed-out');
  $('join').hidden = true;
  $('sign-in').hidden = false;
  window.Clerk.mountSignIn($('sign-in'), { appearance: appearance() });
}

async function renderJobs(main) {
  main.className = 'fx-main';
  let jobs = [];
  let query = '';
  let mine = false;
  let view = { match: 'all', groups: [] };
  const head = listHead('Jobs', {});
  const table = h('table', { class: 'fx-table' },
    h('thead', {}, h('tr', {}, ...['Case', 'Item', 'Dentist', 'Status', 'Due'].map((label) => h('th', {}, label)))),
    h('tbody', {}));
  cardRows(table, { areas: ['case status', 'item due', 'dentist dentist'], columns: '1fr auto' });
  const frame = listFrame(main, table);
  const find = findBox(h, { label: 'Search', oninput: (value) => { query = value.trim().toLowerCase(); draw(); } });
  const mineButton = h('button', {
    type: 'button', class: 'fx-chip', 'aria-pressed': 'false',
    onclick: () => {
      mine = !mine;
      mineButton.setAttribute('aria-pressed', String(mine));
      draw();
    },
  }, 'Mine');
  const filter = viewBar(h).filterMenu({
    fields: () => [{ value: 'status', label: 'Status' }],
    kindOf: () => 'choice',
    choicesOf: () => STAGES.map((name) => ({ value: name, label: name })),
    view: () => view,
    change: (patch) => { view = { ...view, ...patch }; draw(); },
    first: 'status',
    empty: 'Every job',
  });
  filter.draw();
  head.bar.querySelector('.fx-toolbar__end')?.prepend(find.element);
  head.bar.querySelector('.fx-toolbar')?.prepend(h('div', { class: 'fx-viewbar', role: 'group', 'aria-label': 'Filter' }, ...filter.node), mineButton);
  const draw = () => {
    const found = filterJobs(jobs, view, {
      valueOf: (job, key) => (key === 'status' ? job.status : null),
      kindOf: () => 'choice',
      today: new Date().toISOString().slice(0, 10),
    }).filter((job) => {
      if (mine && (job.dentist || '').toLowerCase() !== (me.member.practitionerName || '').toLowerCase()) return false;
      if (!query) return true;
      return [job.caseRef, job.item, job.dentist, job.status].join(' ').toLowerCase().includes(query);
    });
    table.tBodies[0].replaceChildren(...found.map((job) => h('tr', {
      onclick: () => go(`/portal/jobs/${job.id}`),
      style: 'cursor: pointer',
    },
    h('td', { 'data-label': 'Case', 'data-area': 'case' }, job.caseRef || '—'),
    h('td', { 'data-label': 'Item', 'data-area': 'item' }, job.item || '—'),
    h('td', { 'data-label': 'Dentist', 'data-area': 'dentist' }, job.dentist || '—'),
    h('td', { 'data-label': 'Status', 'data-area': 'status' }, job.status ? h('span', { class: 'fx-status' }, job.status) : '—'),
    h('td', { 'data-label': 'Due', 'data-area': 'due', class: 'fx-due', 'data-late': job.late ? 'true' : null }, job.dueOn || '—'))));
    frame.count(`${found.length} job${found.length === 1 ? '' : 's'}`);
  };
  main.replaceChildren(...head.nodes, frame.element);
  try {
    jobs = (await api('/portal/api/jobs')).jobs;
    draw();
  } catch (error) {
    toast(error.message, 'danger', { stay: true });
  }
}

function track(job) {
  return h('ol', { class: 'fx-track' }, ...(job.track ?? []).map((step) => h('li', { 'data-state': step.state }, step.name)));
}

async function renderJob(main, id) {
  main.className = 'fx-main';
  main.replaceChildren(h('p', { class: 'fx-loading', role: 'status' }, 'Opening…'));
  let job;
  try {
    job = (await api(`/portal/api/jobs/${id}`)).job;
  } catch (error) {
    main.replaceChildren(pageHeader('Job'), h('p', {}, error.message));
    return;
  }
  main.replaceChildren(
    crumbs(['/portal/jobs', 'Jobs'], job.caseRef || 'Job'),
    pageHeader(job.caseRef || 'Job'),
    h('section', { class: 'fx-card' },
      track(job),
      h('dl', { class: 'fx-meta' },
        fact('Item', (job.items ?? []).join(', ') || '—'),
        fact('Dentist', job.dentist || '—'),
        fact('Due', h('span', { class: 'fx-due', 'data-late': job.late ? 'true' : null }, job.dueOn || '—')),
        fact('Status', job.status || '—'))),
  );
  main.querySelector('.fx-crumbs a')?.addEventListener('click', (event) => {
    event.preventDefault();
    go('/portal/jobs');
  });
}

function fact(label, value) {
  return h('div', {}, h('dt', {}, label), h('dd', {}, value));
}

async function renderTeam(main) {
  main.className = 'fx-main';
  const head = listHead('Team', { actions: [h('button', { class: 'fx-btn fx-btn--primary', type: 'button', onclick: () => invite() }, 'Invite')] });
  const table = h('table', { class: 'fx-table' },
    h('thead', {}, h('tr', {}, ...['Name', 'Email', 'Role', ''].map((label) => h('th', {}, label)))),
    h('tbody', {}));
  const frame = listFrame(main, table);
  main.replaceChildren(...head.nodes, frame.element);
  const load = async () => {
    const members = (await api('/portal/api/team')).members;
    table.tBodies[0].replaceChildren(...members.map((member) => h('tr', {},
      h('td', { 'data-label': 'Name' }, member.name || '—'),
      h('td', { 'data-label': 'Email' }, member.email),
      h('td', { 'data-label': 'Role' }, member.role),
      h('td', {}, member.id === me.member.id ? null : rowMenu('Member', () => [
        ...(me.member.role === 'owner' || member.role !== 'owner' ? [{ text: 'Remove', tone: 'danger', run: () => remove(member) }] : []),
      ])))));
    frame.count(`${members.length} member${members.length === 1 ? '' : 's'}`);
  };
  async function invite() {
    const roles = me.member.role === 'owner' ? ['owner', 'admin', 'dentist', 'staff'] : ['admin', 'dentist', 'staff'];
    const name = h('input', { class: 'fx-input', name: 'name' });
    const email = h('input', { class: 'fx-input', type: 'email', name: 'email', required: true });
    const role = h('select', { class: 'fx-select', name: 'role' }, ...roles.map((value) => h('option', { value }, value)));
    const dentist = h('input', { class: 'fx-input', name: 'practitionerName' });
    const form = await dialog({
      title: 'Invite',
      confirm: 'Invite',
      body: h('div', { class: 'fx-fields' }, field('Name', name), field('Email', email), field('Role', role), field('Dentist', dentist)),
    });
    if (!form) return;
    try {
      await api('/portal/api/team', {
        method: 'POST',
        body: JSON.stringify({
          name: form.get('name'), email: form.get('email'), role: form.get('role'), practitionerName: form.get('practitionerName'),
        }),
      });
      toast('Invited.', 'success');
      await load();
    } catch (error) {
      toast(error.message, 'danger', { stay: true });
    }
  }
  async function remove(member) {
    const ok = await dialog({ title: 'Remove', confirm: 'Remove', tone: 'danger', body: h('p', {}, member.email) });
    if (!ok) return;
    try {
      await api(`/portal/api/team/${member.id}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      toast(error.message, 'danger', { stay: true });
    }
  }
  try {
    await load();
  } catch (error) {
    toast(error.message, 'danger', { stay: true });
  }
}

function route() {
  const parts = location.pathname.replace(/\/+$/, '').split('/');
  const page = parts[2] || 'jobs';
  const id = parts[3] || null;
  drawNav();
  const main = $('main');
  if (page === 'team') return renderTeam(main);
  if (page === 'jobs' && id) return renderJob(main, id);
  return renderJobs(main);
}

function installMenu() {
  const toggle = $('menu-toggle');
  const shell = $('shell');
  if (!toggle || !shell || toggle.dataset.ready) return;
  toggle.dataset.ready = 'true';
  const mark = document.createElement('span');
  mark.className = 'fx-toggle__mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = document.querySelector('.fx-side__head .fx-brand svg')?.outerHTML ?? '';
  const icon = document.createElement('span');
  icon.className = 'fx-ico fx-toggle__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/></svg>';
  toggle.replaceChildren(mark, icon);
  const narrow = window.matchMedia('(max-width: 820px)');
  const sync = () => {
    const open = shell.hasAttribute('data-menu-open');
    toggle.setAttribute('aria-expanded', String(open));
    const label = open ? 'Close the menu' : 'Open the menu';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  };
  toggle.addEventListener('click', () => {
    if (!narrow.matches) return;
    shell.toggleAttribute('data-menu-open');
    sync();
  });
  document.addEventListener('click', (event) => {
    if (!shell.hasAttribute('data-menu-open') || event.target.closest('#menu-toggle')) return;
    shell.removeAttribute('data-menu-open');
    sync();
  });
  sync();
}

async function signedIn() {
  me = await api('/portal/api/me');
  setState('signed-in');
  installMenu();
  window.Clerk.mountUserButton?.($('user-button'), { appearance: appearance() });
  route();
}

async function start() {
  let config;
  try {
    config = await fetch('/portal/api/auth/config').then((res) => res.json());
  } catch {
    setState('error');
    return;
  }
  if (config.mode !== 'clerk') {
    setState('off');
    return;
  }
  try {
    await loadClerk(config.clerk);
    await window.Clerk.load({ appearance: appearance() });
  } catch {
    setState('error');
    return;
  }
  const page = location.pathname.replace(/\/+$/, '');
  if (!window.Clerk.session) {
    if (page === '/portal/waiting') return showWaiting();
    if (page === '/portal/join') return showJoin();
    return showSignIn();
  }
  try {
    await signedIn();
  } catch (error) {
    if (error.code === 'access_pending' || page === '/portal/waiting') return showWaiting();
    if (error.code === 'not_invited' || page === '/portal/join') return showJoin();
    setState('no-access');
    $('no-access').replaceChildren(h('h1', { class: 'fx-title' }, 'No access'), h('p', {}, error.message));
  }
}

window.addEventListener('popstate', () => { if (me) route(); });
start();
