// The Portal section on a customer contact: members, requests, the audit
// log, and a read-only view of that practice's jobs.

export async function mountPortalSection(ui, contact, host) {
  if (contact.kind !== 'customer') return;
  const { h, flow, toast } = ui;
  let body;
  try {
    body = await flow(`/api/portal/contacts/${contact.id}`);
  } catch {
    return;
  }
  const members = h('div');
  const requests = h('div');
  const events = h('div');
  const jobs = h('div');
  host.replaceChildren(h('section', { class: 'fx-card fx-portal-lab' },
    h('h2', { class: 'fx-title' }, 'Portal'),
    h('h3', { class: 'fx-label' }, 'Members'),
    members,
    h('h3', { class: 'fx-label' }, 'Requests'),
    requests,
    h('h3', { class: 'fx-label' }, 'Jobs'),
    jobs,
    h('h3', { class: 'fx-label' }, 'Audit'),
    events));
  const drawMembers = () => {
    members.replaceChildren(...(body.members.length ? body.members.map((member) => h('div', { class: 'fx-setting' },
      h('span', {}, `${member.name || member.email} · ${member.role}`),
      h('button', {
        class: 'fx-btn fx-btn--sm', type: 'button',
        onclick: async () => {
          try {
            await flow(`/api/portal/contacts/${contact.id}/members/${member.id}/sign-out`, { method: 'POST' });
            toast('Signed out.', 'success');
          } catch (error) {
            toast(error.message, 'danger');
          }
        },
      }, 'Sign out'))) : []));
  };
  requests.replaceChildren(...body.requests.map((request) => h('p', {}, `${request.name} · ${request.status}`)));
  events.replaceChildren(...body.events.slice(0, 20).map((event) => h('p', { class: 'fx-dim' }, `${event.action} ${event.recordType}`)));
  drawMembers();
  try {
    const listed = await flow(`/api/portal/contacts/${contact.id}/jobs`);
    jobs.replaceChildren(...(listed.jobs ?? []).map((job) => h('p', {}, `${job.caseRef || 'Job'} · ${job.status || ''}`)));
  } catch {
    jobs.replaceChildren();
  }
}
