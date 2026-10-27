// Settings > Portal, and the Portal section on a contact (docs/PORTAL.md).
import { cardRows } from '/assets/ui/kit.js';
const DOCS = 'https://github.com/arcforgelabs/flow/blob/main/docs/PORTAL.md';
const HIDDEN = '';

function dayLabel(iso) {
  if (!iso) return '';
  const [year, month, day] = String(iso).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return '';
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function statusSelect(h, statuses, names) {
  return statuses.map((status) => {
    const current = names[status] ?? HIDDEN;
    const control = h('select', { class: 'fx-select', 'aria-label': status, 'data-status': status },
      h('option', { value: HIDDEN, selected: current === HIDDEN }, 'Hidden'),
      ...['Ordered', 'Received', 'In work', 'Quality check', 'Sent'].map((stage) => h('option', { value: stage, selected: stage === current }, stage)));
    return { status, control };
  });
}

export async function renderPortalSettings(main, ui) {
  const { h, flow, toast, notice, pageHeader, sectionTitle, settingRow, me } = ui;
  const canEdit = ['owner', 'admin'].includes(me?.person?.role);
  const host = h('div', { class: 'fx-set fx-portal-settings' }, h('div', { class: 'fx-skeleton' }));
  main.append(pageHeader('Portal', { help: { href: DOCS, label: 'How the portal works' } }), host);
  if (!canEdit) {
    host.replaceChildren(notice('Only an owner or an admin can change the portal.', 'warn'));
    return;
  }
  let body;
  try {
    body = await flow('/api/portal/settings');
  } catch (error) {
    host.replaceChildren(notice(error.message, 'danger'));
    return;
  }
  const enabled = h('select', { class: 'fx-select', 'aria-label': 'On' },
    h('option', { value: 'off', selected: !body.enabled }, 'Off'),
    h('option', { value: 'on', selected: body.enabled }, 'On'));
  const rows = statusSelect(h, body.statuses ?? [], body.names ?? {});
  const requests = h('div');
  const save = h('button', {
    class: 'fx-btn fx-btn--primary', type: 'button',
    onclick: async () => {
      save.disabled = true;
      try {
        const names = {};
        for (const row of rows) if (row.control.value) names[row.status] = row.control.value;
        await flow('/api/portal/settings', { method: 'PUT', body: JSON.stringify({ enabled: enabled.value === 'on', names }) });
        toast('Saved.', 'success');
      } catch (error) {
        toast(error.message, 'danger');
      } finally {
        save.disabled = false;
      }
    },
  }, 'Save');
  host.replaceChildren(
    sectionTitle('Portal', { href: DOCS, label: 'How the portal works' }),
    settingRow({ label: 'On', help: 'Practices can sign in and see their jobs.', control: enabled }),
    h('h2', { class: 'fx-set__title' }, 'Status names'),
    ...rows.map((row) => settingRow({
      label: row.status,
      help: 'The name a practice sees for this stage. Hidden stages are skipped.',
      control: row.control,
    })),
    h('div', { class: 'fx-row' }, save),
    h('h2', { class: 'fx-set__title' }, 'Requests'),
    requests,
  );
  drawRequests(ui, body.requests ?? [], requests, async () => {
    main.replaceChildren();
    await renderPortalSettings(main, ui);
  });
}

function drawRequests(ui, requests, host, redraw) {
  const { h, flow, toast, pickOne } = ui;
  if (!requests.length) {
    host.replaceChildren(h('p', { class: 'fx-empty' }, 'No requests.'));
    return;
  }
  host.replaceChildren(h('table', { class: 'fx-table' },
    h('thead', { class: 'fx-sr' }, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Practice'), h('th', {}, 'Approve'))),
    h('tbody', {}, requests.map((request) => h('tr', {},
      h('td', {}, h('span', { class: 'fx-person__name' }, request.name), h('span', { class: 'fx-person__email' }, request.email)),
      h('td', {}, request.practiceName, request.phone ? h('span', { class: 'fx-dim' }, ` ${request.phone}`) : null),
      h('td', {}, h('div', { class: 'fx-row' },
        h('button', { class: 'fx-btn fx-btn--primary', type: 'button', onclick: () => approve(request) }, 'Approve'),
        h('button', { class: 'fx-btn fx-btn--ghost', type: 'button', onclick: () => decline(request) }, 'Decline'))))))));

  async function approve(request) {
    const picked = await pickOne({
      title: 'Link practice',
      intro: `${request.name} asked to join ${request.practiceName}.`,
      label: 'Practices',
      find: 'Find a practice',
      confirm: 'Approve',
      remote: true,
      empty: 'No practices.',
      load: async (q) => {
        const found = await flow(`/api/invoicing/contacts?kind=customer&limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`);
        return found.contacts ?? [];
      },
      item: (contact) => ({ value: contact.id, title: contact.name, meta: contact.email }),
    });
    if (!picked) return;
    try {
      await flow(`/api/portal/requests/${request.id}/approve`, { method: 'POST', body: JSON.stringify({ contactId: picked.id }) });
      toast('Approved.', 'success');
      await redraw();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async function decline(request) {
    try {
      await flow(`/api/portal/requests/${request.id}/decline`, { method: 'POST', body: JSON.stringify({}) });
      toast('Declined.', 'success');
      await redraw();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }
}

// The Portal section on a customer: members, requests, and a read-only view.
export async function renderContactPortal(host, ui, contact) {
  const { h, flow, notice, sectionTitle, toast } = ui;
  let body;
  try {
    body = await flow(`/api/portal/contacts/${contact.id}`);
  } catch (error) {
    if (error.status === 403 || error.status === 404) return;
    host.replaceChildren(notice(error.message, 'danger'));
    return;
  }
  const preview = h('div');
  const requests = h('div');
  const members = body.members?.length
    ? h('table', { class: 'fx-table' },
      h('tbody', {}, body.members.map((member) => h('tr', {},
        h('td', {}, member.name || member.email),
        h('td', {}, member.role),
        h('td', {}, member.status === 'removed' ? 'Removed' : member.invited ? 'Invited' : 'Active')))))
    : h('p', { class: 'fx-empty' }, 'No members.');
  host.replaceChildren(h('section', { class: 'fx-card fx-portal-lab' },
    sectionTitle('Portal', { href: 'https://github.com/arcforgelabs/flow/blob/main/docs/PORTAL.md', label: 'How the portal works' }),
    h('h3', { class: 'fx-label' }, 'Members'),
    members,
    h('h3', { class: 'fx-label' }, 'Requests'),
    requests,
    h('div', { class: 'fx-row' }, h('button', {
      class: 'fx-btn', type: 'button',
      onclick: async () => {
        try {
          const view = await flow(`/api/portal/preview?contactId=${encodeURIComponent(contact.id)}`);
          const table = h('table', { class: 'fx-table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Case'), h('th', {}, 'Item'), h('th', {}, 'Dentist'), h('th', {}, 'Status'), h('th', {}, 'Due'))),
            h('tbody', {}, (view.jobs ?? []).map((job) => h('tr', {},
              h('td', { 'data-area': 'case', 'data-label': 'Case' }, job.caseRef),
              h('td', { 'data-area': 'item', 'data-label': 'Item' }, job.item),
              h('td', { 'data-area': 'dentist', 'data-label': 'Dentist' }, job.dentist),
              h('td', { 'data-area': 'status', 'data-label': 'Status' }, job.status ?? ''),
              h('td', { 'data-area': 'due', 'data-label': 'Due', class: job.late ? 'fx-job__date--late' : '' }, dayLabel(job.due))))));
          preview.replaceChildren(notice('Read only.', 'info', 'View as practice'), cardRows(table, {
            areas: ['case status', 'item item', 'dentist due'],
            columns: 'minmax(0, 1fr) minmax(0, 1fr)',
          }));
        } catch (error) {
          toast(error.message, 'danger');
        }
      },
    }, 'View')),
    preview));
  drawRequests(ui, body.requests ?? [], requests, async () => { await renderContactPortal(host, ui, contact); });
}
