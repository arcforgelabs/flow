// The "job changed" problem on a draft invoice (server/core/ledger.js,
// jobChangeFor): what the job was when the invoice was made and what the
// work system has now, one row per changed fact, with "Open in <system>" to
// fix it there, "Accept change" to take the new values into Flow's own draft,
// and a recheck button that reads the job from the work system again. Flow
// never writes to the work system. Kept apart from
// invoicing.js so tests can load it without a browser.

// Rows shown before "Show all".
export const FIRST_ROWS = 5;

const lineText = (line) => [line.code, line.description].filter(Boolean).join(' · ');
const lineFull = (line, money) => `${lineText(line)} · ${line.quantity} × ${line.unitAmountCents == null ? '—' : money(line.unitAmountCents)}`;

// [{ field, was, now }] in plain words. `money` formats cents.
export function changeRows(change, money) {
  const rows = [];
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
  const order = change.sourceInvoiceRef ? `Order #${change.sourceInvoiceRef}` : null;
  const link = change.link
    ? h('a', {
      class: 'fx-btn fx-btn--sm', href: change.link.url, target: '_blank', rel: 'noopener noreferrer',
      title: change.link.exact ? `Opens this job in ${system}.` : `Opens ${system}. Find ${order ?? 'the job'} there.`,
    }, `Open in ${system} ↗`)
    : null;
  const accept = change.canAccept && onAccept
    ? h('button', { class: 'fx-btn fx-btn--sm fx-btn--primary', type: 'button', title: `This invoice takes the Now in ${system} column.`, onclick: onAccept }, 'Accept change')
    : null;
  const recheck = onRecheck
    ? h('button', {
      class: 'fx-btn fx-btn--sm fx-btn--icon fx-change__recheck', type: 'button', title: `Check ${system} again`, 'aria-label': `Check ${system} again`,
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.classList.add('is-busy');
        try { await onRecheck(); } finally { button.disabled = false; button.classList.remove('is-busy'); }
      },
    }, h('span', { class: 'fx-lucide', style: '--icon: url(/assets/icons/refresh-cw.svg)', 'aria-hidden': 'true' }))
    : null;
  const body = h('tbody', {});
  const draw = (all) => body.replaceChildren(...(all ? rows : rows.slice(0, FIRST_ROWS)).map((row) => h('tr', {},
    h('th', { scope: 'row' }, row.field),
    h('td', { class: `fx-change__was${row.num ? ' fx-num' : ''}` }, row.was),
    h('td', { class: `fx-change__now${row.num ? ' fx-num' : ''}` }, row.now))));
  draw(false);
  const more = rows.length > FIRST_ROWS
    ? h('button', { class: 'fx-btn fx-btn--ghost fx-btn--sm', type: 'button', onclick: (event) => { draw(true); event.currentTarget.remove(); } }, `Show all ${rows.length}`)
    : null;
  return h('section', { class: 'fx-change', role: 'alert' },
    h('div', { class: 'fx-change__head' },
      h('p', {}, h('strong', {}, 'Problem.'), ' ', changeSummary(change, rows.filter((row) => row.field !== 'Total').length)),
      h('div', { class: 'fx-change__acts' }, link, accept, recheck)),
    !change.link && order ? h('p', { class: 'fx-change__note' }, `Find ${order} in ${system} to fix it there.`) : null,
    rows.length ? h('div', { class: 'fx-change__scroll' }, h('table', { class: 'fx-change__table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Field'), h('th', { scope: 'col' }, 'Was'), h('th', { scope: 'col' }, `Now in ${system}`))),
      body)) : null,
    more);
}
