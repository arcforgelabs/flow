// Home: the page a person lands on. One job first: send the invoices that
// are ready. The big number is the Ready tab's count, and Send sends them
// all with the same step as the Invoices page (POST /invoices/send-ready).
// Under it, where sent invoices are now, by the Invoices page's tabs; each
// card opens that tab. Draft and Approved are amber: in draft send mode a
// person still approves and emails them in the accounting system. No calls
// of its own to other systems.
import { formatCents, localDate } from '/assets/ui/invoicing.js';
import { sendModeNote } from '/assets/ui/invoice-notes.js';
import { lucide } from '/assets/ui/custom-fields.js';

// After Send, by the Invoices page's tabs. Draft, Approved and Sent are the
// accounting system's stages; with none, an issued invoice is Approved.
const AFTER = [
  ['pending', 'Needs a look', 'circle-alert', 'danger'],
  ['draft', 'Draft', 'file-text', 'warn', true],
  ['approved', 'Approved', 'circle-check', 'warn'],
  ['sent', 'Sent', 'send', 'success'],
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function renderHome(main, ui) {
  const { h, flow, toast, notice, pageHeader, tileCard, tileSection, dialog } = ui;
  const host = h('div', { class: 'fx-home' });
  main.append(pageHeader('Home'), host);

  async function load() {
    let context;
    let body;
    try {
      [context, body] = await Promise.all([
        flow('/api/invoicing/context'),
        flow(`/api/invoicing/invoices?${new URLSearchParams({ status: 'ready', limit: '1' })}`),
      ]);
    } catch (error) {
      host.replaceChildren(notice(error.message, 'danger', 'Flow could not load your invoices.'));
      return;
    }
    if (!host.isConnected) return;
    draw(context, body);
  }

  function draw(context, body) {
    const to = body.sendsTo;
    const ready = body.counts?.ready ?? 0;
    const blocked = to && body.sendMode && (!body.sendMode.connected || !body.sendMode.writesAllowed);
    const button = h('button', {
      class: 'fx-btn fx-btn--primary fx-home__btn', type: 'button',
      disabled: !ready || !context.canIssue || blocked,
      onclick: () => send(to, ready, body.sendMode, button),
    }, lucide(h, 'send'), ready ? `Send ${plural(ready, 'invoice', 'invoices')}` : 'Nothing to send');
    const hero = h('section', { class: 'fx-home__send', 'aria-labelledby': 'home-ready' },
      h('p', { class: 'fx-label', id: 'home-ready' }, 'Ready to send'),
      h('p', { class: 'fx-home__count' }, String(ready)),
      h('p', { class: 'fx-home__sum' }, ready ? formatCents(body.totalCents) : 'All ready invoices are sent.'),
      button,
      h('p', { class: 'fx-home__note' }, context.canIssue ? sendModeNote(to, body.sendMode) : 'Only an owner or an admin can send invoices.'));
    // With no accounting system, an issued invoice is Approved: no Draft or Sent.
    const cards = AFTER.filter(([tab]) => to || !['draft', 'sent'].includes(tab)).map(([tab, title, mark, tone, viaAccounting]) => tileCard({
      href: `/invoices?tab=${tab}`, mark, row: true,
      title: viaAccounting && to ? `${title} in ${to}` : title,
      status: { label: String(body.counts?.[tab] ?? 0), tone: body.counts?.[tab] ? tone : 'mute' },
    }));
    host.replaceChildren(hero, tileSection('Invoices', cards, { href: '/invoices', more: 'All invoices' }));
  }

  async function send(to, ready, sendMode, button) {
    const ok = await dialog({
      title: `Send ${plural(ready, 'invoice', 'invoices')}?`,
      body: h('p', {}, to ? sendModeNote(to, sendMode, 'each one') : 'Each one gets the next number and is locked.'),
      confirm: 'Send',
    });
    if (!ok) return;
    button.disabled = true;
    button.textContent = 'Sending';
    try {
      const res = await flow('/api/invoicing/invoices/send-ready', { method: 'POST', body: JSON.stringify({ issueDate: localDate() }) });
      const notes = [
        to ? `${res.issued} on the way to ${to}.` : `${res.issued} approved.`,
        res.held ? `${res.held} failed a check: see Needs a look.` : '',
        res.waiting ? `${res.waiting} could not be confirmed with the work system yet: press Send again.` : '',
        res.remaining ? `${res.remaining} more are ready: press Send again.` : '',
      ].filter(Boolean);
      toast(notes.join(' '), res.held || res.waiting || res.remaining ? 'info' : 'success', { stay: Boolean(res.held || res.waiting) });
    } catch (error) {
      toast(error.message, 'danger', { stay: true });
    }
    await load();
  }

  await load();
}
