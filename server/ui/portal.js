// The practice portal (/portal): sign-in, Join, Jobs, one job and Team.
// It reuses the lab's list, filter, dialog and Clerk appearance
// (docs/PORTAL.md). A practice never sees another practice's rows.
import { flowClerkAppearance } from '/assets/ui/clerk-appearance.js';
import { lucide } from '/assets/ui/custom-fields.js';
import { filterJobs } from '/assets/ui/job-view.js';
import { cardRows, crumbs, dialog, h, linksOpenWith, listFrame, listHead, notice, pageHeader, rowMenu, toast } from '/assets/ui/kit.js';
import { findBox, today, viewBar } from '/assets/ui/view-bar.js';

const $ = (id) => document.getElementById(id);
const STAGES = ['Ordered', 'Received', 'In work', 'Quality check', 'Sent'];
const ROLE = { owner: 'Owner', admin: 'Admin', dentist: 'Dentist', staff: 'Staff' };
const KINDS = { case: 'text', item: 'text', dentist: 'text', status: 'choice', due: 'date' };

let config = null;
let session = null;
let practiceId = null;
let booted = null;

const pathOf = () => location.pathname.replace(/\/+$/, '') || '/portal';

function dayLabel(iso) {
  if (!iso) return '';
  const [year, month, day] = String(iso).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return '';
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function isLate(job) {
  return Boolean(job.due && job.due < today() && job.status !== 'Sent');
}

function withPractice(url) {
  if (!practiceId) return url;
  const join = url.includes('?') ? '&' : '?';
  return `${url}${join}practice=${encodeURIComponent(practiceId)}`;
}

async function flow(url, options = {}) {
  const token = await window.Clerk?.session?.getToken();
  const res = await fetch(withPractice(url), {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, code: body.code, request: body.request });
  return body;
}

function go(href) {
  if (location.pathname !== href) history.pushState(null, '', href);
  return route();
}

linksOpenWith((href) => { go(href); });

function openLink(event) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  go(event.currentTarget.getAttribute('href'));
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

function showOff() {
  document.body.dataset.state = 'off';
  document.title = 'Portal · Flow';
}

function showError() {
  document.body.dataset.state = 'error';
  document.title = 'Portal · Flow';
}

function showWaiting(request) {
  document.body.dataset.state = 'no-access';
  document.title = 'Waiting · Flow';
  const declined = request?.status === 'declined';
  const practice = request?.practiceName ? `${request.practiceName} is waiting for the lab.` : 'Ask the lab to approve access, or join.';
  $('portal-waiting').replaceChildren(
    h('h1', { class: 'fx-title' }, declined ? 'Declined' : 'Waiting'),
    h('p', {}, declined ? 'The lab declined this request. Ask the lab, or join again.' : practice),
    h('a', { class: 'fx-btn', href: '/portal/join' }, 'Join'),
  );
}

function showJoin() {
  document.body.dataset.state = 'signed-out';
  document.title = 'Join · Flow';
  $('portal-sign-in').hidden = true;
  $('portal-join').hidden = false;
  document.querySelector('.fx-portal-signin-join')?.setAttribute('hidden', '');
  if ($('portal-join').childElementCount) return;
  const field = (name, label, type, required = true) => h('label', { class: 'fx-field' },
    h('span', { class: 'fx-label' }, label),
    h('input', { class: 'fx-input', name, type, required, autocomplete: 'off' }));
  const form = h('form', { class: 'fx-portal-join', onsubmit: submitJoin },
    field('name', 'Name', 'text'),
    field('email', 'Email', 'email'),
    field('practiceName', 'Practice', 'text'),
    field('phone', 'Phone', 'tel', false),
    h('button', { class: 'fx-btn fx-btn--primary', type: 'submit' }, 'Join'),
    h('p', {}, 'Already invited? ', h('a', { href: '/portal/sign-in' }, 'Sign in')));
  $('portal-join').replaceChildren(form);
}

async function submitJoin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  const body = Object.fromEntries(new FormData(form));
  try {
    const res = await fetch('/portal/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 201) {
      showWaiting({ status: 'open', practiceName: body.practiceName });
      return;
    }
    if (json.code === 'portal_off') {
      showOff();
      return;
    }
    toast(json.error || 'Join failed.', 'danger');
  } catch {
    toast('Check the connection, then try again.', 'danger');
  } finally {
    button.disabled = false;
  }
}

