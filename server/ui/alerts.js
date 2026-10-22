// The quiet alert strip (issue 117, docs/ALERTS.md): one slim line under a
// page's header when something on that page needs this person. It is hidden
// when nothing does. It shows the worst alert first, with "+N more" when there
// are others; × hides that alert for this person until something new joins
// it, and the next one shows. Data comes from /api/alerts
// (server/api/alerts.js). The caller passes in app.js's shared pieces as `ui`.

const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

// `onTab(tab)` opens a tab on the page, for an alert whose action names one.
// `scope` narrows the page to one part (an integration's own page), and
// `onLoad({ alerts, danger })` hears each answer (`danger`: a danger alert is
// open, even one this person hid), so the page can show the same state
// elsewhere. An action that links to the page already open is left out.
// Answers { element, refresh }: put `element` on the page, and call
// `refresh()` after a change that can fix or make an alert.
export function alertStrip(ui, page, { onTab = () => {}, scope = null, onLoad = () => {} } = {}) {
  const { h, flow, go, toast } = ui;
  const element = h('div', { class: 'fx-alerts', hidden: true, role: 'status', 'aria-live': 'polite' });
  let alerts = [];

  function draw() {
    const [first] = alerts;
    element.hidden = !first;
    if (!first) {
      element.replaceChildren();
      return;
    }
    element.dataset.tone = first.tone;
    const close = h('button', { class: 'fx-alerts__close', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => dismiss(first.key) });
    close.innerHTML = CLOSE;
    let action = null;
    if (first.action?.href && first.action.href !== location.pathname) action = h('a', { class: 'fx-alerts__action', href: first.action.href, onclick: go }, first.action.label);
    else if (first.action?.tab) action = h('button', { class: 'fx-alerts__action', type: 'button', onclick: () => onTab(first.action.tab) }, first.action.label);
    const line = first.moneyAtRiskCents > 0 ? `${first.title} ${money.format(first.moneyAtRiskCents / 100)} at risk.` : first.title;
    element.replaceChildren(...[
      h('p', { class: 'fx-alerts__text', title: line },
        first.title,
        first.moneyAtRiskCents > 0 ? h('span', { class: 'fx-alerts__money' }, ` ${money.format(first.moneyAtRiskCents / 100)} at risk.`) : null),
      action,
      alerts.length > 1 ? h('span', { class: 'fx-alerts__more' }, `+${alerts.length - 1} more`) : null,
      close,
    ].filter(Boolean));
  }

  async function dismiss(key) {
    alerts = alerts.filter((a) => a.key !== key);
    draw();
    try {
      await flow('/api/alerts/dismiss', { method: 'POST', body: JSON.stringify({ key }) });
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  // An alert that cannot load shows nothing: the page works without it.
  async function refresh() {
    let danger = false;
    try {
      const query = new URLSearchParams({ page, ...(scope ? { scope } : {}) });
      ({ alerts, danger = false } = await flow(`/api/alerts?${query}`));
    } catch {
      alerts = [];
    }
    onLoad({ alerts, danger });
    draw();
  }

  // Coming back to the tab checks again, while this page is open.
  const onVisible = () => {
    if (!element.isConnected) document.removeEventListener('visibilitychange', onVisible);
    else if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  refresh();
  return { element, refresh };
}
