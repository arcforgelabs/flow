// The "Rules" section of Settings, Invoicing (server/core/invoice-rules.js,
// /api/invoicing/rules). Each rule a lab builds is a row: its name, one short
// line that reads its conditions, and its switch. Edit opens a dialog where
// every part is picked from a menu: the field, the test, and a value from
// what Flow already holds (Seazona's statuses, the customers, the price list).
// Everyone can read the rules; an owner or admin changes them. The caller
// passes in app.js's shared pieces as `ui`.

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/INVOICE_RULES.md';

const TEST_LABELS = {
  more_than: 'is more than', at_most: 'is at most', is: 'is', is_not: 'is not', is_one_of: 'is one of',
  is_empty: 'is empty', is_not_empty: 'is not empty', has: 'has', has_not: 'does not have',
  is_not_one_of: 'is not one of', contains: 'contains', does_not_contain: 'does not contain',
  starts_with: 'starts with', does_not_start_with: 'does not start with', has_number: 'has a number', number_in_words: 'has a number beside words', one_word: 'is one word',
};
const ACTION_LABELS = { wait: 'Wait for a person', skip: 'Never draft', pending: 'Pending, with a note' };
const NO_VALUE = ['is_empty', 'is_not_empty', 'has_number', 'number_in_words', 'one_word'];
const MANY = ['is_one_of', 'is_not_one_of'];
const TYPED = ['contains', 'does_not_contain', 'starts_with', 'does_not_start_with'];

// A rule as one short line: "Job age (days) is more than 90 · Wait for a person".
export function ruleSummary(rule, meta) {
  const fieldOf = new Map(meta.fields.map((f) => [f.key, f]));
  const labelOf = (field, value) => {
    const option = (meta.options[field.options] ?? []).find((o) => String(o.value).toLowerCase() === String(value).toLowerCase());
    return option?.label ?? String(value);
  };
  const part = (c) => {
    const field = fieldOf.get(c.field);
    if (!field) return c.field;
    const test = TEST_LABELS[c.test] ?? c.test;
    if (NO_VALUE.includes(c.test)) return `${field.label} ${test}`;
    if (field.kind === 'boolean') return `${field.label} ${test} ${c.value ? 'yes' : 'no'}`;
    if (field.kind === 'share') return `${labelOf(field, c.item).split(' · ')[0]} share ${test} ${c.value}%`;
    if (field.kind === 'money') return `${field.label} ${test} $${Number(c.value).toFixed(2)}`;
    const value = Array.isArray(c.value) ? c.value.map((v) => labelOf(field, v)).join(', ') : labelOf(field, c.value);
    return `${field.label} ${test} ${value}`;
  };
  const then = rule.action.kind === 'pending' ? `Pending: ${rule.action.note}` : ACTION_LABELS[rule.action.kind] ?? rule.action.kind;
  return `${rule.conditions.map(part).join(' and ')} · ${then}`;
}

