// Settings, Custom fields (/custom-fields; server/core/custom-fields.js,
// docs/CUSTOM_FIELDS.md). The fields a lab makes for its jobs, laid out like
// ClickUp's Custom Field Manager: one table, with a group per type that folds
// open and closed, and one row per field with its type icon, who made it,
// when, and where it applies. Search, a type filter and Filter (archived
// fields) sit above it. A row's Edit opens ClickUp's sidecar from the right
// (name, colour, options); options show only there. Its ⋯ menu has Rename,
// Colour, Duplicate, Copy field ID, Archive and Delete. A group's pill picks
// the group's colour. Each colour picker shows the real pill in every
// colour, so a person sees what they get. The work systems' own fields
// (Seazona's stage) sit in their own group, read only: View opens their
// stages, and Date created is the day the system was connected.
// Everyone can read the page; an owner or admin changes it. The caller
// passes in app.js's shared pieces as `ui`.

import { orderStatuses, statusRank } from '/assets/ui/job-board.js';

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/CUSTOM_FIELDS.md';
const TYPE_LABELS = {
  dropdown: 'Dropdown', person: 'Person', checkbox: 'Checkbox', date: 'Date', number: 'Number', text: 'Text',
};
// Each type's icon (Lucide, served at /assets/icons/). Group colours come
// from the server (groupColors); a field's own colour wins over its group's.
const TYPE_ICONS = {
  dropdown: 'square-chevron-down', person: 'user-round', checkbox: 'square-check', date: 'calendar', number: 'hash', text: 'type',
};
const FOLDED_KEY = 'flow_custom_fields_folded';
const colorName = (c) => c[0].toUpperCase() + c.slice(1);
let pickerCount = 0;

// A colour picker: a button that shows `face()` (by default the real pill,
// `sample()`) in the colour now chosen, and a popover with the pill in
// every colour.
// `onpick(color)` gets the choice; the button follows it unless onpick
// answers false.
export function colorPicker(h, { colors, value, sample, face = sample, label, onpick, disabled = false }) {
  let current = value;
  const id = `fx-cf-colour-${++pickerCount}`;
  const button = h('button', {
    class: 'fx-cf__swatch', type: 'button', 'aria-label': label, 'aria-haspopup': 'dialog', popovertarget: id, disabled, title: disabled ? null : 'Change colour',
  });
  const panel = h('div', { class: 'fx-pop fx-cf__palette', id, popover: 'auto', role: 'dialog', 'aria-label': label });
  const draw = () => button.replaceChildren(...[face(current), disabled || face !== sample ? null : lucide(h, 'chevron-down')].filter(Boolean));
  const choose = async (color) => {
    panel.hidePopover();
    if (await onpick(color) === false) return;
    current = color;
    draw();
  };
  panel.addEventListener('toggle', (event) => {
    button.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState !== 'open') return;
    panel.replaceChildren(h('p', { class: 'fx-pop__head' }, 'Colour'), h('div', { class: 'fx-cf__grid', role: 'radiogroup', 'aria-label': label },
      colors.map((c) => h('button', {
        type: 'button', class: 'fx-cf__choice', role: 'radio', 'aria-checked': String(c === current), title: colorName(c), onclick: () => choose(c),
      }, sample(c), h('span', { class: 'fx-cf__choice-name' }, colorName(c)), c === current ? lucide(h, 'check') : null))));
    const at = button.getBoundingClientRect();
    panel.style.top = `${Math.round(Math.min(at.bottom + 6, innerHeight - panel.offsetHeight - 8))}px`;
    panel.style.left = `${Math.round(Math.max(8, Math.min(at.left, innerWidth - panel.offsetWidth - 8)))}px`;
    panel.querySelector('[aria-checked="true"]')?.focus();
  });
  draw();
  return { button, panel, open: () => panel.showPopover(), set: (c) => { current = c; draw(); } };
}

// A dropdown option as it shows on a job and on the board.
export const optionPill = (h, name, color) => h('span', { class: 'fx-cf__opt', 'data-color': color }, name || 'Option');

