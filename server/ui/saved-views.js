// Saved views: the named view tabs of a list (Jobs, Invoices, Reconcile),
// as ClickUp's, in the toolbar beside Group, Sort and Filter (listHead). A view keeps the page's Group, Sort, Filter and
// Columns under a name. A tab shows it; "Save" and "Revert" show when the
// page no longer matches the chosen tab; "+ View" saves the page as a new
// view. Each tab's ⋯ menu has "Set as my default" (the view that opens
// when the person comes to the page), Rename and Delete. The views follow
// the person's account (PUT /api/me/saved-views/:page, list-views.js).
//
//   const views = savedViews(ui, { page, current, apply });
//   views.element   the tabs, for listHead's `views`
//   views.opening() the view to open on, or null: the default view on the
//                   first visit in this browser tab, else the page's own
//   views.draw()    call after any change to the page's view
import { lucide } from '/assets/ui/custom-fields.js';
import { rowMenu } from '/assets/ui/kit.js';
import { MAX_SAVED_VIEWS, normaliseSavedViews, sameView } from '/assets/ui/list-views.js';
import { applyPhoneRule } from './mobile.js';

const ACTIVE_KEY = (page) => `flow_view_tab_${page}`;

function readActive(page) {
  try { return sessionStorage.getItem(ACTIVE_KEY(page)); } catch { return null; }
}
function writeActive(page, id) {
  try {
    if (id) sessionStorage.setItem(ACTIVE_KEY(page), id);
    else sessionStorage.removeItem(ACTIVE_KEY(page));
  } catch { /* the tab is forgotten on the next visit */ }
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export function savedViews(ui, { page, current, apply }) {
  const { h, flow, dialog, toast } = ui;
  let saved = normaliseSavedViews(page, ui.me?.views?.saved?.[page]);
  let active = null;
  const element = applyPhoneRule(h('div', { class: 'fx-views', role: 'tablist', 'aria-label': 'Views' }), 'savedViews');
  const chosen = () => saved.list.find((v) => v.id === active) ?? null;

  async function store(next) {
    const before = saved;
    saved = normaliseSavedViews(page, next);
    if (ui.me) ui.me.views = { ...ui.me.views, saved: { ...ui.me.views?.saved, [page]: saved } };
    draw();
    try {
      await flow(`/api/me/saved-views/${page}`, { method: 'PUT', body: JSON.stringify(saved) });
    } catch {
      saved = before;
      draw();
      toast?.('Flow could not save your views. Try again.', 'danger');
    }
  }

  function choose(id) {
    active = id;
    writeActive(page, id);
    const view = chosen();
    if (view) apply(view.view);
    draw();
  }

  // A name for a view: a dialog with one box.
  async function askName(title, value, confirm) {
    const data = await dialog({
      title,
      body: h('div', { class: 'fx-fields' }, h('label', { class: 'fx-field' },
        h('span', { class: 'fx-label' }, 'Name'),
        h('input', { class: 'fx-input', name: 'name', required: true, maxlength: '60', autocomplete: 'off', value }))),
      confirm,
    });
    const name = data?.get('name')?.toString().trim();
    return name || null;
  }

  async function addView() {
    const name = await askName('Save view', `View ${saved.list.length + 1}`, 'Save');
    if (!name) return;
    const id = newId();
    await store({ ...saved, list: [...saved.list, { id, name, view: current() }] });
    active = id;
    writeActive(page, id);
    draw();
  }

  async function rename(view) {
    const name = await askName('Rename view', view.name, 'Rename');
    if (name) await store({ ...saved, list: saved.list.map((v) => (v.id === view.id ? { ...v, name } : v)) });
  }

  async function remove(view) {
    const ok = await dialog({ title: `Delete "${view.name}"?`, body: h('p', {}, 'The list stays as it is now.'), confirm: 'Delete', tone: 'danger' });
    if (!ok) return;
    if (active === view.id) { active = null; writeActive(page, null); }
    await store({ list: saved.list.filter((v) => v.id !== view.id), default: saved.default === view.id ? null : saved.default });
  }

  const setDefault = (view) => store({ ...saved, default: saved.default === view.id ? null : view.id });

  function draw() {
    const view = chosen();
    const changed = Boolean(view) && !sameView(page, view.view, current());
    const tabs = saved.list.map((v) => {
      const on = v.id === active;
      const isDefault = saved.default === v.id;
      const [more, menu] = rowMenu(`More for ${v.name}`, [
        { icon: isDefault ? 'house' : 'house-plus', text: isDefault ? 'Not my default' : 'Set as my default', run: () => setDefault(v) },
        { icon: 'pencil', text: 'Rename', run: () => rename(v) },
        '-',
        { icon: 'trash-2', text: 'Delete', tone: 'danger', run: () => remove(v) },
      ], { align: 'start' });
      return h('span', { class: 'fx-views__item', 'data-on': String(on) },
        h('button', {
          type: 'button', class: 'fx-views__tab', role: 'tab', 'aria-selected': String(on),
          title: isDefault ? `${v.name} (your default)` : v.name,
          onclick: () => choose(v.id),
        }, isDefault ? lucide(h, 'house', 'Your default') : null, h('span', { class: 'fx-views__name' }, v.name), on && changed ? h('span', { class: 'fx-views__dot', 'aria-label': 'Changed', title: 'Changed' }) : null),
        more, menu);
    });
    // A tab list needs tabs: with no saved view yet it is a plain group.
    element.setAttribute('role', tabs.length ? 'tablist' : 'group');
    element.replaceChildren(...[
      ...tabs,
      saved.list.length < MAX_SAVED_VIEWS ? h('button', { type: 'button', class: 'fx-views__add', title: 'Save as a view', onclick: addView }, lucide(h, 'plus'), 'View') : null,
      changed ? h('span', { class: 'fx-views__end' },
        h('button', { type: 'button', class: 'fx-btn fx-btn--ghost fx-btn--sm', onclick: () => { apply(view.view); draw(); } }, 'Revert'),
        h('button', { type: 'button', class: 'fx-btn fx-btn--primary fx-btn--sm', onclick: () => store({ ...saved, list: saved.list.map((v) => (v.id === view.id ? { ...v, view: current() } : v)) }) }, 'Save')) : null,
    ].filter(Boolean));
  }

  // The view the page opens on. In the same browser tab, the tab chosen
  // last stays chosen and the page keeps its own view; on a new visit the
  // person's default view opens.
  function opening() {
    const kept = readActive(page);
    if (kept && saved.list.some((v) => v.id === kept)) { active = kept; return null; }
    const first = saved.list.find((v) => v.id === saved.default);
    if (!first) return null;
    active = first.id;
    writeActive(page, first.id);
    return first.view;
  }

  return { element, opening, draw };
}
