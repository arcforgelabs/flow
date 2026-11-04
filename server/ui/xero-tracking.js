import { h, notice, settingRow, toast } from '/assets/ui/kit.js';

// Business settings belong on the connected adapter's page, not in host setup.
export function xeroTracking(ui, organisations, canChange) {
  const host = h('section', { id: 'tracking', class: 'fx-set fx-int-section fx-card', style: { padding: '8px 20px 16px' } },
    h('h2', { class: 'fx-set__title' }, 'Tracking'));
  if (!canChange) return null;
  for (const organisation of organisations ?? []) {
    const content = h('div', {}, h('span', { class: 'fx-dim' }, 'Loading…'));
    host.append(content);
    const save = async (tracking, button) => {
      button.disabled = true;
      try {
        await ui.flow('/api/xero/tracking', { method: 'PUT', body: JSON.stringify({ organisationId: organisation.id, tracking }) });
        toast('Tracking saved.', 'success');
        await load();
      } catch (error) { toast(error.message, 'danger'); }
      finally { button.disabled = false; }
    };
    const load = async () => {
      try {
        const { tracking, categories, connected, warning } = await ui.flow('/api/xero/tracking?organisationId=' + encodeURIComponent(organisation.id));
        const category = h('select', { class: 'fx-input', 'aria-label': 'Tracking category' },
          h('option', { value: '' }, 'Off'), categories.map((c) => h('option', { value: c.category }, c.category)));
        const option = h('select', { class: 'fx-input', 'aria-label': 'Tracking option' });
        const fillOptions = (selected = '') => {
          option.replaceChildren(h('option', { value: '' }, 'Choose an option'),
            ...(categories.find((c) => c.category === category.value)?.options ?? []).map((o) => h('option', { value: o }, o)));
          if (selected && !Array.from(option.options).some((o) => o.value === selected)) option.append(h('option', { value: selected }, selected + ' (unavailable)'));
          option.value = selected;
          option.disabled = !category.value;
        };
        if (tracking && !categories.some((c) => c.category === tracking.category)) category.append(h('option', { value: tracking.category }, tracking.category + ' (unavailable)'));
        category.value = tracking?.category ?? '';
        fillOptions(tracking?.option);
        const button = h('button', { class: 'fx-btn', type: 'button', onclick: () => {
          if (category.value && !option.value) { toast('Choose a tracking option.', 'danger'); return; }
          void save(category.value ? { category: category.value, option: option.value } : null, button);
        } }, 'Save');
        category.addEventListener('change', () => fillOptions());
        content.replaceChildren(...[
          warning ? notice(warning, 'warn') : !connected ? notice('Connect Xero to choose an active category and option. Off can still be saved.', 'mute') : null,
          settingRow({ label: organisations.length > 1 ? organisation.name : 'Tracking',
            help: 'Each line uses the client’s own Xero sales option in this category, otherwise this option. Off sends no tracking. Previously sent invoices stay unchanged.',
            control: h('div', { class: 'fx-setting__stack' }, category, option, button) }),
        ].filter(Boolean));
        if (location.hash === '#tracking') host.scrollIntoView({ block: 'start' });
      } catch (error) { content.replaceChildren(notice(error.message, 'danger')); }
    };
    void load();
  }
  return host;
}
