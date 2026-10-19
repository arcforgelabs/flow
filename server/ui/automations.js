// Automation rows (server/core/automations.js, /api/invoicing/automations).
// Each automation shows where its trigger lives: the work system's ready rule
// on that integration's page, the draft rule on Settings, Invoicing. One row
// for each: its name, one short line, and its switch, plus a row for each of
// its settings. A change saves at once. Everyone can read them; an owner or
// admin changes them. The caller passes in app.js's shared pieces as `ui`.

const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/AUTOMATIONS.md';

// A section of the automations kept at `place`, filled when they load.
export function automationSection(ui, place, title) {
  const { h, flow, toast, notice, me } = ui;
  const section = h('section', { class: 'fx-set' }, h('h2', { class: 'fx-set__title' }, title), h('div', { class: 'fx-skeleton' }));
  const disabled = !['owner', 'admin'].includes(me?.person.role);

  async function save(key, changes, control) {
    control.disabled = true;
    try {
      const { automation } = await flow(`/api/invoicing/automations/${key}`, { method: 'PUT', body: JSON.stringify(changes) });
      toast('Saved.', 'success');
      return automation;
    } catch (error) {
      toast(error.message, 'danger');
      return null;
    } finally {
      control.disabled = disabled;
    }
  }

  const row = (name, hint, control) => h('div', { class: 'fx-set__row' },
    h('div', { class: 'fx-set__text' }, h('span', { class: 'fx-set__name' }, name), h('span', { class: 'fx-set__hint' }, hint)),
    h('div', { class: 'fx-set__control' }, control));

  const rowsOf = (automation) => {
    const button = h('button', { class: 'fx-switch', type: 'button', role: 'switch', 'aria-label': automation.name, 'aria-checked': String(automation.enabled), disabled });
    button.addEventListener('click', async () => {
      const saved = await save(automation.key, { enabled: button.getAttribute('aria-checked') !== 'true' }, button);
      if (saved) button.setAttribute('aria-checked', String(saved.enabled));
    });
    const out = [row(automation.name, automation.hint, button)];
    if (automation.config.statuses) {
      const input = h('input', { class: 'fx-input', type: 'text', value: automation.config.statuses.join(', '), 'aria-label': 'Ready statuses', disabled });
      input.addEventListener('change', async () => {
        const statuses = input.value.split(',').map((x) => x.trim()).filter(Boolean);
        const saved = await save(automation.key, { config: { statuses } }, input);
        input.value = (saved ?? automation).config.statuses.join(', ');
        if (saved) automation.config = saved.config;
      });
      out.push(row('Ready statuses', 'Statuses that mean ready. Comma between.', input));
    }
    return out;
  };

  (async () => {
    try {
      const { automations } = await flow(`/api/invoicing/automations?place=${encodeURIComponent(place)}`);
      section.replaceChildren(h('h2', { class: 'fx-set__title' }, title), ...automations.flatMap(rowsOf),
        h('p', { class: 'fx-dim', style: { margin: '8px 0 0' } }, h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'How automations work')));
    } catch (error) {
      section.replaceChildren(h('h2', { class: 'fx-set__title' }, title), notice(error.message, 'danger'));
    }
  })();
  return section;
}
