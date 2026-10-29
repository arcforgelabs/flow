export async function renderCaptureSettings(main, ui) {
  const { h, flow, crumbs, settingRow, notice, toast } = ui;
  const host = h('div', { class: 'fx-settings' });
  main.append(crumbs(['/captures', 'Captures'], 'Settings'), host);
  const draw = (settings) => {
    const control = h('button', { type: 'button', class: 'fx-switch', role: 'switch', 'aria-label': 'Reader', 'aria-checked': String(settings.enabled), disabled: !ui.me?.ownerActions?.allowed,
      onclick: async () => {
        control.disabled = true;
        try {
          const result = await flow('/api/capture-settings', { method: 'PUT', body: JSON.stringify({ enabled: !settings.enabled }) });
          draw(result.settings);
          toast(result.settings.enabled ? 'Reader enabled.' : 'Reader disabled.', 'success');
        } catch (error) { control.disabled = false; toast(error.message, 'danger'); }
      },
    });
    host.replaceChildren(...[
      settingRow({ label: 'Reader', control, help: 'Read form photos with Bedrock in Australia. Off leaves photos for manual entry. A read already running can finish.' }),
      settingRow({ label: 'This month', control: h('span', {}, `US$${(settings.cost.costMicros / 1_000_000).toFixed(4)}`), help: `Recorded cost for ${settings.cost.month} (UTC). Undecided captures expire after 7 days, taking their cost with them; this total can decrease. It is not a billing ledger.` }),
      settings.cost.unpriced ? notice(`${settings.cost.unpriced} unpriced ${settings.cost.unpriced === 1 ? 'read is' : 'reads are'} excluded.`, 'warn') : null,
      !settings.storageReady ? notice('Ask your host to configure photo storage.', 'warn', 'Unavailable.') : null,
      !settings.readerReady ? notice('Ask your host to configure the Bedrock Australia reader.', 'warn', 'Reader unavailable.') : null,
    ].filter(Boolean));
  };
  try { draw((await flow('/api/capture-settings')).settings); }
  catch (error) { host.replaceChildren(notice(error.message, 'danger')); }
}