export function rulesSection(ui, title = 'Rules') {
  const { h, flow, toast, notice, dialog, me, settingRow } = ui;
  const disabled = !['owner', 'admin'].includes(me?.person.role);
  const section = h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, title), h('div', { class: 'fx-skeleton' }));
  let meta;
  let rules = [];

  const row = (label, hint, control) => settingRow({ label, hint, control });

  async function send(path, method, payload) {
    try {
      const body = await flow(path, { method, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      toast('Saved.', 'success');
      return body;
    } catch (error) {
      toast(error.message, 'danger');
      return null;
    }
  }

  // One condition's controls: field, test and value, each a menu where Flow
  // knows the values. `read()` answers the condition as the API takes it.
  function conditionEditor(start, onRemove) {
    const fieldSelect = h('select', { class: 'fx-select', 'aria-label': 'Field' },
      meta.fields.map((f) => h('option', { value: f.key }, f.label)));
    const testSelect = h('select', { class: 'fx-select', 'aria-label': 'Test' });
    const valueHost = h('div', { class: 'fx-rule__value' });
    let readValue = () => ({});

    const options = (field) => meta.options[field.options] ?? [];
    const choiceSelect = (field, value, label) => {
      const list = options(field);
      const select = h('select', { class: 'fx-select', 'aria-label': label },
        list.map((o) => h('option', { value: o.value }, o.label)));
      if (value !== undefined && !list.some((o) => String(o.value).toLowerCase() === String(value).toLowerCase())) {
        select.append(h('option', { value }, String(value)));
      }
      if (value !== undefined) select.value = list.find((o) => String(o.value).toLowerCase() === String(value).toLowerCase())?.value ?? value;
      return select;
    };
    const numberBox = (value, label) => h('input', { class: 'fx-input', type: 'number', min: '0', step: 'any', value: value ?? '', 'aria-label': label });

    function drawValue(value, item) {
      const field = meta.fields.find((f) => f.key === fieldSelect.value);
      const test = testSelect.value;
      valueHost.replaceChildren();
      if (NO_VALUE.includes(test)) {
        readValue = () => ({});
      } else if (field.kind === 'boolean') {
        const select = h('select', { class: 'fx-select', 'aria-label': 'Value' }, h('option', { value: 'true' }, 'Yes'), h('option', { value: 'false' }, 'No'));
        select.value = String(value ?? false);
        valueHost.append(select);
        readValue = () => ({ value: select.value === 'true' });
      } else if (field.kind === 'share') {
        const items = choiceSelect(field, item, 'Line item');
        const box = numberBox(value ?? 20, 'Percent of the other lines');
        valueHost.append(items, box, h('span', { class: 'fx-dim' }, '%'));
        readValue = () => ({ item: items.value, value: Number(box.value) });
      } else if (['number', 'money'].includes(field.kind)) {
        const box = numberBox(value, 'Value');
        valueHost.append(box);
        readValue = () => ({ value: Number(box.value) });
      } else if (TYPED.includes(test) || (field.kind === 'text' && !MANY.includes(test) && !options(field).length)) {
        const box = h('input', { class: 'fx-input', type: 'text', maxlength: '200', value: Array.isArray(value) ? value[0] ?? '' : value ?? '', 'aria-label': 'Value' });
        valueHost.append(box);
        readValue = () => ({ value: box.value });
      } else if (MANY.includes(test)) {
        const picked = Array.isArray(value) ? value : [];
        const chosen = new Set(picked.map((v) => String(v).toLowerCase()));
        // A value saved earlier that is no longer on the menu stays ticked.
        const known = new Set(options(field).map((o) => String(o.value).toLowerCase()));
        // Ticked values come first, so a long menu shows what the rule holds.
        const list = [...picked.filter((v) => !known.has(String(v).toLowerCase())).map((v) => ({ value: v, label: v })), ...options(field)]
          .sort((x, y) => Number(chosen.has(String(y.value).toLowerCase())) - Number(chosen.has(String(x.value).toLowerCase())));
        const boxes = list.map((o) => {
          const box = h('input', { type: 'checkbox', value: o.value, checked: chosen.has(String(o.value).toLowerCase()) });
          return h('label', { class: 'fx-multi__option' }, box, h('span', {}, o.label));
        });
        valueHost.append(h('div', { class: 'fx-rule__many' }, ...(boxes.length ? boxes : [h('span', { class: 'fx-dim' }, 'No values yet.')])));
        readValue = () => ({ value: boxes.map((b) => b.querySelector('input')).filter((b) => b.checked).map((b) => b.value) });
      } else if (field.options) {
        const select = choiceSelect(field, Array.isArray(value) ? value[0] : value, 'Value');
        valueHost.append(select);
        readValue = () => ({ value: select.value });
      }
    }

    function drawTests(test) {
      const field = meta.fields.find((f) => f.key === fieldSelect.value);
      testSelect.replaceChildren(...field.tests.map((t) => h('option', { value: t }, TEST_LABELS[t] ?? t)));
      testSelect.value = field.tests.includes(test) ? test : field.tests[0];
    }

    fieldSelect.value = start?.field ?? meta.fields[0].key;
    drawTests(start?.test);
    drawValue(start?.value, start?.item);
    fieldSelect.addEventListener('change', () => { drawTests(); drawValue(); });
    testSelect.addEventListener('change', () => drawValue());

    const remove = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', 'aria-label': 'Remove condition' }, 'Remove');
    const element = h('div', { class: 'fx-rule__condition' }, fieldSelect, testSelect, valueHost, remove);
    remove.addEventListener('click', () => onRemove(element));
    return { element, read: () => ({ field: fieldSelect.value, test: testSelect.value, ...readValue() }) };
  }

  // The dialog for a new rule (rule null) or an existing one. `draft` fills
  // it again after a refused save, so no choice is lost.
  async function edit(rule, draft = rule) {
    const name = h('input', { class: 'fx-input', name: 'name', required: true, maxlength: '120', value: draft?.name ?? '', 'aria-label': 'Rule name' });
    const action = h('select', { class: 'fx-select', 'aria-label': 'Then' },
      Object.entries(ACTION_LABELS).map(([value, label]) => h('option', { value }, label)));
    action.value = draft?.action.kind ?? 'wait';
    // A pending rule's note: what a person must fix. It shows on the draft.
    const note = h('input', {
      class: 'fx-input', maxlength: '200', value: draft?.action.note ?? '', 'aria-label': 'Note',
      placeholder: 'Type a note',
    });
    const noteField = h('div', { class: 'fx-field' }, h('span', { class: 'fx-label' }, 'Note on the draft'), note);
    const showNote = () => { noteField.hidden = action.value !== 'pending'; };
    action.addEventListener('change', showNote);
    showNote();
    let editors = [];
    const list = h('div', { class: 'fx-rule__conditions' });
    const addCondition = (start) => {
      if (editors.length >= 10) return toast('A rule has 10 conditions at most.', 'danger');
      const editor = conditionEditor(start, (element) => {
        if (editors.length === 1) return toast('A rule needs at least one condition.', 'danger');
        editors = editors.filter((e) => e.element !== element);
        element.remove();
        return null;
      });
      editors.push(editor);
      list.append(editor.element);
      return null;
    };
    for (const c of draft?.conditions ?? [null]) addCondition(c);
    const more = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button' }, 'Add condition');
    more.addEventListener('click', () => addCondition());

    let wantsDelete = false;
    const remove = rule ? h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm fx-rule__delete', type: 'button' }, 'Delete rule') : null;
    remove?.addEventListener('click', () => {
      wantsDelete = true;
      remove.closest('dialog').close();
    });

    const label = (text, ...children) => h('div', { class: 'fx-field' }, h('span', { class: 'fx-label' }, text), ...children);
    const data = await dialog({
      title: rule ? 'Edit rule' : 'New rule',
      body: h('div', { class: 'fx-fields fx-rule__dialog' },
        label('Name', name),
        label('When', h('span', { class: 'fx-dim' }, 'A job is ready to invoice. A pending rule also checks its draft and the Reference.')),
        label('If all of these match', list, more),
        label('Then', action),
        noteField,
        remove),
      confirm: rule ? 'Save' : 'Add rule',
    });
    if (wantsDelete) {
      const sure = await dialog({ title: `Delete "${rule.name}"?`, body: h('p', { class: 'fx-dim' }, 'Jobs stop waiting on this rule.'), confirm: 'Delete', tone: 'danger' });
      if (sure && await send(`/api/invoicing/rules/${rule.id}`, 'DELETE')) rules = rules.filter((r) => r.id !== rule.id);
      return draw();
    }
    if (!data) return null;
    const payload = {
      name: name.value,
      conditions: editors.map((e) => e.read()),
      action: action.value === 'pending' ? { kind: 'pending', note: note.value } : { kind: action.value },
    };
    const body = rule
      ? await send(`/api/invoicing/rules/${rule.id}`, 'PUT', payload)
      : await send('/api/invoicing/rules', 'POST', payload);
    if (!body) return edit(rule, payload);
    rules = rule ? rules.map((r) => (r.id === rule.id ? body.rule : r)) : [...rules, body.rule];
    return draw();
  }

  const rowOf = (rule) => {
    const toggle = h('button', { class: 'fx-switch', type: 'button', role: 'switch', 'aria-label': rule.name, 'aria-checked': String(rule.enabled), disabled });
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      const body = await send(`/api/invoicing/rules/${rule.id}`, 'PUT', { enabled: toggle.getAttribute('aria-checked') !== 'true' });
      toggle.disabled = disabled;
      if (!body) return;
      rules = rules.map((r) => (r.id === rule.id ? body.rule : r));
      toggle.setAttribute('aria-checked', String(body.rule.enabled));
    });
    const controls = [toggle];
    if (!disabled) {
      const open = h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', 'aria-label': `Edit ${rule.name}` }, 'Edit');
      open.addEventListener('click', () => edit(rule));
      controls.unshift(open);
    }
    return row(rule.name, ruleSummary(rule, meta), controls);
  };

  function draw() {
    const add = disabled ? null : h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button' }, 'Add rule');
    add?.addEventListener('click', () => edit(null));
    section.replaceChildren(
      h('h2', { class: 'fx-set__title' }, title),
      h('p', { class: 'fx-set__hint', style: { margin: '0 0 4px' } }, 'When a rule matches, a ready job waits, is never drafted, or its draft is Pending with the rule\'s note.'),
      ...(rules.length ? rules.map(rowOf) : [h('p', { class: 'fx-dim' }, 'No rules. Every ready job is drafted.')]),
      h('div', { class: 'fx-rule__footer' }, add,
        h('a', { class: 'fx-dim', href: DOCS, target: '_blank', rel: 'noopener' }, 'How rules work')));
  }

  (async () => {
    try {
      [meta, { rules }] = await Promise.all([flow('/api/invoicing/rule-fields'), flow('/api/invoicing/rules')]);
      draw();
    } catch (error) {
      section.replaceChildren(h('h2', { class: 'fx-set__title' }, title), notice(error.message, 'danger'));
    }
  })();
  return section;
}
