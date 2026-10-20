// Settings, Custom fields (/custom-fields; server/core/custom-fields.js,
// docs/CUSTOM_FIELDS.md). The fields a lab makes for its jobs, laid out like
// ClickUp's Custom Field Manager: one table, with a group per type that folds
// open and closed, and one row per field with its type icon, who made it,
// when, and where it applies. Search, a type filter and Filter (archived
// fields) sit above it. A row's Edit opens the field's dialog (name and
// options); its ⋯ menu has Rename, Duplicate, Copy field ID and Archive. The
// work systems' own fields (Seazona's stage) sit in their own group, read
// only. Everyone can read the page; an owner or admin changes it. The caller
// passes in app.js's shared pieces as `ui`.

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/CUSTOM_FIELDS.md';
const TYPE_LABELS = {
  dropdown: 'Dropdown', person: 'Person', checkbox: 'Checkbox', date: 'Date', number: 'Number', text: 'Text',
};
const TYPE_HINTS = {
  dropdown: 'One option from a list. Makes board lanes.',
  person: 'One person in Flow. Makes board lanes.',
  checkbox: 'Yes or no. Makes board lanes.',
  date: 'A day, for example a promised date.',
  number: 'A number, for example units.',
  text: 'A short note.',
};
// Each type's icon (Lucide, served at /assets/icons/) and group colour.
const TYPE_ICONS = {
  dropdown: 'square-chevron-down', person: 'user-round', checkbox: 'square-check', date: 'calendar', number: 'hash', text: 'type',
};
const TYPE_COLORS = { dropdown: 'green', person: 'blue', checkbox: 'purple', date: 'teal', number: 'amber', text: 'gray' };
const FOLDED_KEY = 'flow_custom_fields_folded';

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
  const addButton = h('button', { class: 'fx-btn fx-btn--primary fx-btn--sm', type: 'button', disabled }, 'Create field');
  main.append(pageHeader('Custom fields', { subtitle: 'Fields for your jobs. They stay in Flow and never change Seazona or Xero.' }), host);

  let data = null;

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


  // The option list editor for a dropdown: one line per option (name,
  // colour, move up, remove), in lane order.
  function optionsEditor(start) {
    let options = start.filter((o) => !o.archived).map((o) => ({ ...o }));
    const list = h('div', { class: 'fx-fields fx-cf__options' });
    const add = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button' }, 'Add option');
    function draw() {
      list.replaceChildren(...options.map((o, i) => {
        const name = h('input', { class: 'fx-input', maxlength: '40', value: o.name, 'aria-label': `Option ${i + 1}`, placeholder: 'Option name' });
        name.addEventListener('input', () => { o.name = name.value; });
        const color = h('select', { class: 'fx-select fx-cf__color', 'aria-label': `Colour of option ${i + 1}`, 'data-color': o.color },
          data.colors.map((c) => h('option', { value: c }, c[0].toUpperCase() + c.slice(1))));
        color.value = o.color ?? 'gray';
        color.addEventListener('change', () => { o.color = color.value; color.dataset.color = color.value; });
        const up = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', 'aria-label': `Move option ${i + 1} up`, disabled: i === 0 }, '↑');
        up.addEventListener('click', () => { [options[i - 1], options[i]] = [options[i], options[i - 1]]; draw(); });
        const remove = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm fx-rule__delete', type: 'button', 'aria-label': `Remove option ${i + 1}` }, 'Remove');
        remove.addEventListener('click', () => { options.splice(i, 1); draw(); });
        return h('div', { class: 'fx-cf__line' }, name, color, up, remove);
      }));
      if (!options.length) list.append(h('span', { class: 'fx-dim' }, 'No options yet.'));
    }
    add.addEventListener('click', () => {
      options.push({ name: '', color: data.colors[options.length % data.colors.length] });
      draw();
      list.querySelector('.fx-cf__line:last-child input')?.focus();
    });
    draw();
    return {
      element: h('div', { class: 'fx-fields' }, list, add),
      value: () => options.filter((o) => o.name.trim()).map(({ id, name, color }) => ({ ...(id ? { id } : {}), name, color })),
    };
  }

  // The dialog for a new field (field null) or an existing one. The type is
  // fixed once the field exists.
  async function edit(field, draft = field) {
    const label = (text, control, hint) => h('div', { class: 'fx-field' }, h('span', { class: 'fx-label' }, text), control, hint ?? null);
    const name = h('input', { class: 'fx-input', required: true, maxlength: '60', value: draft?.name ?? '', 'aria-label': 'Field name', placeholder: 'For example Priority' });
    const type = h('select', { class: 'fx-select', 'aria-label': 'Type', disabled: Boolean(field) },
      data.types.map((t) => h('option', { value: t }, TYPE_LABELS[t] ?? t)));
    type.value = draft?.type ?? 'dropdown';
    const typeHint = h('span', { class: 'fx-dim' }, TYPE_HINTS[type.value]);
    const editor = optionsEditor(draft?.options ?? [
      { name: 'To do', color: 'gray' }, { name: 'Doing', color: 'blue' }, { name: 'Done', color: 'green' },
    ]);
    const optionsField = label('Options', editor.element, h('span', { class: 'fx-dim' }, 'Board lanes follow this order. A removed option is kept for old jobs.'));
    const showOptions = () => { optionsField.hidden = type.value !== 'dropdown'; typeHint.textContent = TYPE_HINTS[type.value]; };
    type.addEventListener('change', showOptions);
    showOptions();

    let action = null;
    const parts = [label('Name', name), label('Type', type, typeHint), optionsField];
    if (field) {
      const archive = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm fx-rule__delete', type: 'button' }, 'Archive field');
      archive.addEventListener('click', () => { action = 'archive'; archive.closest('dialog').close(); });
      parts.push(archive);
    }
    const ok = await dialog({ title: field ? `Edit ${field.name}` : 'Create field', body: h('div', { class: 'fx-fields fx-rule__dialog' }, ...parts), confirm: field ? 'Save' : 'Create field' });
    if (action === 'archive') {
      if (await send(`/api/custom-fields/${field.id}/archive`, 'POST', { archived: true }, 'Archived. Its values are kept.')) return load();
      return null;
    }
    if (!ok) return null;
    const payload = { name: name.value };
    if (!field) payload.type = type.value;
    if (type.value === 'dropdown') payload.options = editor.value();
    const body = field
      ? await send(`/api/custom-fields/${field.id}`, 'PUT', payload)
      : await send('/api/custom-fields', 'POST', payload, 'Field created.');
    if (!body) return edit(field, { ...draft, ...payload, type: type.value });
    return load();
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

  const search = h('input', { class: 'fx-input fx-cfm__search', type: 'search', placeholder: 'Search fields…', 'aria-label': 'Search fields' });
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
    item(view.archived ? 'check' : null, 'Show archived fields', () => { view.archived = !view.archived; close(); draw(); }, { role: 'menuitemcheckbox', checked: view.archived }),
  ]);
  const toolbar = h('div', { class: 'fx-cfm__bar' }, search, typeButton, typeMenu, filterButton, filterMenu, h('span', { class: 'fx-cfm__gap' }), addButton);
  const table = h('div', { class: 'fx-cfm', role: 'table', 'aria-label': 'Custom fields' });
  host.replaceChildren(toolbar, table);

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
      toast('Field ID copied.', 'success');
    } catch {
      toast(`Field ID: ${field.id}`, 'info');
    }
  }

  async function setArchived(field, archived) {
    if (await send(`/api/custom-fields/${field.id}/archive`, 'POST', { archived }, archived ? 'Archived. Its values are kept.' : 'Brought back.')) await load();
  }

  function rowMenu(field) {
    const button = h('button', { class: 'fx-cfm__more', type: 'button', 'aria-label': `More for ${field.name}` }, lucide(h, 'ellipsis'));
    const panel = popMenu(button, (close) => (field.archived
      ? [item('archive-restore', 'Bring back', () => { close(); setArchived(field, false); }, { disabled })]
      : [
        item('square-pen', 'Edit', () => { close(); edit(field); }, { disabled }),
        item('pencil', 'Rename', () => { close(); view.renaming = field.id; draw(); }, { disabled }),
        item('copy', 'Duplicate', () => { close(); duplicate(field); }, { disabled }),
        item('repeat', 'Convert', null, { disabled: true, title: 'Changing a field\'s type is not in Flow yet.' }),
        item('clipboard-copy', 'Copy field ID', () => { close(); copyId(field); }),
        h('div', { class: 'fx-pop__sep' }),
        item('archive', 'Archive', () => { close(); setArchived(field, true); }, { disabled }),
      ]));
    return [button, panel];
  }

  function nameCell(field) {
    if (view.renaming === field.id) {
      const input = h('input', { class: 'fx-input fx-cfm__rename', value: field.name, maxlength: '60', 'aria-label': 'Field name' });
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
    return h('div', { class: 'fx-cfm__name', role: 'cell' },
      field.source ? lucide(h, 'lock', 'Read only') : null,
      h('span', { class: 'fx-cfm__label', title: field.name }, field.name), editButton);
  }

  function fieldRow(field) {
    const by = field.source ? field.sourceLabel : personName(field.createdBy);
    return h('div', { class: 'fx-cfm__row', role: 'row', 'data-archived': field.archived ? 'true' : null },
      nameCell(field),
      h('div', { class: 'fx-cfm__type', role: 'cell', 'data-color': TYPE_COLORS[field.type] }, lucide(h, TYPE_ICONS[field.type], TYPE_LABELS[field.type])),
      h('div', { class: 'fx-cfm__by', role: 'cell' }, by ? h('span', { class: 'fx-cfm__avatar', title: by }, field.source ? lucide(h, 'plug') : initials(by)) : h('span', { class: 'fx-dim' }, '—')),
      h('div', { class: 'fx-cfm__date', role: 'cell' }, field.source ? h('span', { class: 'fx-dim' }, '—') : createdDay(field.createdAt)),
      h('div', { class: 'fx-cfm__where', role: 'cell' }, field.source ? `${field.sourceLabel} jobs` : 'Jobs'),
      h('div', { class: 'fx-cfm__end', role: 'cell' }, field.source ? null : rowMenu(field)));
  }

  // One group: a header that folds it, its rows, and "Create … field". A
  // search opens every group that has a match.
  function group(key, pill, rows, { create = null } = {}) {
    const open = Boolean(view.q) || !view.folded.has(key);
    const toggle = h('button', { class: 'fx-cfm__fold', type: 'button', 'aria-expanded': String(open), 'aria-label': `${open ? 'Fold' : 'Open'} ${pill.text}` }, lucide(h, 'chevron-down'));
    toggle.addEventListener('click', () => {
      if (open) view.folded.add(key); else view.folded.delete(key);
      saveFolded(view.folded);
      draw();
    });
    const head = h('div', { class: 'fx-cfm__group', role: 'row' }, toggle,
      h('span', { class: 'fx-cfm__pill', 'data-color': pill.color }, pill.icon ? lucide(h, pill.icon) : null, pill.text),
      h('span', { class: 'fx-cfm__count' }, String(rows.length)));
    if (!open) return [head];
    const out = [head, ...rows.map(fieldRow)];
    if (create) out.push(create);
    return out;
  }

  function draw() {
    if (!data) return;
    typeButton.replaceChildren(lucide(h, 'layers'), h('span', {}, view.types.size === 1 ? TYPE_LABELS[[...view.types][0]] : view.types.size ? `${view.types.size} types` : 'Field type'), lucide(h, 'chevron-down'));
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
      parts.push(...group(type, { text: TYPE_LABELS[type], icon: TYPE_ICONS[type], color: TYPE_COLORS[type] }, fields, { create }));
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
    if (!count && (view.q || view.types.size)) parts.push(h('p', { class: 'fx-cfm__empty' }, 'No field matches.'));
    if (!data.fields.length && !view.q && !view.types.size) {
      parts.push(h('p', { class: 'fx-cfm__empty' }, 'No fields yet. Create one, for example Priority or Technician, to group the Jobs board by it.'));
    }
    table.replaceChildren(...parts);
    foot.replaceChildren(h('span', {}, `${data.fields.length} ${data.fields.length === 1 ? 'field' : 'fields'}`),
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
