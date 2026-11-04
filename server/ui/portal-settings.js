// Settings > Portal. The lab turns the portal on and names each work-system
// status with one of the five portal stages. Open join requests are approved
// here, linked to a customer with Pick.

const STAGES = ['Ordered', 'Received', 'In work', 'Quality check', 'Sent'];

export async function renderPortalSettings(main, ui) {
  const { h, flow, toast, pageHeader, settingRow, pickOne } = ui;
  main.className = 'fx-main';
  let data;
  try {
    data = await flow('/api/portal/settings');
  } catch (error) {
    main.replaceChildren(pageHeader('Portal'), h('p', {}, error.message));
    return;
  }
  const enabled = h('select', { class: 'fx-select', 'aria-label': 'Portal' },
    h('option', { value: 'on', selected: data.enabled ? '' : null }, 'On'),
    h('option', { value: 'off', selected: data.enabled ? null : '' }, 'Off'));
  const names = { ...data.statusNames };
  const statusRows = (data.statuses ?? []).map((status) => {
    const control = h('select', {
      class: 'fx-select',
      'aria-label': status,
      onchange: () => { names[status] = control.value; },
    },
    h('option', { value: '' }, 'Hidden'),
    ...STAGES.map((stage) => h('option', { value: stage, selected: names[status] === stage ? '' : null }, stage)));
    return settingRow({ label: status, control });
  });
  const save = h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button',
    onclick: async () => {
      save.disabled = true;
      const statusNames = {};
      for (const [status, name] of Object.entries(names)) if (STAGES.includes(name)) statusNames[status] = name;
      try {
        await flow('/api/portal/settings', {
          method: 'PUT',
          body: JSON.stringify({ enabled: enabled.value === 'on', statusNames }),
        });
        toast('Saved.', 'success');
      } catch (error) {
        toast(error.message, 'danger');
      } finally {
        save.disabled = false;
      }
    },
  }, 'Save');
  const requests = h('div');
  main.replaceChildren(
    pageHeader('Portal', { actions: [save] }),
    h('section', { class: 'fx-card' },
      settingRow({ label: 'Portal', help: 'Practice sign-in, jobs and team.', control: enabled }),
      ...statusRows),
    h('section', { class: 'fx-card' }, h('h2', { class: 'fx-title' }, 'Requests'), requests),
  );
  await drawRequests(ui, requests);
}

async function drawRequests(ui, host) {
  const { h, flow, toast, pickOne } = ui;
  let body;
  try {
    body = await flow('/api/portal/requests?status=open');
  } catch (error) {
    host.replaceChildren(h('p', {}, error.message));
    return;
  }
  const rows = body.requests ?? [];
  if (!rows.length) {
    host.replaceChildren();
    return;
  }
  host.replaceChildren(h('table', { class: 'fx-table' },
    h('tbody', {}, ...rows.map((request) => h('tr', {},
      h('td', {}, request.name),
      h('td', {}, request.practiceName),
      h('td', {}, request.email),
      h('td', {},
        h('button', { class: 'fx-btn fx-btn--primary fx-btn--sm', type: 'button', onclick: () => approve(ui, request, () => drawRequests(ui, host)) }, 'Approve'),
        ' ',
        h('button', {
          class: 'fx-btn fx-btn--sm', type: 'button',
          onclick: async () => {
            try {
              await flow(`/api/portal/requests/${request.id}/decline`, { method: 'POST' });
              toast('Declined.', 'success');
              await drawRequests(ui, host);
            } catch (error) {
              toast(error.message, 'danger');
            }
          },
        }, 'Decline')))))));
}

async function approve(ui, request, done) {
  const { flow, toast, pickOne } = ui;
  const listed = await flow('/api/invoicing/contacts');
  const picked = await pickOne({
    title: 'Practice',
    label: 'Practice',
    find: 'Find',
    load: async () => (listed.contacts ?? []).filter((contact) => contact.kind === 'customer'),
    item: (contact) => ({ value: contact.id, title: contact.name, meta: contact.email }),
    empty: 'No practice',
    confirm: 'Approve',
  });
  if (!picked) return;
  try {
    await flow(`/api/portal/requests/${request.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ contactId: picked.id }),
    });
    toast('Approved.', 'success');
    await done();
  } catch (error) {
    toast(error.message, 'danger', { stay: true });
  }
}
