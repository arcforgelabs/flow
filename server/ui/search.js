// Search across Flow, from the button at the foot of the sidebar or with
// Ctrl+K (⌘K on a Mac): the pages, then invoices by number, client or
// reference, then jobs by case, client or practitioner. Up and down move
// through the results, Enter opens one, Escape closes. Text from the server
// is only ever set as text.

const LIMIT = 6;

const lower = (value) => String(value ?? '').toLowerCase();

/**
 * `views` is [{ name, label, icon }] for the pages this person may open;
 * `icon(name)` draws a sidebar icon; `go(path)` opens a path in place.
 */
export function openSearch({ h, flow, go, icon, views }) {
  if (document.querySelector('.fx-search-dialog')) return;
  const input = h('input', {
    class: 'fx-search-dialog__input', type: 'search', placeholder: 'Search pages, invoices and jobs',
    'aria-label': 'Search Flow', 'aria-controls': 'search-results', autocomplete: 'off',
  });
  const results = h('div', { class: 'fx-search-dialog__results', id: 'search-results', role: 'listbox', 'aria-label': 'Results' });
  const element = h('dialog', { class: 'fx-dialog fx-search-dialog', 'aria-label': 'Search' },
    h('div', { class: 'fx-search-dialog__bar' }, icon('search'), input,
      h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', onclick: () => element.close() }, 'Close')),
    results);

  // Jobs come as one list (GET /api/invoicing/jobs), loaded once per opening
  // and filtered here, the same way the Jobs page filters them.
  let jobs = null;
  const jobsReady = flow('/api/invoicing/jobs').then((body) => { jobs = body.jobs ?? []; }).catch(() => { jobs = []; });
  let asked = 0;
  let timer = null;
  let options = [];
  let active = -1;

  function option({ path, title, detail, kind }) {
    const link = h('a', { class: 'fx-search-dialog__option', href: path, role: 'option', 'aria-selected': 'false', tabindex: '-1' },
      icon(kind),
      h('span', { class: 'fx-search-dialog__text' },
        h('span', { class: 'fx-search-dialog__title' }, title),
        detail ? h('span', { class: 'fx-search-dialog__detail' }, detail) : null));
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      open(path);
    });
    return link;
  }

  function open(path) {
    element.close();
    go(path);
  }

  function select(index) {
    options.forEach((node, i) => node.setAttribute('aria-selected', String(i === index)));
    active = index;
    const node = options[index];
    if (node) {
      input.setAttribute('aria-activedescendant', node.id);
      node.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function draw(groups, waiting) {
    const sections = groups.filter((group) => group.items.length).map((group) => h('div', { class: 'fx-search-dialog__group', role: 'group', 'aria-label': group.label },
      h('div', { class: 'fx-search-dialog__label', 'aria-hidden': 'true' }, group.label),
      group.items.map(option)));
    if (!sections.length) sections.push(h('p', { class: 'fx-search-dialog__empty' }, waiting ? 'Searching…' : 'Nothing found.'));
    results.replaceChildren(...sections);
    options = [...results.querySelectorAll('[role="option"]')];
    options.forEach((node, i) => { node.id = `search-option-${i}`; });
    select(options.length ? 0 : -1);
  }

  const pages = (q) => views.filter((view) => !q || lower(view.label).includes(q))
    .map((view) => ({ path: `/${view.name}`, title: view.label, kind: view.icon }));

  const matchingJobs = (q) => (jobs ?? [])
    .filter((job) => [job.caseRef, job.sourceJobRef, job.contactName, job.practitioner, job.invoiceNumber]
      .some((value) => value && lower(value).includes(q)))
    .slice(0, LIMIT)
    .map((job) => ({
      // A job with an invoice opens that invoice; any other opens the Jobs page, filtered to it.
      path: job.invoiceId ? `/invoices/${job.invoiceId}` : `/jobs?q=${encodeURIComponent(job.caseRef || job.sourceJobRef || '')}`,
      title: job.caseRef || job.sourceJobRef || 'Job',
      detail: [job.contactName, job.practitioner].filter(Boolean).join(' · '),
      kind: 'jobs',
    }));

  async function search() {
    const q = lower(input.value.trim());
    const turn = ++asked;
    if (!q) {
      draw([{ label: 'Pages', items: pages('') }]);
      return;
    }
    draw([{ label: 'Pages', items: pages(q) }], true);
    const [invoices] = await Promise.all([
      flow(`/api/invoicing/invoices?${new URLSearchParams({ q, limit: String(LIMIT) })}`)
        .then((body) => body.invoices ?? []).catch(() => []),
      jobsReady,
    ]);
    if (turn !== asked) return;
    draw([
      { label: 'Pages', items: pages(q) },
      {
        label: 'Invoices',
        items: invoices.map((invoice) => ({
          path: `/invoices/${invoice.id}`,
          title: invoice.number || 'Draft invoice',
          detail: [invoice.contactName, invoice.reference].filter(Boolean).join(' · '),
          kind: 'invoices',
        })),
      },
      { label: 'Jobs', items: matchingJobs(q) },
    ]);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 150);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!options.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      select((active + step + options.length) % options.length);
    } else if (event.key === 'Enter' && options[active]) {
      event.preventDefault();
      open(options[active].getAttribute('href'));
    }
  });
  element.addEventListener('click', (event) => { if (event.target === element) element.close(); });
  element.addEventListener('close', () => { clearTimeout(timer); element.remove(); });

  document.body.append(element);
  element.showModal();
  input.focus();
  search();
}