// A Lucide icon as a mask, so it takes the text colour.
export function lucide(h, name, label = null) {
  return h('span', { class: 'fx-lucide', style: `--icon: url(/assets/icons/${name}.svg)`, ...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': 'true' }) });
}

// "Today", "Yesterday", else d/m/yy, like ClickUp's Date created.
export function createdDay(iso, now = new Date()) {
  if (!iso) return '';
  const day = new Date(iso);
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(day)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${day.getDate()}/${day.getMonth() + 1}/${String(day.getFullYear()).slice(2)}`;
}

const initials = (name) => (name ?? '').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

function readFolded() {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]')); } catch { return new Set(); }
}
function saveFolded(set) {
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...set])); } catch { /* this browser keeps no state */ }
}

export async function renderCustomFields(main, ui) {
  const { h, flow, toast, notice, dialog, pageHeader, me } = ui;
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  const host = h('div', { class: 'fx-card fx-cfm__card' }, h('div', { class: 'fx-skeleton' }));
  const addButton = h('button', { class: 'fx-btn fx-btn--primary fx-btn--sm', type: 'button', disabled }, 'Create custom field');
  main.append(pageHeader('Custom fields', { subtitle: 'Fields for your jobs. They stay in Flow and never change Seazona or Xero.' }), host);

  let data = null;
  const groupColor = (type) => data?.groupColors?.[type] ?? 'gray';
  const colorOfField = (field) => field.color ?? groupColor(field.type);

  async function send(path, method, payload, done = 'Saved.') {
    try {
      const body = await flow(path, { method, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (done) toast(done, 'success');
      return body;
    } catch (error) {
      toast(error.message, 'danger');
      return null;
    }
  }


  // The option list editor for a dropdown, as in ClickUp's sidecar: one
  // box per option with its colour dot (the picker shows the real pill in
  // every colour) and its name, in lane order, then "Add option".
  function optionsEditor(start, { readOnly = false, changed = () => {} } = {}) {
    const options = start.filter((o) => !o.archived).map((o) => ({ ...o }));
    const list = h('div', { class: 'fx-cfs__options' });
    const add = readOnly ? null : h('button', { class: 'fx-cfs__add', type: 'button' }, lucide(h, 'plus'), 'Add option');
    function draw() {
      list.replaceChildren(...options.map((o, i) => {
        const name = h('input', { class: 'fx-cfs__optname', maxlength: '40', value: o.name, 'aria-label': `Option ${i + 1}`, placeholder: 'Option name', readonly: readOnly });
        const dot = (c) => h('span', { class: 'fx-cfs__dot', 'data-color': c });
        const color = colorPicker(h, {
          colors: data.colors, value: o.color ?? 'gray', label: `Colour of option ${i + 1}`, disabled: readOnly,
          face: dot, sample: (c) => optionPill(h, o.name.trim(), c), onpick: (c) => { o.color = c; changed(); },
        });
        // The button shows the dot; the palette shows each colour as the pill.
        color.button.classList.add('fx-cfs__colour');
        name.addEventListener('input', () => color.set(o.color ?? 'gray'));
        name.addEventListener('input', () => { o.name = name.value; changed(); });
        const tools = readOnly ? null : h('span', { class: 'fx-cfs__tools' },
          h('button', { class: 'fx-cfs__tool', type: 'button', 'aria-label': `Move option ${i + 1} up`, disabled: i === 0, onclick: () => { [options[i - 1], options[i]] = [options[i], options[i - 1]]; changed(); draw(); } }, lucide(h, 'arrow-up')),
          h('button', { class: 'fx-cfs__tool', type: 'button', 'aria-label': `Remove option ${i + 1}`, onclick: () => { options.splice(i, 1); changed(); draw(); } }, lucide(h, 'x')));
        return h('div', { class: 'fx-cfs__opt' }, color.button, color.panel, name, tools);
      }));
      if (!options.length) list.append(h('span', { class: 'fx-dim' }, readOnly ? 'No stages read yet.' : 'No options yet.'));
    }
    add?.addEventListener('click', () => {
      options.push({ name: '', color: data.colors[options.length % data.colors.length] });
      changed();
      draw();
      list.querySelector('.fx-cfs__opt:last-child input')?.focus();
    });
    draw();
    return {
      element: h('div', { class: 'fx-cfs__list' }, list, add),
      value: () => options.filter((o) => o.name.trim()).map(({ id, name, color }) => ({ ...(id ? { id } : {}), name, color })),
    };
  }

  // The sidecar: ClickUp's field panel, which slides in from the right of
  // the manager. Edit on a row (or Create) opens it; another row's Edit
  // switches it at once, so a person moves between fields quickly. The
  // table stays usable behind it. Save closes it; so do Cancel, × and Esc.
  const side = h('aside', { class: 'fx-cfs', 'aria-label': 'Custom field', hidden: true });
  let sideFor = null;
  function closeSide() {
    side.hidden = true;
    side.replaceChildren();
    sideFor = null;
    table.querySelector('.fx-cfm__row[data-open]')?.removeAttribute('data-open');
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && side.isConnected && !side.hidden && !document.querySelector('dialog[open], .fx-pop:popover-open')) closeSide();
  });

  // Open the sidecar for a field (null: a new one; `draft` fills it after a
  // failed save). A work system's field opens read only.
  function edit(field, draft = field) {
    sideFor = field?.id ?? 'new';
    const readOnly = Boolean(field?.source) || disabled;
    const section = (title, control, { required = false, hint = null } = {}) => h('div', { class: 'fx-cfs__section' },
      h('span', { class: 'fx-cfs__label' }, title, required && !readOnly ? h('span', { class: 'fx-cfs__req', 'aria-hidden': 'true' }, '*') : null), control, hint ? h('span', { class: 'fx-dim fx-cfs__hint' }, hint) : null);
    let dirty = false;
    const save = h('button', { class: 'fx-btn fx-btn--primary fx-btn--sm', type: 'submit', disabled: true }, field ? 'Save' : 'Create');
    const changed = () => { dirty = true; save.disabled = readOnly || !name.value.trim(); };

    // Head: the type (chosen for a new field, fixed after), and ×.
    const type = h('select', { class: 'fx-cfs__type', 'aria-label': 'Custom field type' }, data.types.map((t) => h('option', { value: t }, TYPE_LABELS[t] ?? t)));
    type.value = draft?.type ?? 'dropdown';
    const typeLabel = () => h('span', { class: 'fx-cfs__typename' }, lucide(h, TYPE_ICONS[type.value]), TYPE_LABELS[type.value]);
    // A new field picks its type from the head, as in ClickUp: the select
    // lies over the label, so the label shows and the browser's list opens.
    const typeText = h('span', {}, TYPE_LABELS[type.value]);
    const headType = field ? typeLabel() : h('label', { class: 'fx-cfs__typepick' }, lucide(h, TYPE_ICONS[type.value]), typeText, lucide(h, 'chevron-down'), type);
    const close = h('button', { class: 'fx-cfs__close', type: 'button', 'aria-label': 'Close', onclick: closeSide }, lucide(h, 'x'));

    const name = h('input', { class: 'fx-cfs__name', required: true, maxlength: '60', value: draft?.name ?? '', 'aria-label': 'Custom field name', placeholder: 'For example Priority', readonly: readOnly });
    name.addEventListener('input', changed);
    const nameBox = h('div', { class: 'fx-cfs__namebox' }, h('span', { class: 'fx-cfs__nameicon', 'data-color': field?.source ? 'gray' : (draft?.color ?? groupColor(type.value)) }, lucide(h, TYPE_ICONS[type.value])), name);

    // The colour is not here, as in ClickUp: the row's type icon and ⋯,
    // Colour change it.
    const colorOf = () => draft?.color ?? groupColor(type.value);

    // A work system's stages: one line each, in board order, with the
    // board's stage colour as the dot. Read only.
    const editor = field?.source
      ? { element: h('div', { class: 'fx-cfs__options' }, orderStatuses(field.options.map((o) => ({ label: o.name, firstSeenAt: o.firstSeenAt })))
        .map((label) => h('div', { class: 'fx-cfs__opt fx-cfs__opt--locked' },
          h('span', { class: 'fx-cfs__dot', 'data-rank': String(statusRank(label)) }), h('span', { class: 'fx-cfs__optname' }, label)))) }
      : optionsEditor(draft?.options ?? [
        { name: 'To do', color: 'gray' }, { name: 'Doing', color: 'blue' }, { name: 'Done', color: 'green' },
      ], { readOnly, changed });
    const optionsSection = section(field?.source ? 'Stages' : 'Dropdown options', editor.element, {
      required: !field?.source, hint: field?.source ? `${field.sourceLabel} owns these stages. Flow reads them and cannot change them.` : null,
    });
    const fit = () => {
      optionsSection.hidden = type.value !== 'dropdown';
      typeText.textContent = TYPE_LABELS[type.value];
      headType.querySelector('.fx-lucide').style.setProperty('--icon', `url(/assets/icons/${TYPE_ICONS[type.value]}.svg)`);
      nameBox.querySelector('.fx-lucide').style.setProperty('--icon', `url(/assets/icons/${TYPE_ICONS[type.value]}.svg)`);
      nameBox.firstChild.dataset.color = field?.source ? 'gray' : colorOf();
    };
    type.addEventListener('change', () => { fit(); changed(); });

    const where = field?.source ? `${field.sourceLabel} jobs` : 'Jobs';
    const belongs = section('Custom field belongs to', h('div', { class: 'fx-cfs__where' }, lucide(h, 'list-checks'), where));

    const remove = field && !readOnly ? h('button', { class: 'fx-cfs__delete', type: 'button', 'aria-label': `Delete ${field.name}`, title: 'Delete', onclick: () => remove(field) }, lucide(h, 'trash-2')) : null;
    const cancel = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', onclick: closeSide }, readOnly ? 'Close' : 'Cancel');
    const form = h('form', { class: 'fx-cfs__form' },
      h('header', { class: 'fx-cfs__head' }, headType, close),
      h('div', { class: 'fx-cfs__body' },
        section('Custom field name', nameBox, { required: true }),
        optionsSection, belongs),
      h('footer', { class: 'fx-cfs__foot' }, remove, h('span', { class: 'fx-cfm__gap' }), cancel, readOnly ? null : save));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (readOnly || !dirty) return;
      const payload = { name: name.value };
      if (!field) payload.type = type.value;
      if (type.value === 'dropdown') payload.options = editor.value();
      save.disabled = true;
      const body = field
        ? await send(`/api/custom-fields/${field.id}`, 'PUT', payload)
        : await send('/api/custom-fields', 'POST', payload, 'Custom field created.');
      if (!body) { save.disabled = false; return; }
      closeSide();
      await load();
    });
    fit();
    side.replaceChildren(form);
    // Below the toolbar, so search and Create stay in reach.
    side.style.top = `${toolbar.offsetHeight}px`;
    side.hidden = false;
    table.querySelector('.fx-cfm__row[data-open]')?.removeAttribute('data-open');
    if (field) table.querySelector(`.fx-cfm__row[data-id="${CSS.escape(field.id)}"]`)?.setAttribute('data-open', 'true');
    (readOnly ? close : name).focus({ preventScroll: true });
  }

  // ---- The manager: toolbar, then one table of groups ----
  const view = { q: '', types: new Set(), archived: false, desc: false, folded: readFolded(), renaming: null };
  let menuCount = 0;

  // A popover menu under a button (the Jobs board's toolbar menus work the same way).
  function popMenu(button, build) {
    const id = `fx-cf-menu-${++menuCount}`;
    const panel = h('div', { class: 'fx-pop', id, popover: 'auto', role: 'menu' });
    button.setAttribute('popovertarget', id);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    panel.addEventListener('toggle', (event) => {
      button.setAttribute('aria-expanded', String(event.newState === 'open'));
      if (event.newState !== 'open') return;
      panel.replaceChildren(...build(() => panel.hidePopover()).filter(Boolean));
      const at = button.getBoundingClientRect();
      panel.style.top = `${Math.round(at.bottom + 6)}px`;
      panel.style.left = `${Math.round(Math.max(8, Math.min(at.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8)))}px`;
    });
    return panel;
  }
  const item = (iconName, text, onclick, { disabled: off = false, title = null, role = 'menuitem', checked = null } = {}) => h('button', {
    type: 'button', class: 'fx-pop__item', role, disabled: off, title, onclick, ...(checked === null ? {} : { 'aria-checked': String(checked) }),
  }, h('span', { class: 'fx-pop__tick' }, iconName ? lucide(h, iconName) : null), h('span', {}, text));

  const search = h('input', { class: 'fx-input fx-cfm__search', type: 'search', placeholder: 'Search custom fields…', 'aria-label': 'Search custom fields' });
  search.addEventListener('input', () => { view.q = search.value.trim().toLowerCase(); draw(); });
  const typeButton = h('button', { class: 'fx-chip fx-cfm__tool', type: 'button' });
  const typeMenu = popMenu(typeButton, (close) => [
    ...data.types.map((t) => item(view.types.has(t) ? 'check' : null, TYPE_LABELS[t], () => {
      if (view.types.has(t)) view.types.delete(t); else view.types.add(t);
      close(); draw();
    }, { role: 'menuitemcheckbox', checked: view.types.has(t) })),
    view.types.size ? h('div', { class: 'fx-pop__sep' }) : null,
    view.types.size ? item(null, 'All types', () => { view.types.clear(); close(); draw(); }) : null,
  ]);
  const filterButton = h('button', { class: 'fx-chip fx-cfm__tool fx-cfm__tool--dashed', type: 'button' });
  const filterMenu = popMenu(filterButton, (close) => [
    item(view.archived ? 'check' : null, 'Show archived custom fields', () => { view.archived = !view.archived; close(); draw(); }, { role: 'menuitemcheckbox', checked: view.archived }),
  ]);
  const toolbar = h('div', { class: 'fx-cfm__bar' }, search, typeButton, typeMenu, filterButton, filterMenu, h('span', { class: 'fx-cfm__gap' }), addButton);
  const table = h('div', { class: 'fx-cfm', role: 'table', 'aria-label': 'Custom fields' });
  host.replaceChildren(toolbar, table);
  host.append(side);

  const personName = (id) => data.people?.find((p) => p.id === id)?.name ?? null;
  const matches = (f) => !view.q || f.name.toLowerCase().includes(view.q)
    || (f.options ?? []).some((o) => !o.archived && o.name.toLowerCase().includes(view.q));
  const byName = (a, b) => a.name.localeCompare(b.name) * (view.desc ? -1 : 1);

  async function rename(field, name) {
    view.renaming = null;
    const clean = name.trim();
    if (clean && clean !== field.name && await send(`/api/custom-fields/${field.id}`, 'PUT', { name: clean }, 'Renamed.')) return load();
    return draw();
  }

  async function duplicate(field) {
    const taken = new Set(data.fields.map((f) => f.name.toLowerCase()));
    let name = `${field.name} copy`.slice(0, 60);
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${field.name} copy ${n}`.slice(0, 60);
    const payload = { name, type: field.type };
    if (field.type === 'dropdown') payload.options = field.options.filter((o) => !o.archived).map(({ name: n, color }) => ({ name: n, color }));
    if (await send('/api/custom-fields', 'POST', payload, `Made ${name}.`)) await load();
  }

  async function copyId(field) {
    try {
      await navigator.clipboard.writeText(field.id);
      toast('Custom field ID copied.', 'success');
    } catch {
      toast(`Custom field ID: ${field.id}`, 'info');
    }
  }

  async function setArchived(field, archived) {
    if (await send(`/api/custom-fields/${field.id}/archive`, 'POST', { archived }, archived ? 'Archived. Its values are kept.' : 'Brought back.')) await load();
  }

  async function setColor(field, color) {
    if (!await send(`/api/custom-fields/${field.id}`, 'PUT', { color }, null)) return false;
    await load();
    return true;
  }

  async function setGroupColor(type, color) {
    const body = await send(`/api/custom-fields/groups/${type}`, 'PUT', { color }, null);
    if (!body) return false;
    data.groupColors = body.groupColors;
    draw();
    return true;
  }

  // Delete for good, after the person says yes. Archive is the step that
  // keeps the values.
  async function remove(field) {
    const jobs = field.valueCount ?? 0;
    const body = h('div', { class: 'fx-fields' },
      h('p', {}, jobs ? `${jobs} ${jobs === 1 ? 'job has' : 'jobs have'} a value in ${field.name}. Delete removes the custom field, these values and their history.` : `Delete removes ${field.name} and its history.`),
      h('p', { class: 'fx-dim' }, 'You cannot undo this. To keep the values, archive the custom field.'));
    if (!await dialog({ title: `Delete ${field.name}?`, body, confirm: 'Delete', tone: 'danger' })) return null;
    if (!await send(`/api/custom-fields/${field.id}`, 'DELETE', null, `Deleted ${field.name}.`)) return null;
    if (sideFor === field.id) closeSide();
    return load();
    return null;
  }

  function rowMenu(field, picker) {
    const button = h('button', { class: 'fx-cfm__more', type: 'button', 'aria-label': `More for ${field.name}` }, lucide(h, 'ellipsis'));
    const deleteItem = (close) => {
      const node = item('trash-2', 'Delete', () => { close(); remove(field); }, { disabled });
      node.dataset.tone = 'danger';
      return node;
    };
    const panel = popMenu(button, (close) => (field.archived
      ? [item('archive-restore', 'Bring back', () => { close(); setArchived(field, false); }, { disabled }), h('div', { class: 'fx-pop__sep' }), deleteItem(close)]
      : [
        item('square-pen', 'Edit', () => { close(); edit(field); }, { disabled }),
        item('pencil', 'Rename', () => { close(); view.renaming = field.id; draw(); }, { disabled }),
        item('palette', 'Colour', () => { close(); picker?.open(); }, { disabled: disabled || !picker }),
        item('copy', 'Duplicate', () => { close(); duplicate(field); }, { disabled }),
        item('repeat', 'Convert', null, { disabled: true, title: 'Changing a field\'s type is not in Flow yet.' }),
        item('clipboard-copy', 'Copy custom field ID', () => { close(); copyId(field); }),
        h('div', { class: 'fx-pop__sep' }),
        item('archive', 'Archive', () => { close(); setArchived(field, true); }, { disabled }),
        deleteItem(close),
      ]));
    return [button, panel];
  }

  function nameCell(field) {
    if (view.renaming === field.id) {
      const input = h('input', { class: 'fx-input fx-cfm__rename', value: field.name, maxlength: '60', 'aria-label': 'Custom field name' });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') input.blur();
        if (event.key === 'Escape') { view.renaming = null; draw(); }
      });
      input.addEventListener('blur', () => { if (view.renaming === field.id) rename(field, input.value); });
      queueMicrotask(() => { input.focus(); input.select(); });
      return h('div', { class: 'fx-cfm__name', role: 'cell' }, input);
    }
    const editButton = field.archived || disabled || field.source ? null
      : h('button', { class: 'fx-cfm__edit', type: 'button', onclick: () => edit(field) }, 'Edit', lucide(h, 'panel-right'));
    const viewButton = field.source ? h('button', { class: 'fx-cfm__edit', type: 'button', onclick: () => edit(field) }, 'View', lucide(h, 'panel-right')) : null;
    return h('div', { class: 'fx-cfm__name', role: 'cell' },
      h('div', { class: 'fx-cfm__title' },
        field.source ? lucide(h, 'lock', 'Read only') : null,
        h('span', { class: 'fx-cfm__label', title: field.name }, field.name), editButton, viewButton));
  }

  function fieldRow(field) {
    const by = field.source ? field.sourceLabel : personName(field.createdBy);
    const color = field.source ? 'gray' : colorOfField(field);
    const icon = lucide(h, TYPE_ICONS[field.type], TYPE_LABELS[field.type]);
    // A manager changes a field's colour from its type icon (or ⋯, Colour).
    const picker = field.source || field.archived || disabled ? null : colorPicker(h, {
      colors: data.colors, value: color, label: `Colour of ${field.name}`,
      sample: (c) => h('span', { class: 'fx-cfm__icon', 'data-color': c }, lucide(h, TYPE_ICONS[field.type], TYPE_LABELS[field.type])),
      onpick: (c) => setColor(field, c),
    });
    return h('div', { class: 'fx-cfm__row', role: 'row', 'data-id': field.id, 'data-open': sideFor === field.id ? 'true' : null, 'data-archived': field.archived ? 'true' : null },
      nameCell(field),
      h('div', { class: 'fx-cfm__type', role: 'cell' }, picker ? [picker.button, picker.panel] : h('span', { class: 'fx-cfm__icon', 'data-color': color }, icon)),
      h('div', { class: 'fx-cfm__by', role: 'cell' }, by ? h('span', { class: 'fx-cfm__avatar', title: by }, field.source ? lucide(h, 'plug') : initials(by)) : h('span', { class: 'fx-dim' }, '—')),
      h('div', { class: 'fx-cfm__date', role: 'cell', title: field.source ? `${field.sourceLabel} connected` : null }, field.createdAt ? createdDay(field.createdAt) : h('span', { class: 'fx-dim' }, '—')),
      h('div', { class: 'fx-cfm__where', role: 'cell' }, field.source ? `${field.sourceLabel} jobs` : 'Jobs'),
      h('div', { class: 'fx-cfm__end', role: 'cell' }, field.source ? null : rowMenu(field, picker)));
  }

  // One group: a header that folds it, its rows, and "Create … field". A
  // search opens every group that has a match.
  function group(key, pill, rows, { create = null, type = null } = {}) {
    const open = Boolean(view.q) || !view.folded.has(key);
    const toggle = h('button', { class: 'fx-cfm__fold', type: 'button', 'aria-expanded': String(open), 'aria-label': `${open ? 'Fold' : 'Open'} ${pill.text}` }, lucide(h, 'chevron-down'));
    toggle.addEventListener('click', () => {
      if (open) view.folded.add(key); else view.folded.delete(key);
      saveFolded(view.folded);
      draw();
    });
    const groupPill = (c) => h('span', { class: 'fx-cfm__pill', 'data-color': c }, pill.icon ? lucide(h, pill.icon) : null, pill.text);
    // A type group's pill picks the group's colour.
    const picker = type && !disabled ? colorPicker(h, {
      colors: data.colors, value: pill.color, label: `Colour of the ${pill.text} group`, sample: groupPill, onpick: (c) => setGroupColor(type, c),
    }) : null;
    const head = h('div', { class: 'fx-cfm__group', role: 'row' }, toggle,
      picker ? [picker.button, picker.panel] : groupPill(pill.color),
      h('span', { class: 'fx-cfm__count' }, String(rows.length)));
    if (!open) return [head];
    const out = [head, ...rows.map(fieldRow)];
    if (create) out.push(create);
    return out;
  }

  function draw() {
    if (!data) return;
    typeButton.replaceChildren(lucide(h, 'layers'), h('span', {}, view.types.size === 1 ? TYPE_LABELS[[...view.types][0]] : view.types.size ? `${view.types.size} types` : 'Type'), lucide(h, 'chevron-down'));
    typeButton.classList.toggle('fx-chip--on', view.types.size > 0);
    filterButton.replaceChildren(lucide(h, 'list-filter'), h('span', {}, view.archived ? 'Archived shown' : 'Filter'), lucide(h, 'chevron-down'));
    filterButton.classList.toggle('fx-chip--on', view.archived);

    const shown = (type) => !view.types.size || view.types.has(type);
    const sortHead = h('button', { class: 'fx-cfm__sort', type: 'button', 'aria-label': `Sort by name, ${view.desc ? 'Z to A' : 'A to Z'}` }, 'Name', lucide(h, view.desc ? 'arrow-up-z-a' : 'arrow-down-a-z'));
    sortHead.addEventListener('click', () => { view.desc = !view.desc; draw(); });
    const parts = [h('div', { class: 'fx-cfm__head', role: 'row' },
      h('div', { role: 'columnheader' }, sortHead), h('div', { role: 'columnheader' }, 'Type'), h('div', { role: 'columnheader', class: 'fx-cfm__by' }, 'Created by'),
      h('div', { role: 'columnheader', class: 'fx-cfm__date' }, 'Date created'), h('div', { role: 'columnheader', class: 'fx-cfm__where' }, 'Location'), h('div', { role: 'columnheader' }))];
    if (disabled) parts.unshift(notice('Only an owner or admin can change these. Everyone can set a job\'s values.', 'info'));

    // Type groups in ClickUp's order: by type name.
    const types = [...data.types].sort((a, b) => TYPE_LABELS[a].localeCompare(TYPE_LABELS[b]));
    let count = 0;
    for (const type of types) {
      if (!shown(type)) continue;
      const fields = data.fields.filter((f) => f.type === type && matches(f)).sort(byName);
      if (!fields.length && (view.q || view.types.size === 0)) continue;
      count += fields.length;
      const create = view.q || disabled ? null : h('button', { class: 'fx-cfm__create', type: 'button', onclick: () => edit(null, { type, name: '', options: undefined }) },
        lucide(h, 'plus'), `Create ${TYPE_LABELS[type].toLowerCase()} field`);
      parts.push(...group(type, { text: TYPE_LABELS[type], icon: TYPE_ICONS[type], color: groupColor(type) }, fields, { create, type }));
    }
    // The work systems' own fields: one read-only group per system.
    for (const source of [...new Set(data.systemFields.map((f) => f.source))]) {
      const fields = data.systemFields.filter((f) => f.source === source && shown(f.type))
        .map((f) => ({ ...f, id: `${f.source}:${f.name}`, name: `${f.sourceLabel} ${f.name.toLowerCase()}` })).filter(matches);
      if (!fields.length) continue;
      count += fields.length;
      parts.push(...group(`source:${source}`, { text: `From ${fields[0].sourceLabel}`, icon: 'lock', color: 'gray' }, fields));
    }
    if (view.archived) {
      const fields = data.archived.filter((f) => f.archived && shown(f.type) && matches(f)).sort(byName);
      count += fields.length;
      parts.push(...group('archived', { text: 'Archived', icon: 'archive', color: 'gray' }, fields));
    }
    if (!count && (view.q || view.types.size)) parts.push(h('p', { class: 'fx-cfm__empty' }, 'No custom field matches.'));
    if (!data.fields.length && !view.q && !view.types.size) {
      parts.push(h('p', { class: 'fx-cfm__empty' }, 'No custom fields yet. Create one, for example Priority or Technician, to group the Jobs board by it.'));
    }
    table.replaceChildren(...parts);
    // The count is what the table shows, the work systems' fields too.
    foot.replaceChildren(h('span', {}, `${count} ${count === 1 ? 'custom field' : 'custom fields'}`),
      h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'How custom fields work'));
  }
  const foot = h('div', { class: 'fx-cfm__foot' });
  host.append(foot);

  async function load() {
    try {
      const [live, all] = await Promise.all([flow('/api/custom-fields'), flow('/api/custom-fields?archived=1')]);
      data = { ...live, archived: all.fields };
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
      return;
    }
    draw();
  }

  addButton.addEventListener('click', () => edit(null));
  await load();
}
