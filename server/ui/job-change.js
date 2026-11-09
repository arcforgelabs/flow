// The "job changed" problem on a draft invoice (server/core/ledger.js,
// jobChangeFor): what the job was when the invoice was made and what the
// work system has now, one row per changed fact, with "Open in <system>" to
// fix it there, "Accept change" to take the new values into Flow's own draft,
// and a recheck button that reads the job from the work system again. Flow
// never writes to the work system. Kept apart from
// invoicing.js so tests can load it without a browser.
import { applyPhoneRule } from './mobile.js';

// Rows shown before "Show all".
export const FIRST_ROWS = 5;

const lineText = (line) => [line.code, line.description].filter(Boolean).join(' · ');
const lineFull = (line, money) => `${lineText(line)} · ${line.quantity} × ${line.unitAmountCents == null ? '—' : money(line.unitAmountCents)}`;

// [{ field, was, now }] in plain words. `money` formats cents.
export function changeRows(change, money) {
  const rows = [];
  if (change.sourceReview) {
    const { sourceTotals, reconstructed } = change.sourceReview;
    return [['Subtotal', 'subtotalCents'], ['GST', 'taxCents'], ['Total', 'totalCents']].map(([field, key]) => {
      const source = sourceTotals?.[key];
      const flow = reconstructed[key];
      const delta = source == null || flow == null ? null : flow - source;
      return { field, was: source == null ? 'Not supplied' : money(source), now: flow == null ? 'Unknown' : money(flow),
        difference: delta == null ? 'Unknown' : delta === 0 ? 'Same' : `${delta > 0 ? '+' : '−'}${money(Math.abs(delta))}`, num: true };
    });
  }
  if (change.contact) rows.push({ field: 'Client', was: change.contact.was ?? '—', now: change.contact.now ?? '—' });
  for (const line of change.lines ?? []) {
    const at = `Line ${line.position}`;
    if (line.change === 'added') { rows.push({ field: `${at} · added`, was: '—', now: lineFull(line.now, money) }); continue; }
    if (line.change === 'removed') { rows.push({ field: `${at} · removed`, was: lineFull(line.was, money), now: '—' }); continue; }
    if (line.fields.includes('item')) rows.push({ field: `${at} · item`, was: lineText(line.was), now: lineText(line.now) });
    if (line.fields.includes('description')) rows.push({ field: `${at} · description`, was: line.was.description, now: line.now.description });
    if (line.fields.includes('quantity')) rows.push({ field: `${at} · qty`, was: String(line.was.quantity), now: String(line.now.quantity), num: true });
    if (line.fields.includes('price')) {
      rows.push({ field: `${at} · price`, was: line.was.unitAmountCents == null ? '—' : money(line.was.unitAmountCents), now: line.now.unitAmountCents == null ? '—' : money(line.now.unitAmountCents), num: true });
    }
  }
  const { was, now } = change.total ?? {};
  if (was != null && now != null && was !== now) rows.push({ field: 'Total', was: money(was), now: money(now), num: true });
  return rows;
}

// The sentence after "Problem." One fact per sentence.
export function changeSummary(change, rowCount) {
  const system = change.systemName ?? 'the work system';
  if (change.sourceReview) return 'Check the source invoice amounts.';
  const count = `${rowCount} ${rowCount === 1 ? 'change' : 'changes'}.`;
  if (change.canAdopt) return `Changed in ${system}. ${count}`;
  if (change.sent) return `Changed in ${system} after sending. ${count}`;
  return `Changed in ${system} and here. ${count}`;
}