function showSignIn() {
  document.body.dataset.state = 'signed-out';
  document.title = 'Sign in · Flow';
  $('portal-join').hidden = true;
  const panel = $('portal-sign-in');
  panel.hidden = false;
  const Clerk = window.Clerk;
  const appearance = flowClerkAppearance({ publicSignUp: config?.publicSignUp });
  if (new URLSearchParams(location.search).has('__clerk_ticket')) {
    $('portal-note').textContent = 'Finish your invitation to Flow.';
    Clerk.mountSignUp(panel, { appearance, forceRedirectUrl: '/portal/sign-in', signInUrl: '/portal/sign-in' });
  } else {
    $('portal-note').textContent = '';
    Clerk.mountSignIn(panel, {
      appearance,
      forceRedirectUrl: '/portal/sign-in',
      withSignUp: Boolean(config?.publicSignUp),
      transferable: Boolean(config?.publicSignUp),
    });
  }
  const form = document.querySelector('.fx-auth__form');
  if (!form.querySelector('.fx-portal-signin-join')) {
    form.append(h('p', { class: 'fx-portal-signin-join' }, 'New practice? ', h('a', { href: '/portal/join' }, 'Join')));
  }
  document.querySelector('.fx-portal-signin-join')?.removeAttribute('hidden');
}

function drawShell() {
  if ($('nav').childElementCount) return;
  const toggle = $('menu-toggle');
  toggle.replaceChildren(lucide(h, 'menu'));
  toggle.addEventListener('click', () => {
    const open = $('shell').toggleAttribute('data-menu-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') $('shell').removeAttribute('data-menu-open');
  });
  const practice = session.practices.find((row) => row.contactId === practiceId) ?? session.practices[0];
  const practiceNode = session.practices.length > 1
    ? h('select', {
      class: 'fx-select', 'aria-label': 'Practice',
      onchange: (event) => { practiceId = event.target.value; route(); },
    }, session.practices.map((row) => h('option', { value: row.contactId, selected: row.contactId === practiceId }, row.name)))
    : h('p', { class: 'fx-portal-practice' }, practice?.name ?? '');
  const manage = ['owner', 'admin'].includes(session.member.role);
  const items = [
    ['/portal/jobs', 'Jobs', false],
    ['/portal/requests', 'Requests', true],
    ['/portal/messages', 'Messages', true],
    ['/portal/team', 'Team', !manage],
    ['/portal/alerts', 'Alerts', true],
  ];
  $('nav').replaceChildren(practiceNode, ...items.map(([href, label, hidden]) => h('a', { href, hidden, onclick: openLink }, label)));
  window.Clerk.mountUserButton?.($('user-button'), { appearance: flowClerkAppearance() });
}

