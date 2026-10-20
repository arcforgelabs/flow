// Settings, Custom fields (/custom-fields; server/core/custom-fields.js,
// docs/CUSTOM_FIELDS.md). The fields a lab makes for its jobs, like ClickUp's
// custom fields: each row is one field, with its type and, for a dropdown,
// its options in lane order. Create field and Edit open a dialog. The work
// systems' own fields (Seazona's stage) show below, read only: Flow reads
// them and never changes them here. Everyone can read the page; an owner or
// admin changes it. The caller passes in app.js's shared pieces as `ui`.

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

export async function renderCustomFields(main, ui) {
  const { h, flow, toast, notice, dialog, pageHeader, me } = ui;
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  const host = h('div', { class: 'fx-card', style: { padding: '8px 20px 16px' } }, h('div', { class: 'fx-skeleton' }));
  const addButton = h('button', { class: 'fx-btn fx-btn--primary', type: 'button', disabled }, 'Create field');
  main.append(pageHeader('Custom fields', { subtitle: 'Fields for your jobs. They stay in Flow and never change Seazona or Xero.', actions: [addButton] }), host);

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

  const row = (name, hint, control) => h('div', { class: 'fx-set__row' },
    h('div', { class: 'fx-set__text' }, h('span', { class: 'fx-set__name' }, name), hint),
    h('div', { class: 'fx-set__control fx-rule__controls' }, control));
  const optionChip = (o) => h('span', { class: 'fx-cf__opt', 'data-color': o.color ?? 'gray' }, o.name);
  const typeChip = (type) => h('span', { class: 'fx-chip fx-chip--static' }, TYPE_LABELS[type] ?? type);

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

  async function move(index, by) {
    const ids = data.fields.map((f) => f.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    if (await send('/api/custom-fields/order', 'PUT', { ids }, null)) await load();
  }

  function fieldRow(field, index) {
    const hint = h('div', { class: 'fx-price__hint' }, typeChip(field.type),
      ...(field.type === 'dropdown' ? field.options.filter((o) => !o.archived).map(optionChip) : [h('span', { class: 'fx-set__hint' }, TYPE_HINTS[field.type])]));
    const controls = [];
    if (index !== null) {
      const up = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', disabled: disabled || index === 0, 'aria-label': `Move ${field.name} up` }, '↑');
      up.addEventListener('click', () => move(index, -1));
      const down = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', disabled: disabled || index === data.fields.length - 1, 'aria-label': `Move ${field.name} down` }, '↓');
      down.addEventListener('click', () => move(index, 1));
      const editButton = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', disabled }, 'Edit');
      editButton.addEventListener('click', () => edit(field));
      controls.push(up, down, editButton);
    } else {
      const back = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', disabled }, 'Bring back');
      back.addEventListener('click', async () => {
        if (await send(`/api/custom-fields/${field.id}/archive`, 'POST', { archived: false }, 'Brought back.')) await load();
      });
      controls.push(back);
    }
    return row(field.name, hint, h('div', { class: 'fx-row' }, ...controls));
  }

  function systemRow(field) {
    const options = field.options.slice(0, 12).map((o) => h('span', { class: 'fx-cf__opt', 'data-color': o.final ? 'green' : 'gray' }, o.name));
    if (field.options.length > 12) options.push(h('span', { class: 'fx-set__hint' }, `${field.options.length - 12} more`));
    return row(`${field.sourceLabel} ${field.name.toLowerCase()}`, h('div', { class: 'fx-price__hint' }, typeChip(field.type), ...options),
      h('span', { class: 'fx-status', 'data-tone': 'mute' }, `Read only · from ${field.sourceLabel}`));
  }

  function draw() {
    const archived = data.archived.filter((f) => f.archived);
    const sections = [
      disabled ? notice('Only an owner or admin can change these. Everyone can set a job\'s values.', 'info') : null,
      h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, `Your fields · ${data.fields.length}`),
        ...(data.fields.length ? data.fields.map(fieldRow)
          : [h('p', { class: 'fx-dim' }, 'No fields yet. Create one, for example Priority or Technician, to group the Jobs board by it.')])),
    ];
    if (data.systemFields.length) {
      sections.push(h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, 'From integrations'),
        ...data.systemFields.map(systemRow),
        h('p', { class: 'fx-dim', style: { margin: '8px 0 0' } }, 'Flow reads these. Change them in their own system.')));
    }
    if (archived.length) {
      sections.push(h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, `Archived · ${archived.length}`), ...archived.map((f) => fieldRow(f, null))));
    }
    sections.push(h('p', { class: 'fx-dim', style: { margin: '8px 0 0' } }, h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'How custom fields work')));
    host.replaceChildren(...sections.filter(Boolean));
  }

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