// The banner. `onAccept` runs "Accept change"; it is shown while the draft
// is not sent (ledger.js, canAccept). `onRecheck` reads the job again.
export function jobChangeBanner(ui, change, { money, onAccept = null, onRecheck = null }) {
  const { h } = ui;
  const system = change.systemName ?? 'the work system';
  const rows = changeRows(change, money);
  const source = change.sourceReview;
  const order = change.sourceInvoiceRef ? `${source ? 'Invoice' : 'Order'} #${change.sourceInvoiceRef}` : null;
  const link = change.link
    ? h('a', {
      class: 'fx-btn fx-btn--sm', href: change.link.url, target: '_blank', rel: 'noopener noreferrer',
      title: change.link.exact ? `Opens this job in ${system}.` : `Opens ${system}. Find ${order ?? 'the job'} there.`,
    }, source ? (change.link.exact ? `Open job in ${system} ↗` : `Open ${system} ↗`) : `Open in ${system} ↗`)
    : null;
  const accept = change.canAccept && onAccept
    ? h('button', { class: 'fx-btn fx-btn--sm fx-btn--primary', type: 'button', 'data-action': 'accept', title: `This invoice takes the Now in ${system} column.`, onclick: onAccept }, 'Accept change')
    : null;
  const recheck = onRecheck && change.canRecheck !== false
    ? h('button', {
      class: `fx-btn fx-btn--sm${source ? '' : ' fx-btn--icon fx-change__recheck'}`, type: 'button', title: `Read this job from ${system} again. Nothing is sent.`, 'aria-label': source ? 'Recheck' : `Check ${system} again`,
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.classList.add('is-busy');
        button.setAttribute('aria-busy', 'true');
        try { await onRecheck(); } finally { button.disabled = false; button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); }
      },
    }, source ? 'Recheck' : h('span', { class: 'fx-lucide', style: '--icon: url(/assets/icons/refresh-cw.svg)', 'aria-hidden': 'true' }))
    : null;
  const body = h('tbody', {});
  const cell = (area, label, value, num) => h('td', {
    class: num ? 'fx-num' : '', ...(source ? { 'data-area': area, 'data-label': label } : {}),
  }, value);
  const draw = (all) => body.replaceChildren(...(all ? rows : rows.slice(0, FIRST_ROWS)).map((row) => h('tr', {},
    source ? cell('field', 'Amount', row.field) : h('th', { scope: 'row' }, row.field),
    source ? cell('source', 'Source invoice', row.was, true) : h('td', { class: `fx-change__was${row.num ? ' fx-num' : ''}` }, row.was),
    source ? cell('flow', 'Flow job lines', row.now, true) : h('td', { class: `fx-change__now${row.num ? ' fx-num' : ''}` }, row.now),
    source ? cell('difference', 'Difference', row.difference, true) : null)));
  draw(false);
  const table = h('table', { class: 'fx-change__table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, source ? 'Amount' : 'Field'),
      h('th', { scope: 'col' }, source ? 'Source invoice' : 'Was'),
      h('th', { scope: 'col' }, source ? 'Flow job lines' : `Now in ${system}`),
      source ? h('th', { scope: 'col' }, 'Difference') : null)), body);
  if (source) ui.cardRows(table, { areas: ['field field', 'source flow', 'difference difference'], columns: 'repeat(2, minmax(0, 1fr))' });
  const inFlow = (href, label) => h('a', { class: 'fx-btn fx-btn--sm', href, onclick: (event) => ui.go(event) }, label);
  const sourceSteps = source ? h('div', { class: 'fx-change__steps' },
    h('p', { class: 'fx-change__note' }, `Source invoice: ${change.sourceInvoiceRef ?? 'Not supplied'}.${change.caseRef ? ` Case: ${change.caseRef}.` : ''}`),
    h('p', {}, 'Flow cannot tell which amount is wrong.'),
    h('p', { class: 'fx-change__note' }, 'Difference = Flow job lines minus source invoice. Do not divide a source invoice total between jobs.'),
    source.unknownTaxLines.length ? h('p', {}, `Tax is unknown on ${source.unknownTaxLines.map((line) => `line ${line.position}${line.description ? ` (${line.description})` : ''}`).join(', ')}. Flow cannot calculate GST or the total.`) : null,
    h('ol', {},
      h('li', {}, change.link?.exact ? `Open the job in ${system}, then check its linked invoice.` : `Open ${system}${change.link ? ' with its link' : ' separately'}. Find ${change.caseRef ? `case ${change.caseRef}` : order ?? 'the linked job'}, then check the source invoice.`),
      h('li', {}, 'Check each price, quantity, discount and tax value against the source facts.'),
      h('li', {}, 'Correct only facts you can verify. Do not choose tax only to remove this difference.'),
      h('li', {}, 'If a Flow mapping is wrong, correct it in Price codes or Price list.'),
      h('li', {}, change.canRecheck === false ? 'Ask an administrator to restore the source connection, then return here.' : 'Return here and select Recheck. Flow reads the source again. It does not send this invoice.')),
    h('div', { class: 'fx-change__acts' }, inFlow('/invoicing-settings/price-codes', 'Price codes'), inFlow('/price-list', 'Price list')),
    change.canRecheck === false ? h('p', {}, `Flow cannot read this job from ${system}.`) : null,
    h('details', {}, h('summary', {}, 'Saved invoice'),
      h('p', {}, 'These saved Flow amounts do not change when you recheck.'),
      h('dl', { class: 'fx-facts' }, [['Subtotal', 'subtotalCents'], ['GST', 'taxCents'], ['Total', 'totalCents']].flatMap(([label, key]) => [h('dt', {}, label), h('dd', {}, money(source.savedInvoice[key]))])),
      change.seenAt ? h('p', { class: 'fx-change__note' }, `Last source report: ${new Date(change.seenAt).toLocaleString('en-AU')}.`) : null)) : null;
  const more = rows.length > FIRST_ROWS
    ? h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', onclick: (event) => { draw(true); event.currentTarget.remove(); } }, `Show all ${rows.length}`)
    : null;
  return applyPhoneRule(h('section', { class: 'fx-change', role: 'alert', 'aria-label': source ? 'Source invoice comparison' : 'Job comparison' },
    h('div', { class: 'fx-change__head' },
      h('p', {}, h('strong', {}, 'Problem.'), ' ', changeSummary(change, rows.filter((row) => row.field !== 'Total').length)),
      h('div', { class: 'fx-change__acts' }, link, accept, recheck)),
    !source && !change.link && order ? h('p', { class: 'fx-change__note' }, `Find ${order} in ${system} to fix it there.`) : null,
    rows.length ? h('div', { class: 'fx-change__scroll' }, table) : null,
    sourceSteps,
    more), 'jobChangeBanner');
}