function markNav() {
  const here = pathOf();
  for (const link of document.querySelectorAll('#nav a')) {
    const href = link.getAttribute('href');
    const on = here === href || (href === '/portal/jobs' && here.startsWith('/portal/jobs'));
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function jobValue(job, field) {
  return { case: job.caseRef, item: job.item, dentist: job.dentist, status: job.status, due: job.due }[field] ?? null;
}

async function renderJobs(main) {
  let all = [];
  try {
    all = (await flow('/portal/api/jobs')).jobs ?? [];
  } catch (error) {
    main.append(notice(error.message, 'danger'));
    return;
  }
  let jobsView = { match: 'all', groups: [] };
  let query = '';
  let mineOn = false;
  const bar = viewBar(h);
  const filter = bar.filterMenu({
    fields: () => [
      { value: 'case', label: 'Case' },
      { value: 'item', label: 'Item' },
      { value: 'dentist', label: 'Dentist' },
      { value: 'status', label: 'Status' },
      { value: 'due', label: 'Due' },
    ],
    kindOf: (field) => KINDS[field] ?? null,
    choicesOf: (field) => (field === 'status' ? STAGES.map((stage) => ({ value: stage, label: stage })) : []),
    view: () => jobsView,
    change: (patch) => { jobsView = { ...jobsView, ...patch }; draw(); },
    first: 'case',
  });
  filter.draw();
  const find = findBox(h, { label: 'Find a case, item or dentist', oninput: (value) => { query = value; draw(); } });
  const mine = h('button', {
    type: 'button', class: 'fx-chip', 'aria-pressed': 'false',
    onclick: () => {
      mineOn = !mineOn;
      mine.setAttribute('aria-pressed', mineOn ? 'true' : 'false');
      draw();
    },
  }, 'Mine');
  const head = listHead('Jobs', { controls: [...filter.node, mine], end: [find.element] });
  const body = h('tbody');
  const table = h('table', { class: 'fx-table' },
    h('thead', {}, h('tr', {}, ...['Case', 'Item', 'Dentist', 'Status', 'Due'].map((name) => h('th', {}, name)))),
    body);
  cardRows(table, { areas: ['case status', 'item item', 'dentist due'], columns: 'minmax(0, 1fr) minmax(0, 1fr)' });
  const frame = listFrame(main, table);
  main.append(...head.nodes, frame.element);

  function shown() {
    const needle = query.trim().toLowerCase();
    let rows = needle
      ? all.filter((job) => [job.caseRef, job.item, job.dentist, job.status].some((value) => String(value ?? '').toLowerCase().includes(needle)))
      : all;
    rows = filterJobs(rows, jobsView, { valueOf: jobValue, kindOf: (field) => KINDS[field] ?? null, late: isLate, today: today() });
    if (mineOn) {
      const name = String(session.member.practitionerName ?? '').trim().toLowerCase();
      rows = rows.filter((job) => name && String(job.dentist ?? '').trim().toLowerCase() === name);
    }
    return rows;
  }

  function draw() {
    const rows = shown();
    body.replaceChildren(...rows.map((job) => h('tr', {},
      h('td', { 'data-area': 'case', 'data-label': 'Case', title: job.caseRef },
        h('a', { href: `/portal/jobs/${job.id}`, onclick: openLink }, job.caseRef || 'Case')),
      h('td', { 'data-area': 'item', 'data-label': 'Item', title: job.item }, job.item),
      h('td', { 'data-area': 'dentist', 'data-label': 'Dentist', title: job.dentist }, job.dentist),
      h('td', { 'data-area': 'status', 'data-label': 'Status' }, job.status ? h('span', { class: 'fx-tag' }, job.status) : ''),
      h('td', { 'data-area': 'due', 'data-label': 'Due', class: isLate(job) ? 'fx-job__date--late' : '', title: dayLabel(job.due) }, dayLabel(job.due)))));
    if (!rows.length) body.append(h('tr', {}, h('td', { colspan: '5' }, 'No jobs.')));
    frame.count(`${rows.length} ${rows.length === 1 ? 'job' : 'jobs'}`);
  }
  draw();
}

function meta(label, value, late = false) {
  return [h('dt', {}, label), h('dd', { class: late ? 'fx-job__date--late' : '' }, value || '—')];
}

async function renderJob(main, id) {
  let job;
  try {
    job = (await flow(`/portal/api/jobs/${id}`)).job;
  } catch (error) {
    main.append(crumbs(['/portal/jobs', 'Jobs'], 'Job'), notice(error.message, 'danger'));
    return;
  }
  const item = (job.lines ?? []).map((line) => line.description).filter(Boolean).join(', ') || job.item;
  main.append(
    crumbs(['/portal/jobs', 'Jobs'], job.caseRef || 'Job'),
    pageHeader(job.caseRef || 'Job'),
    h('ol', { class: 'fx-track' }, (job.track ?? []).map((step) => h('li', { 'data-state': step.state }, step.name))),
    h('dl', { class: 'fx-meta' },
      ...meta('Case', job.caseRef),
      ...meta('Item', item),
      ...meta('Dentist', job.dentist),
      ...meta('Ordered', dayLabel(job.orderedOn)),
      ...meta('Due', dayLabel(job.due), isLate(job))));
}

async function renderTeam(main) {
  const manage = ['owner', 'admin'].includes(session.member.role);
  if (!manage) {
    main.append(pageHeader('Team'), notice('An owner or an admin looks after the team.', 'info'));
    return;
  }
  let team = [];
  try {
    team = (await flow('/portal/api/team')).team ?? [];
  } catch (error) {
    main.append(pageHeader('Team'), notice(error.message, 'danger'));
    return;
  }
  const invite = h('button', { class: 'fx-btn fx-btn--primary', type: 'button', onclick: () => inviteMember() }, 'Invite');
  const rows = team.filter((member) => member.status !== 'removed');
  const body = h('tbody', {}, rows.map((member) => h('tr', {},
    h('td', { 'data-area': 'name', 'data-label': 'Name' }, member.name || member.email, member.invited ? h('span', { class: 'fx-dim' }, ' Invited') : ''),
    h('td', { 'data-area': 'email', 'data-label': 'Email' }, member.email),
    h('td', { 'data-area': 'role', 'data-label': 'Role' }, ROLE[member.role] ?? member.role),
    h('td', { 'data-area': 'menu', 'data-label': 'Actions' }, memberMenu(member)))));
  const table = h('table', { class: 'fx-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', { class: 'fx-sr' }, 'Actions'))),
    body);
  cardRows(table, { areas: ['name menu', 'email role'], columns: 'minmax(0, 1fr) auto' });
  main.append(pageHeader('Team', { actions: [invite] }), table);

  function memberMenu(member) {
    if (member.id === session.member.id) return null;
    if (session.member.role !== 'owner' && member.role === 'owner') return null;
    const roles = (session.member.role === 'owner' ? ['owner', 'admin', 'dentist', 'staff'] : ['admin', 'dentist', 'staff'])
      .filter((role) => role !== member.role);
    const items = [
      ...roles.map((role) => ({ text: ROLE[role], run: () => changeRole(member, role) })),
      '-',
      { text: 'Remove', tone: 'danger', run: () => removeMember(member) },
    ];
    return rowMenu(`Actions for ${member.name || member.email}`, items);
  }
}

