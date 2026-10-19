// Problems (/problems): what people reported and what the server logged as
// an error, for owners and admins to triage (docs/PROBLEMS.md). The report
// dialog opens from the sidebar on every view. Data comes from /api/problems
// (server/api/problems.js); it stays in this installation.

const STATUS_LABEL = { new: 'New', seen: 'Seen', closed: 'Closed' };
const KINDS = [
  { id: 'reports', label: 'Reports' },
  { id: 'errors', label: 'Errors' },
];
const KIND_KEY = 'flow_problems_kind';

const showTime = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');

// Ask what went wrong, then keep it with the page, the person and the build.
export async function openReportDialog(ui) {
  const { h, flow, toast, dialog } = ui;
  const page = location.pathname;
  const data = await dialog({
    title: 'Report a problem',
    body: h('div', { class: 'fx-field' },
      h('label', { class: 'fx-label', for: 'problem-message' }, 'What went wrong?'),
      h('textarea', {
        class: 'fx-input', id: 'problem-message', name: 'message', rows: 5, maxlength: 4000, required: true,
        placeholder: 'What you did, what you expected, and what happened.',
      }),
      h('p', { class: 'fx-dim' }, `Flow adds this page (${page}), your name and the version. The report stays in this installation.`)),
    confirm: 'Send report',
  });
  if (!data) return;
  try {
    await flow('/api/problems/reports', { method: 'POST', body: JSON.stringify({ message: data.get('message'), page }) });
    toast('Report sent. An owner or admin will see it under Problems.', 'success');
  } catch (error) {
    toast(error.message, 'danger');
  }
}

function readKind() {
  try { return sessionStorage.getItem(KIND_KEY) === 'errors' ? 'errors' : 'reports'; } catch { return 'reports'; }
}

export async function renderProblems(main, ui) {
  const { h, flow, pageHeader, notice, toast } = ui;
  const state = { kind: readKind(), status: 'new', counts: { reports: null, errors: null } };
  const tabs = h('div', { class: 'fx-tabs', role: 'tablist' });
  const filter = h('select', { class: 'fx-select', 'aria-label': 'Show', id: 'problems-status' },
    ['new', 'seen', 'closed', ''].map((value) => h('option', { value, selected: value === state.status }, value ? STATUS_LABEL[value] : 'All')));
  const host = h('div', { class: 'fx-panel' }, h('div', { class: 'fx-skeleton' }));
  main.append(
    pageHeader('Problems', { subtitle: 'What people reported, and the errors Flow logged. Both stay in this installation.' }),
    h('div', { class: 'fx-toolbar' }, tabs, filter),
    host);
  filter.addEventListener('change', () => { state.status = filter.value; load(); });

  const drawTabs = () => tabs.replaceChildren(...KINDS.map(({ id, label }) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(state.kind === id),
    onclick: () => {
      state.kind = id;
      try { sessionStorage.setItem(KIND_KEY, id); } catch { /* only a convenience */ }
      load();
    },
  }, label, state.counts[id] == null ? null : h('span', { class: 'fx-tabs__count', title: 'New' }, String(state.counts[id])))));

  function statusControl(row) {
    return h('select', {
      class: 'fx-select', 'aria-label': 'Status',
      onchange: async (event) => {
        try {
          await flow(`/api/problems/${state.kind}/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: event.target.value }) });
          toast(`Marked ${STATUS_LABEL[event.target.value].toLowerCase()}.`, 'success');
        } catch (error) {
          toast(error.message, 'danger');
        }
        await load();
      },
    }, Object.entries(STATUS_LABEL).map(([value, label]) => h('option', { value, selected: value === row.status }, label)));
  }

  function reportsTable(reports) {
    return h('table', { class: 'fx-table fx-table--rows' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Reported'), h('th', {}, 'By'), h('th', {}, 'Page'), h('th', {}, 'What went wrong'), h('th', {}, 'Status'))),
      h('tbody', {}, reports.map((report) => h('tr', {},
        h('td', { class: 'fx-dim' }, showTime(report.createdAt)),
        h('td', {}, report.reporterEmail ?? '—'),
        h('td', { class: 'fx-dim', title: report.userAgent ?? '' }, [report.page ?? '—', report.build].filter(Boolean).join(' · ')),
        h('td', { style: { whiteSpace: 'pre-wrap' } }, report.message),
        h('td', {}, statusControl(report))))));
  }

  function errorsTable(errors) {
    return h('table', { class: 'fx-table fx-table--rows' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Last seen'), h('th', {}, 'Where'), h('th', {}, 'Error'), h('th', { class: 'fx-num' }, 'Times'), h('th', {}, 'Status'))),
      h('tbody', {}, errors.map((error) => h('tr', {},
        h('td', { class: 'fx-dim', title: `First seen ${showTime(error.firstSeenAt)}` }, showTime(error.lastSeenAt)),
        h('td', {}, [error.source, error.build].filter(Boolean).join(' · ')),
        h('td', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, error.message),
        h('td', { class: 'fx-num fx-strong' }, String(error.count)),
        h('td', {}, statusControl(error))))));
  }

  async function load() {
    drawTabs();
    const query = state.status ? `?status=${state.status}` : '';
    let body;
    try {
      body = await flow(`/api/problems/${state.kind}${query}`);
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger'));
      return;
    }
    state.counts[state.kind] = body.counts.new;
    drawTabs();
    const rows = state.kind === 'reports' ? body.reports : body.errors;
    if (!rows.length) {
      const what = state.kind === 'reports' ? 'reports' : 'errors';
      host.replaceChildren(h('p', { class: 'fx-empty' }, state.status ? `No ${STATUS_LABEL[state.status].toLowerCase()} ${what}.` : `No ${what} yet.`));
      return;
    }
    host.replaceChildren(state.kind === 'reports' ? reportsTable(rows) : errorsTable(rows));
  }

  await load();
}