// The banner with Accept change and the recheck wired, for the invoice page
// and a job's Review sidecar (jobs.js). `canAccept`: the person may change
// drafts (owners and admins). `unsaved()`: edits on the page that Accept
// would lose. `done(invoice)` hears the invoice after Accept or a recheck.
export function jobChangeReview(ui, change, { money, canAccept = false, unsaved = () => false, done = () => {} }) {
  const { h, flow, toast } = ui;
  const system = change.systemName;
  return jobChangeBanner(ui, change, {
    money,
    onAccept: !canAccept ? null : async () => {
      const lost = [change.outcome === 'conflict' ? 'Your own line changes here are replaced.' : null, unsaved() ? 'Unsaved changes are lost.' : null].filter(Boolean);
      if (lost.length) {
        const ok = await ui.dialog({ title: 'Accept change?', body: h('p', {}, lost.join(' ')), confirm: 'Accept change' });
        if (!ok) return;
      }
      try {
        const res = await flow(`/api/invoicing/jobs/${change.jobId}/use-new-lines`, { method: 'POST', body: JSON.stringify({ accept: true }) });
        toast(`Matches ${system}.${res.invoice.view === 'ready' ? ' In Ready.' : ''}`, 'success');
        await done(res.invoice);
      } catch (error) {
        toast(error.message, 'danger');
      }
    },
    // Reads this one job from the work system again, then every check runs.
    onRecheck: async () => {
      if (unsaved()) {
        toast('Save or discard your changes before Recheck.', 'danger');
        return;
      }
      try {
        const res = await flow(`/api/invoicing/jobs/${change.jobId}/recheck`, { method: 'POST', body: '{}' });
        const pending = Boolean(res.invoice?.jobChange || res.invoice?.problems?.length);
        const cached = res.outcome === 'fresh';
        toast(cached ? `No new source read. Try again in ${res.retryAfterSeconds ?? 10} seconds.`
          : pending ? 'Still pending. Check the comparison and the remaining problems.'
            : 'Source check complete. No invoice problem remains.', cached ? 'info' : pending ? 'danger' : 'success');
        if (res.invoice) await done(res.invoice);
      } catch (error) {
        toast(error.message, 'danger');
      }
    },
  });
}