async function inviteMember() {
  const roles = session.member.role === 'owner' ? ['owner', 'admin', 'dentist', 'staff'] : ['admin', 'dentist', 'staff'];
  const dentist = h('label', { class: 'fx-field', hidden: true },
    h('span', { class: 'fx-label' }, 'Dentist'),
    h('input', { class: 'fx-input', name: 'practitionerName', autocomplete: 'off' }));
  const role = h('select', {
    class: 'fx-select', name: 'role', 'aria-label': 'Role',
    onchange: () => { dentist.hidden = role.value !== 'dentist'; },
  }, roles.map((value) => h('option', { value, selected: value === 'staff' }, ROLE[value])));
  const data = await dialog({
    title: 'Invite',
    confirm: 'Invite',
    body: h('div', { class: 'fx-fields' },
      h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, 'Name'), h('input', { class: 'fx-input', name: 'name', autocomplete: 'off' })),
      h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, 'Email'), h('input', { class: 'fx-input', name: 'email', type: 'email', required: true, autocomplete: 'off' })),
      h('label', { class: 'fx-field' }, h('span', { class: 'fx-label' }, 'Role'), role),
      dentist),
  });
  if (!data) return;
  try {
    await flow('/portal/api/team', {
      method: 'POST',
      body: JSON.stringify({
        name: data.get('name'),
        email: data.get('email'),
        role: data.get('role'),
        practitionerName: data.get('role') === 'dentist' ? data.get('practitionerName') : null,
      }),
    });
    toast('Invited.', 'success');
    await route();
  } catch (error) {
    toast(error.message, 'danger');
  }
}

async function changeRole(member, role) {
  try {
    await flow(`/portal/api/team/${member.id}`, { method: 'PATCH', body: JSON.stringify({ role }) });
    await route();
  } catch (error) {
    toast(error.message, 'danger');
  }
}

async function removeMember(member) {
  const ok = await dialog({
    title: 'Remove',
    body: h('p', {}, `Remove ${member.name || member.email}.`),
    confirm: 'Remove',
    tone: 'danger',
  });
  if (!ok) return;
  try {
    await flow(`/portal/api/team/${member.id}`, { method: 'DELETE' });
    toast('Removed.', 'success');
    await route();
  } catch (error) {
    toast(error.message, 'danger');
  }
}

async function fail(error) {
  if (error.code === 'portal_off') {
    showOff();
    return;
  }
  if (error.code === 'not_a_member') {
    showWaiting(error.request);
    return;
  }
  if (error.status === 401 || error.code === 'signed_out' || error.code === 'session_expired') {
    showSignIn();
    return;
  }
  showError();
}

async function route() {
  if (pathOf() === '/portal/join') {
    showJoin();
    return;
  }
  if (!window.Clerk?.user) {
    showSignIn();
    return;
  }
  if (!session) {
    try {
      session = await flow('/portal/api/me');
      practiceId = session.practice;
    } catch (error) {
      await fail(error);
      return;
    }
    drawShell();
  }
  document.body.dataset.state = 'signed-in';
  const here = pathOf();
  const main = $('main');
  main.className = 'fx-main';
  main.replaceChildren();
  markNav();
  $('shell').removeAttribute('data-menu-open');
  if (here === '/portal/team') await renderTeam(main);
  else if (/^\/portal\/jobs\/[^/]+$/.test(here)) await renderJob(main, here.split('/').pop());
  else {
    if (here !== '/portal/jobs') history.replaceState(null, '', '/portal/jobs');
    document.title = 'Jobs · Flow';
    await renderJobs(main);
    return;
  }
  document.title = `${here === '/portal/team' ? 'Team' : 'Job'} · Flow`;
}

async function boot() {
  config = await fetch('/api/auth/config').then((res) => res.json()).catch(() => null);
  if (!config || config.mode !== 'clerk') {
    showOff();
    return;
  }
  await loadClerk(config.clerk);
  await window.Clerk.load({
    ui: { ClerkUI: window.__internal_ClerkUICtor },
    appearance: flowClerkAppearance({ publicSignUp: config.publicSignUp }),
    localization: {
      signIn: { start: { title: 'Sign in to Flow', subtitle: 'Your work, as it moves.' } },
      signUp: { start: { title: 'Finish your invitation', subtitle: 'Use the email the lab invited.' } },
    },
  });
  const opened = Boolean(window.Clerk.user);
  window.Clerk.addListener(({ user }) => { if (user && !opened) location.reload(); });
}

async function start() {
  if (pathOf() === '/portal/join') {
    showJoin();
    return;
  }
  try {
    booted ??= boot();
    await booted;
    if (document.body.dataset.state === 'off') return;
    await route();
  } catch {
    if (document.body.dataset.state === 'loading') showError();
  }
}

window.addEventListener('popstate', () => { start(); });
start();
