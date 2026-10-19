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

  // A menu of the statuses the work system reported, each with its job count.
  // A status saved earlier stays in the menu even when no job has it now.
  const statusPicker = (automation) => {
    const summary = h('summary', { class: 'fx-select fx-multi__summary' });
    const list = h('div', { class: 'fx-multi__list', role: 'group', 'aria-label': 'Ready statuses' }, h('div', { class: 'fx-skeleton' }));
    const picker = h('details', { class: 'fx-multi' }, summary, list);
    let options = [];
    const show = () => {
      const chosen = new Set(automation.config.statuses);
      const names = options.filter((o) => chosen.has(o.value)).map((o) => o.label);
      summary.textContent = names.length ? names.join(', ') : 'None';
      list.replaceChildren(...(options.length ? options.map((o) => {
        const box = h('input', { type: 'checkbox', checked: chosen.has(o.value), disabled });
        box.addEventListener('change', async () => {
          const next = options.map((x) => x.value).filter((v) => (v === o.value ? box.checked : chosen.has(v)));
          if (!next.length) {
            box.checked = true;
            toast('Pick at least one status. To stop it, turn the automation off.', 'danger');
            return;
          }
          const saved = await save(automation.key, { config: { statuses: next } }, box);
          if (saved) automation.config = saved.config;
          show();
        });
        return h('label', { class: 'fx-multi__option' }, box, h('span', {}, o.label), h('span', { class: 'fx-dim' }, String(o.jobs)));
      }) : [h('p', { class: 'fx-dim', style: { margin: 0 } }, 'Seazona has reported no statuses yet.')]));
    };
    (async () => {
      try {
        ({ statuses: options } = await flow('/api/invoicing/work-statuses'));
      } catch (error) {
        options = [];
        toast(error.message, 'danger');
      }
      const known = new Set(options.map((o) => o.value));
      for (const value of automation.config.statuses) if (!known.has(value)) options.push({ value, label: value, jobs: 0 });
      show();
    })();
    return picker;
  };

  const rowsOf = (automation) => {
    const button = h('button', { class: 'fx-switch', type: 'button', role: 'switch', 'aria-label': automation.name, 'aria-checked': String(automation.enabled), disabled });
    button.addEventListener('click', async () => {
      const saved = await save(automation.key, { enabled: button.getAttribute('aria-checked') !== 'true' }, button);
      if (saved) button.setAttribute('aria-checked', String(saved.enabled));
    });
    const out = [row(automation.name, automation.hint, button)];
    if (automation.config.statuses) out.push(row('Ready statuses', 'Picked from the statuses Seazona reports.', statusPicker(automation)));
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
